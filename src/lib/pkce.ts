import { createHash, randomBytes } from "node:crypto";

/** base64url (no padding) of a buffer. */
export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A high-entropy, URL-safe random token (default 256 bits → 43 chars). */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/**
 * Generate a PKCE pair (RFC 7636, S256). The verifier is a 43-char base64url
 * string; the challenge is base64url(SHA-256(verifier)) — exactly what the API's
 * `/v1/cli/auth/token` endpoint re-derives and checks.
 */
export function generatePkce(): Pkce {
  const verifier = randomToken(32);
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
