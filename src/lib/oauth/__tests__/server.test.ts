import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPair, exportJWK, importJWK, jwtVerify } from "jose";
import { randomBytes, createHash } from "node:crypto";

const ISS = "https://mcp.example.test";

// In-memory stand-ins for the ElectroDB entities, keyed on their pk attribute.
function memEntity(pk: string) {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    create: (data: Record<string, unknown>) => ({
      go: async () => {
        rows.set(String(data[pk]), data);
        return { data };
      },
    }),
    get: (key: Record<string, string>) => ({ go: async () => ({ data: rows.get(key[pk]) ?? null }) }),
    delete: (key: Record<string, string>) => ({ go: async () => { rows.delete(key[pk]); return {}; } }),
  };
}
const clients = memEntity("clientId");
const codes = memEntity("codeHash");
const refreshTokens = memEntity("tokenHash");
const users = memEntity("userId");
const usersByName = vi.fn(async (_: { username: string }) => ({ data: [] as unknown[] }));

vi.mock("../../entities/oauth.js", () => ({
  OAuthClientEntity: clients,
  AuthCodeEntity: codes,
  RefreshTokenEntity: refreshTokens,
}));
vi.mock("../../entities/user.js", () => ({
  UserEntity: { ...users, query: { byUsername: (p: { username: string }) => ({ go: () => usersByName(p) }) } },
}));
vi.mock("../../powertools.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { OAuthServer, loadOAuthConfig, isAllowedRedirectUri } = await import("../server.js");
const { loadServerKeys } = await import("../../auth/oauth.js");

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = await exportJWK(privateKey);
jwk.kid = "k1";
const env = {
  OAUTH_SIGNING_KEY: JSON.stringify(jwk),
  OAUTH_ISSUER: ISS,
};

const server = new OAuthServer(loadOAuthConfig(env)!);

const req = (method: string, path: string, opts: { query?: Record<string, string>; body?: string; headers?: Record<string, string> } = {}) => ({
  method,
  path,
  query: new URLSearchParams(opts.query ?? {}),
  headers: opts.headers ?? {},
  body: opts.body ?? "",
});
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

async function registerClient() {
  const res = await server.handle(
    req("POST", "/register", {
      body: JSON.stringify({ client_name: "Claude Code", redirect_uris: ["http://localhost:3456/callback", "https://claude.ai/api/mcp/auth_callback"] }),
    }),
  );
  expect(res.status).toBe(201);
  return JSON.parse(res.body) as { client_id: string };
}

const AUTHZ = (clientId: string, redirectUri: string) => ({
  client_id: clientId, redirect_uri: redirectUri, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "cs1", scope: "knowledge",
});

/** Walk GET /authorize → POST /authorize and return the code the client receives. */
async function obtainCode(clientId: string, redirectUri = "http://localhost:3456/callback", username?: string) {
  const consent = await server.handle(req("GET", "/authorize", { query: AUTHZ(clientId, redirectUri) }));
  expect(consent.status).toBe(200);
  expect(consent.body).toContain("Claude Code");
  expect(consent.body).toContain('name="code_challenge"');
  expect(consent.body).toContain('name="username"');

  const back = await server.handle(
    req("POST", "/authorize", {
      body: form({ ...AUTHZ(clientId, redirectUri), ...(username ? { username } : {}) }),
      headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1", "user-agent": "claude-code/2.1", "cloudfront-viewer-country": "DE" },
    }),
  );
  expect(back.status).toBe(302);
  const loc = new URL(back.headers.location);
  expect(loc.origin + loc.pathname).toBe(redirectUri);
  expect(loc.searchParams.get("state")).toBe("cs1");
  return loc.searchParams.get("code")!;
}

beforeEach(() => {
  for (const e of [clients, codes, refreshTokens, users]) e.rows.clear();
  usersByName.mockReset();
  usersByName.mockResolvedValue({ data: [] });
});

describe("discovery", () => {
  it("serves authorization server and protected resource metadata", async () => {
    const as = JSON.parse((await server.handle(req("GET", "/.well-known/oauth-authorization-server"))).body);
    expect(as.issuer).toBe(ISS);
    expect(as.token_endpoint).toBe(`${ISS}/token`);
    expect(as.registration_endpoint).toBe(`${ISS}/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);

    const prm = JSON.parse((await server.handle(req("GET", "/.well-known/oauth-protected-resource"))).body);
    expect(prm.resource).toBe(`${ISS}/mcp`);
    expect(prm.authorization_servers).toEqual([ISS]);
    const prm2 = await server.handle(req("GET", "/.well-known/oauth-protected-resource/mcp"));
    expect(prm2.status).toBe(200);

    const jwks = JSON.parse((await server.handle(req("GET", "/.well-known/jwks.json"))).body);
    expect(jwks.keys[0].kid).toBe("k1");
    expect(jwks.keys[0].d).toBeUndefined();
  });

  it("is disabled when the signing key is unset", () => {
    expect(loadOAuthConfig({ ...env, OAUTH_SIGNING_KEY: "unset" })).toBeUndefined();
    expect(loadOAuthConfig({ ...env, OAUTH_SIGNING_KEY: undefined })).toBeUndefined();
  });
});

describe("registration", () => {
  it("accepts https and loopback redirect URIs only", async () => {
    expect(isAllowedRedirectUri("https://claude.ai/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:1234/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://x.test/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("myapp://cb")).toBe(false);

    const bad = await server.handle(req("POST", "/register", { body: JSON.stringify({ redirect_uris: ["http://evil.test/cb"] }) }));
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toBe("invalid_redirect_uri");

    const confidential = await server.handle(
      req("POST", "/register", { body: JSON.stringify({ redirect_uris: ["https://x.test/cb"], token_endpoint_auth_method: "client_secret_post" }) }),
    );
    expect(confidential.status).toBe(400);
  });

  it("returns a client id and stores the registration", async () => {
    const { client_id } = await registerClient();
    expect(client_id).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(clients.rows.get(client_id)?.clientName).toBe("Claude Code");
  });
});

describe("authorization", () => {
  it("refuses to redirect to an unregistered redirect_uri", async () => {
    const { client_id } = await registerClient();
    const res = await server.handle(
      req("GET", "/authorize", { query: { client_id, redirect_uri: "https://evil.test/cb", response_type: "code", code_challenge: challenge } }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });

  it("redirects protocol errors back to the client with state", async () => {
    const { client_id } = await registerClient();
    const res = await server.handle(
      req("GET", "/authorize", { query: { client_id, redirect_uri: "http://localhost:3456/callback", response_type: "code", state: "s" } }),
    );
    expect(res.status).toBe(302);
    const u = new URL(res.headers.location);
    expect(u.searchParams.get("error")).toBe("invalid_request");
    expect(u.searchParams.get("state")).toBe("s");
  });

  it("accepts a loopback redirect on a different port than registered", async () => {
    const { client_id } = await registerClient();
    const code = await obtainCode(client_id, "http://localhost:60000/callback");
    expect(code).toBeTruthy();
  });

  it("creates a fresh agent account on connect, with a generated name and signup metadata", async () => {
    const { client_id } = await registerClient();
    await obtainCode(client_id);
    expect(users.rows.size).toBe(1);
    const user = [...users.rows.values()][0];
    expect(user.username).toMatch(/^agent-[a-z0-9]{6,8}$/);
    expect(user.publicKey).toBeUndefined();
    expect(user.signupIp).toBe("198.51.100.7");
    expect(user.signupCountry).toBe("DE");
    expect(user.signupUserAgent).toBe("claude-code/2.1");

    await obtainCode(client_id);
    expect(users.rows.size).toBe(2);
  });

  it("uses a requested name, suffixing it when taken, and rejects a malformed one", async () => {
    const { client_id } = await registerClient();
    await obtainCode(client_id, undefined, "My-Laptop");
    expect([...users.rows.values()][0].username).toBe("my-laptop");

    usersByName.mockResolvedValueOnce({ data: [{ userId: "someone" }] });
    await obtainCode(client_id, undefined, "my-laptop");
    const names = [...users.rows.values()].map((u) => u.username as string);
    expect(names.filter((n) => n.startsWith("my-laptop-"))).toHaveLength(1);

    const bad = await server.handle(
      req("POST", "/authorize", { body: form({ ...AUTHZ(client_id, "http://localhost:3456/callback"), username: "-nope-" }) }),
    );
    expect(bad.status).toBe(400);
    expect(users.rows.size).toBe(2);
  });

  it("has no GitHub callback route", async () => {
    const res = await server.handle(req("GET", "/callback", { query: { code: "x", state: "nope" } }));
    expect(res.status).toBe(404);
  });
});

describe("token", () => {
  it("exchanges a code with PKCE for a verifiable access token and a refresh token", async () => {
    const { client_id } = await registerClient();
    const code = await obtainCode(client_id);

    const res = await server.handle(
      req("POST", "/token", { headers: FORM, body: form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: "http://localhost:3456/callback" }) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(res.body);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(30 * 24 * 3600);

    const keys = loadServerKeys(env)!;
    const { payload } = await jwtVerify(body.access_token, await importJWK(keys.publicJwk, "ES256"), { issuer: ISS, audience: ISS });
    expect(payload.sub).toBe([...users.rows.keys()][0]);
    expect(payload.client_id).toBe(client_id);

    // a code is single use
    const again = await server.handle(
      req("POST", "/token", { headers: FORM, body: form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id }) }),
    );
    expect(again.status).toBe(400);
    expect(JSON.parse(again.body).error).toBe("invalid_grant");

    // refresh rotates
    const refreshed = await server.handle(
      req("POST", "/token", { headers: FORM, body: form({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id }) }),
    );
    expect(refreshed.status).toBe(200);
    expect(JSON.parse(refreshed.body).refresh_token).not.toBe(body.refresh_token);
    const replay = await server.handle(
      req("POST", "/token", { headers: FORM, body: form({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id }) }),
    );
    expect(replay.status).toBe(400);
  });

  it("rejects a wrong verifier and burns the code", async () => {
    const { client_id } = await registerClient();
    const code = await obtainCode(client_id);
    const res = await server.handle(
      req("POST", "/token", { headers: FORM, body: form({ grant_type: "authorization_code", code, code_verifier: "a".repeat(43), client_id }) }),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error_description).toMatch(/PKCE/);
    expect(codes.rows.size).toBe(0);
  });

  it("rejects a code presented by a different client", async () => {
    const { client_id } = await registerClient();
    const other = await registerClient();
    const code = await obtainCode(client_id);
    const res = await server.handle(
      req("POST", "/token", { headers: FORM, body: form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: other.client_id }) }),
    );
    expect(res.status).toBe(400);
  });

  it("requires form encoding", async () => {
    const res = await server.handle(req("POST", "/token", { headers: { "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(400);
  });
});
