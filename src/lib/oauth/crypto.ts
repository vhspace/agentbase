import { createHash, randomBytes } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256base64url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) must equal the stored challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  return sha256base64url(verifier) === challenge;
}
