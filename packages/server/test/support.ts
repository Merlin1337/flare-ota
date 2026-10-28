// In-memory doubles for the Worker bindings: node:sqlite runs the real migrations as D1,
// a Map stands in for R2 (with the same SHA-256 integrity check), and WebCrypto keys stand in
// for the signing key and Cloudflare Access.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { base64url, hex, randomToken, sha256, utf8 } from "@flare-ota/core";
import { createApp } from "../src/app.ts";
import { hashToken } from "../src/auth.ts";
import type { D1Database, D1PreparedStatement, D1Result, Env, R2Bucket } from "../src/env.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

class Statement implements D1PreparedStatement {
  constructor(private readonly db: DatabaseSync, private readonly sql: string, private readonly params: unknown[] = []) {}
  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values);
  }
  private values() {
    return this.params.map((v) => (v === undefined ? null : v)) as (string | number | null)[];
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.values()) as T) ?? null;
  }
  async all<T>(): Promise<D1Result<T>> {
    return { results: this.db.prepare(this.sql).all(...this.values()) as T[], meta: {} };
  }
  async run(): Promise<D1Result<unknown>> {
    if (/\bRETURNING\b/i.test(this.sql)) return this.all();
    const info = this.db.prepare(this.sql).run(...this.values());
    return { results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

export function memoryD1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const out: D1Result<unknown>[] = [];
        for (const statement of statements) out.push(await statement.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export function memoryR2(): R2Bucket & { objects: Map<string, { bytes: Uint8Array; contentType?: string }> } {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    objects,
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: new Blob([object.bytes as Uint8Array<ArrayBuffer>]).stream(),
        size: object.bytes.length,
        httpMetadata: object.contentType ? { contentType: object.contentType } : {},
      };
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.bytes.length } : null;
    },
    async put(key, value, options) {
      const bytes = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : new Uint8Array(value as ArrayBuffer);
      if (options?.sha256 && hex(await sha256(bytes as Uint8Array<ArrayBuffer>)) !== options.sha256) throw new Error("sha256 mismatch");
      objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
      return {};
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
}

export async function rsaPem() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, "$1\n");
  return { pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

export async function assetHash(bytes: Uint8Array<ArrayBuffer>) {
  return base64url(await sha256(bytes));
}

export interface Harness {
  env: Env;
  db: ReturnType<typeof memoryD1>;
  bucket: ReturnType<typeof memoryR2>;
  publicKey: CryptoKey;
  fetch(path: string, init?: RequestInit & { host?: string }): Promise<Response>;
  token(scope: "read" | "publish" | "admin", name?: string): Promise<string>;
}

export async function harness(overrides: Partial<Env> = {}): Promise<Harness> {
  const db = memoryD1();
  const bucket = memoryR2();
  const { pem, publicKey } = await rsaPem();
  const env: Env = { DB: db, BUCKET: bucket, SIGNING_KEY: pem, PREVIEW_SECRET: randomToken(), APP_SCHEME: "myapp", DASHBOARD_HOST: "admin.test", ...overrides };
  const app = createApp();
  return {
    env,
    db,
    bucket,
    publicKey,
    fetch(path, init = {}) {
      const { host = "ota.test", ...rest } = init;
      return Promise.resolve(app.fetch(new Request(`https://${host}${path}`, rest), env));
    },
    async token(scope, name = `${scope}-token`) {
      const token = `fota_${randomToken(32)}`;
      db.raw.prepare("INSERT INTO tokens (id, name, hash, scope, created_at) VALUES (?, ?, ?, ?, ?)").run(crypto.randomUUID(), name, await hashToken(token), scope, new Date().toISOString());
      return token;
    },
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Uploads a fake bundle and one image, returns the platform update payload. */
export async function uploadBundle(h: Harness, token: string, source: string, runtimeVersion = "rt-1") {
  const bundle = utf8(source);
  const image = utf8(`png:${source}`);
  const refs = [];
  for (const [bytes, contentType, ext] of [[bundle, "application/javascript", ".bundle"], [image, "image/png", ".png"]] as const) {
    const hash = await assetHash(bytes);
    const response = await h.fetch(`/api/v1/assets/${hash}`, {
      method: "PUT",
      headers: { ...bearer(token), "content-type": contentType, "content-length": String(bytes.length) },
      body: bytes,
    });
    if (!response.ok) throw new Error(`upload failed: ${response.status} ${await response.text()}`);
    refs.push({ hash, key: hex(await sha256(bytes)), contentType, fileExtension: ext });
  }
  return { runtimeVersion, launchAsset: refs[0]!, assets: [refs[1]!] };
}

export async function publish(h: Harness, token: string, body: Record<string, unknown>) {
  return h.fetch("/api/v1/groups", { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function manifestHeaders(extra: Record<string, string> = {}) {
  return {
    "expo-protocol-version": "1",
    "expo-platform": "ios",
    "expo-runtime-version": "rt-1",
    "expo-channel-name": "production",
    "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
    ...extra,
  };
}

/** Splits a multipart/mixed protocol response into its named parts. */
export async function parseMultipart(response: Response) {
  const boundary = /boundary=([^;]+)/.exec(response.headers.get("content-type") ?? "")?.[1];
  if (!boundary) throw new Error(`not multipart: ${response.status} ${response.headers.get("content-type")}`);
  const text = await response.text();
  const parts: Record<string, { headers: Record<string, string>; body: string }> = {};
  for (const chunk of text.split(`--${boundary}`).slice(1, -1)) {
    const [head, ...rest] = chunk.replace(/^\r\n/, "").split("\r\n\r\n");
    const headers = Object.fromEntries(head!.split("\r\n").map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
    const name = /name="([^"]+)"/.exec(headers["content-disposition"] ?? "")![1]!;
    parts[name] = { headers, body: rest.join("\r\n\r\n").replace(/\r\n$/, "") };
  }
  return parts;
}

export async function verifySignature(publicKey: CryptoKey, header: string, body: string) {
  const sig = /sig="([^"]+)"/.exec(header)![1]!;
  const bytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, bytes, utf8(body));
}
