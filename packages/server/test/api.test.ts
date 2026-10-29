import { base64url, utf8 } from "@flare-ota/core";
import { beforeEach, describe, expect, it } from "vitest";
import { accessIdentity } from "../src/auth.ts";
import { resetDeviceDebounce } from "../src/devices.ts";
import { assetHash, bearer, harness, manifestHeaders, parseMultipart, publish, uploadBundle, verifySignature, type Harness } from "./support.ts";

let h: Harness;
let publisher: string;
let admin: string;

beforeEach(async () => {
  resetDeviceDebounce();
  h = await harness();
  publisher = await h.token("publish", "ci");
  admin = await h.token("admin", "ops");
});

async function publishBundle(source: string, extra: Record<string, unknown> = {}, branch = "production") {
  const ios = await uploadBundle(h, publisher, source);
  const response = await publish(h, publisher, { branch, message: source, updates: { ios }, ...extra });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; updates: { id: string; platform: string }[] };
}

async function check(extra: Record<string, string> = {}) {
  const response = await h.fetch("/manifest", { headers: manifestHeaders(extra) });
  expect(response.status).toBe(200);
  const parts = await parseMultipart(response);
  const part = parts.manifest ?? parts.directive!;
  expect(await verifySignature(h.publicKey, part.headers["expo-signature"]!, part.body)).toBe(true);
  return { parts, json: JSON.parse(part.body) as Record<string, any>, response };
}

const post = (path: string, token: string, body: unknown = {}) =>
  h.fetch(path, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body) });

describe("publish and serve", () => {
  it("serves a signed manifest whose assets download with immutable caching", async () => {
    const group = await publishBundle("console.log(1)");
    const { json, response } = await check();
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(json.id).toBe(group.updates[0]!.id);
    expect(json.metadata).toEqual({ branchName: "production" });
    const asset = await h.fetch(new URL(json.launchAsset.url).pathname);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toBe("console.log(1)");
  });

  it("answers noUpdateAvailable once the device runs the update", async () => {
    const group = await publishBundle("a");
    const { json } = await check({ "expo-current-update-id": group.updates[0]!.id });
    expect(json).toEqual({ type: "noUpdateAvailable" });
  });

  it("answers noUpdateAvailable for an unknown channel", async () => {
    await publishBundle("a");
    const { json } = await check({ "expo-channel-name": "nope" });
    expect(json.type).toBe("noUpdateAvailable");
  });

  it("refuses to publish assets that were never uploaded", async () => {
    const response = await publish(h, publisher, {
      branch: "production",
      message: "x",
      updates: { ios: { runtimeVersion: "rt-1", launchAsset: { hash: "A".repeat(43), key: "k", contentType: "application/javascript", fileExtension: ".bundle" }, assets: [] } },
    });
    expect(response.status).toBe(400);
  });

  it("rejects an upload whose bytes do not match the hash", async () => {
    const hash = await assetHash(utf8("real"));
    const response = await h.fetch(`/api/v1/assets/${hash}`, {
      method: "PUT",
      headers: { ...bearer(publisher), "content-type": "application/javascript", "content-length": "4" },
      body: utf8("fake"),
    });
    expect(response.status).toBe(400);
    expect(h.bucket.objects.size).toBe(0);
  });

  it("reports which assets are missing", async () => {
    const present = (await uploadBundle(h, publisher, "x")).launchAsset.hash;
    const absent = await assetHash(utf8("absent"));
    const response = await post("/api/v1/assets/missing", publisher, { hashes: [present, absent] });
    expect(await response.json()).toEqual({ missing: [absent] });
  });
});

describe("rollouts", () => {
  it("blocks a new publish while a partial rollout runs, until it reaches 100%", async () => {
    await publishBundle("stable");
    const canary = await publishBundle("canary", { rolloutPercent: 10 });
    const ios = await uploadBundle(h, publisher, "next");
    expect((await publish(h, publisher, { branch: "production", message: "next", updates: { ios } })).status).toBe(409);
    expect((await post(`/api/v1/groups/${canary.id}/rollout`, admin, { percent: 5 })).status).toBe(409);
    expect((await post(`/api/v1/groups/${canary.id}/rollout`, admin, { percent: 100 })).status).toBe(200);
    expect((await publish(h, publisher, { branch: "production", message: "next", updates: { ios } })).status).toBe(201);
  });

  it("splits devices between the canary and the stable update", async () => {
    const stable = await publishBundle("stable");
    const canary = await publishBundle("canary", { rolloutPercent: 50 });
    const served = new Set<string>();
    for (let i = 0; i < 30; i++) served.add((await check({ "eas-client-id": crypto.randomUUID() })).json.id);
    expect(served).toEqual(new Set([stable.updates[0]!.id, canary.updates[0]!.id]));
  });

  it("pausing hides an update from new devices", async () => {
    const stable = await publishBundle("stable");
    const bad = await publishBundle("bad");
    expect((await post(`/api/v1/groups/${bad.id}/pause`, admin)).status).toBe(200);
    expect((await check()).json.id).toBe(stable.updates[0]!.id);
    expect((await check({ "expo-current-update-id": bad.updates[0]!.id })).json.type).toBe("noUpdateAvailable");
  });
});

describe("rollback and promote", () => {
  it("republishes the previous bundle under a new id", async () => {
    const good = await publishBundle("good");
    await publishBundle("bad");
    const response = await post("/api/v1/branches/production/rollback", admin, { to: "previous" });
    expect(response.status).toBe(201);
    const rollback = (await response.json()) as { id: string; sourceGroupId: string; updates: { id: string }[] };
    expect(rollback.sourceGroupId).toBe(good.id);
    const { json } = await check();
    expect(json.id).toBe(rollback.updates[0]!.id);
    expect(await (await h.fetch(new URL(json.launchAsset.url).pathname)).text()).toBe("good");
  });

  it("rolls back to the embedded bundle with a signed directive", async () => {
    await publishBundle("only");
    expect((await post("/api/v1/branches/production/rollback", admin, { to: "embedded" })).status).toBe(201);
    const { json } = await check({ "expo-current-update-id": crypto.randomUUID(), "expo-embedded-update-id": crypto.randomUUID() });
    expect(json.type).toBe("rollBackToEmbedded");
    expect(typeof json.parameters.commitTime).toBe("string");
  });

  it("refuses a previous-bundle rollback when there is none", async () => {
    await publishBundle("only");
    expect((await post("/api/v1/branches/production/rollback", admin, { to: "previous" })).status).toBe(409);
  });

  it("promotes a staging group to production", async () => {
    const staged = await publishBundle("tested", {}, "staging");
    const response = await post(`/api/v1/groups/${staged.id}/promote`, admin, { branch: "production" });
    expect(response.status).toBe(201);
    const promoted = (await response.json()) as { branch: string; sourceGroupId: string; updates: { id: string }[] };
    expect(promoted).toMatchObject({ branch: "production", sourceGroupId: staged.id });
    expect((await check()).json.id).toBe(promoted.updates[0]!.id);
  });
});

describe("preview links", () => {
  it("serves the previewed group to one device, outside the rollout", async () => {
    const stable = await publishBundle("stable");
    const canary = await publishBundle("canary", { rolloutPercent: 1 });
    const response = await post("/api/v1/previews", admin, { groupId: canary.id, ttlMinutes: 30 });
    expect(response.status).toBe(201);
    const preview = (await response.json()) as { token: string; deepLink: string };
    expect(preview.deepLink).toMatch(/^myapp:\/\/flare-ota\/preview\?token=/);
    expect((await check({ "flare-preview": preview.token, "eas-client-id": crypto.randomUUID() })).json.id).toBe(canary.updates[0]!.id);
    // Without the header the same device stays on the channel's choice.
    expect((await check({ "expo-current-update-id": stable.updates[0]!.id })).json.type).toBe("noUpdateAvailable");
  });

  it("ignores tampered and revoked tokens", async () => {
    const stable = await publishBundle("stable");
    const other = await publishBundle("other", { rolloutPercent: 1 });
    const { token } = (await (await post("/api/v1/previews", admin, { groupId: other.id })).json()) as { token: string };
    const [body] = token.split(".");
    const forged = `${body}.${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    expect((await check({ "flare-preview": forged })).json.id).toBe(stable.updates[0]!.id);
    h.db.raw.exec("UPDATE previews SET revoked_at = '2000-01-01'");
    expect((await check({ "flare-preview": token })).json.id).toBe(stable.updates[0]!.id);
  });
});

describe("tokens and scopes", () => {
  it("rejects missing, unknown and revoked tokens", async () => {
    expect((await h.fetch("/api/v1/overview")).status).toBe(401);
    expect((await h.fetch("/api/v1/overview", { headers: bearer(`fota_${"x".repeat(43)}`) })).status).toBe(401);
    const created = (await (await post("/api/v1/tokens", admin, { name: "temp", scope: "read" })).json()) as { id: string; token: string };
    expect((await h.fetch("/api/v1/overview", { headers: bearer(created.token) })).status).toBe(200);
    expect((await h.fetch(`/api/v1/tokens/${created.id}`, { method: "DELETE", headers: bearer(admin) })).status).toBe(200);
    expect((await h.fetch("/api/v1/overview", { headers: bearer(created.token) })).status).toBe(401);
  });

  it("keeps each scope to its job", async () => {
    const reader = await h.token("read");
    const group = await publishBundle("x");
    expect((await post("/api/v1/assets/missing", reader, { hashes: [] })).status).toBe(403);
    expect((await post(`/api/v1/groups/${group.id}/rollout`, publisher, { percent: 100 })).status).toBe(403);
    expect((await post("/api/v1/tokens", publisher, { name: "escalate", scope: "admin" })).status).toBe(403);
    expect((await h.fetch("/api/v1/metrics", { headers: bearer(reader) })).status).toBe(200);
  });

  it("stores only token digests", async () => {
    const { token } = (await (await post("/api/v1/tokens", admin, { name: "ci", scope: "publish" })).json()) as { token: string };
    const rows = h.db.raw.prepare("SELECT hash FROM tokens").all() as { hash: string }[];
    expect(rows.some((r) => r.hash.includes(token) || token.includes(r.hash))).toBe(false);
  });

  it("records every mutation in the audit log with its actor", async () => {
    const group = await publishBundle("x", { rolloutPercent: 10 });
    await post(`/api/v1/groups/${group.id}/rollout`, admin, { percent: 50 });
    const log = (await (await h.fetch("/api/v1/audit", { headers: bearer(admin) })).json()) as { actor: string; action: string }[];
    expect(log.map((e) => `${e.action}:${e.actor}`)).toEqual(["rollout:token:ops", "publish:token:ci"]);
  });
});

describe("devices and metrics", () => {
  it("tracks adoption and launch failures per update", async () => {
    const group = await publishBundle("x");
    const updateId = group.updates[0]!.id;
    const app = (await import("../src/app.ts")).createApp();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {}, props: {} };
    const send = (headers: Record<string, string>) =>
      app.fetch(new Request("https://ota.test/manifest", { headers: manifestHeaders(headers) }), h.env, ctx as never);
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await send({ "eas-client-id": a });
    await send({ "eas-client-id": b, "expo-current-update-id": updateId });
    await send({ "eas-client-id": crypto.randomUUID(), "expo-recent-failed-update-ids": `"${updateId}"` });
    await send({ "eas-client-id": "not-a-uuid" });
    await Promise.all(waits);
    const metrics = (await (await h.fetch("/api/v1/metrics?branch=production", { headers: bearer(admin) })).json()) as Record<string, number>[];
    expect(metrics[0]).toMatchObject({ served: 1, running: 1, failed: 1, population: 3 });
  });
});

describe("mcp", () => {
  const rpc = (token: string, method: string, params: Record<string, unknown> = {}, id: number | null = 1) =>
    h.fetch("/mcp", { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }) });

  it("requires a token and lists only the tools the scope allows", async () => {
    expect((await h.fetch("/mcp", { method: "POST", body: "{}" })).status).toBe(401);
    const init = (await (await rpc(admin, "initialize", { protocolVersion: "2025-06-18" })).json()) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const reader = await h.token("read");
    const tools = (await (await rpc(reader, "tools/list")).json()) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((t) => t.name)).not.toContain("rollback");
    expect(tools.result.tools.map((t) => t.name)).toContain("get_metrics");
  });

  it("runs admin tools and refuses them to read tokens", async () => {
    const group = await publishBundle("x", { rolloutPercent: 10 });
    const ok = (await (await rpc(admin, "tools/call", { name: "set_rollout", arguments: { groupId: group.id, percent: 40 } })).json()) as { result: { isError?: boolean } };
    expect(ok.result.isError).toBeUndefined();
    const reader = await h.token("read");
    const denied = (await (await rpc(reader, "tools/call", { name: "set_rollout", arguments: { groupId: group.id, percent: 90 } })).json()) as { result: { isError: boolean } };
    expect(denied.result.isError).toBe(true);
    expect((await rpc(admin, "notifications/initialized", {}, null)).status).toBe(202);
  });
});

describe("dashboard", () => {
  it("is refused without a valid Cloudflare Access assertion", async () => {
    expect((await h.fetch("/", { host: "admin.test" })).status).toBe(403);
    expect((await h.fetch("/", { host: "admin.test", headers: { "cf-access-jwt-assertion": "a.b.c" } })).status).toBe(403);
  });

  it("verifies Access JWTs: signature, audience, issuer and expiry", async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    const fetcher = (async () => Response.json({ keys: [{ ...jwk, kid: "k1" }] })) as unknown as typeof fetch;
    const env = { ...h.env, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud-1" };
    const sign = async (claims: Record<string, unknown>) => {
      const head = base64url(utf8(JSON.stringify({ alg: "RS256", kid: "k1" })));
      const body = base64url(utf8(JSON.stringify(claims)));
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, utf8(`${head}.${body}`)));
      return `${head}.${body}.${base64url(sig)}`;
    };
    const good = { aud: ["aud-1"], iss: "https://team.cloudflareaccess.com", exp: Date.now() / 1000 + 60, email: "dev@example.com" };
    const withJwt = async (claims: Record<string, unknown>) =>
      accessIdentity(new Request("https://admin.test/", { headers: { "cf-access-jwt-assertion": await sign(claims) } }), env, fetcher);
    expect(await withJwt(good)).toBe("dev@example.com");
    expect(await withJwt({ ...good, aud: ["other"] })).toBeNull();
    expect(await withJwt({ ...good, iss: "https://evil.cloudflareaccess.com" })).toBeNull();
    expect(await withJwt({ ...good, exp: Date.now() / 1000 - 1 })).toBeNull();
  });

  it("renders for an authenticated user and refuses cross-origin form posts", async () => {
    const local = await harness({ INSECURE_DASHBOARD: "1" });
    const page = await local.fetch("/", { host: "admin.test" });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const forged = await local.fetch("/actions/channel", {
      host: "admin.test",
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" },
      body: "channel=production&branch=evil",
    });
    expect(forged.status).toBe(403);
    const nullOrigin = await local.fetch("/actions/channel", {
      host: "admin.test",
      method: "POST",
      headers: { origin: "null", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" },
      body: "channel=production&branch=evil",
    });
    expect(nullOrigin.status).toBe(403);
  });

  it("shows the app's name and icon from its latest publish", async () => {
    const local = await harness({ INSECURE_DASHBOARD: "1" });
    const ci = await local.token("publish");
    const icon = utf8("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const hash = await assetHash(icon);
    await local.fetch(`/api/v1/assets/${hash}`, { method: "PUT", headers: { ...bearer(ci), "content-type": "image/svg+xml", "content-length": String(icon.length) }, body: icon });
    const ios = await uploadBundle(local, ci, "app");
    const appIcon = { hash, key: "k", contentType: "image/svg+xml", fileExtension: ".svg" };
    expect((await publish(local, ci, { branch: "production", message: "x", expoConfig: { name: "Acme Pay", version: "2.4.0" }, appIcon, updates: { ios } })).status).toBe(201);
    const html = await (await local.fetch("/", { host: "admin.test" })).text();
    expect(html).toContain("Acme Pay");
    const served = await local.fetch("/_app/icon", { host: "admin.test" });
    expect(served.headers.get("content-type")).toBe("image/svg+xml");
    expect(served.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await publish(local, ci, { branch: "production", message: "y", appIcon: { ...appIcon, contentType: "text/html" }, updates: { ios } })).status).toBe(400);
  });

  it("shows what a rollback would do before doing it", async () => {
    const local = await harness({ INSECURE_DASHBOARD: "1" });
    const ci = await local.token("publish");
    for (const message of ["Good build", "Bad build"]) {
      const ios = await uploadBundle(local, ci, message);
      await publish(local, ci, { branch: "production", message, updates: { ios } });
    }
    const confirm = await local.fetch("/confirm/rollback?branch=production&to=previous", { host: "admin.test" });
    const html = await confirm.text();
    expect(html).toContain("Good build");
    expect(html).toContain("Roll back now");
    const groups = local.db.raw.prepare("SELECT COUNT(*) AS n FROM update_groups").get() as { n: number };
    expect(groups.n).toBe(2);
  });

  it("accepts a same-site form post even when the browser withholds Origin", async () => {
    const local = await harness({ INSECURE_DASHBOARD: "1" });
    const post = await local.fetch("/actions/channel", {
      host: "admin.test",
      method: "POST",
      headers: { origin: "null", "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: "channel=beta&branch=staging",
    });
    expect(post.status).toBe(303);
    expect((await local.fetch("/", { host: "admin.test" })).headers.get("referrer-policy")).toBe("same-origin");
  });
});

describe("garbage collection", () => {
  it("deletes unreferenced assets and keeps the ones live updates need", async () => {
    await publishBundle("live");
    const orphan = await uploadBundle(h, publisher, "orphan");
    h.db.raw.exec("UPDATE assets SET touched_at = '2000-01-01T00:00:00.000Z', created_at = '2000-01-01T00:00:00.000Z'");
    const response = await post("/api/v1/gc", admin);
    expect(await response.json()).toMatchObject({ assets: 2 });
    expect(h.bucket.objects.has(`assets/${orphan.launchAsset.hash}`)).toBe(false);
    expect((await check()).json.launchAsset).toBeDefined();
  });
});

describe("device write budget", () => {
  it("does not rewrite an unchanged device on every check", async () => {
    const group = await publishBundle("x");
    const client = crypto.randomUUID();
    const { Store } = await import("../src/store.ts");
    const store = new Store(h.db);
    const device = {
      clientId: client, platform: "ios" as const, runtimeVersion: "rt-1", channel: "production",
      currentUpdateId: group.updates[0]!.id, embeddedUpdateId: null, servedUpdateId: null, appVersion: null, country: null, failedUpdateIds: [], fatalError: null,
    };
    expect(await store.recordCheck(device)).toBe(true);
    expect(await store.recordCheck(device)).toBe(false);
    expect(await store.recordCheck({ ...device, currentUpdateId: null })).toBe(true);
  });
});
