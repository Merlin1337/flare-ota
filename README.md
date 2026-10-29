# flare-ota

**Self-hosted OTA updates for Expo, 100% on Cloudflare.** A drop-in server for the standard
`expo-updates` client: no fork, no custom native SDK, no EAS Update. Deploy it on your own
Cloudflare account in a few commands.

- **Expo Updates protocol v1**, signed manifests (code signing), channels and branches
- **Progressive rollouts**, pause, rollback (previous bundle or embedded JS), promote between channels
- **Preview links**: a signed, expiring QR code that puts one device on a given release, outside the rollout
- **Dashboard** behind Cloudflare Access with adoption metrics (served / running / failed per update)
- **CLI** for local use and CI (`--json` everywhere)
- **MCP server**: drive publish, rollouts, rollbacks and metrics from Claude, Cursor or any MCP client
- **Content-addressed assets** cached at the edge, daily garbage collection
- **Security by default**: scoped hashed tokens, verified Access JWTs, audit log, WAF rules, bounded inputs

```
          expo-updates (iOS / Android)                     you, CI, AI agents
                     │  GET /manifest, /assets/:hash             │  CLI · REST · MCP
                     ▼                                           ▼
   ┌──────────────── Cloudflare ────────────────────────────────────────────────┐
   │  WAF + rate limit ─▶ Worker (flare-ota) ◀─ Access ─ dashboard host          │
   │                       │        │        │                                   │
   │                      D1       R2   Analytics Engine*    cron: GC            │
   │              (updates, devices,  (bundles,  (optional raw events)            │
   │               tokens, audit)     assets)                                     │
   └──────────────────────────────────────────────────────────────────────────────┘
```

> Status: **beta**. The protocol, rollout, rollback, preview and security paths are covered by
> tests; the configuration format of Cloudflare's `cf` CLI is itself in open beta.

## Quick start

You need a Cloudflare account with a domain on it, Node 24.22+ and pnpm.

```sh
git clone https://github.com/Merlin1337/flare-ota && cd flare-ota
pnpm install
npx cf auth login                                         # Cloudflare's new CLI
pnpm server:setup --stage production   # guided: Access, D1, deploy, token, WAF
```

Then, in your Expo app:

```sh
npx expo install expo-updates
npm i -D flare-ota
cp ~/.flare-ota/flare-ota/certificate.pem certs/certificate.pem   # printed by setup
FLARE_OTA_URL=https://ota.example.com npx flare-ota init --channel production
# build and install a release binary, then:
FLARE_OTA_URL=https://ota.example.com FLARE_OTA_TOKEN=fota_… npx flare-ota publish --branch production --message "Fix checkout"
npx flare-ota doctor
```

Full walkthrough: [docs/quick-start.md](docs/quick-start.md).

## Documentation

| | |
|---|---|
| [Quick start](docs/quick-start.md) | Deploy the server, connect an app, publish, roll back |
| [Expo app integration](docs/expo-app.md) | app.json, certificates, channels, staging builds, preview links, gotchas |
| [CI](docs/ci.md) | GitHub Actions: publish on push, production on demand, deploy the server |
| [MCP](docs/mcp.md) | Remote (Streamable HTTP) and local (stdio) MCP, the tool list |
| [Costs and limits](docs/costs.md) | Free tier vs Workers Paid, what each request costs |
| [Security](docs/security.md) | Threat model and protections |
| [Example app](examples/expo-app) | Minimal Expo app to test publish → update → rollback |
| [Claude skill](skills/flare-ota/SKILL.md) | Lets Claude set up and operate flare-ota for an Expo app |

## Commands at a glance

```sh
flare-ota publish --branch production --message "…" [--rollout 10]
flare-ota rollout <groupId> 50          # only goes up
flare-ota pause <groupId>               # stop offering it to new devices
flare-ota rollback --branch production [--to embedded]
flare-ota promote <groupId> --branch production
flare-ota preview <groupId> --ttl 60    # QR code in the terminal
flare-ota metrics --branch production
flare-ota mcp                           # stdio MCP for local agents
```

## Inspired by

flare-ota is a new implementation, built from the designs of
[focux/open-ota](https://github.com/focux/open-ota) (Cloudflare-native protocol server) and
[dnlsilva/open-ota](https://github.com/dnlsilva/open-ota) (MCP, preview links, metrics).
A few functions are adapted from focux/open-ota under its MIT license; see [NOTICE.md](NOTICE.md).

## License

MIT
