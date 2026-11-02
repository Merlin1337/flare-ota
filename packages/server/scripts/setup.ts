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
import { cfJson, env, keychainRead, keychainService, keychainWrite, stageArgs, upsertEnvFile, workerName, SERVER_DIR } from "./lib.ts";
import { c, exitCleanly, fail, header, note, ok, question, quietly, row, section, task, warn } from "./ui.ts";

exitCleanly();

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

async function ask(key: string, label: string, hint: string, fallback?: string): Promise<string> {
  const current = env(key) ?? fallback;
  const line = await prompt(question(label, hint, current));
  const answer = line?.trim() || current || "";
  if (!answer) {
    if (line === null) throw new Error(`No value for ${key}: set it in the environment or ${envFile}.`);
    return ask(key, label, hint, fallback);
  }
  // A terminal echoes what the user typed; piped answers (CI, agents) are echoed here instead.
  if (line === null || !process.stdin.isTTY) process.stdout.write(`${answer}\n`);
  process.env[key] = answer;
  return answer;
}

/** Runs another setup script with its output captured (shown only if it fails). */
const script = (name: string, update: (line: string) => void, extra: string[] = []) =>
  quietly("node", [join(SERVER_DIR, "scripts", name), ...forward, ...extra], { update });

/** Runs another setup script in the foreground (it prints something the user must see). */
function foreground(name: string, extra: string[] = []) {
  const result = spawnSync("node", [join(SERVER_DIR, "scripts", name), ...forward, ...extra], { stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${name} failed`);
}

const started = performance.now();

// `npx flare-ota setup` already printed the header.
if (!env("FLARE_OTA_SETUP_WRAPPED")) header("setup", `${workerName(stage)} ${c.dim(`· ${stage}`)}`);
note(`settings in ${envFile}`);

section("Cloudflare");
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
    const nameWidth = Math.max(...accounts.map((a) => a.name.length)) + 3;
    const numberWidth = String(accounts.length).length;
    accounts.forEach((a, i) => process.stdout.write(`    ${c.flame(String(i + 1).padStart(numberWidth))}  ${a.name.padEnd(nameWidth)}${c.dim(a.id)}\n`));
    const line = await prompt(question("Account", "for this server", `1-${accounts.length}`));
    if (line === null || !process.stdin.isTTY) process.stdout.write(`${line ?? ""}\n`);
    const choice = Number((line ?? "").trim());
    if (!Number.isInteger(choice) || choice < 1 || choice > accounts.length) throw new Error("Pick an account by its number.");
    account = accounts[choice - 1]!;
  }
  process.env.CLOUDFLARE_ACCOUNT_ID = account.id;
  ok("Account", account.name);
} else {
  ok("Account", c.dim(env("CLOUDFLARE_ACCOUNT_ID")!));
}

section("Settings");
const updatesHost = await ask("FLARE_OTA_UPDATES_HOST", "Updates host", "devices fetch updates here", stage === "production" ? "ota.example.com" : `ota-${stage}.example.com`);
const dashboardHost = await ask("FLARE_OTA_DASHBOARD_HOST", "Dashboard host", "behind Cloudflare Access", updatesHost.replace(/^([^.]+)/, "$1-admin"));
await ask("FLARE_OTA_ACCESS_EMAILS", "Dashboard emails", "comma-separated");
const scheme = await ask("FLARE_OTA_APP_SCHEME", "App scheme", "app.json \"scheme\", for preview links");
const settings: Record<string, string> = {
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID!,
  FLARE_OTA_UPDATES_HOST: updatesHost,
  FLARE_OTA_DASHBOARD_HOST: dashboardHost,
  FLARE_OTA_ACCESS_EMAILS: process.env.FLARE_OTA_ACCESS_EMAILS!,
  FLARE_OTA_APP_SCHEME: scheme,
};
if (app) settings.FLARE_OTA_NAME = app;
await upsertEnvFile(envFile, settings);

section("Signing");
const keyService = keychainService(stage, "signing-key-b64");
const previewService = keychainService(stage, "preview-secret");
let signingKey = env("FLARE_OTA_SIGNING_KEY") ?? (keychainRead(keyService) ? Buffer.from(keychainRead(keyService)!, "base64").toString() : null);
const certDir = join(homedir(), ".flare-ota", workerName(stage));
mkdirSync(certDir, { recursive: true, mode: 0o700 });
const certPath = join(certDir, "certificate.pem");
let backup: string | null = null;
if (!signingKey) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  signingKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  if (platform() === "darwin") {
    keychainWrite(keyService, Buffer.from(signingKey).toString("base64"));
    ok("Signing key", `new · keychain ${c.dim(keyService)}`);
    backup = `security find-generic-password -s ${keyService} -a flare-ota -w | pbcopy`;
  } else {
    const keyPath = join(certDir, "signing-key.pem");
    writeFileSync(keyPath, signingKey, { mode: 0o600 });
    ok("Signing key", `new · ${keyPath} ${c.dim("(0600)")}`);
    warn("Move it to your password manager or CI secrets, then delete the file.");
  }
} else {
  ok("Signing key", c.dim("existing key reused"));
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
    { input: signingKey, stdio: ["pipe", "ignore", "ignore"] },
  );
}
ok("Certificate", `${certPath.replace(homedir(), "~")} ${c.dim("· public, goes in your app")}`);
let preview = env("FLARE_OTA_PREVIEW_SECRET") ?? keychainRead(previewService);
if (!preview) {
  preview = randomBytes(32).toString("base64url");
  if (platform() === "darwin") keychainWrite(previewService, preview);
  else warn("Set FLARE_OTA_PREVIEW_SECRET in your secrets store to keep preview links valid across deploys.");
}
process.env.FLARE_OTA_PREVIEW_SECRET = preview;
ok("Previews", c.dim("signing secret for preview links"));

section("Cloudflare resources");
await task("Access", (update) => script("access.ts", update), () => `${dashboardHost} ${c.dim(`· ${env("FLARE_OTA_ACCESS_EMAILS")}`)}`);
process.loadEnvFile(envFile);
await task("Deploy", (update) => script("deploy.ts", update), () => `${workerName(stage)} ${c.dim("· D1, R2, Worker")}`);
const me = env("FLARE_OTA_ACCESS_EMAILS")!.split(",")[0]!.trim();
const tokenService = keychainService(stage, "admin-token");
if (platform() === "darwin") {
  // The token goes to the keychain and is never printed (bootstrap-token --print to show it).
  await task("Admin token", (update) => script("bootstrap-token.ts", update, ["--name", me]), () => `keychain ${c.dim(tokenService)}`);
} else {
  foreground("bootstrap-token.ts", ["--name", me]);
}

const wafLine = await prompt(question("WAF rules", "recommended edge rules on the zone", "Y/n"));
if (wafLine === null || !process.stdin.isTTY) process.stdout.write(`${wafLine || "y"}\n`);
const wafAnswer = (wafLine ?? "").trim().toLowerCase();
if (wafAnswer !== "n" && wafAnswer !== "no") {
  await task("WAF", (update) => script("waf.ts", update), () => `rules applied ${c.dim(`on the zone of ${updatesHost}`)}`);
} else {
  note("skipped: pnpm server:waf later");
}

section("Health check");
const report = await script("doctor.ts", () => {}).catch((error: Error) => {
  throw new Error(`doctor failed: ${error.message}`);
});
for (const line of report.split("\n")) {
  const check = /^([✓✗]) ([^:]+): (.*)$/.exec(line.trim());
  if (check) (check[1] === "✓" ? ok : fail)(check[2]!, check[3]!);
}
rl.close();

const secs = ((performance.now() - started) / 1000).toFixed(0);
process.stdout.write(`\n  ${c.green("●")} ${c.bold("Server live")} ${c.dim(`in ${secs}s`)}\n\n`);
row("Updates", `https://${updatesHost}`);
row("Dashboard", c.flame(`https://${dashboardHost}`));
row("Certificate", certPath.replace(homedir(), "~"));
if (platform() === "darwin") row("Admin token", `keychain ${c.dim(tokenService)}`);
process.stdout.write(`\n  ${c.dim("Next, in your Expo app")}\n`);
process.stdout.write(`    mkdir -p certs && cp ${certPath.replace(homedir(), "~")} certs/\n`);
process.stdout.write(`    FLARE_OTA_URL=https://${updatesHost} npx flare-ota init --channel ${stage}\n`);
note("then build a new binary: the URL and certificate are native settings");
if (backup) {
  process.stdout.write(`\n  ${c.yellow("!")} ${c.bold("Back up the signing key")} ${c.dim("losing it means a store build for every user")}\n`);
  process.stdout.write(`    ${backup}\n`);
}
process.stdout.write(`\n  ${c.dim("Redeploy later")}\n`);
process.stdout.write(`    ${c.dim(`FLARE_OTA_SIGNING_KEY="$(security find-generic-password -s ${keyService} -a flare-ota -w | base64 -d)" \\`)}\n`);
process.stdout.write(`    ${c.dim(`FLARE_OTA_PREVIEW_SECRET="$(security find-generic-password -s ${previewService} -a flare-ota -w)" \\`)}\n`);
process.stdout.write(`    ${c.dim(`pnpm server:deploy ${forward.join(" ")}`)}\n\n`);
