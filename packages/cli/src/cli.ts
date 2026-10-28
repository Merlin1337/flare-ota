#!/usr/bin/env node
import { parseArgs } from "node:util";
import { isPlatform, type GroupSummary, type Platform, type UpdateMetrics } from "@flare-ota/core";
import { Client, resolveClientOptions } from "./api.ts";
import { doctor } from "./doctor.ts";
import { init } from "./init.ts";
import { serveMcp } from "./mcp.ts";
import { publishUpdate } from "./publish.ts";
import { terminalQr } from "./qr.ts";

const HELP = `flare-ota — self-hosted OTA updates for Expo on Cloudflare

Usage: flare-ota <command> [options]

App setup
  init [--channel production] [--cert ./certs/certificate.pem]   Configure app.json for this server
  doctor                                                          Check app config, server, token and signing

Releases
  publish --branch <b> --message <m> [--platform ios|android] [--rollout <1-100>]
  groups [--branch <b>] [--limit n]                               List published update groups
  rollout <groupId> <percent>                                     Raise a rollout (it only goes up)
  pause <groupId> | resume <groupId>                              Stop / resume offering a group
  rollback --branch <b> [--to previous|embedded] [--platform p]   Republish the last good bundle
  promote <groupId> --branch <b> [--rollout <1-100>]              Copy a group to another branch
  preview <groupId> [--ttl <minutes>] [--scheme <scheme>]         Signed preview link + QR code

Operations
  metrics [--branch <b>] [--platform p]                           Adoption per update
  channels [set <channel> <branch>]                               List or repoint channels
  tokens [create <name> --scope read|publish|admin | revoke <id>] Manage API/MCP tokens
  audit [--limit n]                                               Recent administrative actions
  whoami                                                          Show the token's identity and scope
  mcp                                                             MCP server over stdio for local agents

Environment: FLARE_OTA_URL (updates server), FLARE_OTA_TOKEN (API token).
Options: --json for machine-readable output, --project <dir> (default: cwd), --server, --token.
Prefer FLARE_OTA_TOKEN over --token: command-line arguments are visible to other processes.`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    branch: { type: "string" },
    message: { type: "string", short: "m" },
    platform: { type: "string" },
    rollout: { type: "string" },
    to: { type: "string" },
    ttl: { type: "string" },
    scheme: { type: "string" },
    scope: { type: "string" },
    limit: { type: "string" },
    channel: { type: "string" },
    cert: { type: "string" },
    project: { type: "string" },
    server: { type: "string" },
    token: { type: "string" },
    json: { type: "boolean" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const json = Boolean(flags.json);
const projectDir = flags.project ?? process.cwd();
const log = (line: string) => {
  if (!json) process.stderr.write(`${line}\n`);
};
const out = (data: unknown, text: () => string) => {
  process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : `${text()}\n`);
};

function client() {
  return new Client(resolveClientOptions({ server: flags.server, token: flags.token }));
}

function platforms(): Platform[] {
  if (!flags.platform) return ["ios", "android"];
  if (!isPlatform(flags.platform)) throw new Error("--platform must be ios or android.");
  return [flags.platform];
}

function percent(value: string | undefined, fallback: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("Percentages are integers from 1 to 100.");
  return n;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}. See flare-ota --help.`);
  return value;
}

const describeGroup = (g: GroupSummary) =>
  `${g.id}  ${g.branch}  ${g.createdAt.slice(0, 16).replace("T", " ")}  ${g.kind === "rollback-embedded" ? "[rollback to embedded] " : ""}${g.message}\n` +
  g.updates.map((u) => `    ${u.platform.padEnd(8)} runtime ${u.runtimeVersion}  rollout ${u.paused ? "paused" : `${u.rolloutPercent}%`}  ${u.id}`).join("\n");

async function main() {
  const [command, ...args] = positionals;
  if (!command || flags.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (flags.token) process.stderr.write("Warning: --token is visible in the process list; prefer FLARE_OTA_TOKEN.\n");

  switch (command) {
    case "init": {
      const server = resolveClientOptions({ server: flags.server, token: flags.token }).server;
      const notes = await init({ projectDir, server, channel: flags.channel ?? "production", certificate: flags.cert ?? "./certs/certificate.pem" });
      out({ notes }, () => notes.join("\n"));
      return;
    }
    case "doctor": {
      const checks = await doctor(projectDir, client());
      out(checks, () => checks.map((c) => `${c.ok ? "✓" : c.warn ? "!" : "✗"} ${c.name}: ${c.detail}`).join("\n"));
      if (checks.some((c) => !c.ok && !c.warn)) process.exitCode = 1;
      return;
    }
    case "publish": {
      const group = await publishUpdate(client(), {
        projectDir,
        branch: need(flags.branch, "--branch"),
        message: need(flags.message, "--message"),
        platforms: platforms(),
        rolloutPercent: percent(flags.rollout, 100),
        force: Boolean(flags.force),
        log,
      });
      out(group, () => `Published\n${describeGroup(group)}`);
      return;
    }
    case "groups": {
      const query = new URLSearchParams({ limit: flags.limit ?? "20", ...(flags.branch ? { branch: flags.branch } : {}) });
      const groups = await client().get<GroupSummary[]>(`/api/v1/groups?${query}`);
      out(groups, () => groups.map(describeGroup).join("\n") || "No update groups.");
      return;
    }
    case "rollout": {
      const group = await client().post<GroupSummary>(`/api/v1/groups/${need(args[0], "groupId")}/rollout`, { percent: percent(args[1], 0) });
      out(group, () => describeGroup(group));
      return;
    }
    case "pause":
    case "resume": {
      const group = await client().post<GroupSummary>(`/api/v1/groups/${need(args[0], "groupId")}/${command}`);
      out(group, () => describeGroup(group));
      return;
    }
    case "rollback": {
      const to = flags.to ?? "previous";
      if (to !== "previous" && to !== "embedded") throw new Error("--to must be previous or embedded.");
      const group = await client().post<GroupSummary>(`/api/v1/branches/${encodeURIComponent(need(flags.branch, "--branch"))}/rollback`, {
        to,
        platform: flags.platform ? platforms()[0] : null,
      });
      out(group, () => `Rolled back\n${describeGroup(group)}`);
      return;
    }
    case "promote": {
      const group = await client().post<GroupSummary>(`/api/v1/groups/${need(args[0], "groupId")}/promote`, {
        branch: need(flags.branch, "--branch"),
        rolloutPercent: percent(flags.rollout, 100),
      });
      out(group, () => `Promoted\n${describeGroup(group)}`);
      return;
    }
    case "preview": {
      const preview = await client().post<{ deepLink: string; expiresAt: string; token: string }>("/api/v1/previews", {
        groupId: need(args[0], "groupId"),
        ttlMinutes: Number(flags.ttl ?? 60),
        ...(flags.scheme ? { scheme: flags.scheme } : {}),
      });
      out(preview, () => `${terminalQr(preview.deepLink)}\n\n${preview.deepLink}\nExpires ${preview.expiresAt}`);
      return;
    }
    case "metrics": {
      const query = new URLSearchParams({ ...(flags.branch ? { branch: flags.branch } : {}), ...(flags.platform ? { platform: flags.platform } : {}) });
      const metrics = await client().get<UpdateMetrics[]>(`/api/v1/metrics?${query}`);
      out(metrics, () =>
        metrics
          .map((m) => `${m.updateId}  ${m.platform.padEnd(8)} ${m.paused ? "paused" : `${m.rolloutPercent}%`.padStart(4)}  running ${m.running}/${m.population}  served ${m.served}  failed ${m.failed}`)
          .join("\n") || "No updates yet.",
      );
      return;
    }
    case "channels": {
      if (args[0] === "set") {
        await client().request("PUT", `/api/v1/channels/${encodeURIComponent(need(args[1], "channel"))}`, { branch: need(args[2], "branch") });
      }
      const channels = await client().get<{ name: string; branch: string }[]>("/api/v1/channels");
      out(channels, () => channels.map((c) => `${c.name} → ${c.branch}`).join("\n"));
      return;
    }
    case "tokens": {
      const c = client();
      if (args[0] === "create") {
        const created = await c.post<{ id: string; token: string }>("/api/v1/tokens", { name: need(args[1], "token name"), scope: flags.scope ?? "publish" });
        out(created, () => `Created ${flags.scope ?? "publish"} token ${created.id}. Store it now, it is not shown again:\n${created.token}`);
        return;
      }
      if (args[0] === "revoke") {
        await c.request("DELETE", `/api/v1/tokens/${encodeURIComponent(need(args[1], "token id"))}`);
        out({ ok: true }, () => "Revoked.");
        return;
      }
      const tokens = await c.get<{ id: string; name: string; scope: string; lastUsedAt: string | null; revokedAt: string | null }[]>("/api/v1/tokens");
      out(tokens, () => tokens.map((t) => `${t.id}  ${t.scope.padEnd(7)} ${t.name}${t.revokedAt ? " (revoked)" : ""}  last used ${t.lastUsedAt ?? "never"}`).join("\n"));
      return;
    }
    case "audit": {
      const entries = await client().get<{ at: string; actor: string; action: string; target: string | null }[]>(`/api/v1/audit?limit=${flags.limit ?? "50"}`);
      out(entries, () => entries.map((e) => `${e.at.slice(0, 19).replace("T", " ")}  ${e.actor}  ${e.action}  ${e.target ?? ""}`).join("\n"));
      return;
    }
    case "whoami": {
      const me = await client().get<{ actor: string; scope: string }>("/api/v1/whoami");
      out(me, () => `${me.actor} (${me.scope})`);
      return;
    }
    case "mcp":
      await serveMcp(client());
      return;
    default:
      throw new Error(`Unknown command ${command}. See flare-ota --help.`);
  }
}

main().catch((error: Error) => {
  if (json) process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
  else process.stderr.write(`flare-ota: ${error.message}\n`);
  process.exitCode = 1;
});
