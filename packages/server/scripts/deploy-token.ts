// Creates a Cloudflare API token scoped to what deploying flare-ota needs, for CI. It cannot
// create other tokens. On macOS it goes to the login keychain (never printed); elsewhere, or with
// --print, it is shown once. Store it as the CI secret CLOUDFLARE_API_TOKEN.
//   pnpm server:deploy-token --stage production [--app myapp] [--with-access] [--with-waf] [--print]
import { cfJson, deliverSecret, keychainService, requireEnv, stageArgs, step, workerName, zoneFor } from "./lib.ts";

const { stage, values } = stageArgs({ "with-access": { type: "boolean" }, "with-waf": { type: "boolean" }, print: { type: "boolean" } });
const account = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const zone = await zoneFor(requireEnv("FLARE_OTA_UPDATES_HOST"));

const accountGroups = ["Workers Scripts Write", "D1 Write", "Workers R2 Storage Write", "Account Settings Read", "Workers Observability Write"];
if (values["with-access"]) accountGroups.push("Access: Apps and Policies Write", "Access: Organizations, Identity Providers, and Groups Read");
const zoneGroups = ["Zone Read", "DNS Write", "Workers Routes Write", "SSL and Certificates Write"];
if (values["with-waf"]) zoneGroups.push("Zone WAF Write");

step("Resolving permission groups");
const groups = await cfJson<{ id: string; name: string }[]>(["accounts", "tokens", "permission-groups", "list"]);
const pick = (names: string[]) =>
  names.map((name) => {
    const group = groups.find((g) => g.name === name);
    if (!group) throw new Error(`Permission group "${name}" not found.`);
    return { id: group.id };
  });
const policies = [
  { effect: "allow", resources: { [`com.cloudflare.api.account.${account}`]: "*" }, permission_groups: pick(accountGroups) },
  { effect: "allow", resources: { [`com.cloudflare.api.account.zone.${zone.id}`]: "*" }, permission_groups: pick(zoneGroups) },
];
step("Creating the token");
const token = await cfJson<{ id: string; value: string }>(["accounts", "tokens", "create", "--name", `${workerName(stage)} deploy (${stage})`, "--policies", JSON.stringify(policies)]);
deliverSecret({
  service: keychainService(stage, "cloudflare-deploy-token"),
  label: `Cloudflare deploy token ${token.id}`,
  print: values.print === true,
  value: token.value,
  usage: "gh secret set CLOUDFLARE_API_TOKEN --repo <owner/repo> < <(printf %s $SECRET)",
});
