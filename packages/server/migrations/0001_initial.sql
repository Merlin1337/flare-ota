-- flare-ota schema. One deployment serves one app; timestamps are ISO-8601 UTC strings.

CREATE TABLE branches (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE channels (
  name TEXT PRIMARY KEY,
  branch_name TEXT NOT NULL REFERENCES branches(name),
  updated_at TEXT NOT NULL
);

-- A publish: one update per platform, made visible atomically by setting published_at.
CREATE TABLE update_groups (
  id TEXT PRIMARY KEY,
  branch_name TEXT NOT NULL REFERENCES branches(name),
  message TEXT NOT NULL,
  git_commit TEXT,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bundle', 'rollback-embedded')),
  source_group_id TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX update_groups_branch ON update_groups(branch_name, created_at DESC);

CREATE TABLE updates (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES update_groups(id),
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  runtime_version TEXT NOT NULL,
  launch_asset TEXT,          -- JSON AssetRef, NULL for rollback-to-embedded
  assets TEXT NOT NULL,       -- JSON AssetRef[]
  expo_config TEXT,           -- JSON, served as extra.expoClient
  rollout_percent INTEGER NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 1 AND 100),
  paused INTEGER NOT NULL DEFAULT 0,
  rollback_to_embedded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  pruned_at TEXT              -- set by GC once its assets may be gone; never served or rolled back to
);
CREATE INDEX updates_selection ON updates(platform, runtime_version, created_at DESC);
CREATE INDEX updates_group ON updates(group_id);

-- Content-addressed files in R2 under assets/<hash>.
CREATE TABLE assets (
  hash TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  touched_at TEXT NOT NULL
);

-- Latest known state per installation (EAS-Client-ID). Only well-formed UUIDs are stored.
CREATE TABLE devices (
  client_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  channel TEXT NOT NULL,
  current_update_id TEXT,
  embedded_update_id TEXT,
  served_update_id TEXT,
  app_version TEXT,
  country TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX devices_seen ON devices(last_seen_at DESC);
CREATE INDEX devices_current ON devices(current_update_id);
CREATE INDEX devices_served ON devices(served_update_id);
CREATE INDEX devices_runtime ON devices(platform, runtime_version, last_seen_at DESC);

-- Launch failures reported by expo-updates (Expo-Recent-Failed-Update-IDs).
CREATE TABLE device_failures (
  update_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  fatal_error TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (update_id, client_id)
);

-- API tokens: only the SHA-256 of the secret is stored.
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'publish', 'admin')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

-- Signed preview links; deleting or revoking the row invalidates the link early.
CREATE TABLE previews (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES update_groups(id),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT
);
CREATE INDEX audit_log_at ON audit_log(at DESC);

INSERT INTO branches (name, created_at) VALUES ('staging', '1970-01-01T00:00:00.000Z'), ('production', '1970-01-01T00:00:00.000Z');
INSERT INTO channels (name, branch_name, updated_at) VALUES ('staging', 'staging', '1970-01-01T00:00:00.000Z'), ('production', 'production', '1970-01-01T00:00:00.000Z');
