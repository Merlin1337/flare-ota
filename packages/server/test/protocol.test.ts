import { describe, expect, it } from "vitest";
import { decide, parseFailedUpdateIds, parseManifestRequest, rolloutBucket, type Candidate, type ManifestRequest } from "../src/protocol.ts";
import { pkcs8FromPem } from "../src/signing.ts";

const base = {
  "expo-protocol-version": "1",
  "expo-platform": "ios",
  "expo-runtime-version": "rt-1",
  "expo-channel-name": "production",
};

function request(overrides: Partial<ManifestRequest> = {}): ManifestRequest {
  return {
    platform: "ios",
    runtimeVersion: "rt-1",
    channel: "production",
    currentUpdateId: null,
    embeddedUpdateId: null,
    expectSignature: false,
    clientId: "8f14e45f-ceea-467a-9575-1c4e5e0f1b2a",
    failedUpdateIds: [],
    fatalError: null,
    previewToken: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: crypto.randomUUID(),
    groupId: crypto.randomUUID(),
    branch: "production",
    platform: "ios",
    createdAt: new Date().toISOString(),
    runtimeVersion: "rt-1",
    rolloutPercent: 100,
    paused: false,
    rollbackToEmbedded: false,
    launchAsset: { hash: "a".repeat(43), key: "k", contentType: "application/javascript", fileExtension: ".bundle" },
    assets: [],
    expoConfig: null,
    ...overrides,
  };
}

describe("parseManifestRequest", () => {
  it("accepts a well-formed v1 request", () => {
    const parsed = parseManifestRequest(new Headers({ ...base, "eas-client-id": "8F14E45F-CEEA-467A-9575-1C4E5E0F1B2A" }));
    expect(parsed.ok && parsed.request.clientId).toBe("8f14e45f-ceea-467a-9575-1c4e5e0f1b2a");
  });

  it.each([
    ["protocol 0", { "expo-protocol-version": "0" }],
    ["unknown platform", { "expo-platform": "web" }],
    ["oversized runtime", { "expo-runtime-version": "x".repeat(65) }],
    ["channel with spaces", { "expo-channel-name": "prod uction" }],
  ])("rejects %s", (_, overrides) => {
    expect(parseManifestRequest(new Headers({ ...base, ...overrides })).ok).toBe(false);
  });

  it("drops a client id that is not a UUID instead of storing it", () => {
    const parsed = parseManifestRequest(new Headers({ ...base, "eas-client-id": "x".repeat(5000) }));
    expect(parsed.ok && parsed.request.clientId).toBeNull();
  });

  it("bounds the failed update ids it parses", () => {
    const ids = Array.from({ length: 9 }, () => `"${crypto.randomUUID()}"`).join(", ");
    expect(parseFailedUpdateIds(ids)).toHaveLength(5);
    expect(parseFailedUpdateIds('"not-a-uuid", garbage')).toEqual([]);
    expect(parseFailedUpdateIds(null)).toEqual([]);
  });
});

describe("rolloutBucket", () => {
  it("is deterministic per device and update, and roughly uniform", async () => {
    const update = crypto.randomUUID();
    const client = crypto.randomUUID();
    expect(await rolloutBucket(client, update)).toBe(await rolloutBucket(client, update));
    const buckets = await Promise.all(Array.from({ length: 2000 }, () => rolloutBucket(crypto.randomUUID(), update)));
    const under10 = buckets.filter((b) => b < 10).length;
    expect(under10).toBeGreaterThan(120);
    expect(under10).toBeLessThan(290);
  });
});

describe("decide", () => {
  it("serves the newest update", async () => {
    const newest = candidate();
    expect(await decide([newest, candidate()], request())).toEqual({ type: "manifest", update: newest });
  });

  it("answers no update when the device already runs it", async () => {
    const newest = candidate();
    expect(await decide([newest], request({ currentUpdateId: newest.id }))).toEqual({ type: "none", reason: "already-current" });
  });

  it("falls back to the previous update outside the rollout bucket", async () => {
    const canary = candidate({ rolloutPercent: 1 });
    const stable = candidate();
    let fellBack = 0;
    for (let i = 0; i < 200; i++) {
      const decision = await decide([canary, stable], request({ clientId: crypto.randomUUID() }));
      if (decision.type === "manifest" && decision.update.id === stable.id) fellBack++;
    }
    expect(fellBack).toBeGreaterThan(180);
  });

  it("keeps devices without a client id off partial rollouts", async () => {
    const canary = candidate({ rolloutPercent: 99 });
    expect(await decide([canary], request({ clientId: null }))).toEqual({ type: "none", reason: "rollout-excluded" });
  });

  it("skips paused updates, except for devices already on them", async () => {
    const paused = candidate({ paused: true });
    const stable = candidate();
    expect(await decide([paused, stable], request())).toMatchObject({ type: "manifest", update: { id: stable.id } });
    expect(await decide([paused, stable], request({ currentUpdateId: paused.id }))).toEqual({ type: "none", reason: "already-current" });
  });

  it("never re-offers an update the device reported as failing", async () => {
    const broken = candidate();
    const stable = candidate();
    expect(await decide([broken, stable], request({ failedUpdateIds: [broken.id] }))).toMatchObject({ update: { id: stable.id } });
    expect(await decide([broken], request({ failedUpdateIds: [broken.id] }))).toEqual({ type: "none", reason: "previously-failed" });
  });

  it("sends rollBackToEmbedded until the device runs its embedded bundle", async () => {
    const rollback = candidate({ rollbackToEmbedded: true, launchAsset: null });
    const embedded = crypto.randomUUID();
    expect(await decide([rollback], request({ currentUpdateId: crypto.randomUUID(), embeddedUpdateId: embedded }))).toMatchObject({ type: "rollBackToEmbedded" });
    expect(await decide([rollback], request({ currentUpdateId: embedded, embeddedUpdateId: embedded }))).toEqual({ type: "none", reason: "already-embedded" });
  });
});

describe("pkcs8FromPem", () => {
  it("passes PKCS#8 through and wraps PKCS#1", () => {
    const der = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]);
    const b64 = btoa(String.fromCharCode(...der));
    expect([...pkcs8FromPem(`-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`)]).toEqual([...der]);
    const wrapped = pkcs8FromPem(`-----BEGIN RSA PRIVATE KEY-----\n${b64}\n-----END RSA PRIVATE KEY-----`);
    expect(wrapped[0]).toBe(0x30);
    expect([...wrapped.slice(-der.length)]).toEqual([...der]);
  });
});
