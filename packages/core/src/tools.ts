// MCP tool contract. The server implements every tool over Streamable HTTP (/mcp);
// `flare-ota mcp` proxies them over stdio and adds `publish_update`, which needs local files.

import type { Scope } from "./model.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  scope: Scope;
  readOnly: boolean;
  inputSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties: false;
  };
}

const groupId = { type: "string", description: "Update group id (UUID), as listed by list_groups." };
const branch = { type: "string", description: "Branch name, e.g. production." };
const platform = { type: "string", enum: ["ios", "android"] };

function tool(name: string, scope: Scope, description: string, properties: ToolDefinition["inputSchema"]["properties"] = {}, required: string[] = []): ToolDefinition {
  return {
    name,
    description,
    scope,
    readOnly: scope === "read",
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
  };
}

export const SERVER_TOOLS: ToolDefinition[] = [
  tool("get_overview", "read", "Channels and their branches, active devices, runtime versions in the fleet, and the latest update groups."),
  tool("list_channels", "read", "List channels and the branch each one serves."),
  tool("list_groups", "read", "List published update groups on a branch, newest first.", {
    branch,
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  }, ["branch"]),
  tool("get_group", "read", "Details of one update group: message, commit, actor, per-platform updates and rollout.", { groupId }, ["groupId"]),
  tool("get_metrics", "read", "Adoption per update: devices served, running, failed, out of the eligible population.", {
    branch,
    platform,
    limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
  }),
  tool("get_audit_log", "read", "Recent administrative actions with their actor.", {
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  }),
  tool("set_rollout", "admin", "Raise the rollout percentage of an update group (it can only increase; roll back instead of lowering).", {
    groupId,
    percent: { type: "integer", minimum: 1, maximum: 100 },
  }, ["groupId", "percent"]),
  tool("pause_group", "admin", "Stop offering an update group to devices that do not run it yet. Devices already on it keep it.", { groupId }, ["groupId"]),
  tool("resume_group", "admin", "Resume offering a paused update group.", { groupId }, ["groupId"]),
  tool("rollback", "admin", "Roll a branch back: republish the previous bundle, or send devices back to the JS embedded in their build.", {
    branch,
    platform,
    to: { type: "string", enum: ["previous", "embedded"], default: "previous" },
  }, ["branch"]),
  tool("promote_group", "admin", "Copy a tested update group to another branch (e.g. staging to production), with an optional starting rollout.", {
    groupId,
    branch: { ...branch, description: "Destination branch." },
    rolloutPercent: { type: "integer", minimum: 1, maximum: 100, default: 100 },
  }, ["groupId", "branch"]),
  tool("set_channel", "admin", "Point a channel at a branch (creates the channel if needed).", {
    channel: { type: "string" },
    branch,
  }, ["channel", "branch"]),
  tool("create_preview_link", "admin", "Signed, expiring deep link (and QR code) that makes one device run a given update group, outside the rollout.", {
    groupId,
    ttlMinutes: { type: "integer", minimum: 1, maximum: 10080, default: 60 },
    scheme: { type: "string", description: "App URL scheme; defaults to the server's APP_SCHEME." },
  }, ["groupId"]),
];

export const LOCAL_TOOLS: ToolDefinition[] = [
  tool("publish_update", "publish", "Export the Expo app in projectDir and publish it as a new update group.", {
    projectDir: { type: "string", description: "Absolute path of the Expo app." },
    branch,
    message: { type: "string" },
    platform,
    rolloutPercent: { type: "integer", minimum: 1, maximum: 100, default: 100 },
  }, ["projectDir", "branch", "message"]),
];
