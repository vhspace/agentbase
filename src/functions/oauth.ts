import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { logger } from "../lib/powertools.js";
import { OAuthServer, loadOAuthConfig, type HttpRequest } from "../lib/oauth/server.js";

const config = loadOAuthConfig();
const server = config ? new OAuthServer(config) : undefined;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  if (!server) {
    return {
      statusCode: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "not_found", error_description: "OAuth is not enabled on this deployment" }),
    };
  }
  const req: HttpRequest = {
    method: event.requestContext.http.method,
    path: event.rawPath,
    query: new URLSearchParams(event.rawQueryString ?? ""),
    headers: event.headers ?? {},
    body: event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "",
  };
  const start = Date.now();
  const res = await server.handle(req);
  logger.info("OAuth request", {
    method: req.method,
    path: req.path,
    statusCode: res.status,
    durationMs: Date.now() - start,
    clientIp: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ?? event.requestContext.http.sourceIp,
    userAgent: event.requestContext.http.userAgent,
  });
  return { statusCode: res.status, headers: res.headers, body: res.body };
}
