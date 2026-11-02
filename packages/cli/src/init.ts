import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PREVIEW_HEADER } from "@flare-ota/core";

export interface InitOptions {
  projectDir: string;
  server: string;
  channel: string;
  certificate: string;
}

/** The app config fields flare-ota needs. URL, channel and certificate are baked into native builds. */
export function updatesConfig(options: Omit<InitOptions, "projectDir">) {
  return {
    runtimeVersion: { policy: "fingerprint" },
    updates: {
      enabled: true,
      url: `${options.server}/manifest`,
      checkAutomatically: "ON_LOAD",
      codeSigningCertificate: options.certificate,
      codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
      // Every header the app may override at runtime must be declared here at build time.
      requestHeaders: { "expo-channel-name": options.channel, [PREVIEW_HEADER]: "" },
    },
  };
}

export async function init(options: InitOptions): Promise<string[]> {
  const notes: string[] = [];
  const fields = updatesConfig(options);
  const dynamic = ["app.config.ts", "app.config.js", "app.config.mjs", "app.config.cjs"].find((f) => existsSync(join(options.projectDir, f)));
  const appJsonPath = join(options.projectDir, "app.json");
  if (dynamic) {
    notes.push(`${dynamic} is dynamic: merge these fields into the returned config yourself (select the channel per build profile):`, JSON.stringify(fields, null, 2));
  } else if (existsSync(appJsonPath)) {
    const raw = await readFile(appJsonPath, "utf8");
    const json = JSON.parse(raw) as { expo?: Record<string, any> };
    const expo = (json.expo ??= {});
    expo.runtimeVersion = fields.runtimeVersion;
    expo.updates = { ...(expo.updates ?? {}), ...fields.updates, requestHeaders: { ...(expo.updates?.requestHeaders ?? {}), ...fields.updates.requestHeaders } };
    await copyFile(appJsonPath, `${appJsonPath}.flare-ota.bak`);
    await writeFile(appJsonPath, `${JSON.stringify(json, null, 2)}\n`);
    notes.push(`Updated app.json (backup: app.json.flare-ota.bak).`);
    if (!expo.scheme) notes.push(`Add a URL "scheme" to app.json so preview links can open the app.`);
  } else {
    throw new Error(`No app.json or app.config.* in ${options.projectDir}.`);
  }
  // The certificate is public and must reach every build (CI, EAS): a gitignored one silently
  // ships binaries without it, or with a stale copy.
  const ignored = spawnSync("git", ["check-ignore", "-q", options.certificate], { cwd: options.projectDir }).status === 0;
  if (ignored) {
    notes.push(`Warning: ${options.certificate} is gitignored. It is public and every build needs it: remove it from .gitignore and commit it.`);
  }
  if (!existsSync(join(options.projectDir, options.certificate))) {
    notes.push(
      `No certificate at ${options.certificate}. Generate the signing pair once, keep the private key OUT of the repo:`,
      `  npx expo-updates codesigning:generate --key-output-directory ../flare-ota-keys --certificate-output-directory certs --certificate-validity-duration-years 10 --certificate-common-name "<Your App>"`,
      `Commit certs/certificate.pem; deploy the server with the private key (FLARE_OTA_SIGNING_KEY).`,
    );
  }
  const native = ["ios", "android"].filter((dir) => existsSync(join(options.projectDir, dir)));
  if (native.length) {
    notes.push(
      `Warning: ${native.map((dir) => `${dir}/`).join(" and ")} already ${native.length > 1 ? "exist" : "exists"} here. \`expo run:*\` and local builds reuse ${native.length > 1 ? "them" : "it"} and keep the old updates URL, channel and certificate.`,
      `  Run \`npx expo prebuild --clean\` before the next build (it regenerates the native folders from app.json).`,
    );
  }
  notes.push("These settings are native: build and ship a new binary before devices can receive updates.");
  return notes;
}
