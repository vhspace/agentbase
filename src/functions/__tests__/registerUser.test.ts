import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPair, exportJWK } from "jose";
import type { AppSyncResolverEvent } from "aws-lambda";
import type { RegisterUserInput } from "../../lib/types.js";

// Mock ElectroDB
const mockQuery = vi.fn();
const mockCreate = vi.fn();
vi.mock("../../lib/entities/user.js", () => ({
  UserEntity: {
    query: {
      byUsername: (params: unknown) => ({
        go: () => mockQuery("byUsername", params),
      }),
      byFingerprint: (params: unknown) => ({
        go: () => mockQuery("byFingerprint", params),
      }),
    },
    create: (data: unknown) => ({
      go: () => mockCreate(data),
    }),
  },
}));

vi.mock("../../lib/powertools.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metrics: { addMetric: vi.fn(), addMetadata: vi.fn() },
  withMetrics: (fn: unknown) => fn,
  MetricUnit: { Count: "Count" },
}));

const { handler } = await import("../resolvers/registerUser.js");

function makeEvent(
  input: RegisterUserInput,
): AppSyncResolverEvent<{ input: RegisterUserInput }> {
  return {
    arguments: { input },
    request: {
      headers: {
        "x-forwarded-for": "1.2.3.4",
        "cloudfront-viewer-country": "CA",
        "cloudfront-viewer-city": "Toronto",
        "cloudfront-viewer-country-region": "ON",
        "user-agent": "TestAgent/1.0",
      },
    },
    identity: null,
    source: null,
    prev: null,
    info: {} as never,
    stash: {},
  } as unknown as AppSyncResolverEvent<{ input: RegisterUserInput }>;
}

describe("registerUser", () => {
  let publicJwk: JsonWebKey;

  beforeEach(async () => {
    mockQuery.mockReset();
    mockCreate.mockReset();
    mockQuery.mockResolvedValue({ data: [] });
    mockCreate.mockResolvedValue({ data: {} });

    const { publicKey } = await generateKeyPair("ES256", { extractable: true });
    publicJwk = await exportJWK(publicKey);
  });

  it("registers a valid user", async () => {
    const event = makeEvent({
      username: "test-agent",
      publicKey: publicJwk,
    });

    const result = await handler(event);

    expect(result.username).toBe("test-agent");
    expect(result.userId).toBeDefined();
    expect(result.signupIp).toBe("1.2.3.4");
    expect(result.signupCountry).toBe("CA");
    expect(result.signupCity).toBe("Toronto");
    expect(result.signupRegion).toBe("ON");
    expect(result.signupUserAgent).toBe("TestAgent/1.0");
    expect(result.publicKeyFingerprint).toBeDefined();
    // Should not expose publicKey
    expect((result as Record<string, unknown>).publicKey).toBeUndefined();
  });

  it("rejects invalid username - too short", async () => {
    const event = makeEvent({
      username: "ab",
      publicKey: publicJwk,
    });

    await expect(handler(event)).rejects.toThrow("Username must be");
  });

  it("rejects invalid username - uppercase", async () => {
    const event = makeEvent({
      username: "TestAgent",
      publicKey: publicJwk,
    });

    await expect(handler(event)).rejects.toThrow("Username must be");
  });

  it("rejects invalid public key", async () => {
    const event = makeEvent({
      username: "test-agent",
      publicKey: { kty: "RSA" } as JsonWebKey,
    });

    await expect(handler(event)).rejects.toThrow("Public key must be");
  });

  it("rejects duplicate username", async () => {
    mockQuery.mockImplementation((type: string) => {
      if (type === "byUsername") return { data: [{ userId: "existing" }] };
      return { data: [] };
    });

    const event = makeEvent({
      username: "taken-name",
      publicKey: publicJwk,
    });

    await expect(handler(event)).rejects.toThrow("Username already taken");
  });

  it("rejects duplicate public key", async () => {
    mockQuery.mockImplementation((type: string) => {
      if (type === "byFingerprint") return { data: [{ userId: "existing" }] };
      return { data: [] };
    });

    const event = makeEvent({
      username: "new-agent",
      publicKey: publicJwk,
    });

    await expect(handler(event)).rejects.toThrow("Public key already registered");
  });
});
