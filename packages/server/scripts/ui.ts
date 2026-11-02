// Terminal output for the setup scripts, in the CLI's palette: one accent, green checks, dim
// details. A spinner on an interactive terminal; plain lines in CI and pipes. NO_COLOR honoured.

import { spawn } from "node:child_process";

const live = Boolean(process.stdout.isTTY) && !process.env.CI;
const colors = !process.env.NO_COLOR && (live || Boolean(process.env.FORCE_COLOR));
const paint = (open: string) => (text: string) => (colors ? `\x1b[${open}m${text}\x1b[0m` : text);

export const c = {
  flame: paint("38;2;249;115;22"),
  green: paint("38;2;52;211;153"),
  red: paint("38;2;248;113;113"),
  yellow: paint("38;2;251;191;36"),
  dim: paint("2"),
  bold: paint("1"),
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WIDTH = 14;
const out = (text: string) => process.stdout.write(text);

export function header(title: string, meta: string) {
  out(`\n  ${c.bold(c.flame("flare-ota"))} ${c.dim(title)}  ${meta}\n`);
}

export function section(title: string, hint = "") {
  out(`\n  ${c.bold(title)}${hint ? `  ${c.dim(hint)}` : ""}\n`);
}

export const ok = (label: string, detail = "") => out(`  ${c.green("✓")} ${label.padEnd(WIDTH)}${detail}\n`);
export const warn = (text: string) => out(`  ${c.yellow("!")} ${c.yellow(text)}\n`);
export const fail = (label: string, detail: string) => out(`  ${c.red("✗")} ${label.padEnd(WIDTH)}${c.red(detail)}\n`);
export const note = (text: string) => out(`    ${c.dim(text)}\n`);
export const row = (label: string, value: string) => out(`    ${c.dim(label.padEnd(WIDTH))}${value}\n`);

function seconds(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Runs one step behind a spinner. `run` returns the summary shown after the check mark. On failure
 * the step turns red and the error propagates.
 */
export async function task<T>(label: string, run: (update: (detail: string) => void) => Promise<T>, summary?: (result: T) => string): Promise<T> {
  const started = performance.now();
  let detail = "";
  let frame = 0;
  const draw = () => out(`\r\x1b[2K  ${c.flame(FRAMES[frame++ % FRAMES.length]!)} ${label.padEnd(WIDTH)}${c.dim(detail)}`);
  const timer = live ? setInterval(draw, 80) : undefined;
  if (live) draw();
  const clear = () => {
    clearInterval(timer);
    if (live) out("\r\x1b[2K");
  };
  try {
    const result = await run((next) => (detail = next));
    clear();
    ok(label, `${summary?.(result) ?? ""}  ${c.dim(seconds(performance.now() - started))}`);
    return result;
  } catch (error) {
    clear();
    fail(label, (error as Error).message.split("\n")[0]!);
    if (error instanceof Error) Object.assign(error, { reported: true });
    throw error;
  }
}

/**
 * Runs a command with its output captured: the last line feeds the spinner, the whole log is
 * printed only if it fails. Returns the output.
 */
export function quietly(command: string, args: string[], options: { cwd?: string; update?: (line: string) => void } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const take = (chunk: Buffer) => {
      log += chunk.toString();
      const last = log.trimEnd().split("\n").at(-1)?.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (last) options.update?.(last.slice(0, 60));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve(log);
      // A script that failed with a clear message: show just that. Anything else: the whole log.
      const thrown = [...log.matchAll(/^Error: (.+)$/gm)].at(-1)?.[1];
      if (!thrown) process.stdout.write(`\n${c.dim(log.trimEnd())}\n\n`);
      reject(new Error(thrown ?? `${args[0]?.split("/").at(-1) ?? command} exited with ${code}`));
    });
  });
}

/** Ends the run on any uncaught error with one red line instead of a stack trace. */
export function exitCleanly() {
  const handle = (error: unknown) => {
    // A failed task already printed its red line: only say how to resume.
    if (error instanceof Error && "reported" in error) out(`\n    ${c.dim("Setup stopped. Fix this and rerun the same command: every step is reusable.")}\n\n`);
    else out(`\n  ${c.red("✗")} ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.exit(1);
  };
  process.on("uncaughtException", handle);
  process.on("unhandledRejection", handle);
}

/** `  ? Label  hint (default) ` — the prompt for one answer. */
export function question(label: string, hint: string, fallback?: string) {
  return `  ${c.flame("?")} ${c.bold(label)}${hint ? ` ${c.dim(hint)}` : ""}${fallback ? ` ${c.dim(`(${fallback})`)}` : ""} ${c.flame("›")} `;
}
