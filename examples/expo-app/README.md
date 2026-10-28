# flare-ota example app

A minimal Expo SDK 58 app to try the whole loop: publish → update → rollout → rollback → preview.

```sh
cd examples/expo-app
npm install                       # links the local flare-ota CLI (packages/cli, build it first: pnpm --filter flare-ota build)
export FLARE_OTA_URL=https://ota.example.com FLARE_OTA_TOKEN=fota_…   # your server, a publish/admin token
mkdir -p certs && cp ~/.flare-ota/flare-ota/certificate.pem certs/
npx flare-ota init --channel production   # points app.json at your server
npm run ios:release               # updates only run in release builds
```

Then:

1. Change `RELEASE_NOTE` in `App.tsx` and run `npx flare-ota publish --branch production -m "v2"`.
   Close and reopen the app twice (download, then apply): the new text shows.
2. `npx flare-ota publish --branch production -m "v3" --rollout 50`, then
   `npx flare-ota metrics --branch production` to watch the split.
3. `npx flare-ota rollback --branch production`: the app goes back to v2 on its next launches.
   `--to embedded` returns it to the JS inside the binary.
4. `npx flare-ota preview <groupId>` prints a QR code; scan it with the device camera to run that
   exact group, then tap **Exit preview**.

The bundle identifier `dev.flareota.example` is a placeholder; change it if you sign the app.
