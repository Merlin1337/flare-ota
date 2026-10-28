// flare-ota/expo — preview links for apps using the standard expo-updates client.
//
// Scanning a preview QR opens `<scheme>://flare-ota/preview?token=…`. `handlePreviewUrl` puts the
// signed token in the `flare-preview` request header (declared in app.json at build time), then
// downloads and launches the previewed update. expo-updates keeps the header across launches, so
// the device stays on that update until `exitPreview()`. This uses
// `setUpdateRequestHeadersOverride`, which keeps expo-updates' anti-bricking protections on.
// Not available in development builds (expo-updates disables overrides there).

import * as Updates from "expo-updates";

const HEADER = "flare-preview";

function previewToken(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "flare-ota" || parsed.pathname !== "/preview") return null;
    return parsed.searchParams.get("token");
  } catch {
    return null;
  }
}

function channelHeaders(): Record<string, string> {
  return Updates.channel ? { "expo-channel-name": Updates.channel } : {};
}

/** Returns true if the URL was a preview link (and the app reloads into the previewed update). */
export async function handlePreviewUrl(url: string | null | undefined): Promise<boolean> {
  const token = url ? previewToken(url) : null;
  if (!token) return false;
  Updates.setUpdateRequestHeadersOverride({ ...channelHeaders(), [HEADER]: token });
  const result = await Updates.fetchUpdateAsync();
  if (result.isNew) await Updates.reloadAsync();
  return true;
}

/** Leaves preview mode and goes back to whatever the channel serves. */
export async function exitPreview(): Promise<void> {
  Updates.setUpdateRequestHeadersOverride(null);
  const result = await Updates.fetchUpdateAsync();
  if (result.isNew) await Updates.reloadAsync();
}

/** Reports the native app version so the dashboard can break adoption down by store version. */
export async function reportAppVersion(version: string | null | undefined): Promise<void> {
  if (version) await Updates.setExtraParamAsync("appVersion", version);
}
