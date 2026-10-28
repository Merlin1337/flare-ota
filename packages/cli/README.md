# flare-ota

CLI and Expo helper for [flare-ota](https://github.com/Merlin1337/flare-ota), self-hosted OTA
updates for Expo on Cloudflare.

```sh
npm i -D flare-ota
export FLARE_OTA_URL=https://ota.example.com FLARE_OTA_TOKEN=fota_…
npx flare-ota init --channel production
npx flare-ota doctor
npx flare-ota publish --branch production --message "Fix checkout" [--rollout 10] [--json]
npx flare-ota --help
```

Preview links in the app:

```ts
import { handlePreviewUrl, exitPreview } from "flare-ota/expo";
```

Docs: https://github.com/Merlin1337/flare-ota#documentation · MIT
