// All D1 access. D1 batches run as one transaction, which is what makes publishing atomic.

import type {
  AssetRef, AuditEntry, GroupKind, GroupSummary, Overview, Platform, PublishInput, Scope, TokenSummary, UpdateMetrics, UpdateSummary,
} from "@flare-ota/core";
import type { D1Database } from "./env.ts";
import type { Candidate } from "./protocol.ts";

const DAY = 24 * 60 * 60 * 1000;

export const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

interface UpdateRow {
  id: string;
  group_id: string;
  platform: Platform;
  runtime_version: string;
  launch_asset: string | null;
  assets: string;
  expo_config: string | null;
  rollout_percent: number;
  paused: number;
  rollback_to_embedded: number;
  created_at: string;
  branch_name: string;
}

interface GroupRow {
  id: string;
  branch_name: string;
  message: string;
  git_commit: string | null;
  actor: string;
  kind: GroupKind;
  source_group_id: string | null;
  created_at: string;
}

function toCandidate(row: UpdateRow): Candidate {
  return {
    id: row.id,
    groupId: row.group_id,
    branch: row.branch_name,
    platform: row.platform,
    createdAt: row.created_at,
    runtimeVersion: row.runtime_version,
    rolloutPercent: row.rollout_percent,
    paused: row.paused === 1,
    rollbackToEmbedded: row.rollback_to_embedded === 1,
    launchAsset: row.launch_asset ? (JSON.parse(row.launch_asset) as AssetRef) : null,
    assets: JSON.parse(row.assets) as AssetRef[],
    expoConfig: row.expo_config ? (JSON.parse(row.expo_config) as Record<string, unknown>) : null,
  };
}

function toUpdateSummary(row: UpdateRow): UpdateSummary {
  return {
    id: row.id,
    platform: row.platform,
    runtimeVersion: row.runtime_version,
    rolloutPercent: row.rollout_percent,
    paused: row.paused === 1,
    rollbackToEmbedded: row.rollback_to_embedded === 1,
  };
}

export class Conflict extends Error {}
export class NotFound extends Error {}

export interface PublishOptions {
  actor: string;
  kind?: GroupKind;
  sourceGroupId?: string | null;
  /** Rollbacks may land on top of an unfinished rollout; regular publishes may not. */
  bypassRolloutGuard?: boolean;
  /** Platform updates marked as "go back to the embedded bundle" (no assets). */
  rollbackToEmbedded?: Partial<Record<Platform, { runtimeVersion: string }>>;
}

const SELECT_UPDATE = `SELECT u.*, g.branch_name FROM updates u JOIN update_groups g ON g.id = u.group_id`;

export class Store {
  private readonly db: D1Database;
  constructor(db: D1Database) {
    this.db = db;
  }

  // ---- channels and branches ----

  async channelBranch(channel: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT branch_name FROM channels WHERE name = ?").bind(channel).first<{ branch_name: string }>();
    return row?.branch_name ?? null;
  }

  async listChannels(): Promise<{ name: string; branch: string }[]> {
    const { results } = await this.db.prepare("SELECT name, branch_name AS branch FROM channels ORDER BY name").all<{ name: string; branch: string }>();
    return results;
  }

  async setChannel(channel: string, branch: string): Promise<void> {
    const at = now();
    await this.db.batch([
      this.db.prepare("INSERT OR IGNORE INTO branches (name, created_at) VALUES (?, ?)").bind(branch, at),
      this.db
        .prepare("INSERT INTO channels (name, branch_name, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET branch_name = excluded.branch_name, updated_at = excluded.updated_at")
        .bind(channel, branch, at),
    ]);
  }

  // ---- selection ----

  async candidates(branch: string, platform: Platform, runtimeVersion: string, limit = 10): Promise<Candidate[]> {
    const { results } = await this.db
      .prepare(`${SELECT_UPDATE} WHERE g.branch_name = ? AND g.published_at IS NOT NULL AND u.platform = ? AND u.runtime_version = ? AND u.pruned_at IS NULL ORDER BY u.created_at DESC, u.rowid DESC LIMIT ?`)
      .bind(branch, platform, runtimeVersion, limit)
      .all<UpdateRow>();
    return results.map(toCandidate);
  }

  async groupUpdate(groupId: string, platform: Platform, runtimeVersion: string): Promise<Candidate | null> {
    const row = await this.db
      .prepare(`${SELECT_UPDATE} WHERE u.group_id = ? AND g.published_at IS NOT NULL AND u.platform = ? AND u.runtime_version = ? AND u.pruned_at IS NULL`)
      .bind(groupId, platform, runtimeVersion)
      .first<UpdateRow>();
    return row ? toCandidate(row) : null;
  }

  // ---- assets ----

  /** Returns the hashes the server does not have yet, and marks the others as recently used so GC spares them. */
  async missingAssets(hashes: string[]): Promise<string[]> {
    const present = new Set<string>();
    for (let i = 0; i < hashes.length; i += 90) {
      const chunk = hashes.slice(i, i + 90);
      const marks = chunk.map(() => "?").join(",");
      const { results } = await this.db.prepare(`SELECT hash FROM assets WHERE hash IN (${marks})`).bind(...chunk).all<{ hash: string }>();
      for (const row of results) present.add(row.hash);
      if (results.length) {
        await this.db.prepare(`UPDATE assets SET touched_at = ? WHERE hash IN (${marks})`).bind(now(), ...chunk).run();
      }
    }
    return hashes.filter((hash) => !present.has(hash));
  }

  async recordAsset(hash: string, contentType: string, size: number): Promise<void> {
    const at = now();
    await this.db
      .prepare("INSERT INTO assets (hash, content_type, size, created_at, touched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET touched_at = excluded.touched_at")
      .bind(hash, contentType, size, at, at)
      .run();
  }

  async assetContentType(hash: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT content_type FROM assets WHERE hash = ?").bind(hash).first<{ content_type: string }>();
    return row?.content_type ?? null;
  }

  async existingAssets(hashes: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < hashes.length; i += 90) {
      const chunk = hashes.slice(i, i + 90);
      const { results } = await this.db.prepare(`SELECT hash FROM assets WHERE hash IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ hash: string }>();
      for (const row of results) found.add(row.hash);
    }
    return found;
  }

  // ---- publishing ----

  /**
   * Inserts the group and its updates and makes them visible in one transaction. A regular
   * publish is refused (Conflict) while the newest update for the same branch, platform and
   * runtime is still a partial, unpaused rollout: finish it, pause it or roll back first.
   */
  async publish(input: PublishInput, options: PublishOptions): Promise<GroupSummary> {
    const groupId = crypto.randomUUID();
    const at = now();
    const rollout = input.rolloutPercent ?? 100;
    const statements = [
      this.db.prepare("INSERT OR IGNORE INTO branches (name, created_at) VALUES (?, ?)").bind(input.branch, at),
      this.db
        .prepare("INSERT INTO update_groups (id, branch_name, message, git_commit, actor, kind, source_group_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(groupId, input.branch, input.message, input.gitCommit ?? null, options.actor, options.kind ?? "bundle", options.sourceGroupId ?? null, at),
    ];
    for (const [platform, update] of Object.entries(input.updates)) {
      if (!update) continue;
      statements.push(
        this.db
          .prepare("INSERT INTO updates (id, group_id, platform, runtime_version, launch_asset, assets, expo_config, rollout_percent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID(), groupId, platform, update.runtimeVersion, JSON.stringify(update.launchAsset), JSON.stringify(update.assets), input.expoConfig ? JSON.stringify(input.expoConfig) : null, rollout, at),
      );
    }
    for (const [platform, target] of Object.entries(options.rollbackToEmbedded ?? {})) {
      if (!target) continue;
      statements.push(
        this.db
          .prepare("INSERT INTO updates (id, group_id, platform, runtime_version, launch_asset, assets, rollout_percent, rollback_to_embedded, created_at) VALUES (?, ?, ?, ?, NULL, '[]', 100, 1, ?)")
          .bind(crypto.randomUUID(), groupId, platform, target.runtimeVersion, at),
      );
    }
    const guard = options.bypassRolloutGuard
      ? ""
      : `AND NOT EXISTS (
          SELECT 1 FROM updates n WHERE n.group_id = ?2 AND EXISTS (
            SELECT 1 FROM updates u JOIN update_groups g ON g.id = u.group_id
            WHERE u.id = (
              SELECT u2.id FROM updates u2 JOIN update_groups g2 ON g2.id = u2.group_id
              WHERE g2.branch_name = ?3 AND g2.published_at IS NOT NULL AND u2.platform = n.platform AND u2.runtime_version = n.runtime_version
              ORDER BY u2.created_at DESC, u2.rowid DESC LIMIT 1
            ) AND u.rollout_percent < 100 AND u.paused = 0
          )
        )`;
    statements.push(
      options.bypassRolloutGuard
        ? this.db.prepare("UPDATE update_groups SET published_at = ?1 WHERE id = ?2 RETURNING id").bind(at, groupId)
        : this.db.prepare(`UPDATE update_groups SET published_at = ?1 WHERE id = ?2 ${guard} RETURNING id`).bind(at, groupId, input.branch),
    );
    const results = await this.db.batch(statements);
    const published = (results.at(-1)?.results ?? []) as unknown[];
    if (published.length === 0) {
      await this.db.batch([
        this.db.prepare("DELETE FROM updates WHERE group_id = ?").bind(groupId),
        this.db.prepare("DELETE FROM update_groups WHERE id = ?").bind(groupId),
      ]);
      throw new Conflict(`A partial rollout is still running on ${input.branch}. Raise it to 100%, pause it or roll back before publishing again.`);
    }
    return (await this.group(groupId))!;
  }

  async group(groupId: string): Promise<GroupSummary | null> {
    const group = await this.db.prepare("SELECT * FROM update_groups WHERE id = ? AND published_at IS NOT NULL").bind(groupId).first<GroupRow>();
    if (!group) return null;
    const { results } = await this.db.prepare(`${SELECT_UPDATE} WHERE u.group_id = ? ORDER BY u.platform`).bind(groupId).all<UpdateRow>();
    return toGroup(group, results);
  }

  /** Full updates of a published group, for promote and preview. */
  async groupCandidates(groupId: string): Promise<Candidate[]> {
    const { results } = await this.db
      .prepare(`${SELECT_UPDATE} WHERE u.group_id = ? AND g.published_at IS NOT NULL AND u.pruned_at IS NULL`)
      .bind(groupId)
      .all<UpdateRow>();
    return results.map(toCandidate);
  }

  async groups(branch: string | null, limit: number): Promise<GroupSummary[]> {
    const { results: groups } = await this.db
      .prepare(`SELECT * FROM update_groups WHERE published_at IS NOT NULL ${branch ? "AND branch_name = ?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .bind(...(branch ? [branch, limit] : [limit]))
      .all<GroupRow>();
    if (groups.length === 0) return [];
    const ids = groups.map((g) => g.id);
    const { results: updates } = await this.db
      .prepare(`${SELECT_UPDATE} WHERE u.group_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<UpdateRow>();
    return groups.map((g) => toGroup(g, updates.filter((u) => u.group_id === g.id)));
  }

  /** Rollouts only grow: lowering one would not remove the update from devices that already have it. */
  async setRollout(groupId: string, percent: number): Promise<void> {
    const group = await this.group(groupId);
    if (!group) throw new NotFound("Update group not found.");
    const current = Math.max(...group.updates.map((u) => u.rolloutPercent));
    if (percent < current) throw new Conflict(`Rollout is already at ${current}%. It can only increase; roll back to withdraw an update.`);
    await this.db.prepare("UPDATE updates SET rollout_percent = ? WHERE group_id = ? AND rollback_to_embedded = 0").bind(percent, groupId).run();
  }

  async setPaused(groupId: string, paused: boolean): Promise<void> {
    if (!(await this.group(groupId))) throw new NotFound("Update group not found.");
    await this.db.prepare("UPDATE updates SET paused = ? WHERE group_id = ?").bind(paused ? 1 : 0, groupId).run();
  }

  /**
   * The bundle each platform should go back to: the newest earlier bundle on the branch that
   * differs from what is live now and whose assets still exist.
   */
  async rollbackTargets(branch: string, platform: Platform | null): Promise<{ platform: Platform; runtimeVersion: string; target: Candidate | null }[]> {
    const { results } = await this.db
      .prepare(`${SELECT_UPDATE} WHERE g.branch_name = ? AND g.published_at IS NOT NULL ${platform ? "AND u.platform = ?" : ""} ORDER BY u.created_at DESC, u.rowid DESC LIMIT 200`)
      .bind(...(platform ? [branch, platform] : [branch]))
      .all<UpdateRow & { pruned_at: string | null }>();
    const out: { platform: Platform; runtimeVersion: string; target: Candidate | null }[] = [];
    const seen = new Set<string>();
    for (const row of results) {
      // Only the runtime that is live now on each platform: older binaries keep what they run.
      const key = row.platform;
      if (seen.has(key)) continue;
      seen.add(key);
      const live = toCandidate(row);
      const liveHash = live.launchAsset?.hash ?? null;
      const target = results
        .filter((r) => r.platform === row.platform && r.runtime_version === row.runtime_version && r.id !== row.id && r.pruned_at === null && r.rollback_to_embedded === 0)
        .map(toCandidate)
        .find((c) => c.launchAsset !== null && c.launchAsset.hash !== liveHash && c.createdAt <= live.createdAt) ?? null;
      out.push({ platform: row.platform, runtimeVersion: row.runtime_version, target });
    }
    return out;
  }

  // ---- devices ----

  async recordCheck(device: {
    clientId: string;
    platform: Platform;
    runtimeVersion: string;
    channel: string;
    currentUpdateId: string | null;
    embeddedUpdateId: string | null;
    servedUpdateId: string | null;
    appVersion: string | null;
    country: string | null;
    failedUpdateIds: string[];
    fatalError: string | null;
  }): Promise<boolean> {
    const at = now();
    // One cheap read saves most writes: D1 bills each written row and index entry, so an
    // unchanged device is refreshed at most every 6 hours (enough for "active" counts).
    if (device.failedUpdateIds.length === 0) {
      const known = await this.db
        .prepare("SELECT platform, runtime_version, channel, current_update_id, embedded_update_id, served_update_id, app_version, last_seen_at FROM devices WHERE client_id = ?")
        .bind(device.clientId)
        .first<{ platform: string; runtime_version: string; channel: string; current_update_id: string | null; embedded_update_id: string | null; served_update_id: string | null; app_version: string | null; last_seen_at: string }>();
      if (
        known &&
        known.platform === device.platform &&
        known.runtime_version === device.runtimeVersion &&
        known.channel === device.channel &&
        known.current_update_id === device.currentUpdateId &&
        known.embedded_update_id === device.embeddedUpdateId &&
        (device.servedUpdateId === null || known.served_update_id === device.servedUpdateId) &&
        (device.appVersion === null || known.app_version === device.appVersion) &&
        known.last_seen_at > ago(6 * 60 * 60 * 1000)
      ) {
        return false;
      }
    }
    const statements = [
      this.db
        .prepare(
          `INSERT INTO devices (client_id, platform, runtime_version, channel, current_update_id, embedded_update_id, served_update_id, app_version, country, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(client_id) DO UPDATE SET platform = excluded.platform, runtime_version = excluded.runtime_version, channel = excluded.channel,
             current_update_id = excluded.current_update_id, embedded_update_id = excluded.embedded_update_id,
             served_update_id = COALESCE(excluded.served_update_id, devices.served_update_id),
             app_version = COALESCE(excluded.app_version, devices.app_version), country = excluded.country, last_seen_at = excluded.last_seen_at`,
        )
        .bind(device.clientId, device.platform, device.runtimeVersion, device.channel, device.currentUpdateId, device.embeddedUpdateId, device.servedUpdateId, device.appVersion, device.country, at, at),
    ];
    for (const updateId of device.failedUpdateIds) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO device_failures (update_id, client_id, fatal_error, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(update_id, client_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, fatal_error = COALESCE(excluded.fatal_error, device_failures.fatal_error)`,
          )
          .bind(updateId, device.clientId, device.fatalError, at, at),
      );
    }
    await this.db.batch(statements);
    return true;
  }

  // ---- metrics ----

  async metrics(branch: string | null, platform: Platform | null, limit: number): Promise<UpdateMetrics[]> {
    const since = ago(30 * DAY);
    const { results } = await this.db
      .prepare(
        `SELECT u.id, u.group_id, u.platform, u.runtime_version, u.rollout_percent, u.paused, g.branch_name,
           (SELECT COUNT(*) FROM devices d WHERE d.served_update_id = u.id) AS served,
           (SELECT COUNT(*) FROM devices d WHERE d.current_update_id = u.id) AS running,
           (SELECT COUNT(*) FROM device_failures f WHERE f.update_id = u.id) AS failed,
           (SELECT COUNT(*) FROM devices d WHERE d.platform = u.platform AND d.runtime_version = u.runtime_version AND d.last_seen_at >= ?
              AND d.channel IN (SELECT name FROM channels WHERE branch_name = g.branch_name)) AS population
         FROM updates u JOIN update_groups g ON g.id = u.group_id
         WHERE g.published_at IS NOT NULL ${branch ? "AND g.branch_name = ?" : ""} ${platform ? "AND u.platform = ?" : ""}
         ORDER BY u.created_at DESC, u.rowid DESC LIMIT ?`,
      )
      .bind(since, ...(branch ? [branch] : []), ...(platform ? [platform] : []), limit)
      .all<{ id: string; group_id: string; platform: Platform; runtime_version: string; rollout_percent: number; paused: number; served: number; running: number; failed: number; population: number }>();
    return results.map((r) => ({
      updateId: r.id,
      groupId: r.group_id,
      platform: r.platform,
      runtimeVersion: r.runtime_version,
      rolloutPercent: r.rollout_percent,
      paused: r.paused === 1,
      served: r.served,
      running: r.running,
      failed: r.failed,
      population: r.population,
    }));
  }

  async overview(): Promise<Overview> {
    const [channels, counts, runtimes, latest] = await Promise.all([
      this.listChannels(),
      this.db
        .prepare("SELECT SUM(last_seen_at >= ?) AS day, COUNT(*) AS month FROM devices WHERE last_seen_at >= ?")
        .bind(ago(DAY), ago(30 * DAY))
        .first<{ day: number | null; month: number }>(),
      this.db
        .prepare("SELECT platform, runtime_version AS runtimeVersion, COUNT(*) AS devices FROM devices WHERE last_seen_at >= ? GROUP BY platform, runtime_version ORDER BY devices DESC LIMIT 20")
        .bind(ago(30 * DAY))
        .all<{ platform: Platform; runtimeVersion: string; devices: number }>(),
      this.groups(null, 5),
    ]);
    return {
      channels,
      devices: { last24h: counts?.day ?? 0, last30d: counts?.month ?? 0 },
      runtimes: runtimes.results,
      latest,
    };
  }

  // ---- tokens ----

  async createToken(name: string, scope: Scope, hash: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.prepare("INSERT INTO tokens (id, name, hash, scope, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, name, hash, scope, now()).run();
    return id;
  }

  async tokenByHash(hash: string): Promise<{ id: string; name: string; scope: Scope; hash: string } | null> {
    return this.db.prepare("SELECT id, name, scope, hash FROM tokens WHERE hash = ? AND revoked_at IS NULL").bind(hash).first();
  }

  async touchToken(id: string): Promise<void> {
    await this.db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").bind(now(), id).run();
  }

  async listTokens(): Promise<TokenSummary[]> {
    const { results } = await this.db
      .prepare("SELECT id, name, scope, created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt FROM tokens ORDER BY created_at DESC")
      .all<TokenSummary>();
    return results;
  }

  async revokeToken(id: string): Promise<void> {
    const result = await this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now(), id).run();
    if (!result.meta.changes) throw new NotFound("Token not found or already revoked.");
  }

  // ---- previews ----

  async createPreview(id: string, groupId: string, actor: string, expiresAt: string): Promise<void> {
    await this.db.prepare("INSERT INTO previews (id, group_id, actor, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(id, groupId, actor, now(), expiresAt).run();
  }

  async previewActive(id: string, groupId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS ok FROM previews WHERE id = ? AND group_id = ? AND revoked_at IS NULL AND expires_at > ?")
      .bind(id, groupId, now())
      .first();
    return row !== null;
  }

  // ---- audit ----

  async audit(actor: string, action: string, target: string | null, details: Record<string, unknown> | null = null): Promise<void> {
    await this.db.prepare("INSERT INTO audit_log (at, actor, action, target, details) VALUES (?, ?, ?, ?, ?)").bind(now(), actor, action, target, details ? JSON.stringify(details) : null).run();
  }

  async auditLog(limit: number): Promise<AuditEntry[]> {
    const { results } = await this.db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").bind(limit).all<{ id: number; at: string; actor: string; action: string; target: string | null; details: string | null }>();
    return results.map((r) => ({ ...r, details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null }));
  }

  // ---- garbage collection ----

  /**
   * Returns asset hashes no kept update references. An update is kept while its group is
   * unpublished-but-fresh, younger than 30 days, among the 20 newest groups of its branch,
   * still rolling out, or running/served on a device seen in the last 90 days. Updates that
   * are not kept are marked pruned so they are never served or rolled back to again.
   */
  async collectGarbage(limit = 200): Promise<{ hashes: string[]; prunedUpdates: number; staleGroups: number; devices: number }> {
    const keptSql = `
      SELECT u.id, u.launch_asset, u.assets FROM updates u JOIN update_groups g ON g.id = u.group_id
      WHERE u.created_at >= ?1 OR u.rollout_percent < 100
        OR g.id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY branch_name ORDER BY created_at DESC) AS rn FROM update_groups WHERE published_at IS NOT NULL) WHERE rn <= 20)
        OR u.id IN (SELECT current_update_id FROM devices WHERE last_seen_at >= ?2 AND current_update_id IS NOT NULL
                    UNION SELECT served_update_id FROM devices WHERE last_seen_at >= ?2 AND served_update_id IS NOT NULL)`;
    const thirty = ago(30 * DAY);
    const ninety = ago(90 * DAY);
    // Unpublished groups are failed or refused publishes: remove them after a day.
    const stale = await this.db.prepare("SELECT id FROM update_groups WHERE published_at IS NULL AND created_at < ?").bind(ago(DAY)).all<{ id: string }>();
    for (const { id } of stale.results) {
      await this.db.batch([
        this.db.prepare("DELETE FROM updates WHERE group_id = ?").bind(id),
        this.db.prepare("DELETE FROM update_groups WHERE id = ?").bind(id),
      ]);
    }
    const pruned = await this.db
      .prepare(`UPDATE updates SET pruned_at = ?3 WHERE pruned_at IS NULL AND id NOT IN (SELECT id FROM (${keptSql}))`)
      .bind(thirty, ninety, now())
      .run();
    const { results } = await this.db
      .prepare(
        `WITH kept AS (${keptSql}),
         refs AS (
           SELECT json_extract(launch_asset, '$.hash') AS hash FROM kept WHERE launch_asset IS NOT NULL
           UNION SELECT json_extract(j.value, '$.hash') FROM kept, json_each(kept.assets) AS j
         )
         SELECT hash FROM assets WHERE touched_at < ?3 AND hash NOT IN (SELECT hash FROM refs WHERE hash IS NOT NULL) LIMIT ?4`,
      )
      .bind(thirty, ninety, ago(DAY), limit)
      .all<{ hash: string }>();
    const forgotten = await this.db.prepare("DELETE FROM devices WHERE last_seen_at < ?").bind(ago(365 * DAY)).run();
    await this.db.batch([
      this.db.prepare("DELETE FROM device_failures WHERE last_seen_at < ?").bind(ninety),
      this.db.prepare("DELETE FROM previews WHERE expires_at < ?").bind(ago(7 * DAY)),
    ]);
    return {
      hashes: results.map((r) => r.hash),
      prunedUpdates: pruned.meta.changes ?? 0,
      staleGroups: stale.results.length,
      devices: forgotten.meta.changes ?? 0,
    };
  }

  async deleteAssets(hashes: string[]): Promise<void> {
    for (let i = 0; i < hashes.length; i += 90) {
      const chunk = hashes.slice(i, i + 90);
      await this.db.prepare(`DELETE FROM assets WHERE hash IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
    }
  }
}

function toGroup(group: GroupRow, updates: UpdateRow[]): GroupSummary {
  return {
    id: group.id,
    branch: group.branch_name,
    message: group.message,
    gitCommit: group.git_commit,
    actor: group.actor,
    kind: group.kind,
    sourceGroupId: group.source_group_id,
    createdAt: group.created_at,
    updates: updates.map(toUpdateSummary),
  };
}
