import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  S3VectorsClient,
  QueryVectorsCommand,
  ListIndexesCommand,
} from "@aws-sdk/client-s3vectors";

vi.mock("../powertools.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const bedrockMock = mockClient(BedrockRuntimeClient);
const s3VectorsMock = mockClient(S3VectorsClient);

const { queryVectors } = await import("../embeddings.js");

describe("queryVectors", () => {
  beforeEach(() => {
    bedrockMock.reset();
    s3VectorsMock.reset();
    bedrockMock.on(InvokeModelCommand).resolves({
      body: new TextEncoder().encode(
        JSON.stringify({ embedding: [0.1, 0.2, 0.3] }),
      ),
    } as never);
    s3VectorsMock
      .on(ListIndexesCommand)
      .resolves({ indexes: [{ indexName: "knowledge" }] } as never);
  });

  it("converts cosine distance to similarity so higher means closer", async () => {
    s3VectorsMock.on(QueryVectorsCommand).resolves({
      vectors: [
        { key: "far", distance: 0.9 },
        { key: "near", distance: 0.2 },
      ],
    } as never);

    const results = await queryVectors("memory leaks", {}, 10);

    expect(results).toEqual([
      { key: "far", score: expect.closeTo(0.1, 5) },
      { key: "near", score: expect.closeTo(0.8, 5) },
    ]);
  });

  it("treats a missing distance as no similarity", async () => {
    s3VectorsMock
      .on(QueryVectorsCommand)
      .resolves({ vectors: [{ key: "k" }] } as never);

    const results = await queryVectors("q", {}, 1);

    expect(results[0].score).toBe(0);
  });
});
