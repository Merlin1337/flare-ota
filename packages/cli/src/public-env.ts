// What `expo export` will inline as EXPO_PUBLIC_*: the shell, then the eas.json build profile
// named with --profile, then the .env files Expo loads in production. A forgotten variable silently ships the app's
// fallback (often localhost) to every device, so publish shows these values and refuses local
// or private hosts on a production branch.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

export type EnvSource = "shell" | "eas" | "dotenv";

export interface PublicEnv {
  /** EXPO_PUBLIC_* values the export will inline, with where each one comes from. */
  values: Record<string, { value: string; source: EnvSource }>;
  /** Build-profile env to pass to `expo export` (only keys the shell does not already set). */
  inject: Record<string, string>;
  /** The eas.json build profile used (--profile), if any. */
  profile: string | null;
}

interface EasProfile {
  extends?: string;
  env?: Record<string, string>;
}

/** Expo's production load order: the first file that defines a key wins. */
const DOTENV_FILES = [".env.production.local", ".env.local", ".env.production", ".env"];

async function dotenv(projectDir: string): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const file of DOTENV_FILES) {
    const path = join(projectDir, file);
    if (!existsSync(path)) continue;
    const parsed = parseEnv(await readFile(path, "utf8"));
    for (const [key, value] of Object.entries(parsed)) if (!(key in merged) && value !== undefined) merged[key] = value;
  }
  return merged;
}

function resolveProfile(profiles: Record<string, EasProfile>, name: string, seen = new Set<string>()): EasProfile {
  const profile = profiles[name];
  if (!profile) throw new Error(`eas.json has no build profile "${name}".`);
  if (seen.has(name)) throw new Error(`eas.json build profile "${name}" extends itself.`);
  seen.add(name);
  if (!profile.extends) return profile;
  const parent = resolveProfile(profiles, profile.extends, seen);
  return { ...parent, ...profile, env: { ...(parent.env ?? {}), ...(profile.env ?? {}) } };
}

/**
 * The env of an eas.json build profile, when one is named with --profile. Never guessed: a
 * channel is not a branch, and variables stored on EAS servers are not in eas.json anyway.
 */
export async function easProfile(projectDir: string, name: string): Promise<{ name: string; env: Record<string, string> }> {
  const path = join(projectDir, "eas.json");
  if (!existsSync(path)) throw new Error(`--profile ${name}: no eas.json in ${projectDir}.`);
  const profiles = (JSON.parse(await readFile(path, "utf8")) as { build?: Record<string, EasProfile> }).build ?? {};
  return { name, env: resolveProfile(profiles, name).env ?? {} };
}

export async function publicEnv(projectDir: string, options: { profile?: string; shell?: NodeJS.ProcessEnv } = {}): Promise<PublicEnv> {
  const shell = options.shell ?? process.env;
  const profile = options.profile ? await easProfile(projectDir, options.profile) : null;
  const files = await dotenv(projectDir);
  const values: PublicEnv["values"] = {};
  const inject: Record<string, string> = {};
  for (const [key, value] of Object.entries(files)) if (key.startsWith("EXPO_PUBLIC_")) values[key] = { value, source: "dotenv" };
  for (const [key, value] of Object.entries(profile?.env ?? {})) {
    if (shell[key] !== undefined) continue;
    inject[key] = value;
    if (key.startsWith("EXPO_PUBLIC_")) values[key] = { value, source: "eas" };
  }
  for (const [key, value] of Object.entries(shell)) if (key.startsWith("EXPO_PUBLIC_") && value !== undefined) values[key] = { value, source: "shell" };
  return { values, inject, profile: profile?.name ?? null };
}

const PRIVATE_HOST = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
];

/** The local or private host a value points at, if any (URLs and bare host[:port] values). */
export function localHost(value: string): string | null {
  const trimmed = value.trim();
  let host: string | null = null;
  try {
    host = new URL(trimmed).hostname;
  } catch {
    const bare = /^([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.exec(trimmed);
    host = bare ? bare[1]! : null;
  }
  if (!host) return null;
  return PRIVATE_HOST.some((pattern) => pattern.test(host!)) ? host : null;
}
