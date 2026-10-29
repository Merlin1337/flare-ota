# Expo app integration

## What `flare-ota init` writes

```json
{
  "expo": {
    "runtimeVersion": { "policy": "fingerprint" },
    "updates": {
      "enabled": true,
      "url": "https://ota.example.com/manifest",
      "checkAutomatically": "ON_LOAD",
      "codeSigningCertificate": "./certs/certificate.pem",
      "codeSigningMetadata": { "keyid": "main", "alg": "rsa-v1_5-sha256" },
      "requestHeaders": { "expo-channel-name": "production", "flare-preview": "" }
    }
  }
}
```

- **URL, channel, certificate and declared headers are native.** Changing them needs a new build;
  an OTA update can never change them. If an `ios/` or `android/` folder already exists,
  `expo run:*` does not regenerate it: run `npx expo prebuild --clean` first, or the binary keeps
  the old values (e.g. the old certificate, and every update fails signature validation).
- **The certificate needs the `codeSigning` extended key usage**, or expo-updates rejects every
  manifest ("Certificate missing code signing extended key usage"). Certificates from
  `pnpm server:setup` or `expo-updates codesigning:generate` have it; `flare-ota doctor` checks it.
- **Runtime version = fingerprint.** An update only reaches binaries with the same native
  fingerprint. A native change (new module, permission, native config) publishes harmlessly to a
  runtime no device runs: ship a store build for it. `flare-ota publish` resolves the fingerprint
  exactly like the native build (`expo-updates runtimeversion:resolve`); the result is the same on
  macOS and Linux CI.
- **Code signing is required.** The server signs every manifest and directive; a device rejects
  anything not signed by the key matching `certs/certificate.pem` (commit that file; it is public).

## Channels and staging builds

A build listens to one channel; a channel points to a branch. Store builds should listen to
`production`. To test updates before users, give internal builds the `staging` channel with a
dynamic config that leaves store builds exactly as `app.json` says (so their fingerprint does not
change):

```ts
// app.config.ts
import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => {
  if (process.env.OTA_STAGE !== "staging") return config as ExpoConfig;
  return {
    ...config,
    updates: {
      ...config.updates,
      url: "https://ota-staging.example.com/manifest", // or the same server, channel "staging"
      requestHeaders: { ...config.updates?.requestHeaders, "expo-channel-name": "staging" },
    },
  } as ExpoConfig;
};
```

Set `OTA_STAGE=staging` in the internal build profile and when publishing to staging. Then promote
a tested group: `flare-ota promote <groupId> --branch production`.

## Environment variables at publish time

`flare-ota publish` runs `expo export` on your machine or CI. `EXPO_PUBLIC_*` values are inlined
into the bundle **at export time**, from your shell and `.env*` files, not from your EAS build
profile. If `.env.local` points at a local API, a publish from your laptop ships that URL to every
user. Export the production values explicitly in the publish environment:

```sh
EXPO_PUBLIC_API_URL=https://api.example.com npx flare-ota publish --branch production -m "…"
```

## Preview links

A preview link makes one device run a given update group, whatever the rollout says. It is a
signed, expiring token, revocable from the server. It uses `Updates.setUpdateRequestHeadersOverride`,
which keeps expo-updates' anti-bricking protections enabled (unlike changing the update URL).

1. Declare the header at build time (`init` does it): `"flare-preview": ""` in `updates.requestHeaders`.
2. Give the app a URL `scheme` and handle the link:

```tsx
import * as Linking from "expo-linking";
import { useEffect } from "react";
import { handlePreviewUrl } from "flare-ota/expo";

export function usePreviewLinks() {
  const url = Linking.useURL();
  useEffect(() => {
    handlePreviewUrl(url).catch((error) => console.warn("preview", error));
  }, [url]);
}
```

3. Create a link: dashboard → group → **Preview link**, `flare-ota preview <groupId>`, or the MCP
   tool `create_preview_link`. Scan the QR code on the device.
4. The device stays on that update across launches until it leaves preview:
   `import { exitPreview } from "flare-ota/expo"` and call it from a debug menu.

Limits: overrides are disabled in development builds; the device must run a binary built with the
header declared; once the token expires the server stops honouring it, but the device keeps
running what it downloaded until it exits preview.

## Adoption by store version

The dashboard groups devices by runtime (fingerprint). To also see the store version, report it:

```ts
import * as Application from "expo-application";
import { reportAppVersion } from "flare-ota/expo";
reportAppVersion(Application.nativeApplicationVersion);
```

## Crash signals

expo-updates reports updates that failed to launch (`Expo-Recent-Failed-Update-IDs`). flare-ota
records them per update (the **Failed** column) and never offers a failed update to that device
again. expo-updates' own recovery only covers errors before the first screen renders, within about
10 seconds; crashes after that need your crash reporter. When the failed count climbs: `pause` the
group, then `rollback`.
