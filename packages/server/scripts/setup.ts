// Guided first deployment of one stage. Safe to rerun: every step reuses what exists.
//   pnpm --filter @flare-ota/server setup -- --stage production
//
// 1. asks for the non-secret settings and saves them to .env.<stage> (gitignored)
// 2. generates the code-signing key in memory and the certificate your app embeds
//    (on macOS the key goes straight into the login keychain; elsewhere into a 0600 file you move
//    to your password manager), plus the preview-link secret
// 3. Cloudflare Access for the dashboard, database + migrations, deploy, first admin token
// 4. optional WAF rules, then a health check

import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { env, stageArgs, step, upsertEnvFile, workerName, SERVER_DIR } from "./lib.ts";

const { stage, envFile } = stageArgs();
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(key: string, question: string, fallback?: string): Promise<string> {
  const current = env(key) ?? fallback;
  const answer = (await rl.question(`${question}${current ? ` [${current}]` : ""}: `)).trim() || current || "";
  if (!answer) return ask(key, question, fallback);
  process.env[key] = answer;
  return answer;
}

const keychainService = (what: string) => `flare-ota.${workerName(stage)}.${what}`;

function keychainRead(service: string): string | null {
  if (platform() !== "darwin") return null;
  const result = spawnSync("security", ["find-generic-password", "-s", service, "-a", "flare-ota", "-w"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Stores a secret in the macOS login keychain without putting it in argv (via `security -i`). */
function keychainWrite(service: string, value: string) {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) throw new Error("keychain values must be base64/base64url");
  const result = spawnSync("security", ["-i"], { input: `add-generic-password -U -s ${service} -a flare-ota -w ${value}\n`, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`security failed: ${result.stderr}`);
  if (keychainRead(service) !== value) throw new Error(`Could not read ${service} back from the keychain.`);
}

function run(script: string, extra: string[] = []) {
  const result = spawnSync("node", [join(SERVER_DIR, "scripts", script), "--stage", stage, ...extra], { stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${script} failed`);
}

console.log(`flare-ota setup for stage "${stage}" (settings in ${envFile})\n`);
step("Settings");
await ask("CLOUDFLARE_ACCOUNT_ID", "Cloudflare account ID (cf accounts list)");
const updatesHost = await ask("FLARE_OTA_UPDATES_HOST", "Updates hostname, on a zone of this account", stage === "production" ? "ota.example.com" : `ota-${stage}.example.com`);
const dashboardHost = await ask("FLARE_OTA_DASHBOARD_HOST", "Dashboard hostname (behind Cloudflare Access)", updatesHost.replace(/^([^.]+)/, "$1-admin"));
await ask("FLARE_OTA_ACCESS_EMAILS", "Emails allowed on the dashboard (comma-separated)");
const scheme = await ask("FLARE_OTA_APP_SCHEME", "Your app's URL scheme (app.json \"scheme\", for preview links)");
const settings: Record<string, string> = {
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID!,
  FLARE_OTA_UPDATES_HOST: updatesHost,
  FLARE_OTA_DASHBOARD_HOST: dashboardHost,
  FLARE_OTA_ACCESS_EMAILS: process.env.FLARE_OTA_ACCESS_EMAILS!,
  FLARE_OTA_APP_SCHEME: scheme,
};
if (env("FLARE_OTA_NAME")) settings.FLARE_OTA_NAME = env("FLARE_OTA_NAME")!;
await upsertEnvFile(envFile, settings);
console.log(`Saved to ${envFile}.`);

step("Signing key, certificate and preview secret");
const keyService = keychainService("signing-key-b64");
const previewService = keychainService("preview-secret");
let signingKey = env("FLARE_OTA_SIGNING_KEY") ?? (keychainRead(keyService) ? Buffer.from(keychainRead(keyService)!, "base64").toString() : null);
const certDir = join(homedir(), ".flare-ota", workerName(stage));
mkdirSync(certDir, { recursive: true, mode: 0o700 });
const certPath = join(certDir, "certificate.pem");
if (!signingKey) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  signingKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  if (platform() === "darwin") {
    keychainWrite(keyService, Buffer.from(signingKey).toString("base64"));
    console.log(`Private key stored in the macOS keychain as "${keyService}" (account flare-ota). Back it up in your password manager:\n  security find-generic-password -s ${keyService} -a flare-ota -w | pbcopy`);
  } else {
    const keyPath = join(certDir, "signing-key.pem");
    writeFileSync(keyPath, signingKey, { mode: 0o600 });
    console.log(`Private key written to ${keyPath} (0600). Move it to your password manager / CI secrets, then delete the file.`);
  }
}
process.env.FLARE_OTA_SIGNING_KEY = signingKey;
if (!existsSync(certPath)) {
  // The key reaches openssl on stdin only; the certificate is public.
  execFileSync("openssl", ["req", "-x509", "-new", "-key", "/dev/stdin", "-sha256", "-days", "3650", "-subj", `/CN=${scheme} updates`, "-out", certPath], { input: signingKey });
}
console.log(`Certificate for your app: ${certPath}\n  copy it to <app>/certs/certificate.pem and commit it (it is public).`);
let preview = env("FLARE_OTA_PREVIEW_SECRET") ?? keychainRead(previewService);
if (!preview) {
  preview = randomBytes(32).toString("base64url");
  if (platform() === "darwin") keychainWrite(previewService, preview);
  else console.log("Set FLARE_OTA_PREVIEW_SECRET in your secrets store to keep preview links valid across deploys (a new one was generated for this run).");
}
process.env.FLARE_OTA_PREVIEW_SECRET = preview;

step("Cloudflare Access");
run("access.ts");
process.loadEnvFile(envFile);

step("Deploy");
run("deploy.ts");

step("First admin token");
const me = env("FLARE_OTA_ACCESS_EMAILS")!.split(",")[0]!.trim();
run("bootstrap-token.ts", ["--name", me]);

const waf = (await rl.question("\nApply the recommended WAF rules on the zone now? [Y/n]: ")).trim().toLowerCase();
if (waf !== "n" && waf !== "no") run("waf.ts");

step("Health check");
run("doctor.ts");
rl.close();
console.log(`\nDone. Next: in your Expo app run
  FLARE_OTA_URL=https://${updatesHost} npx flare-ota init --channel ${stage}
then build a new binary. On macOS, deploy again later with:
  FLARE_OTA_SIGNING_KEY="$(security find-generic-password -s ${keyService} -a flare-ota -w | base64 -d)" \\
  FLARE_OTA_PREVIEW_SECRET="$(security find-generic-password -s ${previewService} -a flare-ota -w)" \\
  pnpm --filter @flare-ota/server deploy -- --stage ${stage}`);
