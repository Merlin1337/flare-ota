// The subset of Workers bindings flare-ota uses. Declared structurally so tests can run on
// Node with in-memory doubles (node:sqlite for D1, a Map for R2) and the real runtime types fit.

export interface D1Result<T> {
  results: T[];
  meta: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]>;
}

export interface R2ObjectBody {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string }; sha256?: string },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

export interface AnalyticsEngineDataset {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Optional: raw delivery events for your own Analytics Engine queries. */
  EVENTS?: AnalyticsEngineDataset;

  /** PEM private key (PKCS#1 or PKCS#8) used to sign manifests. */
  SIGNING_KEY?: string;
  /** HMAC secret for preview links. */
  PREVIEW_SECRET?: string;

  /** Hostname devices use, e.g. ota.example.com (shown in the dashboard's setup commands). */
  UPDATES_HOST?: string;
  /** Hostname that serves the dashboard behind Cloudflare Access, e.g. ota-admin.example.com. */
  DASHBOARD_HOST?: string;
  /** Your Access team domain, e.g. myteam.cloudflareaccess.com. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Audience tag of the dashboard's Access application. */
  ACCESS_AUD?: string;
  /** Default URL scheme for preview deep links. */
  APP_SCHEME?: string;
  /** Local development only: serve the dashboard without Access. Never set in production. */
  INSECURE_DASHBOARD?: string;
}

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}
