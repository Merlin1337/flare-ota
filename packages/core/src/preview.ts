// Signed preview tokens: let one device run one update group, outside the channel rollout.
// The token travels in the `flare-preview` request header, set at runtime by the app
// (expo-updates `setUpdateRequestHeadersOverride`), so no custom native SDK is involved.

import { base64url, fromBase64url, timingSafeEqual, utf8 } from "./encoding.ts";

export const PREVIEW_HEADER = "flare-preview";
export const PREVIEW_MAX_TTL_MINUTES = 7 * 24 * 60;

export interface PreviewPayload {
  /** Format version. */
  v: 1;
  /** Update group the device should run. */
  g: string;
  /** Unix seconds after which the server stops honouring the token. */
  exp: number;
  /** Random id, also the revocation key in the server's previews table. */
  n: string;
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function signPreview(secret: string, payload: PreviewPayload): Promise<string> {
  const body = base64url(utf8(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(body)));
  return `${body}.${base64url(mac)}`;
}

/** Returns the payload when the signature is valid and the token has not expired, otherwise null. */
export async function verifyPreview(secret: string, token: string, nowSeconds = Date.now() / 1000): Promise<PreviewPayload | null> {
  if (token.length > 512) return null;
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  let given: Uint8Array;
  try {
    given = fromBase64url(mac);
  } catch {
    return null;
  }
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(body)));
  if (!timingSafeEqual(given, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
  } catch {
    return null;
  }
  if (!isPayload(payload) || payload.exp <= nowSeconds) return null;
  return payload;
}

function isPayload(value: unknown): value is PreviewPayload {
  const p = value as PreviewPayload;
  return (
    typeof p === "object" && p !== null && p.v === 1 &&
    typeof p.g === "string" && typeof p.n === "string" && typeof p.exp === "number"
  );
}

/** Deep link opened by the QR code; the app's preview helper handles `<scheme>://flare-ota/preview`. */
export function previewDeepLink(scheme: string, token: string): string {
  return `${scheme}://flare-ota/preview?token=${encodeURIComponent(token)}`;
}
