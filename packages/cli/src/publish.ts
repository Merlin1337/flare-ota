import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { AssetRef, GroupSummary, Platform, PlatformUpdateInput } from "@flare-ota/core";
import type { Client } from "./api.ts";
import { expoConfig, exportBundles, gitCommit, runtimeVersion } from "./expo.ts";

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", heic: "image/heic",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
  json: "application/json", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
  mp4: "video/mp4", mov: "video/quicktime", lottie: "application/json", txt: "text/plain", html: "text/html",
  db: "application/octet-stream", bin: "application/octet-stream", pdf: "application/pdf",
};

interface ExportMetadata {
  fileMetadata: Partial<Record<Platform, { bundle: string; assets: { path: string; ext: string }[] }>>;
}

export interface LocalFile {
  ref: AssetRef;
  path: string;
}

function refFor(bytes: Buffer, contentType: string, fileExtension: string): AssetRef {
  const digest = createHash("sha256").update(bytes).digest();
  return { hash: digest.toString("base64url"), key: digest.toString("hex"), contentType, fileExtension };
}

/** Reads `expo export` output into content-addressed asset references, per platform. */
export async function readExport(outputDir: string, platforms: Platform[]) {
  const metadata = JSON.parse(await readFile(join(outputDir, "metadata.json"), "utf8")) as ExportMetadata;
  const files = new Map<string, LocalFile>();
  const perPlatform: Partial<Record<Platform, { launchAsset: AssetRef; assets: AssetRef[] }>> = {};
  for (const platform of platforms) {
    const entry = metadata.fileMetadata[platform];
    if (!entry) throw new Error(`expo export produced nothing for ${platform}.`);
    const bundlePath = join(outputDir, entry.bundle);
    const launchAsset = refFor(await readFile(bundlePath), "application/javascript", ".bundle");
    files.set(launchAsset.hash, { ref: launchAsset, path: bundlePath });
    const assets: AssetRef[] = [];
    for (const asset of entry.assets) {
      const path = join(outputDir, asset.path);
      const ext = asset.ext.replace(/^\./, "").toLowerCase();
      const ref = refFor(await readFile(path), CONTENT_TYPES[ext] ?? "application/octet-stream", `.${ext}`);
      if (!files.has(ref.hash)) files.set(ref.hash, { ref, path });
      if (!assets.some((a) => a.hash === ref.hash)) assets.push(ref);
    }
    perPlatform[platform] = { launchAsset, assets };
  }
  return { files, perPlatform };
}

async function pool<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]!);
    }),
  );
}

export interface PublishOptions {
  projectDir: string;
  branch: string;
  message: string;
  platforms: Platform[];
  rolloutPercent: number;
  /** Skip the check that the app's updates.url points at this server. */
  force?: boolean;
  log?: (line: string) => void;
  /** Expo tooling, replaceable in tests. */
  tools?: Partial<ExpoTools>;
}

export interface ExpoTools {
  expoConfig: typeof expoConfig;
  exportBundles: typeof exportBundles;
  runtimeVersion: typeof runtimeVersion;
  gitCommit: typeof gitCommit;
}

export async function publishUpdate(client: Client, options: PublishOptions): Promise<GroupSummary> {
  const log = options.log ?? (() => {});
  const tools: ExpoTools = { expoConfig, exportBundles, runtimeVersion, gitCommit, ...options.tools };
  const config = await tools.expoConfig(options.projectDir);
  const updatesUrl: string | undefined = config.updates?.url;
  const expected = `${client.options.server}/manifest`;
  if (!options.force && updatesUrl !== expected) {
    throw new Error(`The app's updates.url is ${updatesUrl ?? "(unset)"} but this server is ${expected}. Run \`flare-ota init\` or select the matching app config (--force to override).`);
  }
  const outputDir = await mkdtemp(join(tmpdir(), "flare-ota-export-"));
  try {
    log(`Exporting ${options.platforms.join(" + ")}…`);
    await tools.exportBundles(options.projectDir, options.platforms, outputDir);
    const { files, perPlatform } = await readExport(outputDir, options.platforms);
    const updates: Partial<Record<Platform, PlatformUpdateInput>> = {};
    for (const platform of options.platforms) {
      const rv = await tools.runtimeVersion(options.projectDir, platform);
      log(`${platform}: runtime ${rv}`);
      updates[platform] = { runtimeVersion: rv, ...perPlatform[platform]! };
    }
    // The app icon travels with the publish so the dashboard can show which app this is.
    const appIcon = await iconFile(options.projectDir, config);
    if (appIcon && !files.has(appIcon.ref.hash)) files.set(appIcon.ref.hash, appIcon);
    const { missing } = await client.post<{ missing: string[] }>("/api/v1/assets/missing", { hashes: [...files.keys()] });
    log(`Uploading ${missing.length} of ${files.size} files…`);
    await pool(missing, 4, async (hash) => {
      const file = files.get(hash)!;
      const bytes = await readFile(file.path);
      await client.request("PUT", `/api/v1/assets/${hash}`, new Uint8Array(bytes), { "content-type": file.ref.contentType });
    });
    return await client.post<GroupSummary>("/api/v1/groups", {
      branch: options.branch,
      message: options.message,
      gitCommit: await tools.gitCommit(options.projectDir),
      rolloutPercent: options.rolloutPercent,
      expoConfig: config,
      ...(appIcon ? { appIcon: appIcon.ref } : {}),
      updates,
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

const ICON_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };

/** The icon declared in the app config (icon, then iOS, then Android), if it is a readable image. */
export async function iconFile(projectDir: string, config: Record<string, any>): Promise<LocalFile | null> {
  for (const candidate of [config.icon, config.ios?.icon, config.android?.icon]) {
    if (typeof candidate !== "string") continue;
    const path = join(projectDir, candidate);
    const type = ICON_TYPES[extname(path).toLowerCase()];
    if (!type) continue;
    try {
      await access(path);
    } catch {
      continue;
    }
    const bytes = await readFile(path);
    if (bytes.length > 2 * 1024 * 1024) continue;
    return { ref: refFor(bytes, type, extname(path).toLowerCase()), path };
  }
  return null;
}
