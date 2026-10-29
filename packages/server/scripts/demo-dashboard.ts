// Serves the real dashboard on http://localhost:8799 with fictional data, no Cloudflare needed.
//   pnpm --filter @flare-ota/server demo
import { createServer } from "node:http";
import { utf8 } from "@flare-ota/core";
import { dashboard } from "../src/dashboard.ts";
import { Services } from "../src/services.ts";
import { Store } from "../src/store.ts";
import { assetHash, harness, publish, uploadBundle } from "../test/support.ts";

const h = await harness({ APP_SCHEME: "acme" });
const ci = await h.token("publish", "github-actions");
const ops = await h.token("admin", "alex@acme.dev");
const db = h.db.raw;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

async function release(branch: string, message: string, rollout = 100, runtime = "c41f9a2e7b") {
  const ios = await uploadBundle(h, ci, `${branch}:${message}:ios`, runtime);
  const android = await uploadBundle(h, ci, `${branch}:${message}:android`, runtime);
  const res = await publish(h, ci, { branch, message, rolloutPercent: rollout, gitCommit: Math.random().toString(16).slice(2, 12), updates: { ios, android } });
  return (await res.json()) as { id: string; updates: { id: string; platform: string }[] };
}

const old = await release("production", "Faster cold start: lazy-load the media editor", 100, "7d03be91aa");
const fix = await release("production", "Fix checkout crash on iOS 18.2");
const canary = await release("production", "New onboarding flow", 25);
const staged = await release("staging", "Dark mode for receipts");
await release("staging", "Experiment: bigger CTA on paywall");
void staged;

// Spread group timestamps so the table reads like real history.
for (const [id, minutes] of [[old.id, 60 * 24 * 9], [fix.id, 60 * 26], [canary.id, 95]] as const) {
  db.prepare("UPDATE update_groups SET created_at = ? WHERE id = ?").run(at(minutes), id);
  db.prepare("UPDATE updates SET created_at = ? WHERE group_id = ?").run(at(minutes), id);
}
db.prepare("UPDATE update_groups SET actor = 'token:github-actions'").run();

const insert = db.prepare("INSERT INTO devices (client_id, platform, runtime_version, channel, current_update_id, embedded_update_id, served_update_id, app_version, country, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'production', ?, NULL, ?, '2.4.0', 'FR', ?, ?)");
const pick = (group: typeof fix, platform: string) => group.updates.find((u) => u.platform === platform)!.id;
function devices(n: number, platform: string, runtime: string, current: string | null, served: string | null) {
  for (let i = 0; i < n; i++) insert.run(crypto.randomUUID(), platform, runtime, current, served, at(60 * 24 * 40), at(Math.random() < 0.7 ? Math.random() * 60 * 20 : 60 * 24 * (1 + Math.random() * 25)));
}
devices(1410, "ios", "c41f9a2e7b", pick(fix, "ios"), pick(fix, "ios"));
devices(388, "ios", "c41f9a2e7b", pick(canary, "ios"), pick(canary, "ios"));
devices(96, "ios", "c41f9a2e7b", pick(fix, "ios"), pick(canary, "ios"));
devices(1120, "android", "c41f9a2e7b", pick(fix, "android"), pick(fix, "android"));
devices(301, "android", "c41f9a2e7b", pick(canary, "android"), pick(canary, "android"));
devices(212, "ios", "7d03be91aa", pick(old, "ios"), pick(old, "ios"));
devices(143, "android", "7d03be91aa", pick(old, "android"), pick(old, "android"));
const fail = db.prepare("INSERT INTO device_failures (update_id, client_id, fatal_error, first_seen_at, last_seen_at) VALUES (?, ?, NULL, ?, ?)");
for (let i = 0; i < 3; i++) fail.run(pick(canary, "android"), crypto.randomUUID(), at(30), at(30));

const services = new Services(new Store(h.env.DB), h.env);
await services.setRollout(canary.id, 25, "access:alex@acme.dev");
void ops; void assetHash; void utf8;

createServer(async (req, res) => {
  const response = await dashboard(new Request(`http://localhost:8799${req.url}`), h.env, new Store(h.env.DB), services, { actor: "access:alex@acme.dev", scope: "admin" });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(8799, () => console.log(`groups ${fix.id} ${canary.id}`));
