import { describe, it, expect, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handler.js";

function event(
  method: string,
  overrides: Partial<APIGatewayProxyEventV2> & { headers?: Record<string, string> } = {},
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/mcp",
    rawQueryString: "",
    headers: { accept: "application/json, text/event-stream", ...overrides.headers },
    requestContext: {
      domainName: "mcp.agentbase.tools",
      http: { method, path: "/mcp", protocol: "HTTP/1.1", sourceIp: "203.0.113.9", userAgent: "test" },
    } as APIGatewayProxyEventV2["requestContext"],
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2;
}

describe("handler", () => {
  it("answers GET /mcp with 405 instead of hanging or crashing (stateless server, no SSE stream)", async () => {
    const res = await Promise.race([
      handler(event("GET", { headers: { accept: "text/event-stream" } })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("GET /mcp hung")), 5000)),
    ]);
    expect(res.statusCode).toBe(405);
    expect(res.headers?.allow).toBe("POST");
  });

  it("answers a JSON-RPC ping over POST", async () => {
    const res = await handler(
      event("POST", {
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).result).toEqual({});
  });
});

describe("structured logging", () => {
  it("records client identity from initialize and the forwarded IP behind the CDN", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: string) => { lines.push(String(l)); });
    try {
      await handler(
        event("POST", {
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            host: "mcp.agentbase.tools",
            via: "1.1 abc.cloudfront.net (CloudFront)",
            "x-forwarded-for": "198.51.100.7, 203.0.113.9",
          },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.0" } },
          }),
        }),
      );
    } finally {
      spy.mockRestore();
    }
    const req = lines.map((l) => JSON.parse(l)).find((e) => e.message === "MCP request");
    expect(req).toMatchObject({
      rpcMethod: "initialize",
      clientName: "claude-code",
      clientVersion: "2.1.0",
      protocolVersion: "2025-06-18",
      clientIp: "198.51.100.7",
      viaCdn: true,
      host: "mcp.agentbase.tools",
    });
  });

  it("flags tool calls whose result is an error", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: string) => { lines.push(String(l)); });
    try {
      await handler(
        event("POST", {
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name: "agentbase_setup", arguments: { username: "x" } },
          }),
        }),
      );
    } finally {
      spy.mockRestore();
    }
    const res = lines.map((l) => JSON.parse(l)).find((e) => e.message === "MCP response");
    expect(res).toMatchObject({ tool: "agentbase_setup", toolError: true });
  });
});
