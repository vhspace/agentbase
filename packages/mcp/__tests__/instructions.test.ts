import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const gqlPublic = vi.fn();
vi.mock("../src/client.js", () => ({
  gqlPublic: (...args: unknown[]) => gqlPublic(...args),
  gql: vi.fn(),
}));

const { createMcpServer } = await import("../src/index.js");

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

describe("server guidance for agents", () => {
  beforeEach(() => gqlPublic.mockReset());

  it("tells connecting agents when to search and when to store", async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("agentbase_search");
    expect(instructions).toContain("agentbase_store_knowledge");
    expect(instructions).toContain("agentbase_setup");
    expect(instructions.length).toBeLessThan(2048);
  });

  it("does not mark setup as destructive", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const setup = tools.find((t) => t.name === "agentbase_setup");
    expect(setup?.annotations?.destructiveHint).toBe(false);
  });

  it("flags searches where nothing relevant exists and asks for a contribution", async () => {
    gqlPublic.mockResolvedValue({
      data: {
        searchKnowledge: [
          { knowledgeId: "a", score: 0.21, topic: "x", snippet: "" },
          { knowledgeId: "b", score: 0.12, topic: "y", snippet: "" },
        ],
      },
    });
    const client = await connect();
    const res = await client.callTool({
      name: "agentbase_search",
      arguments: { query: "sourdough hydration" },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/^No relevant matches \(best score 0\.21/);
    expect(text).toContain("agentbase_store_knowledge");
  });

  it("logs the query, result count and best score for every search", async () => {
    gqlPublic.mockResolvedValue({
      data: {
        searchKnowledge: [
          { knowledgeId: "a", score: 0.61, topic: "x", snippet: "" },
          { knowledgeId: "b", score: 0.4, topic: "y", snippet: "" },
        ],
      },
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    let entry: unknown;
    try {
      const client = await connect();
      await client.callTool({
        name: "agentbase_search",
        arguments: { query: "lambda cold start", topic: "aws" },
      });
      entry = out.mock.calls
        .map(([line]) => JSON.parse(String(line)))
        .find((e) => e.message === "Knowledge search");
    } finally {
      out.mockRestore();
    }
    expect(entry).toMatchObject({
      query: "lambda cold start",
      topic: "aws",
      authenticated: false,
      resultCount: 2,
      bestScore: 0.61,
      relevant: true,
    });
  });

  it("reports the best score when results are relevant", async () => {
    gqlPublic.mockResolvedValue({
      data: {
        searchKnowledge: [{ knowledgeId: "a", score: 0.76, topic: "x", snippet: "" }],
      },
    });
    const client = await connect();
    const res = await client.callTool({
      name: "agentbase_search",
      arguments: { query: "zero downtime deploys" },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/^Found 1 result\(s\), best score 0\.76/);
  });
});

describe("agentbase_setup", () => {
  it("tells plugin users how to save the token with one command", async () => {
    gqlPublic.mockResolvedValue({
      data: { registerUser: { userId: "u1", username: "tester", publicKeyFingerprint: "fp" } },
    });
    const client = await connect();
    const res = await client.callTool({
      name: "agentbase_setup",
      arguments: { username: "tester" },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/claude plugin install agentbase@agentbase --config api_token=\S+/);
    expect(text).toContain("claude mcp add --scope user");
  });
});
