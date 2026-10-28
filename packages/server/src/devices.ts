// Device check-ins. Every manifest request can produce an Analytics Engine data point (cheap,
// append-only); D1 is written only for well-formed client ids and only when the device's
// state changed or 10 minutes passed, so check-in floods cannot turn into D1 write floods.

import type { Env } from "./env.ts";
import type { Decision, ManifestRequest } from "./protocol.ts";
import type { Store } from "./store.ts";

const DEBOUNCE_MS = 10 * 60 * 1000;
const MAX_TRACKED = 20_000;
const recent = new Map<string, { fingerprint: string; at: number }>();

/** `Expo-Extra-Params` is a structured-field dictionary; the preview helper sets `appVersion`. */
export function appVersionFrom(extraParams: string | null): string | null {
  if (!extraParams || extraParams.length > 1024) return null;
  return /(?:^|,)\s*appVersion="([^"\\]{1,32})"/.exec(extraParams)?.[1] ?? null;
}

export async function recordCheck(
  env: Env,
  store: Store,
  request: ManifestRequest,
  decision: Decision,
  meta: { country: string | null; appVersion: string | null },
): Promise<void> {
  const served = decision.type === "none" ? null : decision.update.id;
  env.EVENTS?.writeDataPoint({
    indexes: [request.platform],
    blobs: ["check", request.runtimeVersion, request.channel, request.currentUpdateId ?? "", served ?? "", decision.type === "none" ? decision.reason : decision.type, meta.country ?? ""],
    doubles: [1],
  });
  if (!request.clientId) return;
  const fingerprint = [request.platform, request.runtimeVersion, request.channel, request.currentUpdateId, request.embeddedUpdateId, served, meta.appVersion, request.failedUpdateIds.join(",")].join("|");
  const previous = recent.get(request.clientId);
  if (previous && previous.fingerprint === fingerprint && Date.now() - previous.at < DEBOUNCE_MS) return;
  if (recent.size >= MAX_TRACKED) recent.clear();
  recent.set(request.clientId, { fingerprint, at: Date.now() });
  await store.recordCheck({
    clientId: request.clientId,
    platform: request.platform,
    runtimeVersion: request.runtimeVersion,
    channel: request.channel,
    currentUpdateId: request.currentUpdateId,
    embeddedUpdateId: request.embeddedUpdateId,
    servedUpdateId: served,
    appVersion: meta.appVersion,
    country: meta.country,
    failedUpdateIds: request.failedUpdateIds,
    fatalError: request.fatalError,
  });
}

/** Test hook. */
export function resetDeviceDebounce() {
  recent.clear();
}
