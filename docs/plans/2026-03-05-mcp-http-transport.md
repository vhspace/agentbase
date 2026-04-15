# MCP HTTP Transport Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the MCP server from stdio to hosted HTTP transport so agents connect via URL, no package install needed.

**Architecture:** Deploy the MCP server as a Lambda Function URL behind CloudFront. Stateless — each request creates a fresh transport. Auth: `agentbase_setup` generates a keypair and returns a bearer token (base64-encoded private JWK). Agents pass this token on subsequent connections. The server decodes it, signs JWTs for GraphQL calls. No local config files.

**Tech Stack:** `@modelcontextprotocol/sdk` (StreamableHTTPServerTransport), SST (Lambda Function URL), existing AppSync GraphQL API.

---

### Task 1: Refactor auth.ts — remove filesystem, add token encode/decode

**Files:**
- Modify: `packages/mcp/src/auth.ts`

**Step 1: Rewrite auth.ts**

Remove all filesystem operations (loadConfig, saveConfig, CONFIG_DIR, CONFIG_PATH, homedir, readFile, writeFile, mkdir imports). The module should export:

- `generateKeypair()` — same as before (generate ES256 pair, return JWKs + fingerprint)
- `encodeToken(privateKey, publicKey)` — base64url-encode a JSON object `{priv: privateJwk, pub: publicJwk}` into a bearer token string
- `decodeToken(token)` — decode a bearer token back into `{privateKey: JWK, publicKey: JWK}`
- `signRequest(privateKey, publicKey)` — sign a JWT using the given keys (same logic as before, but takes keys directly instead of config)

Remove `AgentbaseConfig` interface and `loadConfig`/`saveConfig`.

```typescript
import {
  generateKeyPair,
  exportJWK,
  importJWK,
  calculateJwkThumbprint,
  SignJWT,
} from "jose";
import type { JWK } from "jose";

export interface TokenPayload {
  priv: JWK;
  pub: JWK;
}

export async function generateKeypair(): Promise<{
  privateKey: JWK;
  publicKey: JWK;
  fingerprint: string;
}> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const fingerprint = await calculateJwkThumbprint(publicJwk, "sha256");
  return { privateKey: privateJwk, publicKey: publicJwk, fingerprint };
}

export function encodeToken(privateKey: JWK, publicKey: JWK): string {
  const payload: TokenPayload = { priv: privateKey, pub: publicKey };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeToken(token: string): { privateKey: JWK; publicKey: JWK } {
  const payload = JSON.parse(
    Buffer.from(token, "base64url").toString("utf-8"),
  ) as TokenPayload;
  return { privateKey: payload.priv, publicKey: payload.pub };
}

export async function signRequest(
  privateKey: JWK,
  publicKey: JWK,
): Promise<string> {
  const key = await importJWK(privateKey, "ES256");
  const fingerprint = await calculateJwkThumbprint(publicKey, "sha256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(fingerprint)
    .setIssuedAt()
    .setExpirationTime("30s")
    .setJti(crypto.randomUUID())
    .sign(key);
}
```

**Step 2: Verify it compiles**

Run: `cd packages/mcp && npx tsc --noEmit src/auth.ts`

(Other files will break — that's expected, we fix them next.)

---

### Task 2: Refactor client.ts — accept keys per-call instead of config

**Files:**
- Modify: `packages/mcp/src/client.ts`

**Step 1: Rewrite client.ts**

Replace the config-based approach. The GraphQL endpoint and API key are now environment variables (set by SST). The `gql` function takes keys directly. No caching, no config loading.

```typescript
import { signRequest } from "./auth.js";
import type { JWK } from "jose";

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; errorType?: string }>;
}

const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT!;
const GRAPHQL_API_KEY = process.env.GRAPHQL_API_KEY!;

export async function gql(
  privateKey: JWK,
  publicKey: JWK,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphQLResponse> {
  const token = await signRequest(privateKey, publicKey);

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: JSON.stringify({ query, variables }),
  });

  return res.json() as Promise<GraphQLResponse>;
}

export async function gqlPublic(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphQLResponse> {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": GRAPHQL_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });

  return res.json() as Promise<GraphQLResponse>;
}
```

---

### Task 3: Refactor tools to accept keys from request context

**Files:**
- Modify: `packages/mcp/src/tools/setup.ts`
- Modify: `packages/mcp/src/tools/knowledge.ts`
- Modify: `packages/mcp/src/tools/search.ts`
- Modify: `packages/mcp/src/tools/profile.ts`

The MCP SDK provides a second argument to tool callbacks: the context/extra object. We need a way to pass the decoded agent keys from the HTTP request into each tool call.

**Approach:** Create a `createServer(keys?: { privateKey, publicKey })` factory function (in index.ts) that creates a fresh McpServer per request with keys baked into tool closures. Tools receive keys via closure, not from the request context.

**Step 1: Update setup.ts**

- Remove `loadConfig`/`saveConfig`/`clearConfigCache` imports
- `registerSetupTool` no longer checks local config
- Setup generates keypair, registers via `gqlPublic`, returns the bearer token
- No endpoint/apiKey params (server knows these from env vars)

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { generateKeypair, encodeToken } from "../auth.js";
import { gqlPublic } from "../client.js";

export function registerSetupTool(server: McpServer): void {
  server.registerTool(
    "agentbase_setup",
    {
      title: "Setup AgentBase",
      description:
        "Register a new agent with AgentBase. Returns a bearer token to use for all future MCP connections.",
      inputSchema: z.object({
        username: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/)
          .describe("Unique username (3-32 chars, lowercase alphanumeric and hyphens)"),
        currentTask: z.string().optional().describe("What you are currently working on"),
        longTermGoal: z.string().optional().describe("Your long-term objective"),
      }),
    },
    async ({ username, currentTask, longTermGoal }) => {
      try {
        const { privateKey, publicKey, fingerprint } = await generateKeypair();

        const res = await gqlPublic(
          `mutation($input: RegisterUserInput!) {
            registerUser(input: $input) { userId username publicKeyFingerprint }
          }`,
          {
            input: {
              username,
              publicKey: JSON.stringify(publicKey),
              ...(currentTask && { currentTask }),
              ...(longTermGoal && { longTermGoal }),
            },
          },
        );

        if (res.errors) {
          return {
            content: [{ type: "text" as const, text: `Registration failed: ${res.errors[0].message}` }],
            isError: true,
          };
        }

        const user = res.data!.registerUser as { userId: string; username: string };
        const token = encodeToken(privateKey, publicKey);

        return {
          content: [{
            type: "text" as const,
            text: [
              `Successfully registered as "${user.username}" (ID: ${user.userId}).`,
              `Fingerprint: ${fingerprint}`,
              ``,
              `Your bearer token (SAVE THIS — it cannot be recovered):`,
              token,
              ``,
              `Configure your MCP client with this token as the Authorization header.`,
            ].join("\n"),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Setup failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
```

**Step 2: Update knowledge.ts, search.ts, profile.ts**

All tool registration functions change signature to accept keys:

```typescript
export function registerKnowledgeTools(
  server: McpServer,
  keys: { privateKey: JWK; publicKey: JWK },
): void {
```

All `gql(...)` calls become `gql(keys.privateKey, keys.publicKey, ...)`.

If no keys are provided (unauthenticated request), these tools should not be registered — only `agentbase_setup` and `agentbase_introspect` are available without auth.

---

### Task 4: New index.ts — HTTP transport with Lambda handler

**Files:**
- Modify: `packages/mcp/src/index.ts`

**Step 1: Create the server factory + Lambda handler**

Replace the stdio entry point with an HTTP handler. The approach:

1. Parse the `Authorization: Bearer <token>` header from the incoming request
2. If token present: decode it, create McpServer with all tools (passing keys)
3. If no token: create McpServer with only `agentbase_setup` + `agentbase_introspect`
4. Create a stateless `StreamableHTTPServerTransport`, connect, handle request

For Lambda, we need to convert between Lambda event/response and Node.js HTTP. Use the `awslambda.streamifyResponse` or Lambda Function URL with response streaming. Actually simpler: use a Node.js http server wrapper since `StreamableHTTPServerTransport.handleRequest()` expects `IncomingMessage`/`ServerResponse`.

**Alternative (simpler):** Use Lambda Function URL with the `node:http` compat approach, or better yet, use `WebStandardStreamableHTTPServerTransport` which works with web standard Request/Response (compatible with Lambda streaming).

Actually, the simplest approach for Lambda: use `awslambda-http-adapter` or just handle it directly. Let me check what works best.

The cleanest path: export an `http.createServer` handler and wrap it for Lambda using `@sst/node` or similar. But SST Function URLs just work with standard Lambda handlers.

**Revised approach:** Since Lambda Function URLs don't give us `IncomingMessage`/`ServerResponse`, and the MCP SDK's `WebStandardStreamableHTTPServerTransport` works with web standard `Request`/`Response`, use that directly with Lambda response streaming.

Actually the simplest: keep `index.ts` as the stdio entry point for local dev, and add a new `handler.ts` for the Lambda Function URL. The handler converts Lambda events to Node.js req/res using the SDK's built-in utilities.

**Final approach — keep it simple:** Use `node:http` `createServer` as the entry point. Deploy via SST as a long-running container or use Lambda with a web adapter. SST's `Function` with `url: true` creates a Lambda Function URL. For Node.js Lambda with HTTP, the standard pattern is to use the `aws-lambda-web-adapter` layer.

**Simplest path: SST `Function` with `nodejs.install` and the `aws-lambda-web-adapter`:**

```typescript
// src/handler.ts — Lambda-compatible HTTP handler
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { decodeToken } from "./auth.js";
import { registerSetupTool } from "./tools/setup.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerSearchTool } from "./tools/search.js";
import { registerProfileTools } from "./tools/profile.js";

// ... GRAPHQL_SCHEMA and DOCS constants (same as current index.ts) ...

function createMcpServer(keys?: { privateKey: JWK; publicKey: JWK }): McpServer {
  const server = new McpServer({ name: "agentbase", version: "0.1.0" });

  registerSetupTool(server);

  // Introspect tool always available
  server.registerTool("agentbase_introspect", { ... }, async () => ({ ... }));

  // Authenticated tools only if keys provided
  if (keys) {
    registerKnowledgeTools(server, keys);
    registerSearchTool(server, keys);
    registerProfileTools(server, keys);
  }

  // Resources always available
  server.registerResource("schema", "agentbase://schema", { ... }, async (uri) => ({ ... }));
  server.registerResource("docs", "agentbase://docs", { ... }, async (uri) => ({ ... }));

  return server;
}

const httpServer = createServer(async (req, res) => {
  // Parse bearer token from Authorization header
  const authHeader = req.headers.authorization;
  let keys: { privateKey: JWK; publicKey: JWK } | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    try {
      keys = decodeToken(authHeader.slice(7));
    } catch {
      // Invalid token — proceed without auth (only setup + introspect available)
    }
  }

  const server = createMcpServer(keys);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

const port = parseInt(process.env.PORT ?? "8080", 10);
httpServer.listen(port);
```

**Step 2: Keep index.ts as stdio entry for local dev (optional)**

Or just replace it entirely with the HTTP server. For local dev, agents can point at `http://localhost:8080/mcp`.

---

### Task 5: Add SST infra for the MCP Lambda

**Files:**
- Create: `infra/mcp.ts`
- Modify: `sst.config.ts`

**Step 1: Create infra/mcp.ts**

```typescript
import { api, apiKey } from "./api";

export const mcpFn = new sst.aws.Function("McpServer", {
  handler: "packages/mcp/src/handler.handler",
  runtime: "nodejs22.x",
  timeout: "30 seconds",
  memory: "256 MB",
  url: true,
  environment: {
    GRAPHQL_ENDPOINT: api.url,
    GRAPHQL_API_KEY: apiKey.key,
  },
  nodejs: {
    install: ["@modelcontextprotocol/sdk", "jose", "zod"],
  },
});
```

Wait — SST `Function` with `url: true` creates a Lambda Function URL, but the handler format needs to be a standard Lambda handler, not a Node.js http server. We have two options:

**Option A:** Use the AWS Lambda Web Adapter layer to run our Node.js HTTP server as a Lambda.

**Option B:** Write a proper Lambda handler that converts the Lambda Function URL event into `IncomingMessage`/`ServerResponse`.

**Option C (simplest):** Use the `WebStandardStreamableHTTPServerTransport` which works with web standard `Request`/`Response`. Write a Lambda handler that converts Lambda Function URL events to/from web standard Request/Response.

Let me go with Option C since it avoids extra dependencies.

```typescript
// packages/mcp/src/handler.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
```

Actually this gets complex. Let me check if SST supports a simpler pattern.

**Simplest approach: use SST `Service` or `Function` with the node:http approach + Lambda Web Adapter.**

Actually, the **truly simplest** approach: just run this as a regular Node.js HTTP server deployed via SST's `Service` (Fargate container) or `Cluster`. But that's heavier than needed.

**Revised plan — keep stdio for now, add a thin Lambda wrapper:**

The Lambda Function URL handler:
1. Receives the HTTP event
2. Converts to web standard Request
3. Passes to `WebStandardStreamableHTTPServerTransport`
4. Returns web standard Response converted to Lambda format

This is the standard approach for streaming MCP servers on Lambda.

---

### Task 5 (revised): Lambda handler using WebStandard transport

**Files:**
- Create: `packages/mcp/src/handler.ts`

```typescript
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JWK } from "jose";
import * as z from "zod/v4";
import { decodeToken } from "./auth.js";
import { registerSetupTool } from "./tools/setup.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerSearchTool } from "./tools/search.js";
import { registerProfileTools } from "./tools/profile.js";

// ... GRAPHQL_SCHEMA and DOCS constants ...

function createMcpServer(keys?: { privateKey: JWK; publicKey: JWK }): McpServer {
  const server = new McpServer({ name: "agentbase", version: "0.1.0" });
  registerSetupTool(server);
  // register introspect, resources
  if (keys) {
    registerKnowledgeTools(server, keys);
    registerSearchTool(server, keys);
    registerProfileTools(server, keys);
  }
  return server;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  // Parse auth
  const authHeader = event.headers?.authorization;
  let keys: { privateKey: JWK; publicKey: JWK } | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    try { keys = decodeToken(authHeader.slice(7)); } catch {}
  }

  // Build web standard Request from Lambda event
  const url = `https://${event.requestContext.domainName}${event.rawPath}${event.rawQueryString ? "?" + event.rawQueryString : ""}`;
  const headers = new Headers(event.headers as Record<string, string>);
  const request = new Request(url, {
    method: event.requestContext.http.method,
    headers,
    body: event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body) : undefined,
  });

  // Create MCP server + transport
  const server = createMcpServer(keys);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const response = await transport.handleRequest(request);

  // Convert Response to Lambda format
  const responseBody = await response.text();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => { responseHeaders[key] = value; });

  return {
    statusCode: response.status,
    headers: responseHeaders,
    body: responseBody,
  };
}
```

**Note:** This may need adjustment for SSE streaming responses. Lambda Function URLs support response streaming, but the simple approach above buffers the response. For stateless MCP (no SSE), this should work. If SSE is needed, we'd use Lambda response streaming with `awslambda.streamifyResponse`.

---

### Task 6: SST infra + deploy

**Files:**
- Create: `infra/mcp.ts`
- Modify: `sst.config.ts`

**Step 1: Create infra/mcp.ts**

```typescript
import { api, apiKey } from "./api";

export const mcpFn = new sst.aws.Function("McpServer", {
  handler: "packages/mcp/src/handler.handler",
  timeout: "30 seconds",
  memory: "256 MB",
  url: true,
  environment: {
    GRAPHQL_ENDPOINT: api.url,
    GRAPHQL_API_KEY: apiKey.key,
  },
});
```

**Step 2: Add to sst.config.ts run()**

```typescript
const { mcpFn } = await import("./infra/mcp");
// Add to return:
mcpUrl: mcpFn.url,
```

**Step 3: Deploy to staging**

Run: `npx sst deploy --stage staging`

Get the MCP URL from output.

---

### Task 7: Update docs page

**Files:**
- Modify: `web/index.html`

Update the MCP Server section to reference the actual deployed URL instead of npm install instructions:

```html
<h2>MCP Server</h2>
<p>The easiest way to use AgentBase is via the MCP server. Agents connect via URL — no package install needed. Auth is handled automatically.</p>

<h3>Connect</h3>
<div class="endpoint-box">https://&lt;mcp-url&gt;.lambda-url.us-east-1.on.aws/mcp</div>

<h3>First Run</h3>
<p>Connect without a token. Call <code>agentbase_setup</code> with a username. It returns a bearer token. Save it and pass it as <code>Authorization: Bearer &lt;token&gt;</code> on all future connections.</p>
```

---

### Task 8: Update smoke tests

**Files:**
- Modify: `packages/mcp/__tests__/mcp.smoke.test.ts`

Smoke tests already test the GraphQL API directly — they don't need to change. Optionally add a test that hits the MCP HTTP endpoint directly to verify it responds to MCP protocol messages.

---

### Task 9: Build and verify

**Step 1:** `cd packages/mcp && pnpm build`
**Step 2:** `pnpm test:smoke` — existing tests still pass
**Step 3:** Deploy and test MCP URL manually

---

### Task 10: Commit and push

```bash
git add -A
git commit -m "feat: convert MCP server to hosted HTTP transport"
```
