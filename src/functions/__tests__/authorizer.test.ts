import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPair, exportJWK, importJWK, SignJWT } from "jose";
import type { AppSyncAuthorizerEvent } from "aws-lambda";

const ISS = "https://mcp.example.test";
const { privateKey: serverPriv } = await generateKeyPair("ES256", { extractable: true });
const serverJwk = await exportJWK(serverPriv);
serverJwk.kid = "k1";
process.env.OAUTH_SIGNING_KEY = JSON.stringify(serverJwk);
process.env.OAUTH_ISSUER = ISS;

const mockGet = vi.fn();
const mockByFingerprint = vi.fn();
vi.mock("../../lib/entities/user.js", () => ({
  UserEntity: {
    get: (key: unknown) => ({ go: () => mockGet(key) }),
    query: {
      byFingerprint: (params: unknown) => ({ go: () => mockByFingerprint(params) }),
    },
  },
}));
const mockJti = vi.fn();
vi.mock("../../lib/auth/replay.js", () => ({
  checkAndStoreJti: (...args: unknown[]) => mockJti(...args),
}));
vi.mock("../../lib/powertools.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { handler } = await import("../authorizer.js");

const event = (authorizationToken: string) =>
  ({ authorizationToken, requestContext: {} }) as unknown as AppSyncAuthorizerEvent;

describe("authorizer", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockByFingerprint.mockReset();
    mockJti.mockReset();
  });

  it("lets anonymous through with an empty context", async () => {
    const res = await handler(event("Bearer anonymous"));
    expect(res.isAuthorized).toBe(true);
    expect(res.resolverContext).toEqual({});
  });

  it("accepts a server-issued access token and resolves the user by id", async () => {
    mockGet.mockResolvedValue({ data: { userId: "01USER", username: "mischa" } });
    const token = await new SignJWT({ client_id: "claude-code" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setSubject("01USER")
      .setIssuer(ISS)
      .setAudience(ISS)
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(await importJWK(serverJwk, "ES256"));

    const res = await handler(event(`Bearer ${token}`));
    expect(res.isAuthorized).toBe(true);
    expect(res.resolverContext).toEqual({ userId: "01USER", username: "mischa" });
    expect(mockGet).toHaveBeenCalledWith({ userId: "01USER" });
    expect(mockByFingerprint).not.toHaveBeenCalled();
    expect(mockJti).not.toHaveBeenCalled();
  });

  it("denies a server-issued token whose user no longer exists", async () => {
    mockGet.mockResolvedValue({ data: null });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("01GONE")
      .setIssuer(ISS)
      .setAudience(ISS)
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(await importJWK(serverJwk, "ES256"));
    const res = await handler(event(`Bearer ${token}`));
    expect(res.isAuthorized).toBe(false);
  });

  it("denies a token claiming our issuer but signed with another key", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("01USER")
      .setIssuer(ISS)
      .setAudience(ISS)
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(privateKey);
    const res = await handler(event(`Bearer ${forged}`));
    expect(res.isAuthorized).toBe(false);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("still verifies legacy keypair tokens by fingerprint and jti", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const pub = await exportJWK(publicKey);
    mockByFingerprint.mockResolvedValue({
      data: [{ userId: "01LEGACY", username: "agent", publicKey: pub }],
    });
    mockJti.mockResolvedValue(undefined);
    const legacy = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("fp-123")
      .setIssuedAt()
      .setExpirationTime("30s")
      .setJti("jti-1")
      .sign(privateKey);
    const res = await handler(event(`Bearer ${legacy}`));
    expect(res.isAuthorized).toBe(true);
    expect(res.resolverContext).toEqual({ userId: "01LEGACY", username: "agent" });
    expect(mockByFingerprint).toHaveBeenCalledWith({ publicKeyFingerprint: "fp-123" });
    expect(mockJti).toHaveBeenCalledWith("jti-1", expect.any(Number));
    expect(mockGet).not.toHaveBeenCalled();
  });
});
