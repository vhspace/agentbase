import { table } from "./database";
import { oauthSigningKey, oauthIssuer } from "./secrets";

// GitHub OAuth App used as the identity provider for /authorize. Create one at
// https://github.com/settings/developers with callback URL
// https://mcp.agentbase.tools/callback, then:
//   sst secret set GithubOAuthClientId <id> --stage prd
//   sst secret set GithubOAuthClientSecret <secret> --stage prd
// While either is "unset" the OAuth endpoints answer 404.
export const githubOAuthClientId = new sst.Secret("GithubOAuthClientId", "unset");
export const githubOAuthClientSecret = new sst.Secret("GithubOAuthClientSecret", "unset");

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
    GITHUB_OAUTH_CLIENT_ID: githubOAuthClientId.value,
    GITHUB_OAUTH_CLIENT_SECRET: githubOAuthClientSecret.value,
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
  "/callback",
  "/token",
];
