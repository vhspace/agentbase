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

describe("getKnowledge", () => {
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
