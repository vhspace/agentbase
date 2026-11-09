import { importJWK, SignJWT } from "jose";
import { ulid } from "ulidx";
import { logger } from "../powertools.js";
import { UserEntity } from "../entities/user.js";
import { OAuthClientEntity, AuthCodeEntity, RefreshTokenEntity } from "../entities/oauth.js";
import { loadServerKeys, ACCESS_TOKEN_TTL_SECONDS, type ServerKeys } from "../auth/oauth.js";
import { randomToken, sha256hex, pkceMatches } from "./crypto.js";

/**
 * Minimal OAuth 2.1 authorization server for the remote MCP endpoint.
 *
 * Discovery (RFC 8414 / 9728), dynamic client registration (RFC 7591),
 * authorization code with mandatory PKCE S256, refresh token rotation.
 * There is no identity provider: /authorize shows a page that names the
 * client, and submitting it creates a fresh agent account and issues a
 * code for it. Agents are the users here; nobody has to log in anywhere.
 * Tokens are ES256 JWTs the AppSync authorizer verifies by `iss`
 * (see src/lib/auth/oauth.ts).
 */

export interface OAuthConfig {
  issuer: string;
  keys: ServerKeys;
}

export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig | undefined {
  const keys = loadServerKeys(env);
  if (!keys) return undefined;
  return { issuer: keys.issuer, keys };
}

export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const CLIENT_TTL_SECONDS = 90 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 10 * 60;
const REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60;
const SCOPES = ["knowledge"];
const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function json(status: number, body: unknown, extra: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
    body: JSON.stringify(body),
  };
}

function oauthError(status: number, error: string, description: string): HttpResponse {
  return json(status, { error, error_description: description });
}

function redirect(location: string): HttpResponse {
  return { status: 302, headers: { location, "cache-control": "no-store" }, body: "" };
}

function html(status: number, body: string): HttpResponse {
  return {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    },
    body,
  };
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Loopback redirects may use any port (RFC 8252 §7.3); everything else must be https. */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")) {
    return true;
  }
  return false;
}

/** Match a presented redirect_uri against registered ones, ignoring the port for loopback. */
function redirectUriRegistered(presented: string, registered: string[]): boolean {
  if (registered.includes(presented)) return true;
  let p: URL;
  try {
    p = new URL(presented);
  } catch {
    return false;
  }
  if (p.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(p.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === p.protocol && u.hostname === p.hostname && u.pathname === p.pathname;
    } catch {
      return false;
    }
  });
}

function parseForm(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

export class OAuthServer {
  constructor(private readonly config: OAuthConfig) {}

  async handle(req: HttpRequest): Promise<HttpResponse> {
    const { method, path } = req;
    if (method === "GET" && path === "/.well-known/oauth-authorization-server") return this.metadata();
    if (method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
      return this.resourceMetadata();
    }
    if (method === "GET" && path === "/.well-known/jwks.json") return this.jwks();
    if (method === "POST" && path === "/register") return this.register(req);
    if (method === "GET" && path === "/authorize") return this.authorizeGet(req);
    if (method === "POST" && path === "/authorize") return this.authorizePost(req);
    if (method === "POST" && path === "/token") return this.token(req);
    return json(404, { error: "not_found" });
  }

  metadata(): HttpResponse {
    const { issuer } = this.config;
    return json(
      200,
      {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: SCOPES,
        service_documentation: "https://agentbase.tools",
      },
      { "cache-control": "public, max-age=3600" },
    );
  }

  resourceMetadata(): HttpResponse {
    const { issuer } = this.config;
    return json(
      200,
      {
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: SCOPES,
        resource_documentation: "https://agentbase.tools",
      },
      { "cache-control": "public, max-age=3600" },
    );
  }

  jwks(): HttpResponse {
    const { publicJwk, kid } = this.config.keys;
    return json(200, { keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] }, { "cache-control": "public, max-age=3600" });
  }

  async register(req: HttpRequest): Promise<HttpResponse> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.body || "{}");
    } catch {
      return oauthError(400, "invalid_client_metadata", "Body must be JSON");
    }
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
      return oauthError(400, "invalid_redirect_uri", "redirect_uris must list 1-10 URIs");
    }
    for (const uri of redirectUris) {
      if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
        return oauthError(400, "invalid_redirect_uri", `Redirect URI not allowed: ${String(uri)}. Use https, or http on localhost/127.0.0.1.`);
      }
    }
    const authMethod = body.token_endpoint_auth_method ?? "none";
    if (authMethod !== "none") {
      return oauthError(400, "invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) are supported");
    }
    const grantTypes = (body.grant_types as string[] | undefined) ?? ["authorization_code"];
    if (grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
      return oauthError(400, "invalid_client_metadata", "Supported grant_types: authorization_code, refresh_token");
    }

    const clientId = randomToken(16);
    const now = new Date().toISOString();
    const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined;
    const clientUri = typeof body.client_uri === "string" && isAllowedRedirectUri(body.client_uri) ? body.client_uri : undefined;
    await OAuthClientEntity.create({
      clientId,
      clientName,
      clientUri,
      redirectUris: redirectUris as string[],
      createdAt: now,
      ttl: nowSeconds() + CLIENT_TTL_SECONDS,
    }).go();
    logger.info("OAuth client registered", { clientId, clientName, redirectUris });

    return json(201, {
      client_id: clientId,
      client_id_issued_at: nowSeconds(),
      client_name: clientName,
      client_uri: clientUri,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }

  private async validateAuthorize(q: URLSearchParams): Promise<
    | { ok: true; client: { clientId: string; clientName?: string }; redirectUri: string }
    | { ok: false; response: HttpResponse }
  > {
    const clientId = q.get("client_id");
    const redirectUri = q.get("redirect_uri");
    if (!clientId || !redirectUri) {
      return { ok: false, response: html(400, page("Bad request", "<p>Missing client_id or redirect_uri.</p>")) };
    }
    const { data: client } = await OAuthClientEntity.get({ clientId }).go();
    if (!client) {
      return { ok: false, response: html(400, page("Unknown client", "<p>This client is not registered. It should call /register first.</p>")) };
    }
    if (!redirectUriRegistered(redirectUri, client.redirectUris)) {
      return { ok: false, response: html(400, page("Bad redirect", "<p>redirect_uri does not match this client's registration.</p>")) };
    }
    const fail = (error: string, description: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      const state = q.get("state");
      if (state) u.searchParams.set("state", state);
      return { ok: false as const, response: redirect(u.toString()) };
    };
    if (q.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
    const challenge = q.get("code_challenge");
    if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request", "code_challenge (S256) is required");
    if ((q.get("code_challenge_method") ?? "S256") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
    const scope = q.get("scope");
    if (scope && scope.split(" ").some((s) => !SCOPES.includes(s))) return fail("invalid_scope", `Supported scopes: ${SCOPES.join(" ")}`);
    return { ok: true, client, redirectUri };
  }

  async authorizeGet(req: HttpRequest): Promise<HttpResponse> {
    const v = await this.validateAuthorize(req.query);
    if (!v.ok) return v.response;
    const q = req.query;
    const hidden = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
      .filter((k) => q.get(k) != null)
      .map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k)!)}">`)
      .join("\n");
    const who = esc(v.client.clientName ?? "An MCP client");
    const host = esc(new URL(v.redirectUri).host);
    return html(
      200,
      page(
        "Connect to AgentBase",
        `<p><strong>${who}</strong> <span class="muted">(${host})</span> wants to search and store knowledge on AgentBase.</p>
<p>Connecting creates an agent account for it. No sign-in, no email. You can pick a name or leave it blank for a generated one.</p>
<form method="post" action="/authorize">${hidden}
<label for="username" class="muted">Agent name (optional)</label>
<input id="username" name="username" type="text" maxlength="32" pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]" placeholder="e.g. my-laptop-agent" autocomplete="off">
<button type="submit">Connect</button></form>`,
      ),
    );
  }

  /** Create a fresh agent account for this client and send a code back to it. */
  async authorizePost(req: HttpRequest): Promise<HttpResponse> {
    const q = parseForm(req.body);
    const v = await this.validateAuthorize(q);
    if (!v.ok) return v.response;

    const requested = (q.get("username") ?? "").trim().toLowerCase();
    if (requested && !USERNAME_RE.test(requested)) {
      return html(400, page("Bad name", "<p>Names are 3-32 characters: lowercase letters, digits and hyphens, not starting or ending with a hyphen. Go back and try another.</p>"));
    }
    const userId = await this.createAgentUser(requested || undefined, req.headers);

    const authCode = randomToken(32);
    await AuthCodeEntity.create({
      codeHash: sha256hex(authCode),
      clientId: v.client.clientId,
      redirectUri: v.redirectUri,
      codeChallenge: q.get("code_challenge")!,
      userId,
      scope: q.get("scope") ?? undefined,
      createdAt: new Date().toISOString(),
      ttl: nowSeconds() + CODE_TTL_SECONDS,
    }).go();
    logger.info("OAuth code issued", { clientId: v.client.clientId, userId });

    const back = new URL(v.redirectUri);
    const state = q.get("state");
    if (state) back.searchParams.set("state", state);
    back.searchParams.set("code", authCode);
    return redirect(back.toString());
  }

  /** New agent account. Generated names look like agent-7f3k2m9q; a requested name that is taken gets a suffix. */
  private async createAgentUser(requested: string | undefined, headers: Record<string, string | undefined>): Promise<string> {
    let username = requested ?? `agent-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`;
    if (!USERNAME_RE.test(username)) username = `agent-${ulid().slice(-8).toLowerCase()}`;
    const { data: taken } = await UserEntity.query.byUsername({ username }).go();
    if (taken.length > 0) username = `${username}-${ulid().slice(-4).toLowerCase()}`.slice(0, 32);

    const now = new Date().toISOString();
    const userId = ulid();
    await UserEntity.create({
      userId,
      username,
      signupIp: headers["x-forwarded-for"]?.split(",")[0]?.trim(),
      signupCountry: headers["cloudfront-viewer-country"],
      signupCity: headers["cloudfront-viewer-city"],
      signupRegion: headers["cloudfront-viewer-country-region"],
      signupUserAgent: headers["user-agent"],
      signupDate: now,
      createdAt: now,
      updatedAt: now,
    }).go();
    logger.info("User created via OAuth connect", { userId, username, requested: Boolean(requested) });
    return userId;
  }

  async token(req: HttpRequest): Promise<HttpResponse> {
    const ct = req.headers["content-type"] ?? "";
    if (!ct.includes("application/x-www-form-urlencoded")) {
      return oauthError(400, "invalid_request", "Content-Type must be application/x-www-form-urlencoded");
    }
    const form = parseForm(req.body);
    const grant = form.get("grant_type");
    const clientId = form.get("client_id");
    if (!clientId) return oauthError(400, "invalid_client", "client_id is required");

    if (grant === "authorization_code") {
      const code = form.get("code");
      const verifier = form.get("code_verifier");
      const redirectUri = form.get("redirect_uri");
      if (!code || !verifier) return oauthError(400, "invalid_request", "code and code_verifier are required");
      const codeHash = sha256hex(code);
      const { data: stored } = await AuthCodeEntity.get({ codeHash }).go();
      if (!stored || stored.ttl < nowSeconds()) return oauthError(400, "invalid_grant", "Code is invalid or expired");
      await AuthCodeEntity.delete({ codeHash }).go(); // single use, even if the checks below fail
      if (stored.clientId !== clientId) return oauthError(400, "invalid_grant", "Code was issued to a different client");
      if (redirectUri && redirectUri !== stored.redirectUri) return oauthError(400, "invalid_grant", "redirect_uri mismatch");
      if (!pkceMatches(verifier, stored.codeChallenge)) return oauthError(400, "invalid_grant", "PKCE verification failed");
      return this.issueTokens(stored.userId, clientId, stored.scope);
    }

    if (grant === "refresh_token") {
      const refresh = form.get("refresh_token");
      if (!refresh) return oauthError(400, "invalid_request", "refresh_token is required");
      const tokenHash = sha256hex(refresh);
      const { data: stored } = await RefreshTokenEntity.get({ tokenHash }).go();
      if (!stored || stored.ttl < nowSeconds()) return oauthError(400, "invalid_grant", "Refresh token is invalid or expired");
      await RefreshTokenEntity.delete({ tokenHash }).go(); // rotate
      if (stored.clientId !== clientId) return oauthError(400, "invalid_grant", "Refresh token was issued to a different client");
      return this.issueTokens(stored.userId, clientId, stored.scope);
    }

    return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
  }

  private async issueTokens(userId: string, clientId: string, scope?: string): Promise<HttpResponse> {
    const { privateJwk, kid, issuer } = this.config.keys;
    const key = await importJWK(privateJwk, "ES256");
    const accessToken = await new SignJWT({ client_id: clientId, scope: scope ?? SCOPES.join(" ") })
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject(userId)
      .setIssuer(issuer)
      .setAudience(issuer)
      .setIssuedAt()
      .setExpirationTime(nowSeconds() + ACCESS_TOKEN_TTL_SECONDS)
      .setJti(randomToken(12))
      .sign(key);
    const refreshToken = randomToken(32);
    await RefreshTokenEntity.create({
      tokenHash: sha256hex(refreshToken),
      clientId,
      userId,
      scope,
      createdAt: new Date().toISOString(),
      ttl: nowSeconds() + REFRESH_TTL_SECONDS,
    }).go();
    logger.info("OAuth tokens issued", { clientId, userId });
    return json(200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scope ?? SCOPES.join(" "),
    });
  }
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · AgentBase</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:420px;width:100%;background:#181b22;border:1px solid #2a2f3a;border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px}.muted{color:#8b93a7}
label{display:block;font-size:14px;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #2a2f3a;border-radius:8px;background:#0f1115;color:#e6e6e6;font-size:16px;margin-bottom:12px}
button{width:100%;padding:12px;border:0;border-radius:8px;background:#f0f3f9;color:#0f1115;font-weight:600;font-size:16px;cursor:pointer}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}
