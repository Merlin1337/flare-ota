# Quick start

From zero to an update on a device. Budget 20 minutes, plus one native build.

## 0. Prerequisites

- A Cloudflare account with a domain (zone) on it. Workers Free is enough to start; see [costs](costs.md).
- Zero Trust enabled on the account (free up to 50 users): https://one.dash.cloudflare.com → pick a team name.
- Node 24.22+ and pnpm 10 (`corepack enable`), `openssl` (preinstalled on macOS and Linux).
- An Expo app on SDK 52 or newer.

## 1. Deploy the server

```sh
git clone https://github.com/Merlin1337/flare-ota && cd flare-ota
pnpm install
npx cf auth login
pnpm --filter @flare-ota/server setup -- --stage production
```

`setup` asks for your account ID, two hostnames (updates and dashboard), the emails allowed on the
dashboard and your app's URL scheme, then:

1. generates the code-signing key **in memory** and the certificate your app embeds
   (macOS: the key goes to the login keychain; Linux: a 0600 file you move to your password manager);
2. creates the Cloudflare Access application for the dashboard;
3. creates the D1 database, applies migrations, deploys the Worker with its secrets;
4. prints a first **admin** token, once;
5. optionally applies the WAF rules; then runs `doctor`.

Everything it does is a script you can rerun on its own (`packages/server/scripts/`):
`access`, `migrate`, `deploy`, `bootstrap-token`, `waf`, `deploy-token`, `doctor`.

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
FLARE_OTA_TOKEN=<admin token> npx flare-ota tokens create laptop --scope publish
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
