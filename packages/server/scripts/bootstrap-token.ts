// Creates the first admin token directly in D1 (only its SHA-256 is stored). On macOS it goes
// straight to the login keychain and is never printed; elsewhere, or with --print, it is shown once.
// Use it to open the API/MCP, then create narrower tokens (publish for CI, read for dashboards).
//   pnpm server:bootstrap-token --stage production [--app myapp] --name you@example.com [--print]
import { createHash, randomBytes } from "node:crypto";
import { cfJson, databaseId, deliverSecret, keychainService, stageArgs, workerName } from "./lib.ts";

const { stage, values } = stageArgs({ name: { type: "string", default: "bootstrap-admin" }, print: { type: "boolean" } });
const name = String(values.name);
if (!/^[\w .@:-]{1,64}$/.test(name)) throw new Error("--name: 1-64 letters, digits, spaces or . @ : _ -");
const id = await databaseId(`${workerName(stage)}-db`);
if (!id) throw new Error("Database not found: deploy first.");
const token = `fota_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(token).digest("hex");
// Only the digest leaves this process (cf's --params flag is a plain string in this beta, so use --body).
await cfJson(["d1", "query", id, "--body", JSON.stringify({
  sql: "INSERT INTO tokens (id, name, hash, scope, created_at) VALUES (?, ?, ?, 'admin', ?)",
  params: [crypto.randomUUID(), name, hash, new Date().toISOString()],
})]);
deliverSecret({
  service: keychainService(stage, "admin-token"),
  label: `Admin token for ${workerName(stage)}`,
  print: values.print === true,
  value: token,
  usage: "FLARE_OTA_TOKEN=$SECRET npx flare-ota whoami",
});
