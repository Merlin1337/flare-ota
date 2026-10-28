// Remote MCP server (Streamable HTTP, stateless JSON responses), authenticated with the same
// scoped bearer tokens as the REST API. Tools come from @flare-ota/core so the stdio proxy in
// the CLI exposes exactly the same contract.

import { SERVER_TOOLS, isPlatform, type ToolDefinition } from "@flare-ota/core";
import { allows, type Principal } from "./auth.ts";
import type { Env } from "./env.ts";
import { Invalid, type Services } from "./services.ts";
import { Conflict, NotFound, type Store } from "./store.ts";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = "0.1.0";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type Args = Record<string, unknown>;
type Handler = (args: Args, principal: Principal) => Promise<unknown>;

function str(args: Args, key: string, fallback?: string): string {
  const value = args[key] ?? fallback;
  if (typeof value !== "string" || value === "") throw new Invalid(`${key} is required.`);
  return value;
}

function int(args: Args, key: string, fallback: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Invalid(`${key} must be an integer.`);
  return value;
}

function optionalPlatform(args: Args) {
  const value = args.platform ?? null;
  if (value !== null && !isPlatform(value)) throw new Invalid("platform must be ios or android.");
  return value;
}

export function toolHandlers(store: Store, services: Services): Record<string, Handler> {
  return {
    get_overview: () => store.overview(),
    list_channels: () => store.listChannels(),
    list_groups: (a) => store.groups(str(a, "branch"), Math.min(int(a, "limit", 20), 100)),
    get_group: async (a) => (await store.group(str(a, "groupId"))) ?? Promise.reject(new NotFound("Update group not found.")),
    get_metrics: (a) => store.metrics((a.branch as string | undefined) ?? null, optionalPlatform(a), Math.min(int(a, "limit", 10), 50)),
    get_audit_log: (a) => store.auditLog(Math.min(int(a, "limit", 50), 200)),
    set_rollout: (a, p) => services.setRollout(str(a, "groupId"), int(a, "percent", 0), p.actor),
    pause_group: (a, p) => services.setPaused(str(a, "groupId"), true, p.actor),
    resume_group: (a, p) => services.setPaused(str(a, "groupId"), false, p.actor),
    rollback: (a, p) => {
      const to = str(a, "to", "previous");
      if (to !== "previous" && to !== "embedded") throw new Invalid("to must be previous or embedded.");
      return services.rollback(str(a, "branch"), optionalPlatform(a), to, p.actor);
    },
    promote_group: (a, p) => services.promote(str(a, "groupId"), str(a, "branch"), int(a, "rolloutPercent", 100), p.actor),
    set_channel: async (a, p) => {
      await services.setChannel(str(a, "channel"), str(a, "branch"), p.actor);
      return { ok: true };
    },
    create_preview_link: (a, p) => services.createPreview(str(a, "groupId"), int(a, "ttlMinutes", 60), (a.scheme as string | undefined) ?? null, p.actor),
  };
}

function rpcResult(id: RpcRequest["id"], result: unknown) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function visibleTools(principal: Principal): ToolDefinition[] {
  return SERVER_TOOLS.filter((tool) => allows(principal, tool.scope));
}

export async function handleMcp(request: Request, principal: Principal, store: Store, services: Services, _env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Use POST (Streamable HTTP, JSON responses).", { status: 405, headers: { allow: "POST" } });
  let message: RpcRequest;
  try {
    const text = await request.text();
    if (text.length > 1024 * 1024) return rpcError(null, -32600, "Request too large.");
    message = JSON.parse(text) as RpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error.");
  }
  if (Array.isArray(message) || message?.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(null, -32600, "Invalid request.");
  // Notifications get no response body.
  if (message.id === undefined) return new Response(null, { status: 202 });

  switch (message.method) {
    case "initialize": {
      const requested = String(message.params?.protocolVersion ?? "");
      return rpcResult(message.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "flare-ota", version: VERSION },
        instructions: "Manage Expo OTA updates: inspect channels, groups and adoption metrics, change rollouts, pause, roll back, promote, and create preview links.",
      });
    }
    case "ping":
      return rpcResult(message.id, {});
    case "tools/list":
      return rpcResult(message.id, {
        tools: visibleTools(principal).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly && tool.name === "rollback" },
        })),
      });
    case "tools/call": {
      const name = String(message.params?.name ?? "");
      const tool = SERVER_TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(message.id, -32602, `Unknown tool ${name}.`);
      if (!allows(principal, tool.scope)) return rpcResult(message.id, toolError(`This token needs the ${tool.scope} scope for ${name}.`));
      const args = (message.params?.arguments ?? {}) as Args;
      if (typeof args !== "object" || args === null || Array.isArray(args)) return rpcError(message.id, -32602, "arguments must be an object.");
      try {
        const result = await toolHandlers(store, services)[name]!(args, principal);
        return rpcResult(message.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: wrap(result) });
      } catch (error) {
        if (error instanceof Invalid || error instanceof NotFound || error instanceof Conflict) return rpcResult(message.id, toolError(error.message));
        console.error(error);
        return rpcResult(message.id, toolError("Internal error."));
      }
    }
    default:
      return rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function toolError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

/** structuredContent must be an object. */
function wrap(result: unknown): Record<string, unknown> {
  return typeof result === "object" && result !== null && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
}
