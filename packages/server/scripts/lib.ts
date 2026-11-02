// Shared helpers for the replayable setup scripts. Every script reads its stage from
// `--stage <name>` (default production) and loads `<repo>/.env.<stage>` when it exists.
// Secrets are read from the environment only; nothing secret is written to the repo.

import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify, type ParseArgsConfig } from "node:util";

export const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = join(SERVER_DIR, "..", "..");

const APP_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** Settings file of one app's stage: `.env.<stage>` for the default app, `.env.<app>.<stage>` otherwise. */
export function envFileFor(app: string | undefined, stage: string): string {
  return join(REPO_DIR, app ? `.env.${app}.${stage}` : `.env.${stage}`);
}

/**
 * Reads `--stage <name>` (default production) and `--app <name>`, then loads that app's stage
 * settings. One server serves one app: `--app` picks the Worker name (FLARE_OTA_NAME), the
 * settings file, the certificate folder and the keychain entries, so several apps can share a
 * clone and a Cloudflare account without colliding.
 */
export function stageArgs(extra: NonNullable<ParseArgsConfig["options"]> = {}) {
  const { values } = parseArgs({
    options: { stage: { type: "string", default: "production" }, app: { type: "string" }, ...extra },
    allowPositionals: true,
    strict: false,
  });
  const stage = String(values.stage);
  if (!/^[a-z][a-z0-9-]{0,20}$/.test(stage)) throw new Error("--stage must be a short lowercase name");
  const app = typeof values.app === "string" ? values.app : undefined;
  if (app !== undefined && !APP_NAME.test(app)) throw new Error("--app must be a short lowercase name (letters, digits, -)");
  if (app) process.env.FLARE_OTA_NAME = app;
  const envFile = envFileFor(app, stage);
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (app) process.env.FLARE_OTA_NAME = app;
  /** Arguments that make a child script target the same app and stage. */
  const forward = ["--stage", stage, ...(app ? ["--app", app] : [])];
  return { stage, app, envFile, values, forward };
}

export function env(key: string): string | undefined {
  return process.env[key]?.trim() || undefined;
}

export function requireEnv(key: string, hint = ""): string {
  const value = env(key);
  if (!value) throw new Error(`${key} is not set.${hint ? ` ${hint}` : ""} See .env.example.`);
  return value;
}

/** The Worker name for a stage, as cloudflare.config.ts computes it. */
export function workerName(stage: string): string {
  const base = env("FLARE_OTA_NAME") ?? "flare-ota";
  return stage === "production" ? base : `${base}-${stage}`;
}

const exec = promisify(execFile);

/** Runs the project's cf CLI and returns stdout. CLOUDFLARE_ACCOUNT_ID selects the account. */
export async function cf(args: string[], options: { cwd?: string } = {}): Promise<string> {
  try {
    const { stdout } = await exec("npx", ["--no-install", "cf", ...args], { cwd: options.cwd ?? SERVER_DIR, maxBuffer: 32 * 1024 * 1024, env: process.env });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message: string };
    throw new Error(`cf ${args[0]} ${args[1] ?? ""} failed:\n${(e.stderr || e.stdout || e.message).trim()}`);
  }
}

/** cf prints JSON for API commands; some wrap it as { result }. */
export async function cfJson<T = any>(args: string[]): Promise<T> {
  const out = (await cf(args)).trim();
  const start = out.search(/[[{]/);
  const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
  return (parsed && typeof parsed === "object" && "result" in parsed && !Array.isArray(parsed) ? parsed.result : parsed) as T;
}

/** Streams a cf command to the terminal (deploys, migrations). */
export function cfLive(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--no-install", "cf", ...args], { cwd: SERVER_DIR, stdio: "inherit", env: process.env });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cf ${args.join(" ")} exited with ${code}`))));
  });
}

export async function databaseId(name: string): Promise<string | null> {
  const list = await cfJson<{ uuid: string; name: string }[]>(["d1", "list", "--name", name]);
  return list.find((db) => db.name === name)?.uuid ?? null;
}

export async function ensureDatabase(name: string): Promise<string> {
  const existing = await databaseId(name);
  if (existing) return existing;
  const created = await cfJson<{ uuid: string }>(["d1", "create", "--name", name]);
  console.log(`Created D1 database ${name}`);
  return created.uuid;
}

/** R2 must be enabled once per account (dashboard → R2); cf cannot do that step. */
export async function ensureBucket(name: string): Promise<void> {
  let buckets: { name: string }[];
  try {
    const listed = await cfJson<{ buckets?: { name: string }[] } | { name: string }[]>(["r2", "buckets", "list"]);
    buckets = Array.isArray(listed) ? listed : (listed.buckets ?? []);
  } catch (error) {
    if (/enable R2/i.test((error as Error).message)) {
      throw new Error("R2 is not enabled on this account. Open the Cloudflare dashboard → R2 Object Storage → enable it (the free tier covers 10 GB), then rerun.");
    }
    throw error;
  }
  if (buckets.some((b) => b.name === name)) return;
  await cf(["r2", "buckets", "create", "--name", name]);
  console.log(`Created R2 bucket ${name}`);
}

export async function zoneFor(hostname: string): Promise<{ id: string; name: string }> {
  const parts = hostname.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    const zones = await cfJson<{ id: string; name: string }[]>(["zones", "list", "--name", candidate]);
    const zone = zones.find((z) => z.name === candidate);
    if (zone) return zone;
  }
  throw new Error(`No zone in this account contains ${hostname}.`);
}

/**
 * Writes secrets to a private temporary file for `cf deploy --secrets-file`, and always removes
 * it. cf cannot read secrets from stdin yet; this keeps them out of argv and out of the repo.
 */
export async function withSecretsFile<T>(secrets: Record<string, string>, run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "flare-ota-secrets-"));
  const path = join(dir, "secrets.json");
  try {
    await writeFile(path, JSON.stringify(secrets), { mode: 0o600 });
    await chmod(path, 0o600);
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Sets KEY=value in a stage env file (non-secret values only), keeping the rest. */
export async function upsertEnvFile(path: string, values: Record<string, string>): Promise<void> {
  let text = existsSync(path) ? await readFile(path, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    text = new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  await writeFile(path, text);
}

export const KEYCHAIN_ACCOUNT = "flare-ota";

/** Keychain service name of one secret of one app's stage, e.g. flare-ota.myapp.admin-token. */
export const keychainService = (stage: string, what: string) => `flare-ota.${workerName(stage)}.${what}`;

export function keychainRead(service: string): string | null {
  if (platform() !== "darwin") return null;
  const result = spawnSync("security", ["find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT, "-w"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Stores a secret in the macOS login keychain without putting it in argv (via `security -i`). */
export function keychainWrite(service: string, value: string) {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) throw new Error("keychain values must be base64/base64url");
  const result = spawnSync("security", ["-i"], { input: `add-generic-password -U -s ${service} -a ${KEYCHAIN_ACCOUNT} -w ${value}\n`, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`security failed: ${result.stderr}`);
  if (keychainRead(service) !== value) throw new Error(`Could not read ${service} back from the keychain.`);
}

/**
 * Hands a newly created secret to the user. On macOS it goes to the login keychain and only the
 * command that reads it back is printed, so the value never lands in a terminal log or an agent
 * transcript. `--print` (or another OS) prints it once instead.
 */
export function deliverSecret(options: { service: string; label: string; print: boolean; value: string; usage: string }) {
  if (platform() === "darwin" && !options.print) {
    keychainWrite(options.service, options.value);
    console.log(
      `${options.label} stored in the macOS keychain as "${options.service}" (account ${KEYCHAIN_ACCOUNT}); it is not printed.\n` +
        `  Use it:    ${options.usage.replace("$SECRET", `"$(security find-generic-password -s ${options.service} -a ${KEYCHAIN_ACCOUNT} -w)"`)}\n` +
        `  Back up:   security find-generic-password -s ${options.service} -a ${KEYCHAIN_ACCOUNT} -w | pbcopy   (then paste into your password manager)`,
    );
    return;
  }
  console.log(`${options.label} (store it now in your password manager; it is not shown again):\n\n${options.value}\n`);
}

export function step(title: string) {
  console.log(`\n▸ ${title}`);
}
