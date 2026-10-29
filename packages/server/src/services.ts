// Operations shared by the REST API, the MCP server and the dashboard. Every mutation is
// written to the audit log with the authenticated actor.

import {
  ASSET_HASH, NAME, PREVIEW_MAX_TTL_MINUTES, RUNTIME_VERSION, SCOPES, isPlatform, previewDeepLink, randomToken, signPreview,
  type AssetRef, type GroupSummary, type Platform, type PlatformUpdateInput, type PublishInput, type Scope,
} from "@flare-ota/core";
import { hashToken, TOKEN_PREFIX } from "./auth.ts";
import type { Env } from "./env.ts";
import { Conflict, NotFound, type Store } from "./store.ts";

export class Invalid extends Error {}

const CONTENT_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
const MAX_ASSETS = 2000;

function assetRef(value: unknown, where: string): AssetRef {
  const ref = value as AssetRef;
  if (
    typeof ref !== "object" || ref === null ||
    typeof ref.hash !== "string" || !ASSET_HASH.test(ref.hash) ||
    typeof ref.key !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(ref.key) ||
    typeof ref.contentType !== "string" || !CONTENT_TYPE.test(ref.contentType) ||
    typeof ref.fileExtension !== "string" || !/^(\.[A-Za-z0-9]{1,16})?$/.test(ref.fileExtension)
  ) {
    throw new Invalid(`Invalid asset in ${where}.`);
  }
  return { hash: ref.hash, key: ref.key, contentType: ref.contentType, fileExtension: ref.fileExtension };
}

/** Validates an untrusted publish body. Everything that reaches D1 or a manifest goes through here. */
export function parsePublishInput(body: unknown): PublishInput {
  const input = body as PublishInput;
  if (typeof input !== "object" || input === null) throw new Invalid("Expected a JSON object.");
  if (typeof input.branch !== "string" || !NAME.test(input.branch)) throw new Invalid("Invalid branch name.");
  if (typeof input.message !== "string" || input.message.length > 1000) throw new Invalid("message must be a string of at most 1000 characters.");
  if (input.gitCommit != null && (typeof input.gitCommit !== "string" || !/^[0-9a-f]{7,64}$/i.test(input.gitCommit))) throw new Invalid("Invalid gitCommit.");
  const rollout = input.rolloutPercent ?? 100;
  if (!Number.isInteger(rollout) || rollout < 1 || rollout > 100) throw new Invalid("rolloutPercent must be an integer from 1 to 100.");
  if (input.expoConfig != null && (typeof input.expoConfig !== "object" || JSON.stringify(input.expoConfig).length > 64_000)) throw new Invalid("expoConfig must be an object under 64 KB.");
  const updates: Partial<Record<Platform, PlatformUpdateInput>> = {};
  for (const [platform, update] of Object.entries(input.updates ?? {})) {
    if (!isPlatform(platform)) throw new Invalid(`Unknown platform ${platform}.`);
    const u = update as PlatformUpdateInput;
    if (typeof u?.runtimeVersion !== "string" || !RUNTIME_VERSION.test(u.runtimeVersion)) throw new Invalid(`Invalid runtimeVersion for ${platform}.`);
    if (!Array.isArray(u.assets) || u.assets.length > MAX_ASSETS) throw new Invalid(`assets for ${platform} must be an array of at most ${MAX_ASSETS}.`);
    updates[platform] = {
      runtimeVersion: u.runtimeVersion,
      launchAsset: assetRef(u.launchAsset, `${platform} launchAsset`),
      assets: u.assets.map((a, i) => assetRef(a, `${platform} assets[${i}]`)),
    };
  }
  if (Object.keys(updates).length === 0) throw new Invalid("Publish at least one platform.");
  let appIcon: AssetRef | undefined;
  if (input.appIcon != null) {
    appIcon = assetRef(input.appIcon, "appIcon");
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(appIcon.contentType)) throw new Invalid("appIcon must be a PNG, JPEG, WebP or SVG image.");
  }
  return { branch: input.branch, message: input.message, gitCommit: input.gitCommit ?? undefined, rolloutPercent: rollout, expoConfig: input.expoConfig ?? undefined, appIcon, updates };
}

export class Services {
  private readonly store: Store;
  private readonly env: Env;
  constructor(store: Store, env: Env) {
    this.store = store;
    this.env = env;
  }

  async publish(input: PublishInput, actor: string): Promise<GroupSummary> {
    const hashes = new Set<string>();
    for (const update of Object.values(input.updates)) {
      if (!update) continue;
      hashes.add(update.launchAsset.hash);
      for (const asset of update.assets) hashes.add(asset.hash);
    }
    if (input.appIcon) hashes.add(input.appIcon.hash);
    const existing = await this.store.existingAssets([...hashes]);
    const missing = [...hashes].filter((hash) => !existing.has(hash));
    if (missing.length) throw new Invalid(`${missing.length} asset(s) were not uploaded, e.g. ${missing[0]}.`);
    const group = await this.store.publish(input, { actor });
    await this.store.audit(actor, "publish", group.id, { branch: input.branch, message: input.message, rolloutPercent: input.rolloutPercent ?? 100 });
    return group;
  }

  async setRollout(groupId: string, percent: number, actor: string): Promise<GroupSummary> {
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new Invalid("percent must be an integer from 1 to 100.");
    await this.store.setRollout(groupId, percent);
    await this.store.audit(actor, "rollout", groupId, { percent });
    return (await this.store.group(groupId))!;
  }

  async setPaused(groupId: string, paused: boolean, actor: string): Promise<GroupSummary> {
    await this.store.setPaused(groupId, paused);
    await this.store.audit(actor, paused ? "pause" : "resume", groupId);
    return (await this.store.group(groupId))!;
  }

  /**
   * `previous` republishes the last good bundle under new ids (devices only move to newer
   * `createdAt`, as with EAS republish); `embedded` sends devices back to their build's JS.
   */
  async rollback(branch: string, platform: Platform | null, to: "previous" | "embedded", actor: string): Promise<GroupSummary> {
    if (!NAME.test(branch)) throw new Invalid("Invalid branch name.");
    const targets = await this.store.rollbackTargets(branch, platform);
    if (targets.length === 0) throw new NotFound(`Nothing is published on ${branch}${platform ? ` for ${platform}` : ""}.`);
    let group: GroupSummary;
    if (to === "embedded") {
      group = await this.store.publish(
        { branch, message: "Roll back to the embedded bundle", updates: {} },
        {
          actor,
          kind: "rollback-embedded",
          bypassRolloutGuard: true,
          rollbackToEmbedded: Object.fromEntries(targets.map((t) => [t.platform, { runtimeVersion: t.runtimeVersion }])),
        },
      );
    } else {
      const missing = targets.filter((t) => !t.target);
      if (missing.length) {
        throw new Conflict(`No earlier bundle to go back to for ${missing.map((t) => t.platform).join(", ")}. Use to=embedded instead.`);
      }
      const updates: PublishInput["updates"] = {};
      let expoConfig: Record<string, unknown> | undefined;
      for (const { platform: p, target } of targets) {
        updates[p] = { runtimeVersion: target!.runtimeVersion, launchAsset: target!.launchAsset!, assets: target!.assets };
        expoConfig ??= target!.expoConfig ?? undefined;
      }
      const source = targets[0]!.target!.groupId;
      group = await this.store.publish(
        { branch, message: `Roll back to ${source}`, updates, expoConfig },
        { actor, sourceGroupId: source, bypassRolloutGuard: true },
      );
    }
    await this.store.audit(actor, "rollback", group.id, { branch, platform, to });
    return group;
  }

  async promote(groupId: string, branch: string, rolloutPercent: number, actor: string): Promise<GroupSummary> {
    if (!NAME.test(branch)) throw new Invalid("Invalid branch name.");
    const updates = (await this.store.groupCandidates(groupId)).filter((u) => !u.rollbackToEmbedded && u.launchAsset);
    const source = await this.store.group(groupId);
    if (!source || updates.length === 0) throw new NotFound("Update group not found or has no bundle to promote.");
    const group = await this.store.publish(
      {
        branch,
        message: source.message,
        gitCommit: source.gitCommit ?? undefined,
        rolloutPercent,
        expoConfig: updates[0]!.expoConfig ?? undefined,
        updates: Object.fromEntries(updates.map((u) => [u.platform, { runtimeVersion: u.runtimeVersion, launchAsset: u.launchAsset!, assets: u.assets }])),
      },
      { actor, sourceGroupId: groupId },
    );
    await this.store.audit(actor, "promote", group.id, { from: groupId, branch, rolloutPercent });
    return group;
  }

  async setChannel(channel: string, branch: string, actor: string): Promise<void> {
    if (!NAME.test(channel) || !NAME.test(branch)) throw new Invalid("Invalid channel or branch name.");
    await this.store.setChannel(channel, branch);
    await this.store.audit(actor, "set-channel", channel, { branch });
  }

  async createPreview(groupId: string, ttlMinutes: number, scheme: string | null, actor: string) {
    const secret = this.env.PREVIEW_SECRET;
    if (!secret) throw new Conflict("Preview links are disabled: set the PREVIEW_SECRET secret.");
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > PREVIEW_MAX_TTL_MINUTES) throw new Invalid(`ttlMinutes must be from 1 to ${PREVIEW_MAX_TTL_MINUTES}.`);
    const appScheme = scheme ?? this.env.APP_SCHEME ?? null;
    if (!appScheme || !/^[a-z][a-z0-9+.-]{0,63}$/i.test(appScheme)) throw new Invalid("Pass the app's URL scheme (or set APP_SCHEME on the server).");
    if (!(await this.store.group(groupId))) throw new NotFound("Update group not found.");
    const exp = Math.floor(Date.now() / 1000) + ttlMinutes * 60;
    const nonce = crypto.randomUUID();
    const token = await signPreview(secret, { v: 1, g: groupId, exp, n: nonce });
    const expiresAt = new Date(exp * 1000).toISOString();
    await this.store.createPreview(nonce, groupId, actor, expiresAt);
    await this.store.audit(actor, "create-preview", groupId, { expiresAt });
    return { token, deepLink: previewDeepLink(appScheme, token), expiresAt };
  }

  async createToken(name: string, scope: Scope, actor: string): Promise<{ id: string; token: string }> {
    if (!/^[\w .@:-]{1,64}$/.test(name)) throw new Invalid("Token name: 1-64 letters, digits, spaces or . @ : _ -");
    if (!SCOPES.includes(scope)) throw new Invalid(`scope must be one of ${SCOPES.join(", ")}.`);
    const token = `${TOKEN_PREFIX}${randomToken(32)}`;
    const id = await this.store.createToken(name, scope, await hashToken(token));
    await this.store.audit(actor, "create-token", id, { name, scope });
    return { id, token };
  }

  async revokeToken(id: string, actor: string): Promise<void> {
    await this.store.revokeToken(id);
    await this.store.audit(actor, "revoke-token", id);
  }

  async collectGarbage(actor: string) {
    const result = await this.store.collectGarbage();
    if (result.hashes.length) {
      await this.env.BUCKET.delete(result.hashes.map((hash) => `assets/${hash}`));
      await this.store.deleteAssets(result.hashes);
    }
    const summary = { assets: result.hashes.length, prunedUpdates: result.prunedUpdates, staleGroups: result.staleGroups, devices: result.devices };
    if (summary.assets || summary.prunedUpdates || summary.staleGroups || summary.devices) await this.store.audit(actor, "gc", null, summary);
    return summary;
  }
}

