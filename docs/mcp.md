# MCP

flare-ota speaks the Model Context Protocol, so an agent can inspect releases and act on them:
"how is yesterday's release doing?", "raise it to 50%", "roll production back".

## Remote (Streamable HTTP)

The server exposes `POST https://<updates-host>/mcp`, authenticated with a flare-ota token. The
token's scope decides which tools the agent sees: give it **read** to explore safely, **admin**
to let it change rollouts.

Claude Code:

```sh
claude mcp add --transport http flare-ota https://ota.example.com/mcp \
  --header "Authorization: Bearer $FLARE_OTA_TOKEN"
```

## Local (stdio)

`flare-ota mcp` forwards every tool to the server and adds `publish_update`, which exports and
publishes the app from a local directory (the remote server never reads files):

```json
{
  "mcpServers": {
    "flare-ota": {
      "command": "npx",
      "args": ["flare-ota", "mcp"],
      "env": { "FLARE_OTA_URL": "https://ota.example.com", "FLARE_OTA_TOKEN": "fota_…" }
    }
  }
}
```

## Tools

| Tool | Scope | |
|---|---|---|
| `get_overview` | read | Channels, active devices, runtimes, latest groups |
| `list_channels` | read | Channel → branch |
| `list_groups` | read | Groups on a branch |
| `get_group` | read | One group: message, commit, actor, per-platform rollout |
| `get_metrics` | read | Served / running / failed per update, out of the eligible devices |
| `get_audit_log` | read | Who did what |
| `set_rollout` | admin | Raise a rollout (never lowers) |
| `pause_group` / `resume_group` | admin | Stop / resume offering a group |
| `rollback` | admin | Previous bundle or embedded JS |
| `promote_group` | admin | Copy a group to another branch |
| `set_channel` | admin | Point a channel at a branch |
| `create_preview_link` | admin | Signed deep link for one device |
| `publish_update` | publish | stdio only: export and publish from a local project |

Every action is recorded in the audit log with the token's name.
