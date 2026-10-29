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
import { recorder } from "../src/ui.ts";

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
  it("checks, uploads only missing files, publishes, and the server serves a signed manifest", async () => {
    const admin = await h.token("publish", "ci");
    const client = new Client({ server: base, token: admin });
    const tools = {
      expoConfig: async () => ({ name: "demo", version: "1.2.0", sdkVersion: "58.0.0", updates: { url: `${base}/manifest` } }),
      exportBundles: async (_cwd: string, _platforms: unknown, out: string) => fakeExport(out, "console.log('v1')"),
      runtimeVersion: async () => "rt-1",
      gitCommit: async () => "abcdef1",
    };
    const steps = recorder();
    const { group, uploaded, devices, dashboardUrl } = await publishUpdate(client, { projectDir: ".", branch: "production", message: "v1", platforms: ["ios"], rolloutPercent: 100, tools, reporter: steps });
    expect(group.updates[0]).toMatchObject({ platform: "ios", runtimeVersion: "rt-1" });
    expect(uploaded).toEqual({ files: 2, bytes: "console.log('v1')".length + "png-bytes".length, reused: 0 });
    expect(devices).toEqual({ ios: 0 });
    expect(dashboardUrl).toBe(`https://admin.test/groups/${group.id}`);
    expect(steps.lines.map((l) => l.split(":")[0])).toEqual(["✓ App config", "✓ Server", "✓ Code signing", "! The app has no codeSigningCertificate", "✓ Export", "✓ Runtime", "✓ Upload", "✓ Publish"]);
    expect(steps.lines[0]).toContain("demo 1.2.0");
    // Same content again: nothing to upload, and a branch no channel serves is called out.
    const again = recorder();
    const second = await publishUpdate(client, { projectDir: ".", branch: "nightly", message: "again", platforms: ["ios"], rolloutPercent: 100, tools, reporter: again });
    expect(second.uploaded).toMatchObject({ files: 0, reused: 2 });
    expect(again.lines.some((l) => l.startsWith("! No channel serves nightly"))).toBe(true);

    const response = await fetch(`${base}/manifest`, { headers: manifestHeaders() });
    const parts = await parseMultipart(response);
    expect(await verifySignature(h.publicKey, parts.manifest!.headers["expo-signature"]!, parts.manifest!.body)).toBe(true);
    expect(JSON.parse(parts.manifest!.body).id).toBe(group.updates[0]!.id);
  });

  it("stops before exporting when the token cannot publish", async () => {
    const client = new Client({ server: base, token: await h.token("read", "viewer") });
    let exported = false;
    const tools = {
      expoConfig: async () => ({ updates: { url: `${base}/manifest` } }),
      exportBundles: async () => {
        exported = true;
      },
    };
    const steps = recorder();
    await expect(publishUpdate(client, { projectDir: ".", branch: "production", message: "x", platforms: ["ios"], rolloutPercent: 100, tools, reporter: steps })).rejects.toThrow(/read scope/);
    expect(exported).toBe(false);
    expect(steps.lines.at(-1)).toMatch(/^✗ Server/);
  });

  it("sends the app icon so the dashboard can show the app", async () => {
    const project = await mkdtemp(join(tmpdir(), "flare-icon-"));
    await mkdir(join(project, "assets"), { recursive: true });
    await writeFile(join(project, "assets/icon.png"), "png-icon-bytes");
    const client = new Client({ server: base, token: await h.token("publish", "icon") });
    const tools = {
      expoConfig: async () => ({ name: "Acme", version: "2.4.0", icon: "./assets/icon.png", ios: { bundleIdentifier: "com.acme.app" }, updates: { url: `${base}/manifest` } }),
      exportBundles: async (_cwd: string, _platforms: unknown, out: string) => fakeExport(out, "console.log('icon')"),
      runtimeVersion: async () => "rt-1",
      gitCommit: async () => undefined,
    };
    await publishUpdate(client, { projectDir: project, branch: "production", message: "with icon", platforms: ["ios"], rolloutPercent: 100, tools });
    const { Store } = await import("../../server/src/store.ts");
    const identity = await new Store(h.env.DB).appIdentity();
    expect(identity).toMatchObject({ name: "Acme", version: "2.4.0", iosBundleId: "com.acme.app" });
    expect(h.bucket.objects.get(`assets/${identity.iconHash}`)?.contentType).toBe("image/png");
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
