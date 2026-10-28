import { fromBase64url, hex, scopeAllows, sha256, timingSafeEqual, utf8, type Scope } from "@flare-ota/core";
import type { Env } from "./env.ts";
import type { Store } from "./store.ts";

export interface Principal {
  /** Who acted, as recorded in the audit log and on published groups. */
  actor: string;
  scope: Scope;
}

export const TOKEN_PREFIX = "fota_";

export async function hashToken(token: string): Promise<string> {
  return hex(await sha256(token));
}

const lastTouched = new Map<string, number>();

/**
 * Resolves `Authorization: Bearer fota_…`. Only SHA-256 digests are stored; the lookup is by
 * digest and the final comparison is constant-time, so neither the table nor response timing
 * reveals a token.
 */
export async function bearerPrincipal(request: Request, store: Store): Promise<Principal | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (fota_[A-Za-z0-9_-]{20,100})$/.exec(header);
  if (!match) return null;
  const digest = await hashToken(match[1]!);
  const token = await store.tokenByHash(digest);
  if (!token || !timingSafeEqual(utf8(token.hash), utf8(digest))) return null;
  const last = lastTouched.get(token.id) ?? 0;
  if (Date.now() - last > 60 * 60 * 1000) {
    lastTouched.set(token.id, Date.now());
    await store.touchToken(token.id);
  }
  return { actor: `token:${token.name}`, scope: token.scope };
}

export function allows(principal: Principal | null, required: Scope): principal is Principal {
  return principal !== null && scopeAllows(principal.scope, required);
}

// ---- Cloudflare Access ----

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

async function accessKeys(teamDomain: string, fetcher: typeof fetch): Promise<Jwk[]> {
  const cached = jwksCache.get(teamDomain);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.keys;
  const response = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs: HTTP ${response.status}`);
  const { keys } = (await response.json()) as { keys: Jwk[] };
  jwksCache.set(teamDomain, { at: Date.now(), keys });
  return keys;
}

/**
 * Verifies the `Cf-Access-Jwt-Assertion` header that Cloudflare Access adds in front of the
 * dashboard: RS256 signature against the team's published keys, audience, issuer and expiry.
 * Edge protection alone is not enough: a request that reaches the Worker another way (a
 * misconfigured route, a preview URL) must not be trusted. Returns the user's email.
 */
export async function accessIdentity(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<string | null> {
  const team = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!team || !audience || !jwt) return null;
  const [head, body, signature] = jwt.split(".");
  if (!head || !body || !signature) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(fromBase64url(head))) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || !header.kid) return null;
    const jwk = (await accessKeys(team, fetcher)).find((key) => key.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(signature), utf8(`${head}.${body}`));
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as {
      aud?: string | string[];
      iss?: string;
      exp?: number;
      nbf?: number;
      email?: string;
    };
    const nowSeconds = Date.now() / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) return null;
    if (claims.iss !== `https://${team}`) return null;
    if (typeof claims.exp !== "number" || claims.exp < nowSeconds) return null;
    if (typeof claims.nbf === "number" && claims.nbf > nowSeconds + 60) return null;
    return claims.email ?? null;
  } catch {
    return null;
  }
}
