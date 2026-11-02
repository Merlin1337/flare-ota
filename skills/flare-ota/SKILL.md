---
name: flare-ota
description: Set up and operate self-hosted Expo OTA updates with flare-ota on Cloudflare — deploy the server, connect an Expo app (expo-updates), publish, roll out, roll back, preview links, CI and MCP. Use when the user wants OTA / over-the-air / CodePush-style updates for an Expo or React Native app without EAS Update, or mentions flare-ota.
---

# flare-ota

flare-ota is a self-hosted server for the standard `expo-updates` client, running on the user's
own Cloudflare account (Workers + D1 + R2 + Access). Repo: https://github.com/Merlin1337/flare-ota.
Read its `docs/` for details; this skill is the operating procedure.

## Rules

- **Secrets never appear in output, files or argv.** The signing key, preview secret, API tokens
  and Cloudflare tokens live in the OS keychain, a password manager or CI secrets, and reach
  commands through environment variables. Read them inline (`FLARE_OTA_TOKEN="$(security find-generic-password … -w)" npx flare-ota …`);
  never `echo` them, never write them to `.env*`, never commit them.
- **Production changes need the user's explicit go**: publishing to the production branch, raising
  a production rollout, rollback, promote to production, channel changes. Staging and read-only
  commands do not.
- Tokens get the smallest scope that works: `publish` for CI, `read` for agents that only look,
  `admin` only for people/agents that operate releases.
- Never disable code signing, never set `INSECURE_DASHBOARD` outside local development, never
  enable `workers.dev` on the Worker.

## Deploy the server (once per stage)

Prerequisites: a Cloudflare account with a zone, Zero Trust and R2 enabled once in the dashboard
(both have free tiers; the user must click them), Node 24.22+, pnpm, openssl. If one is missing, say exactly what the user must do (e.g. "open one.dash.cloudflare.com
and pick a team name") and wait.

```sh
npx flare-ota setup --stage production [--app <name>]   # fetches the server into ~/.flare-ota/server, installs, logs in, guides
```

Cloudflare login is OAuth in the browser (`cf auth login`, opened by setup when needed): never ask
the user for an API key or account ID; setup reads the account from the login. To prefill answers,
pass `FLARE_OTA_UPDATES_HOST`, `FLARE_OTA_DASHBOARD_HOST`, `FLARE_OTA_ACCESS_EMAILS`,
`FLARE_OTA_APP_SCHEME` (and `CLOUDFLARE_ACCOUNT_ID` if they have several accounts) as environment
variables in the command you hand over.

**Hand setup to the user.** It creates DNS records, an Access application and WAF rules on their
zone; agent permission systems often block that, and it is theirs to approve anyway. Give them the
exact command to run themselves (in Claude Code, prefixed with `!`), then continue from its output.
The same goes for `access`, `waf` and `deploy-token`.

One server serves one app. For a second app, use `--app <name>` on setup and every
`pnpm server:*` script: it keeps its own Worker, database, settings file, certificate and keychain entries.

Setup creates a first admin token. On macOS it is stored in the keychain as
`flare-ota.<name>.admin-token` (account `flare-ota`) and never printed: read it inline when needed.
Elsewhere it is printed once (`--print` forces that): ask the user to store it in their password
manager, never paste it back into the conversation. Tell the user to back up the signing key (`security find-generic-password -s flare-ota.<name>.signing-key-b64 -a flare-ota -w | pbcopy`
on macOS): losing it means a store build for every user.

## Upgrade

When `publish` or `doctor` says the server is older than the CLI: `npx flare-ota upgrade [--stage …] [--app …]`.
It redeploys with the existing settings and keychain secrets, applies migrations, then checks
`/health`. It is a production deploy: ask the user first, and hand it over like setup if your
permissions block it.

## Connect an Expo app

1. `npx expo install expo-updates` and `npm i flare-ota` in the app.
2. Copy the certificate printed by setup to `certs/certificate.pem`; commit it.
3. `FLARE_OTA_URL=https://<updates-host> npx flare-ota init --channel production`.
   With a dynamic `app.config.*`, merge the printed fields instead. For staging builds, use the
   `OTA_STAGE` pattern in `docs/expo-app.md` so store builds keep `app.json` exactly.
4. Add a URL `scheme` and the preview hook (`handlePreviewUrl` from `flare-ota/expo`) if the user
   wants preview links.
5. These are native settings: a **new store/release build** is required before OTA works. Say so.
   If the app has an `ios/`/`android/` folder (`init` warns about it), run `npx expo prebuild --clean`
   first or the build keeps the old URL/certificate.
6. `npx flare-ota doctor` must pass (it verifies the server's signature against the certificate).

## Everyday operations

```sh
npx flare-ota publish --branch staging -m "…"                 # staging: no confirmation needed
npx flare-ota publish --branch production -m "…" --rollout 10 # ask first
npx flare-ota metrics --branch production                     # watch running / failed
npx flare-ota rollout <groupId> 50                            # only increases
npx flare-ota pause <groupId>                                 # stop new devices getting it
npx flare-ota rollback --branch production [--to embedded]    # incident
npx flare-ota promote <groupId> --branch production
npx flare-ota preview <groupId> --ttl 60                      # QR for one device
```

`publish` lists the `EXPO_PUBLIC_*` values the export will inline and refuses localhost or private
IPs on production. Do not reach for `--allow-local`: set the production values in the shell or pass
`--profile <eas build profile>` to reuse that profile's `env` block.

A native change (new native module, permissions, `app.json` native fields) changes the
fingerprint: an OTA cannot deliver it. Tell the user a store build is needed.

## CI and MCP

- CI: `docs/ci.md` — publish token as `FLARE_OTA_TOKEN` secret, staging on push, production on
  manual dispatch. Use `gh secret set NAME --repo … < <(…)` piping from the keychain so the value
  never appears in argv or output.
- MCP: `claude mcp add --transport http flare-ota https://<updates-host>/mcp --header "Authorization: Bearer $FLARE_OTA_TOKEN"`
  with a `read` token by default; `npx flare-ota mcp` locally adds `publish_update`.

## When something fails

- `doctor` names the failing check. "signature does NOT match": the server's key and the app's
  certificate differ — redeploy with the right key; never swap the certificate in a shipped app.
- Publish refused with 409: a partial rollout is running on that branch — raise it to 100%, pause
  it or roll back first.
- Device not updating: same channel? same runtime (fingerprint)? rollout bucket? Relaunch twice
  (download on launch, apply on next start). Check the dashboard's device counts.
