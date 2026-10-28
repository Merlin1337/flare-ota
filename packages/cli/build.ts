// Bundles the CLI (with @flare-ota/core inlined) and the Expo preview helper into dist/.
import { build } from "esbuild";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist");
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "inline",
});
await build({
  entryPoints: ["src/expo-client.ts"],
  outfile: "dist/expo.js",
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2020",
  external: ["expo-updates"],
});
await writeFile(
  "dist/expo.d.ts",
  `export declare function handlePreviewUrl(url: string | null | undefined): Promise<boolean>;
export declare function exitPreview(): Promise<void>;
export declare function reportAppVersion(version: string | null | undefined): Promise<void>;
`,
);
await copyFile("../../LICENSE", "dist/LICENSE").catch(() => {});
console.log("built dist/cli.js and dist/expo.js");
