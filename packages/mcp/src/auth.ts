import {
  generateKeyPair,
  exportJWK,
  importJWK,
  calculateJwkThumbprint,
  SignJWT,
} from "jose";
import type { JWK } from "jose";

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
