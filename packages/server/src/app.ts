import { ASSET_HASH, NAME, fromBase64url, hex, isPlatform, verifyPreview, type Scope } from "@flare-ota/core";
import { Hono, type Context } from "hono";
import { accessIdentity, allows, bearerPrincipal, type Principal } from "./auth.ts";
import { dashboard } from "./dashboard.ts";
import { errorResponse } from "./errors.ts";
import { appVersionFrom, recordCheck } from "./devices.ts";
import type { Ctx, Env } from "./env.ts";
import { handleMcp } from "./mcp.ts";
import { decide, parseManifestRequest, protocolResponse, type Decision } from "./protocol.ts";
import { Invalid, Services, parsePublishInput } from "./services.ts";
import { signerFromPem } from "./signing.ts";
import { NotFound, Store } from "./store.ts";

type AppEnv = { Bindings: Env; Variables: { principal: Principal | null; store: Store; services: Services } };

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 50 * 1024 * 1024;

async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > MAX_JSON_BYTES) throw new Invalid("Request body too large.");
  const text = await c.req.text();
  if (text.length > MAX_JSON_BYTES) throw new Invalid("Request body too large.");
  try {
    const body = JSON.parse(text || "{}");
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new Invalid("Expected a JSON object.");
  }
}

function requireScope(c: Context<AppEnv>, scope: Scope): Principal {
  const principal = c.get("principal");
  if (!principal) throw new HttpError(401, "Missing or invalid bearer token.");
  if (!allows(principal, scope)) throw new HttpError(403, `This token needs the ${scope} scope.`);
  return principal;
}

class HttpError extends Error {
  readonly status: 401 | 403 | 405;
  constructor(status: 401 | 403 | 405, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.onError((error) => {
    if (error instanceof HttpError) {
      const headers: Record<string, string> = { "cache-control": "no-store" };
      if (error.status === 401) headers["www-authenticate"] = 'Bearer realm="flare-ota"';
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    return errorResponse(error);
  });

  app.use("*", async (c, next) => {
    const store = new Store(c.env.DB);
    c.set("store", store);
    c.set("services", new Services(store, c.env));
    c.set("principal", null);
    await next();
  });

  // The dashboard host is a separate world: Cloudflare Access in front, and a verified Access JWT here.
  app.use("*", async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (c.env.DASHBOARD_HOST && host === c.env.DASHBOARD_HOST) {
      const email = c.env.INSECURE_DASHBOARD === "1" ? "local-dev" : await accessIdentity(c.req.raw, c.env);
      if (!email) return c.text("Cloudflare Access authentication required.", 403);
      return dashboard(c.req.raw, c.env, c.get("store"), c.get("services"), { actor: `access:${email}`, scope: "admin" });
    }
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ---- device routes ----

  app.get("/manifest", async (c) => {
    const parsed = parseManifestRequest(c.req.raw.headers);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const request = parsed.request;
    const store = c.get("store");
    const branch = await store.channelBranch(request.channel);
    let decision: Decision | null = null;
    if (request.previewToken && c.env.PREVIEW_SECRET) {
      const payload = await verifyPreview(c.env.PREVIEW_SECRET, request.previewToken);
      if (payload && (await store.previewActive(payload.n, payload.g))) {
        const update = await store.groupUpdate(payload.g, request.platform, request.runtimeVersion);
        if (update) {
          decision =
            update.id === request.currentUpdateId ? { type: "none", reason: "already-current" }
            : update.rollbackToEmbedded ? { type: "rollBackToEmbedded", update }
            : { type: "manifest", update };
        }
      }
    }
    if (!decision) {
      decision = branch
        ? await decide(await store.candidates(branch, request.platform, request.runtimeVersion), request)
        : { type: "none", reason: "unknown-channel" };
    }
    const response = await protocolResponse(decision, {
      origin: new URL(c.req.url).origin,
      signer: c.env.SIGNING_KEY ? signerFromPem(c.env.SIGNING_KEY) : null,
      expectSignature: request.expectSignature,
      branch,
    });
    const cf = (c.req.raw as Request & { cf?: { country?: string } }).cf;
    const finalDecision = decision;
    executionCtx(c)?.waitUntil(
      recordCheck(c.env, store, request, finalDecision, {
        country: cf?.country ?? null,
        appVersion: appVersionFrom(c.req.header("expo-extra-params") ?? null),
      }).catch((error) => console.error("recordCheck", error)),
    );
    return response;
  });

  app.get("/assets/:hash", async (c) => {
    const hash = c.req.param("hash");
    if (!ASSET_HASH.test(hash)) return c.text("Not found", 404);
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    const cacheKey = new Request(new URL(`/assets/${hash}`, c.req.url).toString());
    const cached = await cache?.match(cacheKey);
    if (cached) return cached;
    const object = await c.env.BUCKET.get(`assets/${hash}`);
    if (!object) return c.text("Not found", 404);
    const response = new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "content-length": String(object.size),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
    c.env.EVENTS?.writeDataPoint({ indexes: ["asset"], blobs: ["asset", hash], doubles: [1, object.size] });
    if (cache) executionCtx(c)?.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  });

  // ---- authenticated API and MCP ----

  app.use("/api/*", async (c, next) => {
    c.set("principal", await bearerPrincipal(c.req.raw, c.get("store")));
    await next();
  });

  app.all("/mcp", async (c) => {
    const principal = await bearerPrincipal(c.req.raw, c.get("store"));
    if (!principal) throw new HttpError(401, "Missing or invalid bearer token.");
    return handleMcp(c.req.raw, principal, c.get("store"), c.get("services"), c.env);
  });

  const api = new Hono<AppEnv>();

  api.get("/whoami", (c) => {
    const principal = requireScope(c, "read");
    return c.json(principal);
  });

  api.post("/assets/missing", async (c) => {
    requireScope(c, "publish");
    const body = await jsonBody(c);
    const hashes = body.hashes;
    if (!Array.isArray(hashes) || hashes.length > 5000 || !hashes.every((h) => typeof h === "string" && ASSET_HASH.test(h))) {
      throw new Invalid("hashes must be an array of at most 5000 asset hashes.");
    }
    return c.json({ missing: await c.get("store").missingAssets([...new Set(hashes as string[])]) });
  });

  api.put("/assets/:hash", async (c) => {
    requireScope(c, "publish");
    const hash = c.req.param("hash");
    if (!ASSET_HASH.test(hash)) throw new Invalid("Invalid asset hash.");
    const contentType = c.req.header("content-type") ?? "";
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(contentType)) throw new Invalid("Send the asset's content-type.");
    const length = Number(c.req.header("content-length") ?? "NaN");
    if (!Number.isInteger(length) || length < 0 || length > MAX_ASSET_BYTES) throw new Invalid(`content-length is required and at most ${MAX_ASSET_BYTES} bytes.`);
    const body = c.req.raw.body;
    if (!body) throw new Invalid("Empty body.");
    try {
      // R2 recomputes SHA-256 while storing and rejects the write if it differs from the address.
      await c.env.BUCKET.put(`assets/${hash}`, body, { httpMetadata: { contentType }, sha256: hex(fromBase64url(hash)) });
    } catch {
      throw new Invalid("Upload rejected: the content does not match its hash.");
    }
    await c.get("store").recordAsset(hash, contentType, length);
    return c.json({ ok: true });
  });

  api.post("/groups", async (c) => {
    const principal = requireScope(c, "publish");
    const input = parsePublishInput(await jsonBody(c));
    return c.json(await c.get("services").publish(input, principal.actor), 201);
  });

  api.get("/groups", async (c) => {
    requireScope(c, "read");
    const branch = c.req.query("branch") ?? null;
    if (branch !== null && !NAME.test(branch)) throw new Invalid("Invalid branch name.");
    return c.json(await c.get("store").groups(branch, clampLimit(c.req.query("limit"), 20, 100)));
  });

  api.get("/groups/:id", async (c) => {
    requireScope(c, "read");
    const group = await c.get("store").group(c.req.param("id"));
    if (!group) throw new NotFound("Update group not found.");
    return c.json(group);
  });

  api.post("/groups/:id/rollout", async (c) => {
    const principal = requireScope(c, "admin");
    const body = await jsonBody(c);
    return c.json(await c.get("services").setRollout(c.req.param("id"), Number(body.percent), principal.actor));
  });

  api.post("/groups/:id/pause", async (c) => {
    const principal = requireScope(c, "admin");
    return c.json(await c.get("services").setPaused(c.req.param("id"), true, principal.actor));
  });

  api.post("/groups/:id/resume", async (c) => {
    const principal = requireScope(c, "admin");
    return c.json(await c.get("services").setPaused(c.req.param("id"), false, principal.actor));
  });

  api.post("/groups/:id/promote", async (c) => {
    const principal = requireScope(c, "admin");
    const body = await jsonBody(c);
    return c.json(await c.get("services").promote(c.req.param("id"), String(body.branch ?? ""), Number(body.rolloutPercent ?? 100), principal.actor), 201);
  });

  api.post("/branches/:branch/rollback", async (c) => {
    const principal = requireScope(c, "admin");
    const body = await jsonBody(c);
    const platform = body.platform ?? null;
    if (platform !== null && !isPlatform(platform)) throw new Invalid("platform must be ios or android.");
    const to = body.to ?? "previous";
    if (to !== "previous" && to !== "embedded") throw new Invalid("to must be previous or embedded.");
    return c.json(await c.get("services").rollback(c.req.param("branch"), platform, to, principal.actor), 201);
  });

  api.get("/channels", async (c) => {
    requireScope(c, "read");
    return c.json(await c.get("store").listChannels());
  });

  api.put("/channels/:name", async (c) => {
    const principal = requireScope(c, "admin");
    const body = await jsonBody(c);
    await c.get("services").setChannel(c.req.param("name"), String(body.branch ?? ""), principal.actor);
    return c.json({ ok: true });
  });

  api.get("/metrics", async (c) => {
    requireScope(c, "read");
    const branch = c.req.query("branch") ?? null;
    const platform = c.req.query("platform") ?? null;
    if (branch !== null && !NAME.test(branch)) throw new Invalid("Invalid branch name.");
    if (platform !== null && !isPlatform(platform)) throw new Invalid("platform must be ios or android.");
    return c.json(await c.get("store").metrics(branch, platform, clampLimit(c.req.query("limit"), 10, 50)));
  });

  api.get("/overview", async (c) => {
    requireScope(c, "read");
    return c.json(await c.get("store").overview());
  });

  api.get("/audit", async (c) => {
    requireScope(c, "read");
    return c.json(await c.get("store").auditLog(clampLimit(c.req.query("limit"), 50, 200)));
  });

  api.post("/previews", async (c) => {
    const principal = requireScope(c, "admin");
    const body = await jsonBody(c);
    return c.json(
      await c.get("services").createPreview(String(body.groupId ?? ""), Number(body.ttlMinutes ?? 60), typeof body.scheme === "string" ? body.scheme : null, principal.actor),
      201,
    );
  });

  api.get("/tokens", async (c) => {
    requireScope(c, "admin");
    return c.json(await c.get("store").listTokens());
  });

  api.post("/tokens", async (c) => {
    const principal = requireScope(c, "admin");
    const body = await jsonBody(c);
    return c.json(await c.get("services").createToken(String(body.name ?? ""), body.scope as Scope, principal.actor), 201);
  });

  api.delete("/tokens/:id", async (c) => {
    const principal = requireScope(c, "admin");
    await c.get("services").revokeToken(c.req.param("id"), principal.actor);
    return c.json({ ok: true });
  });

  api.post("/gc", async (c) => {
    const principal = requireScope(c, "admin");
    return c.json(await c.get("services").collectGarbage(principal.actor));
  });

  app.route("/api/v1", api);

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}

function clampLimit(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

function executionCtx(c: Context<AppEnv>): Ctx | null {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

