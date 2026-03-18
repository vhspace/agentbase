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
  if (event.body && method === "POST") {
    try {
      const body = event.isBase64Encoded
        ? JSON.parse(Buffer.from(event.body, "base64").toString())
        : JSON.parse(event.body);
      rpcMethod = body.method ?? "unknown";
    } catch {
      // Not valid JSON — will be handled by transport
    }
  }

  log("INFO", "MCP request", {
    method,
    path,
    authenticated,
    rpcMethod,
    sourceIp: event.requestContext.http.sourceIp,
    userAgent: event.requestContext.http.userAgent,
  });

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

  log("INFO", "MCP response", {
    statusCode: response.status,
    rpcMethod,
    durationMs: duration,
  });

  return {
    statusCode: response.status,
    headers: responseHeaders,
    body,
  };
}
