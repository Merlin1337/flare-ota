// `npx flare-ota setup`: fetches the server source at the version of this CLI, installs it, and
// runs the same guided setup as `pnpm server:setup` from a clone. The source stays on disk
// (default ~/.flare-ota/server): later deploys and scripts run from there.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO = "https://github.com/Merlin1337/flare-ota.git";

export interface SetupOptions {
  dir?: string;
  stage: string;
  app?: string;
  /** Git ref to fetch (default: the tag of this CLI's version). */
  ref?: string;
}

function cliVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function run(command: string, args: string[], cwd?: string): boolean {
  return spawnSync(command, args, { cwd, stdio: "inherit" }).status === 0;
}

function quiet(command: string, args: string[], cwd?: string): boolean {
  return spawnSync(command, args, { cwd, stdio: "ignore" }).status === 0;
}

/** pnpm, or pnpm through corepack (bundled with Node), at the version the repo pins. */
function pnpm(): string[] {
  if (quiet("pnpm", ["--version"])) return ["pnpm"];
  if (quiet("corepack", ["pnpm", "--version"])) return ["corepack", "pnpm"];
  throw new Error("The server needs pnpm: run `corepack enable` (or `npm i -g pnpm`), then retry.");
}

export function setup(options: SetupOptions): void {
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  if (major < 24 || (major === 24 && minor < 22)) throw new Error(`The server scripts need Node 24.22+ (this is ${process.versions.node}).`);
  if (!quiet("git", ["--version"])) throw new Error("git is required to fetch the server source.");
  if (!quiet("openssl", ["version"])) throw new Error("openssl is required to create the code-signing certificate.");
  if (options.stage && !/^[a-z][a-z0-9-]{0,20}$/.test(options.stage)) throw new Error("--stage must be a short lowercase name");
  if (options.app && !/^[a-z][a-z0-9-]{0,30}$/.test(options.app)) throw new Error("--app must be a short lowercase name");

  const dir = resolve(options.dir ?? join(homedir(), ".flare-ota", "server"));
  const ref = options.ref ?? `v${cliVersion()}`;
  if (!existsSync(join(dir, "packages", "server", "cloudflare.config.ts"))) {
    if (existsSync(dir)) throw new Error(`${dir} exists but is not a flare-ota checkout. Pass --dir <empty folder>.`);
    console.log(`Fetching flare-ota ${ref} into ${dir}`);
    if (!run("git", ["clone", "--depth", "1", "--branch", ref, REPO, dir])) {
      throw new Error(`Could not clone ${REPO} at ${ref}. Pass --ref main to use the latest source.`);
    }
  } else {
    console.log(`Using the server source in ${dir} (git -C ${dir} pull to update it).`);
  }

  const pm = pnpm();
  console.log("Installing the server's dependencies");
  if (!run(pm[0]!, [...pm.slice(1), "install", "--frozen-lockfile"], dir)) throw new Error("pnpm install failed.");

  // Cloudflare login: the interactive browser step, only when cf has no session yet.
  const serverDir = join(dir, "packages", "server");
  if (!quiet("npx", ["--no-install", "cf", "accounts", "list"], serverDir)) {
    console.log("Log in to Cloudflare (a browser window opens)");
    if (!run("npx", ["--no-install", "cf", "auth", "login"], serverDir)) throw new Error("Cloudflare login failed.");
  }

  const forward = ["--stage", options.stage, ...(options.app ? ["--app", options.app] : [])];
  if (!run(pm[0]!, [...pm.slice(1), "server:setup", ...forward], dir)) throw new Error("Setup stopped. Fix the error above and rerun the same command: every step is reusable.");
  console.log(`\nServer source and settings live in ${dir}. Redeploy later from there:\n  cd ${dir} && pnpm server:deploy ${forward.join(" ")}`);
}
