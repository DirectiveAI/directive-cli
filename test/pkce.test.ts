import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { generatePkce, randomToken } from "../src/lib/pkce.js";

describe("pkce", () => {
  it("generates a 43-char verifier and a matching S256 challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toHaveLength(43);
    expect(verifier).not.toMatch(/[+/=]/); // url-safe, unpadded
    // challenge must equal base64url(SHA-256(verifier)) — what the API re-derives.
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it("randomToken is url-safe and unique", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/[+/=]/);
    expect(randomToken(16)).toHaveLength(22); // base64url(16 bytes)
  });
});
