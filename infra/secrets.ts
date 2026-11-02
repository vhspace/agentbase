// Private P-256 JWK (with kid) used to sign OAuth access tokens. Generate one
// with `node scripts/oauth-signing-key.mjs` and set it with
// `sst secret set OAuthSigningKey "$(node scripts/oauth-signing-key.mjs)" --stage prd`.
// While it is "unset", the authorizer ignores OAuth tokens and the MCP server
// does not advertise an authorization server.
export const oauthSigningKey = new sst.Secret("OAuthSigningKey", "unset");

export const oauthIssuer =
  $app.stage === "prd" ? "https://mcp.agentbase.tools" : undefined;
