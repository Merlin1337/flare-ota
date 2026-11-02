# Quick start

From zero to an update on a device. Budget 20 minutes, plus one native build.

## 0. Prerequisites

- A Cloudflare account with a domain (zone) on it. Workers Free is enough to start; see [costs](costs.md).
- Two one-time switches in the Cloudflare dashboard, for that account (cf cannot flip them):
  - **Zero Trust**: https://one.dash.cloudflare.com → pick a team name, Free plan (up to 50 users).
  - **R2**: dashboard → R2 Object Storage → enable (free tier: 10 GB). Cloudflare may ask for a
    payment method even for free usage.
- Node 24.22+ and pnpm 10 (`corepack enable`), `openssl` (preinstalled on macOS and Linux).
- An Expo app on SDK 52 or newer.

## 1. Deploy the server

```sh
npx flare-ota setup --stage production
```

This fetches the server source at the CLI's version into `~/.flare-ota/server` (`--dir` to choose),
installs it with pnpm, opens the Cloudflare login if needed, then runs the guided setup. From a
clone of this repo, `pnpm install && npx cf auth login && pnpm server:setup --stage production` is
the same thing. Later deploys run from that folder: `pnpm server:deploy --stage production`.

Cloudflare login is OAuth in your browser: no API key to create or paste. `setup` picks your
account from that login (a numbered list if you have several), asks for two hostnames (updates and
dashboard), the emails allowed on the dashboard and your app's URL scheme, then:

1. generates the code-signing key **in memory** and the certificate your app embeds
   (macOS: the key goes to the login keychain; Linux: a 0600 file you move to your password manager);
2. creates the Cloudflare Access application for the dashboard;
3. creates the D1 database, applies migrations, deploys the Worker with its secrets;
4. creates a first **admin** token: on macOS it goes to the login keychain
   (`flare-ota.<name>.admin-token`, account `flare-ota`) and is never printed; elsewhere, or with
   `bootstrap-token --print`, it is printed once;
5. optionally applies the WAF rules; then runs `doctor`.

Everything it does is a script you can rerun on its own (`packages/server/scripts/`):
`access`, `migrate`, `deploy`, `bootstrap-token`, `waf`, `deploy-token`, `doctor`.

**One server per app.** For a second app, pass `--app <name>` to `setup` and to every script
(`pnpm server:deploy --stage production --app myapp`): it gets its own Worker, database, bucket,
settings file (`.env.<name>.<stage>`), certificate folder (`~/.flare-ota/<name>/`) and keychain entries.

**Without prompts** (CI, or an agent preparing the run): every answer can come from the
environment instead: `CLOUDFLARE_ACCOUNT_ID`, `FLARE_OTA_UPDATES_HOST`, `FLARE_OTA_DASHBOARD_HOST`,
`FLARE_OTA_ACCESS_EMAILS`, `FLARE_OTA_APP_SCHEME`. With stdin closed, setup accepts the defaults and
stops on anything it still needs.

**Using an AI agent?** Setup creates DNS records, an Access application and WAF rules on your zone.
Agents that guard infrastructure changes (Claude Code's auto mode, for one) will refuse it: run
setup yourself, then let the agent take over.

Back up the signing key now. Installed apps only trust its certificate: losing the key means a
new store build for everyone.

## 2. Connect your app

```sh
cd your-expo-app
npx expo install expo-updates
npm i -D flare-ota
mkdir -p certs && cp ~/.flare-ota/flare-ota/certificate.pem certs/
export FLARE_OTA_URL=https://ota.example.com
npx flare-ota init --channel production
```

`init` writes `updates.url`, the channel, the code-signing settings, the `flare-preview` header and
a `fingerprint` runtime policy into `app.json`. These are native settings: **build and install a
new release binary** (`npx expo run:ios --configuration Release`, EAS Build, your CI…).

Create a token for publishing, in the dashboard (Tokens) or with the admin token:

```sh
FLARE_OTA_TOKEN="$(security find-generic-password -s flare-ota.flare-ota.admin-token -a flare-ota -w)" \
  npx flare-ota tokens create laptop --scope publish
```

## 3. Publish

```sh
export FLARE_OTA_TOKEN=fota_…            # publish token
npx flare-ota doctor                      # config, server, token, and signature vs your certificate
npx flare-ota publish --branch production --message "First OTA"
```

Open the app, close it, open it again: expo-updates downloads on launch and applies on the next
start. The dashboard shows the device moving to the new update.

## 4. Roll out, roll back

```sh
npx flare-ota publish --branch production --message "Risky change" --rollout 10
npx flare-ota metrics --branch production
npx flare-ota rollout <groupId> 50
npx flare-ota rollback --branch production            # back to the previous bundle
npx flare-ota rollback --branch production --to embedded
```

Next: [CI](ci.md), [preview links and staging builds](expo-app.md), [MCP](mcp.md).
