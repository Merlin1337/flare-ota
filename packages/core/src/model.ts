// Shapes shared by the server API, the CLI and the MCP tools.

export const PLATFORMS = ["ios", "android"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Token scopes, from least to most powerful. Each scope includes the ones before it. */
export const SCOPES = ["read", "publish", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

export function scopeAllows(granted: Scope, required: Scope): boolean {
  return SCOPES.indexOf(granted) >= SCOPES.indexOf(required);
}

/** base64url(sha256), unpadded: the content address of an asset (Expo Updates protocol `hash`). */
export const ASSET_HASH = /^[A-Za-z0-9_-]{43}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Branch and channel names: short, URL-safe, no surprises in SQL or headers. */
export const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** Runtime versions are fingerprints or semver-ish strings. */
export const RUNTIME_VERSION = /^[A-Za-z0-9._+-]{1,64}$/;

export function isPlatform(value: unknown): value is Platform {
  return value === "ios" || value === "android";
}

export interface AssetRef {
  hash: string;
  /** Unique key the client uses to store the file (we use the hex sha256). */
  key: string;
  contentType: string;
  fileExtension: string;
}

export interface PlatformUpdateInput {
  runtimeVersion: string;
  launchAsset: AssetRef;
  assets: AssetRef[];
}

export interface PublishInput {
  branch: string;
  message: string;
  gitCommit?: string | undefined;
  rolloutPercent?: number | undefined;
  /** Public Expo config, served to the app as `extra.expoClient`. */
  expoConfig?: Record<string, unknown> | undefined;
  /** The app icon, uploaded like any asset, so the dashboard can show which app this is. */
  appIcon?: AssetRef | undefined;
  updates: Partial<Record<Platform, PlatformUpdateInput>>;
}

export type GroupKind = "bundle" | "rollback-embedded";

export interface UpdateSummary {
  id: string;
  platform: Platform;
  runtimeVersion: string;
  rolloutPercent: number;
  paused: boolean;
  rollbackToEmbedded: boolean;
}

export interface GroupSummary {
  id: string;
  branch: string;
  message: string;
  gitCommit: string | null;
  actor: string;
  kind: GroupKind;
  sourceGroupId: string | null;
  createdAt: string;
  updates: UpdateSummary[];
}

export interface UpdateMetrics {
  updateId: string;
  groupId: string;
  platform: Platform;
  runtimeVersion: string;
  rolloutPercent: number;
  paused: boolean;
  /** Devices that were last offered this update. */
  served: number;
  /** Devices currently running it. */
  running: number;
  /** Devices that reported a failed launch of it. */
  failed: number;
  /** Devices seen in the last 30 days that could receive it (same channel set, platform, runtime). */
  population: number;
}

export interface Overview {
  channels: { name: string; branch: string }[];
  devices: { last24h: number; last30d: number };
  runtimes: { platform: Platform; runtimeVersion: string; devices: number }[];
  latest: GroupSummary[];
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
}

export interface TokenSummary {
  id: string;
  name: string;
  scope: Scope;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AppIdentity {
  name: string | null;
  version: string | null;
  iosBundleId: string | null;
  androidPackage: string | null;
  iconHash: string | null;
}
