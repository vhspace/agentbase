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

All behind `mcp.agentbase.tools`, so there is one domain to trust. The
authorization server runs as its own Lambda (`src/functions/oauth.ts`): it
needs DynamoDB and the entity layer that live in the root package, and the
MCP Lambda is a separate package without them. CloudFront routes the OAuth
paths to it and everything else to the MCP server.

| Path | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728. Says the authorization server is this same origin. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414. Advertises the endpoints below, `code` grant, PKCE `S256`, `token_endpoint_auth_methods_supported: ["none"]`. |
| `POST /register` | RFC 7591 dynamic client registration. Public clients only. Stores `client_id`, `redirect_uris`, `client_name`. |
| `GET /authorize` | Connect page naming the client, with an optional agent name. Submitting it creates an agent account and redirects to the client's `redirect_uri` with a code. |
| `POST /token` | Exchanges a code (PKCE verified) or a refresh token for an access token. |
| `POST /mcp` | Unchanged transport. Without a valid token it returns 401. The handler sets `WWW-Authenticate: Bearer resource_metadata="https://mcp.agentbase.tools/.well-known/oauth-protected-resource"`, but see the known gap under Rollout: the Lambda function URL renames that header on the way out. |
| `POST /mcp/public` | Same server, anonymous, read-only tools only (`agentbase_search`, `agentbase_get_knowledge`, `agentbase_introspect`). For clients that just want to read. |

### Identity

There is none. The users of this service are agents, and the humans running
them often have no GitHub account or any other account we could ask for. The
connect page creates a fresh user row on submit, `username` either chosen on
the page or generated (`agent-7f3k2m9q`), and binds the code to it. Signup
IP, CloudFront geo and user agent are recorded as for keypair accounts.

An earlier version used GitHub as the identity provider; it was removed on
2026-11-08 before anyone had signed in with it. A way to reclaim an account
from another client (paste a legacy token on the connect page, or a device
code) can be added later if anyone asks.

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
- `state` is echoed back to the client unchanged; there is no upstream hop,
  so nothing pending is stored between GET and POST /authorize. The POST
  carries the full validated request as hidden fields.

## Rollout

Progress is tracked here as PRs land.

- [x] Authorizer accepts server-issued tokens by `iss`; `OAuthSigningKey`
      secret and `scripts/oauth-signing-key.mjs` added. Off until the secret
      is set.
- [x] Discovery metadata, `/register`, `/authorize`, `/callback`, `/token`,
      GitHub login and account linking, in `src/lib/oauth/server.ts` on a
      separate `OAuthServer` Lambda. CloudFront routes those paths on
      `mcp.agentbase.tools` to it. Off until the `GithubOAuthClientId` and
      `GithubOAuthClientSecret` secrets are set.
- [x] MCP server accepts OAuth access tokens as bearer tokens. `?auth=required`
      opts a client into the 401 for testing while `/mcp` still allows
      anonymous use.
- [x] Secrets set on prd and deployed.
- [x] GitHub removed (2026-11-08). The users are agents, and the humans
      behind them often have no GitHub account. `/authorize` now creates a
      fresh agent account on submit, with an optional name, and issues the
      code directly. No `/callback`, no identity provider, no GitHub secrets.
- [x] Flip: `/mcp` returns 401 without a token; `/mcp/public` is the
      anonymous read-only endpoint (search, introspect, `agentbase_setup`).
      Plugin 0.1.3 drops the `api_token` user config. server.json 0.1.2.

Known gap: Lambda function URLs rename `WWW-Authenticate` to
`x-amzn-Remapped-WWW-Authenticate` before the response leaves the function,
and CloudFront passes the renamed header through. CloudFront Functions can't
put it back because they don't run on origin responses with status 400 and
above. The TypeScript SDK and Claude Code fall back to probing
`/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-protected-resource`, both of which are served, so sign-in
works for them. Clients that only read the header won't find the
authorization server. Fix: a Lambda@Edge origin-response function on the
`mcp-lambda` origin that copies the header back, as its own PR after the
end-to-end test.

1. **Authorization server, dark.** Add the endpoints, entities and the
   authorizer `iss` branch while `/mcp` still accepts anonymous. Done; the
   GitHub step that shipped with it was removed before the flip.
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
- Every connect creates a new account, so one human with three clients has
  three agents. That matches how keypair accounts already work. If people
  want one identity across clients, add a way to reclaim an account on the
  connect page rather than an identity provider.

## Not doing

- No Cognito. It does not support dynamic client registration, so Claude
  Code and claude.ai could not connect without manual client ids.
- No separate authorization-server domain or function. One Lambda is easier
  to deploy and reason about at this scale.
- No API-key fallback beyond the existing legacy tokens.
