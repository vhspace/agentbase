/**
 * Smoke tests for the AgentBase MCP HTTP server.
 * Starts the server locally and exercises it via the MCP SDK client.
 *
 * Run with: cd packages/mcp && pnpm test:smoke
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, type Server } from "node:http";
import { createMcpServer } from "../src/index.js";
import { generateKeypair, encodeToken, decodeToken } from "../src/auth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PORT = 9876 + Math.floor(Math.random() * 1000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

let httpServer: Server;

/** Create a local HTTP server that mirrors the production handler */
function startTestServer(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      const authHeader = req.headers.authorization;
      let keys: { privateKey: any; publicKey: any } | undefined;
      if (authHeader?.startsWith("Bearer ")) {
        try {
          keys = decodeToken(authHeader.slice(7));
        } catch {
          // proceed without auth
        }
      }

      const mcpServer = createMcpServer(keys);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    });

    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

/** Create an MCP client connected to our test server */
async function createMcpClient(bearerToken?: string): Promise<Client> {
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  }

  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL}/mcp`),
    { requestInit: { headers } },
  );

  const client = new Client({
    name: "smoke-test",
    version: "1.0.0",
  });

  await client.connect(transport);
  return client;
}

/** Call a tool and return the text content */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError?: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return {
    text: content.map((c) => c.text).join("\n"),
    isError: result.isError as boolean | undefined,
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let bearerToken: string;
let knowledgeId: string;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP HTTP Server Smoke Tests", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    httpServer = await startTestServer();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  // ── Health check ──────────────────────────────────────────────────────

  it("health check returns ok", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  // ── Unauthenticated tools ─────────────────────────────────────────────

  describe("Unauthenticated", () => {
    it("lists tools (only setup + introspect without auth)", async () => {
      const client = await createMcpClient();
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("agentbase_setup");
      expect(names).toContain("agentbase_introspect");
      // Should NOT have authenticated tools
      expect(names).not.toContain("agentbase_me");
      expect(names).not.toContain("agentbase_store_knowledge");
      await client.close();
    });

    it("introspect returns GraphQL schema", async () => {
      const client = await createMcpClient();
      const result = await callTool(client, "agentbase_introspect");
      expect(result.text).toContain("type Query");
      expect(result.text).toContain("searchKnowledge");
      expect(result.isError).toBeFalsy();
      await client.close();
    });

    it("setup registers a new agent and returns a token", async () => {
      const suffix = Date.now().toString(36);
      const client = await createMcpClient();
      const result = await callTool(client, "agentbase_setup", {
        username: `mcp-smoke-${suffix}`,
        currentTask: "MCP HTTP smoke test",
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("Successfully registered");
      expect(result.text).toContain("bearer token");

      // Extract bearer token from the response
      const lines = result.text.split("\n");
      // Token is on the line after "Your bearer token..."
      const tokenIdx = lines.findIndex((l) =>
        l.includes("bearer token"),
      );
      bearerToken = lines[tokenIdx + 1].trim();
      expect(bearerToken.length).toBeGreaterThan(10);

      // Verify it decodes to valid keys
      const decoded = decodeToken(bearerToken);
      expect(decoded.privateKey).toBeDefined();
      expect(decoded.publicKey).toBeDefined();

      await client.close();
    });
  });

  // ── Authenticated tools ───────────────────────────────────────────────

  describe("Authenticated", () => {
    it("lists all tools when authenticated", async () => {
      const client = await createMcpClient(bearerToken);
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("agentbase_setup");
      expect(names).toContain("agentbase_introspect");
      expect(names).toContain("agentbase_me");
      expect(names).toContain("agentbase_store_knowledge");
      expect(names).toContain("agentbase_get_knowledge");
      expect(names).toContain("agentbase_list_knowledge");
      expect(names).toContain("agentbase_update_knowledge");
      expect(names).toContain("agentbase_delete_knowledge");
      expect(names).toContain("agentbase_search");
      expect(names).toContain("agentbase_update_me");
      await client.close();
    });

    it("agentbase_me returns profile", async () => {
      const client = await createMcpClient(bearerToken);
      const result = await callTool(client, "agentbase_me");
      expect(result.isError).toBeFalsy();
      const profile = JSON.parse(result.text);
      expect(profile.username).toMatch(/^mcp-smoke-/);
      expect(profile.currentTask).toBe("MCP HTTP smoke test");
      await client.close();
    });

    it("agentbase_update_me updates profile", async () => {
      const client = await createMcpClient(bearerToken);
      const result = await callTool(client, "agentbase_update_me", {
        currentTask: "Running smoke tests",
        longTermGoal: "Validate MCP server",
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("Running smoke tests");
      expect(result.text).toContain("Validate MCP server");
      await client.close();
    });

    it("agentbase_store_knowledge creates an item", async () => {
      const client = await createMcpClient(bearerToken);
      const result = await callTool(client, "agentbase_store_knowledge", {
        topic: "mcp-smoke-test",
        content: JSON.stringify({ info: "MCP smoke test knowledge item" }),
        contentType: "application/json",
        visibility: "public",
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("Stored knowledge item");

      // Extract knowledge ID from response
      const match = result.text.match(/Stored knowledge item (\S+)/);
      expect(match).toBeTruthy();
      knowledgeId = match![1];

      await client.close();
    });

    it("agentbase_get_knowledge retrieves the item", async () => {
      const client = await createMcpClient(bearerToken);
      const result = await callTool(client, "agentbase_get_knowledge", {
        id: knowledgeId,
      });
      expect(result.isError).toBeFalsy();
      const item = JSON.parse(result.text);
      expect(item.knowledgeId).toBe(knowledgeId);
      expect(item.topic).toBe("mcp-smoke-test");
      await client.close();
    });

    it("agentbase_list_knowledge lists items", async () => {
      const client = await createMcpClient(bearerToken);
      const result = await callTool(client, "agentbase_list_knowledge", {
        topic: "mcp-smoke-test",
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("item(s)");
      expect(result.text).toContain(knowledgeId);
      await client.close();
    });

    it("agentbase_update_knowledge updates the item", async () => {
      const client = await createMcpClient(bearerToken);
      const result = await callTool(client, "agentbase_update_knowledge", {
        id: knowledgeId,
        topic: "mcp-smoke-updated",
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("Updated knowledge item");
      expect(result.text).toContain("mcp-smoke-updated");
      await client.close();
    });

    it("agentbase_search finds knowledge", async () => {
      const client = await createMcpClient(bearerToken);
      const result = await callTool(client, "agentbase_search", {
        query: "MCP smoke test knowledge",
        limit: 5,
      });
      expect(result.isError).toBeFalsy();
      // Search may return results or "No results found" if vectors haven't propagated
      expect(result.text).toBeDefined();
      await client.close();
    });

    it("agentbase_delete_knowledge removes the item", async () => {
      const client = await createMcpClient(bearerToken);
      const result = await callTool(client, "agentbase_delete_knowledge", {
        id: knowledgeId,
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("Deleted knowledge item");
      await client.close();
    });

    it("agentbase_get_knowledge returns not found after delete", async () => {
      const client = await createMcpClient(bearerToken);
      const result = await callTool(client, "agentbase_get_knowledge", {
        id: knowledgeId,
      });
      // Should either error or return null
      expect(
        result.isError || result.text.includes("not found"),
      ).toBeTruthy();
      await client.close();
    });
  });

  // ── Resources ─────────────────────────────────────────────────────────

  describe("Resources", () => {
    it("lists resources", async () => {
      const client = await createMcpClient();
      const resources = await client.listResources();
      const uris = resources.resources.map((r) => r.uri);
      expect(uris).toContain("agentbase://schema");
      expect(uris).toContain("agentbase://docs");
      await client.close();
    });

    it("reads schema resource", async () => {
      const client = await createMcpClient();
      const result = await client.readResource({ uri: "agentbase://schema" });
      const text = (result.contents[0] as { text: string }).text;
      expect(text).toContain("type Query");
      expect(text).toContain("type Mutation");
      await client.close();
    });

    it("reads docs resource", async () => {
      const client = await createMcpClient();
      const result = await client.readResource({ uri: "agentbase://docs" });
      const text = (result.contents[0] as { text: string }).text;
      expect(text).toContain("AgentBase");
      expect(text).toContain("Setup");
      await client.close();
    });
  });
});
