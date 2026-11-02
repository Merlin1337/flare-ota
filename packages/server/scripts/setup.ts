// Guided first deployment of one stage of one app. Safe to rerun: every step reuses what exists.
//   pnpm server:setup --stage production [--app myapp]
//
// One server serves one app. For a second app, run setup again with another --app: it gets its
// own Worker, database, bucket, settings file (.env.<app>.<stage>), certificate and keychain entries.
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
import { createInterface } from "node:readline";
import { cfJson, env, keychainRead, keychainService, keychainWrite, stageArgs, step, upsertEnvFile, workerName, SERVER_DIR } from "./lib.ts";

const parsed = stageArgs();
const { stage } = parsed;
const { app, envFile, forward } = parsed;
// Lines are queued as they arrive, so piped answers (CI, agents) are never lost between prompts.
const rl = createInterface({ input: process.stdin });
const pending: string[] = [];
const waiters: ((line: string | null) => void)[] = [];
let closed = false;
rl.on("line", (line) => (waiters.length ? waiters.shift()!(line) : pending.push(line)));
rl.on("close", () => {
  closed = true;
  while (waiters.length) waiters.shift()!(null);
});

async function prompt(question: string): Promise<string | null> {
  process.stdout.write(question);
  if (pending.length) return pending.shift()!;
  if (closed) return null;
  return new Promise((resolve) => waiters.push(resolve));
}

async function ask(key: string, question: string, fallback?: string): Promise<string> {
  const current = env(key) ?? fallback;
  const line = await prompt(`${question}${current ? ` [${current}]` : ""}: `);
  const answer = line?.trim() || current || "";
  if (!answer) {
    if (line === null) throw new Error(`No value for ${key}: set it in the environment or ${envFile}.`);
    return ask(key, question, fallback);
  }
  process.stdout.write(line === null ? "\n" : "");
  process.env[key] = answer;
  return answer;
}

function run(script: string, extra: string[] = []) {
  const result = spawnSync("node", [join(SERVER_DIR, "scripts", script), ...forward, ...extra], { stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${script} failed`);
}

console.log(`flare-ota setup for ${workerName(stage)}, stage "${stage}" (settings in ${envFile})\n`);
step("Settings");
// The account comes from the Cloudflare login (OAuth): one account is picked automatically,
// several are offered as a numbered list. Nobody copies an ID or an API key by hand.
if (!env("CLOUDFLARE_ACCOUNT_ID")) {
  let accounts: { id: string; name: string }[] = [];
  try {
    accounts = await cfJson<{ id: string; name: string }[]>(["accounts", "list"]);
  } catch {
    throw new Error("Not logged in to Cloudflare: run `npx cf auth login` (it opens your browser), then rerun setup.");
  }
  if (accounts.length === 0) throw new Error("This Cloudflare login has no account.");
  let account = accounts[0]!;
  if (accounts.length > 1) {
    accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.name}  ${a.id}`));
    const choice = Number(((await prompt(`Which account hosts the server? [1-${accounts.length}]: `)) ?? "").trim());
    if (!Number.isInteger(choice) || choice < 1 || choice > accounts.length) throw new Error("Pick an account by its number.");
    account = accounts[choice - 1]!;
  }
  process.env.CLOUDFLARE_ACCOUNT_ID = account.id;
  console.log(`Cloudflare account: ${account.name}`);
}
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
if (app) settings.FLARE_OTA_NAME = app;
await upsertEnvFile(envFile, settings);
console.log(`Saved to ${envFile}.`);

step("Signing key, certificate and preview secret");
const keyService = keychainService(stage, "signing-key-b64");
const previewService = keychainService(stage, "preview-secret");
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
  // expo-updates rejects certificates without the codeSigning extended key usage.
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-new", "-key", "/dev/stdin", "-sha256", "-days", "3650", "-subj", `/CN=${scheme} updates`,
      "-addext", "keyUsage=critical,digitalSignature", "-addext", "extendedKeyUsage=critical,codeSigning", "-out", certPath,
    ],
    { input: signingKey },
  );
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
// On macOS the token goes to the keychain and is never printed (bootstrap-token --print to show it).
run("bootstrap-token.ts", ["--name", me]);

const waf = ((await prompt("\nApply the recommended WAF rules on the zone now? [Y/n]: ")) ?? "").trim().toLowerCase();
if (waf !== "n" && waf !== "no") run("waf.ts");

step("Health check");
run("doctor.ts");
rl.close();
console.log(`\nDone. Next: in your Expo app run
  FLARE_OTA_URL=https://${updatesHost} npx flare-ota init --channel ${stage}
then build a new binary. On macOS, deploy again later with:
  FLARE_OTA_SIGNING_KEY="$(security find-generic-password -s ${keyService} -a flare-ota -w | base64 -d)" \\
  FLARE_OTA_PREVIEW_SECRET="$(security find-generic-password -s ${previewService} -a flare-ota -w)" \\
  pnpm server:deploy ${forward.join(" ")}`);
