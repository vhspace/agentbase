import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppSyncResolverEvent } from "aws-lambda";

// Mock embeddings
vi.mock("../../lib/embeddings.js", () => ({
  storeEmbedding: vi.fn().mockResolvedValue(undefined),
  deleteVector: vi.fn().mockResolvedValue(undefined),
}));

// Mock powertools
vi.mock("../../lib/powertools.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metrics: { addMetric: vi.fn(), addMetadata: vi.fn() },
  withMetrics: (fn: unknown) => fn,
  MetricUnit: { Count: "Count" },
}));

// Mock rate limiter
const mockRateLimit = vi.fn();
vi.mock("../../lib/ratelimit.js", () => ({
  consumeRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

// Mock KnowledgeEntity
const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();
const mockQuery = vi.fn();

vi.mock("../../lib/entities/knowledge.js", () => ({
  KnowledgeEntity: {
    get: (params: unknown) => ({
      go: () => mockGet(params),
    }),
    create: (data: unknown) => ({
      go: () => mockCreate(data),
    }),
    patch: (params: unknown) => ({
      set: (updates: unknown) => ({
        go: (opts: unknown) => mockPatch(params, updates, opts),
      }),
    }),
    delete: (params: unknown) => ({
      go: () => mockDelete(params),
    }),
    query: {
      byUserAndTopic: (params: unknown) => ({
        go: (opts: unknown) => mockQuery("byUserAndTopic", params, opts),
        begins: () => ({
          go: (opts: unknown) => mockQuery("byUserAndTopicBegins", params, opts),
        }),
      }),
    },
  },
}));

function makeAuthEvent<T>(args: T): AppSyncResolverEvent<T> {
  return {
    arguments: args,
    identity: {
      resolverContext: {
        userId: "user-123",
        username: "test-agent",
      },
    },
    request: { headers: {} },
    source: null,
    prev: null,
    info: {} as never,
    stash: {},
  } as unknown as AppSyncResolverEvent<T>;
}

describe("createKnowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ data: [] });
    mockCreate.mockResolvedValue({ data: {} });
  });

  it("creates a knowledge item with defaults", async () => {
    const { handler } = await import("../resolvers/createKnowledge.js");

    const event = makeAuthEvent({
      input: {
        topic: "software",
        contentType: "text/plain",
        content: "TypeScript is great",
      },
    });

    const result = await handler(event);

    expect(result.topic).toBe("software");
    expect(result.language).toBe("en-CA");
    expect(result.visibility).toBe("public");
    expect(result.userId).toBe("user-123");
    expect(result.knowledgeId).toBeDefined();
  });

  it("rejects invalid topic", async () => {
    const { handler } = await import("../resolvers/createKnowledge.js");

    const event = makeAuthEvent({
      input: {
        topic: "INVALID TOPIC!",
        contentType: "text/plain",
        content: "test",
      },
    });

    await expect(handler(event)).rejects.toThrow("Topic must be");
  });

  it("rejects oversized content", async () => {
    const { handler } = await import("../resolvers/createKnowledge.js");

    const event = makeAuthEvent({
      input: {
        topic: "test",
        contentType: "text/plain",
        content: "x".repeat(300_000),
      },
    });

    await expect(handler(event)).rejects.toThrow("Content exceeds");
  });
});

describe("createKnowledge without a credential", () => {
  function makeAnonEvent<T>(args: T, headers: Record<string, string> = {}): AppSyncResolverEvent<T> {
    const e = makeAuthEvent(args) as unknown as { identity: unknown; request: { headers: Record<string, string> } };
    e.identity = { resolverContext: {} };
    e.request = { headers };
    return e as unknown as AppSyncResolverEvent<T>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ data: {} });
    mockRateLimit.mockResolvedValue({ allowed: true, count: 1, limit: 60, resetInSeconds: 100 });
  });

  it("stores under the shared anonymous owner with the caller's address", async () => {
    const { handler } = await import("../resolvers/createKnowledge.js");
    const result = await handler(
      makeAnonEvent(
        { input: { topic: "software", contentType: "text/plain", content: "x" } },
        { "x-agentbase-client-ip": "198.51.100.7, 10.0.0.1", "x-agentbase-user-agent": "codex-mcp-client/1" },
      ),
    );
    expect(result.userId).toBe("anonymous");
    expect(result.visibility).toBe("public");
    expect(result.sourceIp).toBe("198.51.100.7");
    expect(result.sourceUserAgent).toBe("codex-mcp-client/1");
    expect(mockRateLimit).toHaveBeenCalledWith("anon-store:198.51.100.7", 60, 3600);
    // No per-user cap query for the shared pool
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("falls back to a shared bucket when no address was forwarded", async () => {
    const { handler } = await import("../resolvers/createKnowledge.js");
    const result = await handler(
      makeAnonEvent({ input: { topic: "software", contentType: "text/plain", content: "x" } }),
    );
    expect(result.sourceIp).toBeUndefined();
    expect(mockRateLimit).toHaveBeenCalledWith("anon-store:unknown", 60, 3600);
  });

  it("refuses private anonymous items", async () => {
    const { handler } = await import("../resolvers/createKnowledge.js");
    await expect(
      handler(makeAnonEvent({ input: { topic: "software", contentType: "text/plain", content: "x", visibility: "private" } })),
    ).rejects.toThrow("Anonymous items are always public");
    expect(mockRateLimit).not.toHaveBeenCalled();
  });

  it("rejects with RATE_LIMITED once the address is over its hourly budget", async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, count: 61, limit: 60, resetInSeconds: 42 });
    const { handler } = await import("../resolvers/createKnowledge.js");
    await expect(
      handler(makeAnonEvent({ input: { topic: "software", contentType: "text/plain", content: "x" } }, { "x-agentbase-client-ip": "198.51.100.7" })),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", message: expect.stringContaining("42s") });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("authenticated stores carry no source metadata and still hit the per-user cap check", async () => {
    mockQuery.mockResolvedValue({ data: [] });
    const { handler } = await import("../resolvers/createKnowledge.js");
    const result = await handler(
      makeAuthEvent({ input: { topic: "software", contentType: "text/plain", content: "x" } }),
    );
    expect(result.userId).toBe("user-123");
    expect(result.sourceIp).toBeUndefined();
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalled();
  });
});

describe("getKnowledge", () => {
  it("returns public items to anonymous callers", async () => {
    const { handler } = await import("../resolvers/getKnowledge.js");
    mockGet.mockResolvedValue({ data: { knowledgeId: "k1", userId: "anonymous", visibility: "public" } });
    const e = makeAuthEvent({ id: "k1" }) as unknown as { identity: unknown };
    e.identity = { resolverContext: {} };
    const result = await handler(e as unknown as AppSyncResolverEvent<{ id: string }>);
    expect(result.knowledgeId).toBe("k1");
  });

  it("hides private items from anonymous callers", async () => {
    const { handler } = await import("../resolvers/getKnowledge.js");
    mockGet.mockResolvedValue({ data: { knowledgeId: "k2", userId: "user-123", visibility: "private" } });
    const e = makeAuthEvent({ id: "k2" }) as unknown as { identity: unknown };
    e.identity = { resolverContext: {} };
    await expect(handler(e as unknown as AppSyncResolverEvent<{ id: string }>)).rejects.toThrow("Access denied");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns public item to any authenticated user", async () => {
    mockGet.mockResolvedValue({
      data: {
        knowledgeId: "k-1",
        userId: "other-user",
        visibility: "public",
        topic: "test",
        content: "hello",
      },
    });

    const { handler } = await import("../resolvers/getKnowledge.js");
    const event = makeAuthEvent({ id: "k-1" });
    const result = await handler(event);

    expect(result.knowledgeId).toBe("k-1");
  });

  it("returns private item to owner", async () => {
    mockGet.mockResolvedValue({
      data: {
        knowledgeId: "k-2",
        userId: "user-123",
        visibility: "private",
        topic: "secret",
        content: "hidden",
      },
    });

    const { handler } = await import("../resolvers/getKnowledge.js");
    const event = makeAuthEvent({ id: "k-2" });
    const result = await handler(event);

    expect(result.knowledgeId).toBe("k-2");
  });

  it("rejects private item for non-owner", async () => {
    mockGet.mockResolvedValue({
      data: {
        knowledgeId: "k-3",
        userId: "other-user",
        visibility: "private",
        topic: "secret",
        content: "hidden",
      },
    });

    const { handler } = await import("../resolvers/getKnowledge.js");
    const event = makeAuthEvent({ id: "k-3" });

    await expect(handler(event)).rejects.toThrow("Access denied");
  });

  it("throws NOT_FOUND for missing item", async () => {
    mockGet.mockResolvedValue({ data: null });

    const { handler } = await import("../resolvers/getKnowledge.js");
    const event = makeAuthEvent({ id: "nonexistent" });

    await expect(handler(event)).rejects.toThrow("Knowledge item not found");
  });
});

describe("deleteKnowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes own item", async () => {
    mockGet.mockResolvedValue({
      data: { knowledgeId: "k-1", userId: "user-123" },
    });
    mockDelete.mockResolvedValue({});

    const { handler } = await import("../resolvers/deleteKnowledge.js");
    const event = makeAuthEvent({ id: "k-1" });
    const result = await handler(event);

    expect(result).toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });

  it("rejects deleting another user's item", async () => {
    mockGet.mockResolvedValue({
      data: { knowledgeId: "k-1", userId: "other-user" },
    });

    const { handler } = await import("../resolvers/deleteKnowledge.js");
    const event = makeAuthEvent({ id: "k-1" });

    await expect(handler(event)).rejects.toThrow("Only the owner");
  });
});
