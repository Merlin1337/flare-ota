// Small runtime-agnostic helpers (Workers and Node share WebCrypto and TextEncoder).

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256(data: Uint8Array<ArrayBuffer> | string): Promise<Uint8Array<ArrayBuffer>> {
  const input = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

/** Compares two byte strings without an early exit, so timing does not reveal the matching prefix. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
