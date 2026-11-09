import { table } from "./database";
import { oauthSigningKey, oauthIssuer } from "./secrets";

export const oauthFn = new sst.aws.Function("OAuthServer", {
  handler: "src/functions/oauth.handler",
  url: true,
  timeout: "15 seconds",
  memory: "256 MB",
  link: [table],
  logging: { retention: "forever" },
  environment: {
    POWERTOOLS_SERVICE_NAME: "agentbase-oauth",
    LOG_LEVEL: "INFO",
    TABLE_NAME: table.name,
    OAUTH_SIGNING_KEY: oauthSigningKey.value,
    ...(oauthIssuer ? { OAUTH_ISSUER: oauthIssuer } : {}),
  },
  permissions: [
    {
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"],
      resources: [table.arn, $interpolate`${table.arn}/index/*`],
    },
  ],
});

// Paths on mcp.agentbase.tools that the OAuth Lambda serves instead of the MCP server.
export const OAUTH_PATHS = [
  "/.well-known/*",
  "/register",
  "/authorize",
  "/token",
];
