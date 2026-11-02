import { describe, it, expect } from "vitest";
import { generateKeyPair, exportJWK, importJWK, SignJWT } from "jose";
import { loadServerKeys, isServerIssued, verifyAccessToken } from "../oauth.js";

const ISS = "https://mcp.example.test";

async function serverKeyEnv() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.kid = "k1";
  return { OAUTH_SIGNING_KEY: JSON.stringify(jwk), OAUTH_ISSUER: ISS };
}

describe("loadServerKeys", () => {
  it("is disabled until the secret is set", () => {
    expect(loadServerKeys({ OAUTH_SIGNING_KEY: "unset", OAUTH_ISSUER: ISS })).toBeUndefined();
    expect(loadServerKeys({ OAUTH_ISSUER: ISS })).toBeUndefined();
    expect(loadServerKeys({ OAUTH_SIGNING_KEY: "{}" })).toBeUndefined();
  });

  it("rejects keys that are not P-256 private JWKs with a kid", () => {
    expect(() => loadServerKeys({ OAUTH_SIGNING_KEY: "nope", OAUTH_ISSUER: ISS })).toThrow(/valid JSON/);
    expect(() =>
      loadServerKeys({ OAUTH_SIGNING_KEY: JSON.stringify({ kty: "EC", crv: "P-256", x: "a", y: "b" }), OAUTH_ISSUER: ISS }),
    ).toThrow(/private JWK with a kid/);
  });

  it("derives the public key by dropping d", async () => {
    const keys = loadServerKeys(await serverKeyEnv())!;
    expect(keys.kid).toBe("k1");
    expect(keys.issuer).toBe(ISS);
    expect(keys.privateJwk.d).toBeDefined();
    expect((keys.publicJwk as { d?: string }).d).toBeUndefined();
  });
});

describe("verifyAccessToken", () => {
  it("accepts a token signed by the server key and returns the user id", async () => {
    const keys = loadServerKeys(await serverKeyEnv())!;
    const t = await new SignJWT({ client_id: "c1", scope: "knowledge" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setSubject("01USER")
      .setIssuer(ISS)
      .setAudience(ISS)
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(await importJWK(keys.privateJwk, "ES256"));
    expect(isServerIssued(t, ISS)).toBe(true);
    await expect(verifyAccessToken(t, keys)).resolves.toEqual({
      userId: "01USER",
      clientId: "c1",
      scope: "knowledge",
    });
  });

  it("rejects tokens from another issuer, another key, or expired", async () => {
    const keys = loadServerKeys(await serverKeyEnv())!;
    const other = loadServerKeys(await serverKeyEnv())!;
    const sign = async (k: typeof keys, iss: string, exp: string) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setSubject("01USER")
        .setIssuer(iss)
        .setAudience(ISS)
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(await importJWK(k.privateJwk, "ES256"));

    const wrongIss = await sign(keys, "https://evil.test", "30d");
    expect(isServerIssued(wrongIss, ISS)).toBe(false);
    await expect(verifyAccessToken(wrongIss, keys)).rejects.toThrow();

    const wrongKey = await sign(other, ISS, "30d");
    expect(isServerIssued(wrongKey, ISS)).toBe(true);
    await expect(verifyAccessToken(wrongKey, keys)).rejects.toThrow(/signature/i);

    const expired = await sign(keys, ISS, "-1h");
    await expect(verifyAccessToken(expired, keys)).rejects.toThrow(/exp/i);
  });

  it("treats a legacy keypair token as not server issued", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const legacy = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("fingerprint")
      .setIssuedAt()
      .setExpirationTime("30s")
      .setJti("x")
      .sign(privateKey);
    expect(isServerIssued(legacy, ISS)).toBe(false);
    expect(isServerIssued("not-a-jwt", ISS)).toBe(false);
  });
});
