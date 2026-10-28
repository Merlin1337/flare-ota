// Puts the dashboard hostname behind Cloudflare Access (creates or reuses the application) and
// records its audience tag in .env.<stage>, so the Worker can verify Access JWTs itself.
//   FLARE_OTA_ACCESS_EMAILS=you@example.com pnpm --filter @flare-ota/server access -- --stage production
import { cfJson, env, requireEnv, stageArgs, step, upsertEnvFile } from "./lib.ts";

const { stage, envFile } = stageArgs();
const host = requireEnv("FLARE_OTA_DASHBOARD_HOST");
const emails = (env("FLARE_OTA_ACCESS_EMAILS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const domains = (env("FLARE_OTA_ACCESS_EMAIL_DOMAINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!emails.length && !domains.length) throw new Error("Set FLARE_OTA_ACCESS_EMAILS and/or FLARE_OTA_ACCESS_EMAIL_DOMAINS: who may open the dashboard.");

step("Zero Trust organization");
let org: { auth_domain?: string };
try {
  org = await cfJson(["zero-trust", "organization", "get"]);
} catch {
  throw new Error("Zero Trust is not enabled on this account. Open https://one.dash.cloudflare.com, pick a team name (the Free plan covers 50 users), then rerun.");
}
if (!org.auth_domain) throw new Error("Could not read the Zero Trust team domain.");

step(`Access application for ${host}`);
const include = [...emails.map((email) => ({ email: { email } })), ...domains.map((domain) => ({ email_domain: { domain } }))];
const apps = await cfJson<{ id: string; aud: string; domain: string }[]>(["zero-trust", "access", "applications", "list"]);
let app = apps.find((a) => a.domain === host);
const body = {
  name: `flare-ota dashboard (${stage})`,
  domain: host,
  type: "self_hosted",
  session_duration: "24h",
  app_launcher_visible: false,
  policies: [{ name: "flare-ota admins", decision: "allow", include }],
};
if (app) {
  app = await cfJson(["zero-trust", "access", "applications", "update", app.id, "--body", JSON.stringify(body)]);
  console.log("Updated the existing application.");
} else {
  app = await cfJson(["zero-trust", "access", "applications", "create", "--body", JSON.stringify(body)]);
  console.log("Created the application.");
}
await upsertEnvFile(envFile, { FLARE_OTA_ACCESS_TEAM_DOMAIN: org.auth_domain, FLARE_OTA_ACCESS_AUD: app!.aud });
console.log(`Saved FLARE_OTA_ACCESS_TEAM_DOMAIN and FLARE_OTA_ACCESS_AUD to ${envFile}. Redeploy to apply.`);
