// Creates the stage's D1 database if needed and applies pending migrations.
//   pnpm server:migrate --stage production
import { cfLive, ensureDatabase, stageArgs, step, workerName } from "./lib.ts";

const { stage } = stageArgs();
const name = `${workerName(stage)}-db`;
step(`D1 database ${name}`);
const id = await ensureDatabase(name);
step("Applying migrations");
await cfLive(["d1", "migrations", "apply", id, "--dir", "migrations"]);
