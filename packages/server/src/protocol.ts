// Expo Updates protocol v1: request parsing, update selection and the multipart response.
// https://docs.expo.dev/technical-specs/expo-updates-1/

import { PREVIEW_HEADER, RUNTIME_VERSION, NAME, UUID, isPlatform, utf8, type AssetRef, type Platform } from "@flare-ota/core";
import { signatureHeader, type Signer } from "./signing.ts";

export interface ManifestRequest {
  platform: Platform;
  runtimeVersion: string;
  channel: string;
  currentUpdateId: string | null;
  embeddedUpdateId: string | null;
  expectSignature: boolean;
  /** EAS-Client-ID, kept only when it is a well-formed UUID (it is unauthenticated). */
  clientId: string | null;
  failedUpdateIds: string[];
  fatalError: string | null;
  previewToken: string | null;
}

export type ParseResult = { ok: true; request: ManifestRequest } | { ok: false; error: string };

function uuidOrNull(value: string | null): string | null {
  return value !== null && UUID.test(value) ? value.toLowerCase() : null;
}

export function parseManifestRequest(headers: Headers): ParseResult {
  if (headers.get("expo-protocol-version") !== "1") return { ok: false, error: "expo-protocol-version must be 1" };
  const platform = headers.get("expo-platform");
  if (!isPlatform(platform)) return { ok: false, error: "expo-platform must be ios or android" };
  const runtimeVersion = headers.get("expo-runtime-version") ?? "";
  if (!RUNTIME_VERSION.test(runtimeVersion)) return { ok: false, error: "invalid expo-runtime-version" };
  const channel = headers.get("expo-channel-name") ?? "";
  if (!NAME.test(channel)) return { ok: false, error: "invalid expo-channel-name" };
  const preview = headers.get(PREVIEW_HEADER);
  return {
    ok: true,
    request: {
      platform,
      runtimeVersion,
      channel,
      currentUpdateId: uuidOrNull(headers.get("expo-current-update-id")),
      embeddedUpdateId: uuidOrNull(headers.get("expo-embedded-update-id")),
      expectSignature: headers.has("expo-expect-signature"),
      clientId: uuidOrNull(headers.get("eas-client-id")),
      failedUpdateIds: parseFailedUpdateIds(headers.get("expo-recent-failed-update-ids")),
      fatalError: headers.get("expo-fatal-error")?.slice(0, 1024) ?? null,
      previewToken: preview && preview.length <= 512 ? preview : null,
    },
  };
}

// parseFailedUpdateIds, rolloutBucket and multipartBody are adapted from focux/open-ota
// (apps/updates/src/protocol.ts, rollout.ts), Copyright (c) 2026 Leonardo E. Dominguez, MIT License.

/** A structured-field list of quoted UUIDs: `"id-1", "id-2"`. expo-updates sends at most five. */
export function parseFailedUpdateIds(header: string | null): string[] {
  const ids = new Set<string>();
  for (const entry of header?.slice(0, 512).split(",") ?? []) {
    const match = /^"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"$/i.exec(entry.trim());
    if (match) ids.add(match[1]!.toLowerCase());
    if (ids.size === 5) break;
  }
  return [...ids];
}

/**
 * A device lands in the same bucket for a given update on every check, so raising a
 * rollout percentage only ever grows the audience. Salted per update, so the same
 * devices are not always the canaries.
 */
export async function rolloutBucket(clientId: string, updateId: string): Promise<number> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(`${clientId}:${updateId}`)));
  return (((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0) % 100;
}

export interface Candidate {
  id: string;
  groupId: string;
  branch: string;
  platform: Platform;
  createdAt: string;
  runtimeVersion: string;
  rolloutPercent: number;
  paused: boolean;
  rollbackToEmbedded: boolean;
  launchAsset: AssetRef | null;
  assets: AssetRef[];
  expoConfig: Record<string, unknown> | null;
}

export type NoUpdateReason =
  | "unknown-channel"
  | "no-update-for-runtime"
  | "rollout-excluded"
  | "already-current"
  | "already-embedded"
  | "previously-failed";

export type Decision =
  | { type: "manifest"; update: Candidate }
  | { type: "rollBackToEmbedded"; update: Candidate }
  | { type: "none"; reason: NoUpdateReason };

/**
 * Picks what to serve from the branch's published updates for this platform and runtime,
 * newest first. Paused updates and updates outside the device's rollout bucket are skipped
 * in favour of the next older one, unless the device already runs them. An update the device
 * reported as failing to launch is never offered again.
 */
export async function decide(candidates: Candidate[], request: ManifestRequest): Promise<Decision> {
  if (candidates.length === 0) return { type: "none", reason: "no-update-for-runtime" };
  let excluded: NoUpdateReason = "rollout-excluded";
  for (const candidate of candidates) {
    if (candidate.id === request.currentUpdateId) return { type: "none", reason: "already-current" };
    if (candidate.paused) continue;
    if (request.failedUpdateIds.includes(candidate.id)) {
      excluded = "previously-failed";
      continue;
    }
    if (candidate.rolloutPercent < 100) {
      // A device without a client id cannot be bucketed reliably: keep it on the stable path.
      if (request.clientId === null) continue;
      if ((await rolloutBucket(request.clientId, candidate.id)) >= candidate.rolloutPercent) continue;
    }
    if (candidate.rollbackToEmbedded) {
      const onEmbedded = request.currentUpdateId === null || request.currentUpdateId === request.embeddedUpdateId;
      return onEmbedded ? { type: "none", reason: "already-embedded" } : { type: "rollBackToEmbedded", update: candidate };
    }
    return { type: "manifest", update: candidate };
  }
  return { type: "none", reason: excluded };
}

export function manifestJson(update: Candidate, origin: string) {
  const asset = (ref: AssetRef) => ({
    hash: ref.hash,
    key: ref.key,
    contentType: ref.contentType,
    fileExtension: ref.fileExtension,
    url: `${origin}/assets/${ref.hash}`,
  });
  return {
    id: update.id,
    createdAt: update.createdAt,
    runtimeVersion: update.runtimeVersion,
    launchAsset: asset(update.launchAsset!),
    assets: update.assets.map(asset),
    metadata: { branchName: update.branch },
    extra: { expoClient: update.expoConfig ?? {} },
  };
}

interface Part {
  name: string;
  body: Uint8Array<ArrayBuffer>;
  headers: Record<string, string>;
}

export function multipartBody(parts: Part[], boundary: string): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (const part of parts) {
    const headers = Object.entries({ ...part.headers, "content-disposition": `form-data; name="${part.name}"` })
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("");
    chunks.push(utf8(`--${boundary}\r\n${headers}\r\n`), part.body, utf8("\r\n"));
  }
  chunks.push(utf8(`--${boundary}--\r\n`));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Builds the protocol response. `manifest`/`directive` parts are signed when the client expects it. */
export async function protocolResponse(
  decision: Decision,
  options: { origin: string; signer: Signer | null; expectSignature: boolean; branch: string | null },
): Promise<Response> {
  if (options.expectSignature && !options.signer) {
    return new Response("This server has no signing key, but the app expects signed updates.", { status: 500 });
  }
  let name: "manifest" | "directive";
  let json: unknown;
  if (decision.type === "manifest") {
    name = "manifest";
    json = manifestJson(decision.update, options.origin);
  } else if (decision.type === "rollBackToEmbedded") {
    name = "directive";
    json = { type: "rollBackToEmbedded", parameters: { commitTime: decision.update.createdAt } };
  } else {
    name = "directive";
    json = { type: "noUpdateAvailable" };
  }
  const body = utf8(JSON.stringify(json));
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (options.expectSignature && options.signer) {
    headers["expo-signature"] = signatureHeader(await options.signer.sign(body), options.signer.keyId);
  }
  const parts: Part[] = [{ name, body, headers }];
  if (name === "manifest") {
    parts.push({ name: "extensions", body: utf8(JSON.stringify({ assetRequestHeaders: {} })), headers: { "content-type": "application/json" } });
  }
  const boundary = crypto.randomUUID();
  const responseHeaders = new Headers({
    "content-type": `multipart/mixed; boundary=${boundary}`,
    "expo-protocol-version": "1",
    "expo-sfv-version": "0",
    "cache-control": "private, max-age=0",
  });
  if (options.branch) responseHeaders.set("expo-manifest-filters", `branchname="${options.branch}"`);
  return new Response(multipartBody(parts, boundary), { headers: responseHeaders });
}
