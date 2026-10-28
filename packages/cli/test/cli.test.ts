// The CLI against the real server app (in-memory bindings), over real HTTP on localhost.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harness, manifestHeaders, parseMultipart, verifySignature, type Harness } from "../../server/test/support.ts";
import { Client } from "../src/api.ts";
import { signedPart } from "../src/doctor.ts";
import { init } from "../src/init.ts";
import { publishUpdate, readExport } from "../src/publish.ts";
import { terminalQr } from "../src/qr.ts";

let h: Harness;
let server: Server;
let base: string;

beforeAll(async () => {
  h = await harness();
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const response = await h.fetch(req.url!, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")) as Record<string, string>,
      ...(body && req.method !== "GET" ? { body } : {}),
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => server.close());

async function fakeExport(dir: string, source: string) {
  await mkdir(join(dir, "_expo/static/js/ios"), { recursive: true });
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "_expo/static/js/ios/index.hbc"), source);
  await writeFile(join(dir, "assets/abc"), "png-bytes");
  await writeFile(join(dir, "assets/def"), "png-bytes"); // same bytes: deduplicated
  await writeFile(
    join(dir, "metadata.json"),
    JSON.stringify({ fileMetadata: { ios: { bundle: "_expo/static/js/ios/index.hbc", assets: [{ path: "assets/abc", ext: "png" }, { path: "assets/def", ext: "png" }] } } }),
  );
}

describe("readExport", () => {
  it("content-addresses the bundle and deduplicates assets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flare-export-"));
    await fakeExport(dir, "bundle");
    const { files, perPlatform } = await readExport(dir, ["ios"]);
    expect(files.size).toBe(2);
    expect(perPlatform.ios!.launchAsset).toMatchObject({ contentType: "application/javascript", fileExtension: ".bundle" });
    expect(perPlatform.ios!.assets).toHaveLength(1);
    expect(perPlatform.ios!.assets[0]!.hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("publish end to end", () => {
  it("uploads only missing files, publishes, and the server serves a signed manifest", async () => {
    const admin = await h.token("publish", "ci");
    const client = new Client({ server: base, token: admin });
    const tools = {
      expoConfig: async () => ({ name: "demo", updates: { url: `${base}/manifest` } }),
      exportBundles: async (_cwd: string, _platforms: unknown, out: string) => fakeExport(out, "console.log('v1')"),
      runtimeVersion: async () => "rt-1",
      gitCommit: async () => "abcdef1",
    };
    const logs: string[] = [];
    const group = await publishUpdate(client, { projectDir: ".", branch: "production", message: "v1", platforms: ["ios"], rolloutPercent: 100, tools, log: (l) => logs.push(l) });
    expect(group.updates[0]).toMatchObject({ platform: "ios", runtimeVersion: "rt-1" });
    expect(logs).toContain("Uploading 2 of 2 files…");
    // Same content again: nothing to upload.
    const logs2: string[] = [];
    await expect(publishUpdate(client, { projectDir: ".", branch: "staging", message: "again", platforms: ["ios"], rolloutPercent: 100, tools, log: (l) => logs2.push(l) })).resolves.toBeDefined();
    expect(logs2).toContain("Uploading 0 of 2 files…");

    const response = await fetch(`${base}/manifest`, { headers: manifestHeaders() });
    const parts = await parseMultipart(response);
    expect(await verifySignature(h.publicKey, parts.manifest!.headers["expo-signature"]!, parts.manifest!.body)).toBe(true);
    expect(JSON.parse(parts.manifest!.body).id).toBe(group.updates[0]!.id);
  });

  it("refuses to publish to a server the app does not point at", async () => {
    const client = new Client({ server: base, token: await h.token("publish") });
    const tools = { expoConfig: async () => ({ updates: { url: "https://elsewhere.example/manifest" } }) };
    await expect(publishUpdate(client, { projectDir: ".", branch: "production", message: "x", platforms: ["ios"], rolloutPercent: 100, tools })).rejects.toThrow(/updates.url/);
  });
});

describe("init", () => {
  it("writes the updates config and keeps a backup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flare-app-"));
    await writeFile(join(dir, "app.json"), JSON.stringify({ expo: { name: "demo", updates: { requestHeaders: { "x-keep": "1" } } } }));
    const notes = await init({ projectDir: dir, server: "https://ota.example.com", channel: "production", certificate: "./certs/certificate.pem" });
    const app = JSON.parse(await readFile(join(dir, "app.json"), "utf8"));
    expect(app.expo.updates).toMatchObject({
      url: "https://ota.example.com/manifest",
      codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
      requestHeaders: { "x-keep": "1", "expo-channel-name": "production", "flare-preview": "" },
    });
    expect(app.expo.runtimeVersion).toEqual({ policy: "fingerprint" });
    expect(notes.join("\n")).toMatch(/codesigning:generate/);
    expect(notes.join("\n")).toMatch(/scheme/);
  });
});

describe("helpers", () => {
  it("extracts the signed part of a protocol response", async () => {
    const response = await h.fetch("/manifest", { headers: manifestHeaders({ "expo-channel-name": "nope" }) });
    const part = signedPart(response.headers.get("content-type")!, await response.text());
    expect(part?.json).toBe('{"type":"noUpdateAvailable"}');
    expect(part?.header).toMatch(/^sig="/);
  });

  it("renders a rectangular terminal QR code", () => {
    const lines = terminalQr("myapp://flare-ota/preview?token=abc").split("\n");
    expect(new Set(lines.map((l) => [...l].length)).size).toBe(1);
    expect(lines.length).toBeGreaterThan(10);
  });
});
