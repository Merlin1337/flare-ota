import { X509Certificate, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW_HEADER } from "@flare-ota/core";
import { Client } from "./api.ts";
import { expoConfig } from "./expo.ts";

export interface Check {
  name: string;
  ok: boolean;
  warn?: boolean;
  detail: string;
}

/** Pulls the signed part out of a multipart/mixed protocol response. */
export function signedPart(contentType: string, body: string): { header: string; json: string } | null {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) return null;
  for (const chunk of body.split(`--${boundary}`).slice(1, -1)) {
    const split = chunk.replace(/^\r\n/, "").indexOf("\r\n\r\n");
    const head = chunk.replace(/^\r\n/, "").slice(0, split);
    const json = chunk.replace(/^\r\n/, "").slice(split + 4).replace(/\r\n$/, "");
    if (/name="(manifest|directive)"/.test(head)) {
      const header = /expo-signature:\s*(.+)/i.exec(head)?.[1]?.trim() ?? "";
      return { header, json };
    }
  }
  return null;
}

export const CODE_SIGNING_EKU = "1.3.6.1.5.5.7.3.3";

/** A signed manifest probe: proves the server's private key matches the certificate baked into the app. */
export async function probeSignature(server: string, channel: string, certificate: X509Certificate | null): Promise<{ ok: boolean; warn?: boolean; detail: string }> {
  try {
    const response = await fetch(`${server}/manifest`, {
      headers: { "expo-protocol-version": "1", "expo-platform": "ios", "expo-runtime-version": "flare-ota-doctor", "expo-channel-name": channel, "expo-expect-signature": "sig" },
    });
    const part = signedPart(response.headers.get("content-type") ?? "", await response.text());
    const sig = part ? /sig="([^"]+)"/.exec(part.header)?.[1] : undefined;
    if (!response.ok || !part || !sig) return { ok: false, detail: `manifest probe → HTTP ${response.status}, no signature` };
    if (!certificate) return { ok: true, warn: true, detail: "server signs responses (no local certificate to verify against)" };
    const valid = verify("sha256", Buffer.from(part.json), certificate.publicKey, Buffer.from(sig, "base64"));
    return { ok: valid, detail: valid ? "server signature verified with the app's certificate" : "signature does NOT match the app's certificate: wrong key on the server" };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

export async function doctor(projectDir: string, client: Client): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, warn = false) => checks.push({ name, ok, detail, warn });
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  add("Node.js", major > 22 || (major === 22 && minor >= 18), `v${process.versions.node} (needs 22.18+)`);

  let config: Record<string, any> | null = null;
  try {
    config = await expoConfig(projectDir, "prebuild");
    add("Expo config", true, `${config.name ?? "app"} (${config.sdkVersion ?? "SDK ?"})`);
  } catch (error) {
    add("Expo config", false, `npx expo config failed: ${(error as Error).message.split("\n")[0]}`);
  }
  const pkg = existsSync(join(projectDir, "package.json")) ? JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) : {};
  add("expo-updates installed", Boolean(pkg.dependencies?.["expo-updates"]), pkg.dependencies?.["expo-updates"] ?? "run: npx expo install expo-updates");

  let certificate: X509Certificate | null = null;
  if (config) {
    const updates = config.updates ?? {};
    const expected = `${client.options.server}/manifest`;
    add("updates.url", updates.url === expected, `${updates.url ?? "(unset)"}${updates.url === expected ? "" : ` (expected ${expected})`}`);
    const channel = updates.requestHeaders?.["expo-channel-name"];
    add("channel", Boolean(channel), channel ? `expo-channel-name: ${channel}` : "declare updates.requestHeaders['expo-channel-name']");
    add("preview header", PREVIEW_HEADER in (updates.requestHeaders ?? {}), `updates.requestHeaders['${PREVIEW_HEADER}'] must be declared (empty string) for preview links`, true);
    add("runtime version", Boolean(config.runtimeVersion), JSON.stringify(config.runtimeVersion ?? "(unset)"));
    add("URL scheme", Boolean(config.scheme), config.scheme ? String(config.scheme) : "needed to open preview links", true);
    const meta = updates.codeSigningMetadata ?? {};
    const certPath = updates.codeSigningCertificate ? join(projectDir, updates.codeSigningCertificate) : null;
    if (certPath && existsSync(certPath)) {
      try {
        certificate = new X509Certificate(readFileSync(certPath));
        add("code signing", meta.keyid === "main" && meta.alg === "rsa-v1_5-sha256", `${updates.codeSigningCertificate}, valid to ${certificate.validTo}; metadata ${JSON.stringify(meta)}`);
        // expo-updates refuses a certificate without the codeSigning extended key usage (1.3.6.1.5.5.7.3.3).
        const usages = certificate.keyUsage ?? [];
        add("certificate usage", usages.includes(CODE_SIGNING_EKU), usages.includes(CODE_SIGNING_EKU) ? "codeSigning extended key usage present" : "missing the codeSigning extended key usage: devices will reject every update. Regenerate the certificate (setup or expo-updates codesigning:generate).");
      } catch (error) {
        add("code signing", false, `cannot read ${updates.codeSigningCertificate}: ${(error as Error).message}`);
      }
    } else {
      add("code signing", false, "set updates.codeSigningCertificate to a committed certificate (see flare-ota init)");
    }
  }

  try {
    const health = await fetch(`${client.options.server}/health`);
    add("server reachable", health.ok, `${client.options.server}/health → ${health.status}`);
  } catch (error) {
    add("server reachable", false, (error as Error).message);
  }

  if (client.options.token) {
    try {
      const me = await client.get<{ actor: string; scope: string }>("/api/v1/whoami");
      add("token", true, `${me.actor} (${me.scope})`);
    } catch (error) {
      add("token", false, (error as Error).message);
    }
  } else {
    add("token", false, "FLARE_OTA_TOKEN is not set (needed to publish)", true);
  }

  const channel = config?.updates?.requestHeaders?.["expo-channel-name"] ?? "production";
  const probe = await probeSignature(client.options.server, channel, certificate);
  add("signed response", probe.ok, probe.detail, probe.warn);
  return checks;
}
