import {
  generateKeyPair,
  exportJWK,
  importJWK,
  calculateJwkThumbprint,
  SignJWT,
} from "jose";
import type { JWK } from "jose";

/**
 * How a request to AppSync is authenticated.
 * - keypair: legacy token holding the agent's own ES256 keypair; every
 *   request is signed with a short-lived JWT (see signRequest).
 * - bearer: an access token issued by the OAuth authorization server, passed
 *   through unchanged and verified by the AppSync authorizer via its iss.
 */
export type Credential =
  | { kind: "keypair"; privateKey: JWK; publicKey: JWK }
  | { kind: "bearer"; token: string };

/** Parse an Authorization header into a credential, or undefined if absent or unusable. */
export function parseAuthorization(header: string | undefined): Credential | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice(7).trim();
  if (!token) return undefined;
  if (looksLikeJwt(token)) return { kind: "bearer", token };
  try {
    const { privateKey, publicKey } = decodeToken(token);
    if (!privateKey?.d || !publicKey?.x) return undefined;
    return { kind: "keypair", privateKey, publicKey };
  } catch {
    return undefined;
  }
}

function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return typeof header?.alg === "string";
  } catch {
    return false;
  }
}

export interface TokenPayload {
  priv: JWK;
  pub: JWK;
}

export async function generateKeypair(): Promise<{
  privateKey: JWK;
  publicKey: JWK;
  fingerprint: string;
}> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const fingerprint = await calculateJwkThumbprint(publicJwk, "sha256");
  return { privateKey: privateJwk, publicKey: publicJwk, fingerprint };
}

export function encodeToken(privateKey: JWK, publicKey: JWK): string {
  const payload: TokenPayload = { priv: privateKey, pub: publicKey };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeToken(token: string): {
  privateKey: JWK;
  publicKey: JWK;
} {
  const payload = JSON.parse(
    Buffer.from(token, "base64url").toString("utf-8"),
  ) as TokenPayload;
  return { privateKey: payload.priv, publicKey: payload.pub };
}

export async function signRequest(
  privateKey: JWK,
  publicKey: JWK,
): Promise<string> {
  const key = await importJWK(privateKey, "ES256");
  const fingerprint = await calculateJwkThumbprint(publicKey, "sha256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(fingerprint)
    .setIssuedAt()
    .setExpirationTime("30s")
    .setJti(crypto.randomUUID())
    .sign(key);
}
