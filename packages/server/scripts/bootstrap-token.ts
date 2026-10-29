// Creates the first admin token directly in D1 (only its SHA-256 is stored) and prints it once.
// Use it to open the API/MCP, then create narrower tokens (publish for CI, read for dashboards).
//   pnpm server:bootstrap-token --stage production --name you@example.com
import { createHash, randomBytes } from "node:crypto";
import { cfJson, databaseId, stageArgs, workerName } from "./lib.ts";

const { stage, values } = stageArgs({ name: { type: "string", default: "bootstrap-admin" } });
const name = String(values.name);
if (!/^[\w .@:-]{1,64}$/.test(name)) throw new Error("--name: 1-64 letters, digits, spaces or . @ : _ -");
const id = await databaseId(`${workerName(stage)}-db`);
if (!id) throw new Error("Database not found: deploy first.");
const token = `fota_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(token).digest("hex");
await cfJson(["d1", "query", id, "--sql", "INSERT INTO tokens (id, name, hash, scope, created_at) VALUES (?, ?, ?, 'admin', ?)", "--params", JSON.stringify([crypto.randomUUID(), name, hash, new Date().toISOString()])]);
console.log(`Admin token for ${stage} (store it now in your password manager; it is not shown again):\n\n${token}\n`);
