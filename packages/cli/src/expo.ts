// Calls into the app's own Expo tooling, so the CLI never disagrees with the app's SDK version.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Platform } from "@flare-ota/core";

const run = promisify(execFile);

async function npx(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const { stdout } = await run("npx", ["--no-install", ...args], { cwd, env, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** `public` is what devices receive (code-signing fields stripped); `prebuild` is the full config. */
export async function expoConfig(cwd: string, type: "public" | "prebuild" = "public"): Promise<Record<string, any>> {
  return JSON.parse(await npx(cwd, ["expo", "config", "--type", type, "--json"]));
}

/** Resolves the runtime version exactly as expo-updates does in the native build (fingerprint included). */
export async function runtimeVersion(cwd: string, platform: Platform): Promise<string> {
  const stdout = await npx(cwd, ["expo-updates", "runtimeversion:resolve", "--platform", platform]);
  const line = stdout.trim().split("\n").at(-1) ?? "";
  const parsed = JSON.parse(line) as { runtimeVersion?: string | null };
  if (!parsed.runtimeVersion) throw new Error(`Could not resolve the ${platform} runtime version. Set runtimeVersion in the app config.`);
  return parsed.runtimeVersion;
}

export async function exportBundles(cwd: string, platforms: Platform[], outputDir: string): Promise<void> {
  await run("npx", ["--no-install", "expo", "export", "--output-dir", outputDir, ...platforms.flatMap((p) => ["--platform", p])], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: "production" },
  });
}

export async function gitCommit(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
