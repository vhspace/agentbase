---
title: "feat: OAuth 2.1 for the remote MCP server"
type: feat
date: 2026-10-27
status: proposed
---

# OAuth 2.1 for the remote MCP server

## Why

Logs from 2026-10-15 to 2026-10-27 show about 45 Claude Code and claude.ai
sessions connecting to `mcp.agentbase.tools`, all unauthenticated, and not
one of them ever stored anything. Storing requires a bearer token, and
getting one means calling `agentbase_setup`, copying a 400-character token
out of a tool result, editing config, and restarting. Nobody does it.

Claude Code, claude.ai, Cursor, VS Code and the MCP Inspector all handle
OAuth 2.1 for remote servers on their own: the client gets a 401, discovers
the authorization server, registers itself, opens a browser, and stores the
token. The user clicks "Authorize" once. That is the whole flow we want.

## Current auth model

- A token is `base64url(JSON{priv, pub})`: an ES256 keypair the agent holds.
- The MCP Lambda decodes it and signs a 30-second JWT (`sub` = JWK
  thumbprint, `jti` for replay protection) per AppSync call.
- The AppSync Lambda authorizer looks the user up by fingerprint, verifies
  the JWT against the stored public key, and puts `userId` in the resolver
  context. `Bearer anonymous` is allowed through with an empty context.

The keypair design stays for CLI and non-OAuth clients. OAuth is added
alongside it, not instead of it.

## Design

### Endpoints

All on the existing MCP Lambda behind `mcp.agentbase.tools`, so there is
one function to deploy and one domain to trust.

| Path | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728. Says the authorization server is this same origin. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414. Advertises the endpoints below, `code` grant, PKCE `S256`, `token_endpoint_auth_methods_supported: ["none"]`. |
| `POST /register` | RFC 7591 dynamic client registration. Public clients only. Stores `client_id`, `redirect_uris`, `client_name`. |
| `GET /authorize` | Consent. Redirects to GitHub for identity, then back here, then to the client's `redirect_uri` with a code. |
| `POST /token` | Exchanges a code (PKCE verified) or a refresh token for an access token. |
| `POST /mcp` | Unchanged transport. Without a valid token it returns 401 with `WWW-Authenticate: Bearer resource_metadata="https://mcp.agentbase.tools/.well-known/oauth-protected-resource"`. |
| `POST /mcp/public` | Same server, anonymous, read-only tools only (`agentbase_search`, `agentbase_get_knowledge`, `agentbase_introspect`). For clients that just want to read. |

### Identity

GitHub is the upstream identity provider. One GitHub OAuth App, client
secret in an SST `Secret`. On first login a user row is created with
`username` = GitHub login (suffixed on collision) and a new `githubId`
attribute. An existing keypair account can be linked from the consent page
by pasting its legacy token once, so current users keep their items.

GitHub rather than email magic links because every MCP user we have seen is
a developer with a GitHub account, and it means no password or email
delivery code in this repo.

### Tokens

- Access token: ES256 JWT signed by a server key (SST `Secret`, JWK
  thumbprint published at `/.well-known/jwks.json`). Claims: `iss`
  `https://mcp.agentbase.tools`, `aud` same, `sub` = `userId`, `exp` 30
  days, `jti`.
- Refresh token: opaque, stored hashed in DynamoDB with the client id,
  rotated on every use, 90-day TTL.
- The MCP Lambda forwards the access token as-is to AppSync. The authorizer
  branches on `iss`: no `iss` means legacy per-request JWT, verify as today;
  our `iss` means verify against the server JWK and take `sub` as `userId`.
  No change to resolvers.

### Storage

Three new single-table entities, all with TTL:

- `OAuthClient` (`clientId`, `redirectUris`, `clientName`, created, 30-day
  idle TTL refreshed on use).
- `AuthCode` (`code` hash, `clientId`, `userId`, `codeChallenge`,
  `redirectUri`, 10-minute TTL, single use).
- `RefreshToken` (`token` hash, `clientId`, `userId`, 90-day TTL).

### Security notes

- PKCE `S256` is mandatory. `plain` is rejected.
- `redirect_uri` must exactly match one registered at `/register`.
  Loopback (`http://127.0.0.1:*`, `http://localhost:*`) is allowed with any
  port, per RFC 8252. Everything else must be `https`.
- `/register` is rate limited per IP at CloudFront (it will be hit by the
  same probe fleet that hits `/mcp` today) and unused clients expire.
- Codes and refresh tokens are stored hashed. Access tokens are stateless;
  revocation is by refresh-token deletion and the 30-day expiry.
- The consent page is static HTML rendered by the Lambda, no JS, CSP
  `default-src 'none'; style-src 'unsafe-inline'`.
- `state` is round-tripped through GitHub and bound to the pending
  authorization in DynamoDB.

## Rollout

Progress is tracked here as PRs land.

- [x] Authorizer accepts server-issued tokens by `iss`; `OAuthSigningKey`
      secret and `scripts/oauth-signing-key.mjs` added. Off until the secret
      is set.
- [ ] Discovery metadata, `/register`, `/authorize`, `/token` on the MCP Lambda.
- [ ] GitHub login and account linking.
- [ ] Flip `/mcp` to 401-by-default and add `/mcp/public`.

1. **Authorization server, dark.** Add the five endpoints, entities, GitHub
   login, authorizer `iss` branch. `/mcp` still accepts anonymous. Test
   with MCP Inspector and Claude Code pointed at a `/mcp?auth=required`
   variant. One PR for the authorizer change, one for the AS.
2. **Flip.** `/mcp` returns 401 without a token; `/mcp/public` added.
   Plugin stays on `/mcp` so the first use triggers the browser flow. The
   `api_token` user config remains as an override for CI and headless
   agents. Website, README, SKILL.md and `agentbase_setup` output updated
   in the same PR.
3. **Watch.** The `authenticated` and `tool` log fields already exist. Success
   is authenticated `agentbase_store_knowledge` calls from `Claude-User` and
   `claude-code/*` user agents, which is zero today.

## Open questions

- Should `agentbase_setup` be removed from the OAuth-authenticated tool
  list? It is confusing once a session already has an identity. Proposal:
  hide it when the request carries a valid token.
- One GitHub login can own many agents today (one account per keypair). With
  OAuth the natural unit is one account per GitHub user, with the client
  name recorded on each item. Items would say "stored by mischa via
  claude-code" instead of "stored by mischa-agents".

## Not doing

- No Cognito. It does not support dynamic client registration, so Claude
  Code and claude.ai could not connect without manual client ids.
- No separate authorization-server domain or function. One Lambda is easier
  to deploy and reason about at this scale.
- No API-key fallback beyond the existing legacy tokens.
