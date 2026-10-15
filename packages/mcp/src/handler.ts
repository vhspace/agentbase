import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./index.js";
import { decodeToken } from "./auth.js";

function log(level: string, message: string, data?: Record<string, unknown>) {
  const entry = {
    level,
    message,
    service: "agentbase-mcp",
    timestamp: new Date().toISOString(),
    ...data,
  };
  if (level === "ERROR") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { method } = event.requestContext.http;
  const path = event.rawPath;
  const start = Date.now();

  // Health check
  if (method === "GET" && (path === "/" || path === "/health")) {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ok", service: "agentbase-mcp" }),
    };
  }

  // OAuth discovery — we use bearer tokens, not OAuth, so return 404
  if (path.startsWith("/.well-known/")) {
    return {
      statusCode: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Not found" }),
    };
  }

  // Stateless server: there is no standalone SSE stream to subscribe to, so
  // GET must be refused up front. Letting the SDK handle it opens a
  // ReadableStream that never closes, the Lambda hangs, and clients see a 502
  // and reconnect in a loop. HEAD and DELETE (session teardown) likewise.
  if (method !== "POST") {
    log("INFO", "MCP request", {
      method,
      path,
      host: event.headers?.["host"],
      sourceIp: event.requestContext.http.sourceIp,
      userAgent: event.requestContext.http.userAgent,
      rpcMethod: "unknown",
      rejected: "method_not_allowed",
    });
    return {
      statusCode: 405,
      headers: { "content-type": "application/json", allow: "POST" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. This server is stateless; send JSON-RPC over POST." },
        id: null,
      }),
    };
  }

  // Reject non-JSON-RPC requests (e.g. OAuth token requests) before they
  // hit the transport, which would return a JSON-RPC error that MCP clients
  // can't parse as an OAuth response.
  const contentType = event.headers?.["content-type"] ?? "";
  if (method === "POST" && !contentType.includes("application/json")) {
    return {
      statusCode: 415,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: "unsupported_media_type",
        error_description: "This server accepts application/json only. OAuth is not supported — use a bearer token.",
      }),
    };
  }

  // Build web standard Request from Lambda event
  const url = `https://${event.requestContext.domainName}${path}${event.rawQueryString ? "?" + event.rawQueryString : ""}`;
  const headers = new Headers(event.headers as Record<string, string>);
  // Ensure Accept header includes both types required by MCP SDK transport
  if (!headers.get("accept")?.includes("text/event-stream")) {
    headers.set("accept", "application/json, text/event-stream");
  }
  const request = new Request(url, {
    method,
    headers,
    body:
      event.body != null
        ? event.isBase64Encoded
          ? Buffer.from(event.body, "base64")
          : event.body
        : undefined,
  });

  // Parse bearer token for auth
  const authHeader = event.headers?.["authorization"];
  let keys: ReturnType<typeof decodeToken> | undefined;
  const authenticated = !!authHeader?.startsWith("Bearer ");
  if (authenticated) {
    try {
      keys = decodeToken(authHeader!.slice(7));
    } catch {
      log("WARN", "Invalid bearer token received");
    }
  }

  // Parse the JSON-RPC body to extract method name for logging
  let rpcMethod = "unknown";
  let tool: string | undefined;
  let client: { name?: string; version?: string; protocolVersion?: string } = {};
  if (event.body && method === "POST") {
    try {
      const body = event.isBase64Encoded
        ? JSON.parse(Buffer.from(event.body, "base64").toString())
        : JSON.parse(event.body);
      rpcMethod = body.method ?? "unknown";
      if (rpcMethod === "tools/call" && typeof body.params?.name === "string") {
        tool = body.params.name;
      }
      if (rpcMethod === "initialize") {
        client = {
          name: body.params?.clientInfo?.name,
          version: body.params?.clientInfo?.version,
          protocolVersion: body.params?.protocolVersion,
        };
      }
    } catch {
      // Not valid JSON — will be handled by transport
    }
  }

  // Behind CloudFront the connecting IP is an edge node; the real client is
  // the first hop in X-Forwarded-For. Direct Lambda URL hits have no Via.
  const forwardedFor = event.headers?.["x-forwarded-for"];
  const clientIp = forwardedFor?.split(",")[0]?.trim() || event.requestContext.http.sourceIp;

  const requestContext = {
    method,
    path,
    host: event.headers?.["host"],
    viaCdn: !!event.headers?.["via"],
    clientIp,
    sourceIp: event.requestContext.http.sourceIp,
    userAgent: event.requestContext.http.userAgent,
    authenticated,
    rpcMethod,
    tool,
    clientName: client.name,
    clientVersion: client.version,
    protocolVersion: client.protocolVersion ?? event.headers?.["mcp-protocol-version"],
    sessionId: event.headers?.["mcp-session-id"],
  };

  log("INFO", "MCP request", requestContext);

  const server = createMcpServer(keys);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  const response = await transport.handleRequest(request);

  // Convert web standard Response to Lambda response
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  const body = await response.text();
  const duration = Date.now() - start;

  let toolError: boolean | undefined;
  if (tool && response.status === 200) {
    try {
      toolError = JSON.parse(body)?.result?.isError === true;
    } catch {
      // streamed or non-JSON body; leave undefined
    }
  }

  log("INFO", "MCP response", {
    statusCode: response.status,
    rpcMethod,
    tool,
    toolError,
    clientName: client.name,
    userAgent: event.requestContext.http.userAgent,
    authenticated,
    durationMs: duration,
  });

  return {
    statusCode: response.status,
    headers: responseHeaders,
    body,
  };
}
