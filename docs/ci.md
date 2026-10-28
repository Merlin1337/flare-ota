# CI

## Publish updates from GitHub Actions

Create a **publish** token (dashboard → Tokens, or `flare-ota tokens create github-actions --scope publish`)
and store it as the repository secret `FLARE_OTA_TOKEN`. A publish token can upload and publish,
but cannot change rollouts, roll back or create tokens.

```yaml
# .github/workflows/ota.yml in your app
name: OTA
on:
  push:
    branches: [main]
    paths-ignore: ["**.md"]
  workflow_dispatch:
    inputs:
      branch: { type: choice, options: [staging, production], default: staging }
      message: { required: true }
      rollout: { default: "100" }

concurrency: ota-${{ inputs.branch || 'staging' }}

jobs:
  publish:
    runs-on: ubuntu-latest
    env:
      BRANCH: ${{ inputs.branch || 'staging' }}
      OTA_STAGE: ${{ inputs.branch || 'staging' }}          # if you use the app.config.ts pattern
      FLARE_OTA_URL: https://ota.example.com
      FLARE_OTA_TOKEN: ${{ secrets.FLARE_OTA_TOKEN }}
      EXPO_PUBLIC_API_URL: https://api.example.com           # every EXPO_PUBLIC_* the bundle needs
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm ci
      - run: >
          npx flare-ota publish --branch "$BRANCH"
          --message "${{ inputs.message || github.event.head_commit.message }}"
          --rollout "${{ inputs.rollout || '100' }}" --json
```

Pushes go to staging; production is a manual run. The fingerprint computed on Linux matches the
one built on macOS, so CI targets the same devices as your store builds.

## Deploy the server from CI

```sh
pnpm --filter @flare-ota/server deploy-token -- --stage production   # scoped, cannot mint tokens
```

Store the printed value as `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID`,
`FLARE_OTA_SIGNING_KEY` and `FLARE_OTA_PREVIEW_SECRET` as secrets, and the non-secret settings
from `.env.production` as variables:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm --filter @flare-ota/server deploy -- --stage production
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    FLARE_OTA_SIGNING_KEY: ${{ secrets.FLARE_OTA_SIGNING_KEY }}
    FLARE_OTA_PREVIEW_SECRET: ${{ secrets.FLARE_OTA_PREVIEW_SECRET }}
    FLARE_OTA_UPDATES_HOST: ${{ vars.FLARE_OTA_UPDATES_HOST }}
    FLARE_OTA_DASHBOARD_HOST: ${{ vars.FLARE_OTA_DASHBOARD_HOST }}
    FLARE_OTA_ACCESS_TEAM_DOMAIN: ${{ vars.FLARE_OTA_ACCESS_TEAM_DOMAIN }}
    FLARE_OTA_ACCESS_AUD: ${{ vars.FLARE_OTA_ACCESS_AUD }}
    FLARE_OTA_APP_SCHEME: ${{ vars.FLARE_OTA_APP_SCHEME }}
```
