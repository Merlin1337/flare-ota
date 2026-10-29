// Builds and deploys one stage: database + migrations first, then the Worker with its secrets.
//   FLARE_OTA_SIGNING_KEY="$(cat key.pem)" pnpm server:deploy --stage production
// Secrets come from the environment (keychain, password manager or CI secrets), never from the repo:
//   FLARE_OTA_SIGNING_KEY      PEM private key matching the certificate in your app
//   FLARE_OTA_PREVIEW_SECRET   random string for preview links (optional; previews off without it)
import { cfLive, ensureDatabase, env, requireEnv, stageArgs, step, withSecretsFile, workerName } from "./lib.ts";

const { stage } = stageArgs();
requireEnv("CLOUDFLARE_ACCOUNT_ID");
requireEnv("FLARE_OTA_UPDATES_HOST", "Devices need a stable hostname.");
const signingKey = requireEnv("FLARE_OTA_SIGNING_KEY", "Pass the PEM private key through the environment.");
if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(signingKey)) throw new Error("FLARE_OTA_SIGNING_KEY does not look like a PEM private key.");
if (env("FLARE_OTA_DASHBOARD_HOST") && (!env("FLARE_OTA_ACCESS_AUD") || !env("FLARE_OTA_ACCESS_TEAM_DOMAIN"))) {
  throw new Error("The dashboard needs Cloudflare Access: run `pnpm server:access ` first (it fills FLARE_OTA_ACCESS_AUD).");
}

const name = workerName(stage);
step(`D1 database ${name}-db`);
const id = await ensureDatabase(`${name}-db`);
await cfLive(["d1", "migrations", "apply", id, "--dir", "migrations"]);

step(`Deploying ${name}`);
const secrets: Record<string, string> = { SIGNING_KEY: signingKey };
const preview = env("FLARE_OTA_PREVIEW_SECRET");
if (preview) secrets.PREVIEW_SECRET = preview;
await withSecretsFile(secrets, (path) => cfLive(["deploy", ...(stage === "production" ? [] : ["--mode", stage]), "--secrets-file", path]));
console.log(`\nUpdates URL: https://${env("FLARE_OTA_UPDATES_HOST")}${env("FLARE_OTA_DASHBOARD_HOST") ? `\nDashboard:   https://${env("FLARE_OTA_DASHBOARD_HOST")}` : ""}`);
