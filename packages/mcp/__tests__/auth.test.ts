import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  encodeToken,
  decodeToken,
  signRequest,
} from "../src/auth.js";
import { importJWK, jwtVerify, calculateJwkThumbprint } from "jose";

describe("auth", () => {
  describe("generateKeypair", () => {
    it("generates valid ES256 keypair with fingerprint", async () => {
      const { privateKey, publicKey, fingerprint } = await generateKeypair();

      expect(privateKey.kty).toBe("EC");
      expect(privateKey.crv).toBe("P-256");
      expect(privateKey.d).toBeTruthy();
      expect(publicKey.kty).toBe("EC");
      expect(publicKey.crv).toBe("P-256");
      expect(publicKey.d).toBeUndefined();
      expect(fingerprint).toBeTruthy();
      expect(typeof fingerprint).toBe("string");
    });

    it("generates unique keypairs each time", async () => {
      const a = await generateKeypair();
      const b = await generateKeypair();
      expect(a.fingerprint).not.toBe(b.fingerprint);
    });
  });

  describe("encodeToken / decodeToken", () => {
    it("round-trips keypair through token encoding", async () => {
      const { privateKey, publicKey } = await generateKeypair();
      const token = encodeToken(privateKey, publicKey);

      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);

      const decoded = decodeToken(token);
      expect(decoded.privateKey).toEqual(privateKey);
      expect(decoded.publicKey).toEqual(publicKey);
    });

    it("produces URL-safe base64 (no +, /, =)", async () => {
      const { privateKey, publicKey } = await generateKeypair();
      const token = encodeToken(privateKey, publicKey);
      expect(token).not.toMatch(/[+/=]/);
    });

    it("throws on invalid token", () => {
      expect(() => decodeToken("not-valid-base64url!!!")).toThrow();
    });
  });

  describe("signRequest", () => {
    it("produces a valid ES256 JWT", async () => {
      const { privateKey, publicKey, fingerprint } = await generateKeypair();
      const jwt = await signRequest(privateKey, publicKey);

      expect(typeof jwt).toBe("string");
      expect(jwt.split(".")).toHaveLength(3);

      const key = await importJWK(publicKey, "ES256");
      const { payload, protectedHeader } = await jwtVerify(jwt, key);

      expect(protectedHeader.alg).toBe("ES256");
      expect(payload.sub).toBe(fingerprint);
      expect(payload.iat).toBeTruthy();
      expect(payload.exp).toBeTruthy();
      expect(payload.jti).toBeTruthy();
    });

    it("sets expiration ~30s from now", async () => {
      const { privateKey, publicKey } = await generateKeypair();
      const jwt = await signRequest(privateKey, publicKey);

      const key = await importJWK(publicKey, "ES256");
      const { payload } = await jwtVerify(jwt, key);

      const diff = payload.exp! - payload.iat!;
      expect(diff).toBe(30);
    });

    it("generates unique JTIs per call", async () => {
      const { privateKey, publicKey } = await generateKeypair();
      const jwt1 = await signRequest(privateKey, publicKey);
      const jwt2 = await signRequest(privateKey, publicKey);

      const key = await importJWK(publicKey, "ES256");
      const { payload: p1 } = await jwtVerify(jwt1, key);
      const { payload: p2 } = await jwtVerify(jwt2, key);

      expect(p1.jti).not.toBe(p2.jti);
    });
  });
});
