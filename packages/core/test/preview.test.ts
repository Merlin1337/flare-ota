import { describe, expect, it } from "vitest";
import { base64url, previewDeepLink, signPreview, utf8, verifyPreview } from "../src/index.ts";

const payload = (exp: number) => ({ v: 1 as const, g: crypto.randomUUID(), exp, n: crypto.randomUUID() });
const soon = () => Math.floor(Date.now() / 1000) + 60;

describe("preview tokens", () => {
  it("round-trips a signed payload", async () => {
    const p = payload(soon());
    expect(await verifyPreview("secret", await signPreview("secret", p))).toEqual(p);
  });

  it("rejects expired tokens, other secrets and tampered payloads", async () => {
    expect(await verifyPreview("secret", await signPreview("secret", payload(Math.floor(Date.now() / 1000) - 1)))).toBeNull();
    const token = await signPreview("secret", payload(soon()));
    expect(await verifyPreview("other", token)).toBeNull();
    const [, mac] = token.split(".");
    const forgedBody = base64url(utf8(JSON.stringify(payload(soon() + 9999))));
    expect(await verifyPreview("secret", `${forgedBody}.${mac}`)).toBeNull();
    expect(await verifyPreview("secret", "garbage")).toBeNull();
    expect(await verifyPreview("secret", "a.b.c")).toBeNull();
  });

  it("builds a deep link the Expo helper understands", () => {
    expect(previewDeepLink("myapp", "a.b")).toBe("myapp://flare-ota/preview?token=a.b");
  });
});
