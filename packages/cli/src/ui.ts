// Terminal output: a spinner and live detail on an interactive terminal, one final line per step
// everywhere else (CI logs, pipes), nothing at all for --json. Colors follow NO_COLOR / FORCE_COLOR.

const live = Boolean(process.stderr.isTTY) && !process.env.CI;
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
const TITLE_WIDTH = 14;

export interface Step {
  /** Live detail next to the spinner (progress, current file…). Ignored off a TTY. */
  update(detail: string): void;
}

export interface Reporter {
  /** Runs one step; `done` turns its result into the summary printed after the check mark. */
  step<T>(title: string, run: (step: Step) => Promise<T>, done?: (result: T) => string | undefined): Promise<T>;
  warn(line: string): void;
  line(text?: string): void;
}

/** Marks an error whose message the reporter already printed, so the CLI does not repeat it. */
export class ReportedError extends Error {}

export const silent: Reporter = {
  step: (_title, run) => run({ update() {} }),
  warn() {},
  line() {},
};

function seconds(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function terminal(write: (text: string) => void = (text) => process.stderr.write(text)): Reporter {
  return {
    async step(title, run, done) {
      const started = performance.now();
      let detail = "";
      let frame = 0;
      const draw = () => write(`\r\x1b[2K  ${c.flame(FRAMES[frame++ % FRAMES.length]!)} ${title.padEnd(TITLE_WIDTH)}${c.dim(detail)}`);
      const timer = live ? setInterval(draw, 80) : undefined;
      if (live) draw();
      const finish = (mark: string, text: string) => {
        clearInterval(timer);
        write(`${live ? "\r\x1b[2K" : ""}  ${mark} ${title.padEnd(TITLE_WIDTH)}${text}  ${c.dim(seconds(performance.now() - started))}\n`);
      };
      try {
        const result = await run({
          update(next) {
            detail = next;
          },
        });
        finish(c.green("✓"), done?.(result) ?? "");
        return result;
      } catch (error) {
        finish(c.red("✗"), c.red((error as Error).message));
        throw new ReportedError((error as Error).message);
      }
    },
    warn(text) {
      write(`  ${c.yellow("!")} ${" ".repeat(TITLE_WIDTH)}${c.yellow(text)}\n`);
    },
    line(text = "") {
      write(`${text}\n`);
    },
  };
}

/** Plain-text lines, for MCP tool results and tests. */
export function recorder(): Reporter & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    async step(title, run, done) {
      try {
        const result = await run({ update() {} });
        lines.push(`✓ ${title}${done ? `: ${done(result) ?? ""}` : ""}`);
        return result;
      } catch (error) {
        lines.push(`✗ ${title}: ${(error as Error).message}`);
        throw error;
      }
    },
    warn(text) {
      lines.push(`! ${text}`);
    },
    line(text = "") {
      lines.push(text);
    },
  };
}

export function progressBar(done: number, total: number, width = 22) {
  const filled = total > 0 ? Math.round((done / total) * width) : width;
  return c.flame("━".repeat(filled)) + c.dim("─".repeat(width - filled));
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const short = (id: string) => id.slice(0, 8);
