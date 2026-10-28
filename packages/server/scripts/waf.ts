// Edge protection for the update hosts (zone WAF), merged with the zone's existing rules:
//  - only the server's paths pass on the update host
//  - /api and /mcp require a Bearer header before reaching the Worker
//  - device routes are GET/HEAD only, with bounded header sizes
//  - /manifest is rate limited per IP (Free plan: one path-only rule, so it applies zone-wide)
//   pnpm --filter @flare-ota/server waf -- --stage production
import { cfJson, env, requireEnv, stageArgs, step, zoneFor } from "./lib.ts";

const { stage } = stageArgs();
const host = requireEnv("FLARE_OTA_UPDATES_HOST");
const zone = await zoneFor(host);
const tag = `flare-ota (${stage})`;
const H = `http.host eq "${host}"`;
const p = "http.request.uri.path";
const header = (name: string, max: number) => `any(len(http.request.headers["${name}"][*])[*] > ${max})`;

const custom = [
  {
    description: `${tag}: only update-server paths`,
    action: "block",
    expression: `(${H} and not (${p} in {"/manifest" "/health" "/mcp"} or starts_with(${p}, "/assets/") or starts_with(${p}, "/api/v1/")))`,
  },
  {
    description: `${tag}: API and MCP need a bearer token`,
    action: "block",
    expression: `(${H} and (${p} eq "/mcp" or starts_with(${p}, "/api/v1/")) and not any(starts_with(http.request.headers["authorization"][*], "Bearer ")))`,
  },
  {
    description: `${tag}: device routes are GET-only with bounded headers`,
    action: "block",
    expression: `(${H} and (${p} eq "/manifest" or starts_with(${p}, "/assets/")) and (not http.request.method in {"GET" "HEAD"} or ${header("eas-client-id", 64)} or ${header("expo-runtime-version", 64)} or ${header("expo-channel-name", 64)} or ${header("expo-current-update-id", 64)} or ${header("expo-embedded-update-id", 64)} or ${header("flare-preview", 512)}))`,
  },
];
const perTenSeconds = Number(env("FLARE_OTA_MANIFEST_RATE") ?? "30");
const rateLimit = {
  description: "flare-ota: /manifest per-IP rate limit",
  action: "block",
  expression: `(${p} eq "/manifest")`,
  ratelimit: { characteristics: ["cf.colo.id", "ip.src"], period: 10, requests_per_period: perTenSeconds, mitigation_timeout: 10 },
};

const KEEP = ["id", "ref", "action", "action_parameters", "expression", "description", "enabled", "logging", "ratelimit"];
const clean = (rule: Record<string, unknown>) => Object.fromEntries(Object.entries(rule).filter(([k]) => KEEP.includes(k)));

async function existing(phase: string): Promise<Record<string, unknown>[]> {
  try {
    return (await cfJson<{ rules?: Record<string, unknown>[] }>(["rulesets", "entrypoint", "get", phase, "-z", zone.id])).rules ?? [];
  } catch {
    return [];
  }
}

step(`Firewall rules on ${zone.name} for ${host}`);
const others = (await existing("http_request_firewall_custom")).filter((r) => !String(r.description ?? "").startsWith(tag));
await cfJson(["rulesets", "entrypoint", "update", "http_request_firewall_custom", "-z", zone.id, "--body", JSON.stringify({ rules: [...others.map(clean), ...custom] })]);
console.log(`Applied ${custom.length} rules (kept ${others.length} other rules).`);

step("Rate limit on /manifest");
const limits = await existing("http_ratelimit");
const foreign = limits.filter((r) => !String(r.description ?? "").startsWith("flare-ota"));
try {
  await cfJson(["rulesets", "entrypoint", "update", "http_ratelimit", "-z", zone.id, "--body", JSON.stringify({ rules: [...foreign.map(clean), rateLimit] })]);
  console.log(`~${perTenSeconds} requests / 10 s / IP on /manifest. On the Free plan this rule matches the path on every hostname of ${zone.name}.`);
} catch (error) {
  console.warn(`Rate limit not applied (${(error as Error).message.split("\n").at(-1)}). The Free plan allows one rate-limiting rule per zone.`);
}
