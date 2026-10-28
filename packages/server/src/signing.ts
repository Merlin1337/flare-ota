// Manifest code signing, verified on device by expo-updates: RSASSA-PKCS1-v1_5 over SHA-256,
// base64, sent per multipart part as `expo-signature: sig="…", keyid="…", alg="rsa-v1_5-sha256"`.

const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export const KEY_ID = "main";

export interface Signer {
  keyId: string;
  sign(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
}

const cache = new Map<string, Promise<CryptoKey>>();

export function signerFromPem(pem: string, keyId = KEY_ID): Signer {
  let key = cache.get(pem);
  if (!key) {
    key = crypto.subtle.importKey("pkcs8", pkcs8FromPem(pem), algorithm, false, ["sign"]);
    // A bad key must not stay cached as a rejected promise.
    key.catch(() => cache.delete(pem));
    cache.set(pem, key);
  }
  const keyPromise = key;
  return {
    keyId,
    async sign(bytes) {
      const signature = await crypto.subtle.sign(algorithm, await keyPromise, bytes);
      let binary = "";
      for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
  };
}

export function signatureHeader(signature: string, keyId: string): string {
  return `sig="${signature}", keyid="${keyId}", alg="rsa-v1_5-sha256"`;
}

// The PKCS#1 → PKCS#8 wrapping below is adapted from focux/open-ota (apps/updates/src/signing.ts),
// Copyright (c) 2026 Leonardo E. Dominguez, MIT License. See NOTICE.md.
//
// `expo-updates codesigning:generate` writes PKCS#1 (`RSA PRIVATE KEY`); WebCrypto only imports
// PKCS#8, so a PKCS#1 body is wrapped in the PKCS#8 envelope here.
export function pkcs8FromPem(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  if (!pem.includes("RSA PRIVATE KEY")) return der;
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaEncryption = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  return derSequence(0x30, concat(version, rsaEncryption, derSequence(0x04, der)));
}

function derSequence(tag: number, content: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const length =
    content.length < 0x80
      ? Uint8Array.of(content.length)
      : content.length < 0x100
        ? Uint8Array.of(0x81, content.length)
        : content.length < 0x10000
          ? Uint8Array.of(0x82, content.length >> 8, content.length & 0xff)
          : Uint8Array.of(0x83, content.length >> 16, (content.length >> 8) & 0xff, content.length & 0xff);
  return concat(Uint8Array.of(tag), length, content);
}

function concat(...chunks: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
