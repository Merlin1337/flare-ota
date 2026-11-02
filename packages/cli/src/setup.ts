// `npx flare-ota setup`: fetches the server source at the version of this CLI, installs it, and
// runs the same guided setup as `pnpm server:setup` from a clone. The source stays on disk
// (default ~/.flare-ota/server): later deploys and scripts run from there.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { c, ReportedError, terminal } from "./ui.ts";

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

/** Runs a command with its output captured; the log is printed only if it fails. */
function captured(command: string, args: string[], cwd: string | undefined, update: (detail: string) => void): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const take = (chunk: Buffer) => {
      log += chunk.toString();
      const last = log.trimEnd().split("\n").at(-1)?.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (last) update(last.slice(0, 60));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolvePromise();
      process.stderr.write(`\n${c.dim(log.trimEnd())}\n\n`);
      reject(new Error(`${command} ${args[0]} exited with ${code}`));
    });
  });
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

export async function setup(options: SetupOptions): Promise<void> {
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  if (major < 24 || (major === 24 && minor < 22)) throw new Error(`The server scripts need Node 24.22+ (this is ${process.versions.node}).`);
  if (!quiet("git", ["--version"])) throw new Error("git is required to fetch the server source.");
  if (!quiet("openssl", ["version"])) throw new Error("openssl is required to create the code-signing certificate.");
  if (!/^[a-z][a-z0-9-]{0,20}$/.test(options.stage)) throw new Error("--stage must be a short lowercase name");
  if (options.app && !/^[a-z][a-z0-9-]{0,30}$/.test(options.app)) throw new Error("--app must be a short lowercase name");

  const r = terminal();
  const dir = resolve(options.dir ?? join(homedir(), ".flare-ota", "server"));
  const shown = dir.replace(homedir(), "~");
  const ref = options.ref ?? `v${cliVersion()}`;
  r.line(`\n  ${c.bold(c.flame("flare-ota"))} ${c.dim("setup")}  ${options.app ?? "flare-ota"} ${c.dim(`· ${options.stage}`)}\n`);

  await r.step(
    "Source",
    async (step) => {
      if (existsSync(join(dir, "packages", "server", "cloudflare.config.ts"))) return "existing";
      if (existsSync(dir)) throw new Error(`${shown} exists but is not a flare-ota checkout. Pass --dir <empty folder>.`);
      await captured("git", ["clone", "--depth", "1", "--branch", ref, REPO, dir], undefined, step.update).catch(() => {
        throw new Error(`could not fetch ${ref}. Pass --ref main for the latest source.`);
      });
      return "fetched";
    },
    (how) => (how === "existing" ? `${shown} ${c.dim("· already here (git pull to update)")}` : `${ref} ${c.dim(`→ ${shown}`)}`),
  );

  const pm = pnpm();
  await r.step("Dependencies", (step) => captured(pm[0]!, [...pm.slice(1), "install", "--frozen-lockfile"], dir, step.update), () => `installed ${c.dim(`with ${pm.join(" ")}`)}`);

  // Cloudflare login (OAuth in the browser), only when cf has no session yet.
  const serverDir = join(dir, "packages", "server");
  if (quiet("npx", ["--no-install", "cf", "accounts", "list"], serverDir)) {
    r.line(`  ${c.green("✓")} ${"Login".padEnd(14)}Cloudflare session found`);
  } else {
    r.line(`  ${c.flame("›")} ${"Login".padEnd(14)}opening your browser for Cloudflare`);
    if (!run("npx", ["--no-install", "cf", "auth", "login"], serverDir)) throw new Error("Cloudflare login failed.");
  }

  const forward = ["--stage", options.stage, ...(options.app ? ["--app", options.app] : [])];
  const result = spawnSync("node", [join(serverDir, "scripts", "setup.ts"), ...forward], { cwd: serverDir, stdio: "inherit", env: { ...process.env, FLARE_OTA_SETUP_WRAPPED: "1" } });
  // The server setup already explained what failed and how to resume.
  if (result.status !== 0) throw new ReportedError("setup stopped");
  r.line(`  ${c.dim(`Server source and settings: ${shown}  (cd there for pnpm server:* commands)`)}\n`);
}
