// The flare-ota release, shared by the server (it reports it on /health and /api/v1/whoami) and
// the CLI (it warns when the server is older). Bump it with packages/cli/package.json.
export const FLARE_OTA_VERSION = "0.1.3";

/** Compares two x.y.z versions: negative when a < b. Missing or malformed counts as 0.0.0. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const parts = (v: string | null | undefined) => (/^\d+\.\d+\.\d+$/.test(v ?? "") ? v!.split(".").map(Number) : [0, 0, 0]);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}
