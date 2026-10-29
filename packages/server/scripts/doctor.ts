// Checks a deployed stage from the outside: health, protocol and signing, Access in front of
// the dashboard, API auth, and the WAF.   pnpm server:doctor --stage production
import { env, requireEnv, stageArgs } from "./lib.ts";

const { stage } = stageArgs();
const host = requireEnv("FLARE_OTA_UPDATES_HOST");
const dashboard = env("FLARE_OTA_DASHBOARD_HOST");
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
};

console.log(`flare-ota doctor — ${stage} (https://${host})`);
const health = await fetch(`https://${host}/health`).catch((e: Error) => e);
check("health", health instanceof Response && health.ok, health instanceof Response ? `HTTP ${health.status}` : health.message);

const probe = await fetch(`https://${host}/manifest`, {
  headers: { "expo-protocol-version": "1", "expo-platform": "ios", "expo-runtime-version": "doctor", "expo-channel-name": stage, "expo-expect-signature": "sig" },
}).catch((e: Error) => e);
if (probe instanceof Response) {
  const text = await probe.text();
  check("manifest", probe.ok && /multipart\/mixed/.test(probe.headers.get("content-type") ?? ""), `HTTP ${probe.status} ${probe.headers.get("content-type") ?? ""}`);
  check("signing", /expo-signature: sig="/.test(text), /expo-signature/.test(text) ? "responses are signed" : "no signature: is FLARE_OTA_SIGNING_KEY deployed?");
} else {
  check("manifest", false, probe.message);
}

const api = await fetch(`https://${host}/api/v1/overview`).catch((e: Error) => e);
check("API requires a token", api instanceof Response && (api.status === 401 || api.status === 403), api instanceof Response ? `HTTP ${api.status} without a token` : api.message);

const junk = await fetch(`https://${host}/wp-login.php`).catch((e: Error) => e);
check("WAF path allowlist", junk instanceof Response && junk.status === 403, junk instanceof Response ? `unknown path → HTTP ${junk.status}${junk.status === 404 ? " (run the waf script to block at the edge)" : ""}` : junk.message);

if (dashboard) {
  const page = await fetch(`https://${dashboard}/`, { redirect: "manual" }).catch((e: Error) => e);
  const ok = page instanceof Response && (page.status === 302 || page.status === 403) && !(page.headers.get("content-type") ?? "").includes("text/html; charset=utf-8");
  check("dashboard behind Access", ok, page instanceof Response ? `HTTP ${page.status} → ${page.headers.get("location")?.split("?")[0] ?? "no redirect"}` : page.message);
}
if (failures) process.exitCode = 1;
