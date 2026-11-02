// `npx flare-ota upgrade`: brings a deployed server to this CLI's version without a question.
// Same source folder and settings as `setup`; secrets come from the environment or, on macOS,
// from the keychain entries setup created. Migrations run as part of the deploy.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { compareVersions, FLARE_OTA_VERSION } from "@flare-ota/core";
import { captured, prepareServer, type SetupOptions } from "./setup.ts";
import { c, terminal } from "./ui.ts";

function keychain(service: string): string | null {
  if (platform() !== "darwin") return null;
  const result = spawnSync("security", ["find-generic-password", "-s", service, "-a", "flare-ota", "-w"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function serverVersion(host: string): Promise<string | null> {
  try {
    const response = await fetch(`https://${host}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    return ((await response.json()) as { version?: string }).version ?? "0.1.2 or older";
  } catch {
    return null;
  }
}

export async function upgrade(options: SetupOptions): Promise<void> {
  const r = terminal();
  const { dir, shown, serverDir } = await prepareServer(options, "upgrade", r);

  const settingsFile = join(dir, options.app ? `.env.${options.app}.${options.stage}` : `.env.${options.stage}`);
  if (!existsSync(settingsFile)) {
    throw new Error(`No settings for ${options.app ?? "flare-ota"} (${options.stage}) in ${shown}. Run \`npx flare-ota setup\` first, or pass --dir to where you ran it.`);
  }
  const settings = parseEnv(readFileSync(settingsFile, "utf8")) as Record<string, string | undefined>;
  const host = settings.FLARE_OTA_UPDATES_HOST;
  if (!host) throw new Error(`${settingsFile} has no FLARE_OTA_UPDATES_HOST.`);
  const base = options.app ?? settings.FLARE_OTA_NAME ?? "flare-ota";
  const worker = options.stage === "production" ? base : `${base}-${options.stage}`;

  // Secrets reach the deploy script through its environment only, never argv or output.
  const signingKey = process.env.FLARE_OTA_SIGNING_KEY ?? (() => {
    const stored = keychain(`flare-ota.${worker}.signing-key-b64`);
    return stored ? Buffer.from(stored, "base64").toString() : undefined;
  })();
  if (!signingKey) {
    throw new Error(`No signing key: set FLARE_OTA_SIGNING_KEY (the PEM your app's certificate matches)${platform() === "darwin" ? ` or restore the keychain entry flare-ota.${worker}.signing-key-b64` : ""}.`);
  }
  const preview = process.env.FLARE_OTA_PREVIEW_SECRET ?? keychain(`flare-ota.${worker}.preview-secret`) ?? undefined;
  if (!preview) r.warn("No preview secret found: preview links stay off until FLARE_OTA_PREVIEW_SECRET is set.");

  const before = await serverVersion(host);
  if (before && compareVersions(before, FLARE_OTA_VERSION) > 0) {
    throw new Error(`The server runs ${before}, newer than this CLI (${FLARE_OTA_VERSION}). Update the CLI instead: npm i flare-ota@latest.`);
  }
  const forward = ["--stage", options.stage, ...(options.app ? ["--app", options.app] : [])];
  await r.step(
    "Deploy",
    (step) =>
      captured("node", [join(serverDir, "scripts", "deploy.ts"), ...forward], serverDir, step.update, {
        ...process.env,
        FLARE_OTA_SIGNING_KEY: signingKey,
        ...(preview ? { FLARE_OTA_PREVIEW_SECRET: preview } : {}),
      }),
    () => `${worker} ${c.dim("· migrations, Worker")}`,
  );

  const after = await r.step(
    "Check",
    async () => {
      // The new Worker is live within seconds; give the edge a moment before calling it failed.
      for (let attempt = 0; attempt < 10; attempt++) {
        const version = await serverVersion(host);
        if (version === FLARE_OTA_VERSION) return version;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      throw new Error(`https://${host}/health does not report ${FLARE_OTA_VERSION} yet. Run \`npx flare-ota doctor\` in a minute.`);
    },
    (version) => `https://${host} ${c.dim(`· ${before ?? "?"} → ${version}`)}`,
  );
  r.line(`\n  ${c.green("●")} ${c.bold(`Server on ${after}`)} ${c.dim(`· settings and keys unchanged`)}\n`);
}
