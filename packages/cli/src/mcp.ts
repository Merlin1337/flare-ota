// `flare-ota mcp`: a stdio MCP server for local agents (Claude Code, Cursor…). It forwards every
// tool to the server's remote /mcp endpoint, so both transports share one contract, and adds
// `publish_update`, which needs the app's files on this machine.

import { createInterface } from "node:readline";
import { LOCAL_TOOLS, isPlatform, type Platform } from "@flare-ota/core";
import type { Client } from "./api.ts";
import { publishUpdate } from "./publish.ts";

interface RpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

export async function serveMcp(client: Client): Promise<void> {
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const remote = async (message: RpcMessage) => {
    const response = await fetch(`${client.options.server}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${client.options.token ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (response.status === 202) return null;
    if (!response.ok) return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32000, message: `flare-ota server: HTTP ${response.status}` } };
    return response.json();
  };

  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: RpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
      continue;
    }
    try {
      if (message.method === "tools/list") {
        const result = (await remote(message)) as { result?: { tools: unknown[] } } | null;
        const tools = [...(result?.result?.tools ?? []), ...LOCAL_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))];
        send({ jsonrpc: "2.0", id: message.id, result: { tools } });
      } else if (message.method === "tools/call" && message.params?.name === "publish_update") {
        const args = message.params.arguments ?? {};
        const platform = args.platform;
        const platforms: Platform[] = platform && isPlatform(platform) ? [platform] : ["ios", "android"];
        try {
          const group = await publishUpdate(client, {
            projectDir: String(args.projectDir),
            branch: String(args.branch),
            message: String(args.message),
            platforms,
            rolloutPercent: Number(args.rolloutPercent ?? 100),
          });
          send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] } });
        } catch (error) {
          send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: (error as Error).message }], isError: true } });
        }
      } else {
        const result = await remote(message);
        if (result !== null && message.id !== undefined) send(result);
      }
    } catch (error) {
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: (error as Error).message } });
    }
  }
}
