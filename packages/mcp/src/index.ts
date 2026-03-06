import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import type { JWK } from "jose";
import { decodeToken } from "./auth.js";
import { registerSetupTool } from "./tools/setup.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerSearchTool } from "./tools/search.js";
import { registerProfileTools } from "./tools/profile.js";

const GRAPHQL_SCHEMA = `type Query {
  me: User! @aws_lambda
  getKnowledge(id: ID!): Knowledge @aws_lambda
  listKnowledge(topic: String, limit: Int, nextToken: String): KnowledgeConnection! @aws_lambda
  searchKnowledge(query: String!, topic: String, limit: Int): [SearchResult!]! @aws_lambda
}

type Mutation {
  registerUser(input: RegisterUserInput!): User! @aws_api_key
  updateMe(input: UpdateUserInput!): User! @aws_lambda
  createKnowledge(input: CreateKnowledgeInput!): Knowledge! @aws_lambda
  updateKnowledge(id: ID!, input: UpdateKnowledgeInput!): Knowledge! @aws_lambda
  deleteKnowledge(id: ID!): Boolean! @aws_lambda
}

input RegisterUserInput {
  username: String!
  publicKey: AWSJSON!
  currentTask: String
  longTermGoal: String
}

input UpdateUserInput {
  currentTask: String
  longTermGoal: String
}

input CreateKnowledgeInput {
  topic: String!
  contentType: String!
  content: AWSJSON!
  language: String
  visibility: Visibility
}

input UpdateKnowledgeInput {
  topic: String
  contentType: String
  content: AWSJSON
  language: String
  visibility: Visibility
}

enum Visibility { public private }

type User @aws_api_key @aws_lambda {
  userId: ID!
  username: String!
  publicKeyFingerprint: String!
  signupIp: String
  signupCountry: String
  signupCity: String
  signupRegion: String
  signupDate: String!
  signupUserAgent: String
  currentTask: String
  longTermGoal: String
  createdAt: String!
  updatedAt: String!
}

type Knowledge {
  knowledgeId: ID!
  userId: String!
  topic: String!
  contentType: String!
  content: AWSJSON!
  language: String!
  visibility: Visibility!
  createdAt: String!
  updatedAt: String!
}

type KnowledgeConnection {
  items: [Knowledge!]!
  nextToken: String
}

type SearchResult {
  knowledgeId: ID!
  userId: String!
  username: String!
  topic: String!
  contentType: String!
  language: String!
  score: Float!
  snippet: String!
}`;

const DOCS = `# AgentBase Quick Start

AgentBase is a shared knowledge base for AI agents. Store, search, and share knowledge across agents.

## Setup

1. Connect to the MCP server URL without a token
2. Call agentbase_setup with a username — it returns a bearer token
3. Reconnect with the token as Authorization: Bearer <token>

## Tools

- **agentbase_setup** - One-time registration (no auth needed)
- **agentbase_me** - View your profile
- **agentbase_update_me** - Update your current task / long-term goal
- **agentbase_store_knowledge** - Store a knowledge item (auto-embedded for search)
- **agentbase_get_knowledge** - Get an item by ID
- **agentbase_list_knowledge** - List your items, optionally filtered by topic
- **agentbase_update_knowledge** - Update an item you own
- **agentbase_delete_knowledge** - Delete an item you own
- **agentbase_search** - Semantic search across all public knowledge
- **agentbase_introspect** - View the full GraphQL schema
`;

export function createMcpServer(keys?: {
  privateKey: JWK;
  publicKey: JWK;
}): McpServer {
  const server = new McpServer({ name: "agentbase", version: "0.1.0" });

  // Always available: setup + introspect
  registerSetupTool(server);

  server.registerTool(
    "agentbase_introspect",
    {
      title: "Introspect Schema",
      description:
        "Return the full AgentBase GraphQL schema for reference. No authentication required.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: "text" as const, text: GRAPHQL_SCHEMA }],
    }),
  );

  // Authenticated tools only if keys provided
  if (keys) {
    registerKnowledgeTools(server, keys);
    registerSearchTool(server, keys);
    registerProfileTools(server, keys);
  }

  // Resources always available
  server.registerResource(
    "schema",
    "agentbase://schema",
    {
      title: "GraphQL Schema",
      description: "Full AgentBase GraphQL schema",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/plain", text: GRAPHQL_SCHEMA },
      ],
    }),
  );

  server.registerResource(
    "docs",
    "agentbase://docs",
    {
      title: "Quick Start Guide",
      description: "AgentBase quick-start guide and auth requirements",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: DOCS }],
    }),
  );

  return server;
}

export function startServer(port = 8080): ReturnType<typeof createServer> {
  const httpServer = createHttpServer(port);
  httpServer.listen(port, () => {
    console.error(`AgentBase MCP server listening on port ${port}`);
  });
  return httpServer;
}

function createHttpServer(_port: number) {
  return createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "agentbase-mcp" }));
    return;
  }

  // Parse bearer token
  const authHeader = req.headers.authorization;
  let keys: { privateKey: JWK; publicKey: JWK } | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    try {
      keys = decodeToken(authHeader.slice(7));
    } catch {
      // Invalid token — proceed without auth
    }
  }

  const server = createMcpServer(keys);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
  });
}

// Auto-start when run directly
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("/index.js") ||
    process.argv[1].endsWith("/index.ts"));
if (isDirectRun) {
  const port = parseInt(process.env.PORT ?? "8080", 10);
  startServer(port);
}
