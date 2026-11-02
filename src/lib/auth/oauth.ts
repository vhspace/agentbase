import { importJWK, jwtVerify, decodeJwt, type JWK } from "jose";

/**
 * Server-issued OAuth access tokens.
 *
 * The OAuth authorization server (packages/mcp) signs access tokens with a
 * server key held in the OAuthSigningKey secret. The AppSync authorizer only
 * needs the public half to verify them. Legacy per-request JWTs signed by an
 * agent's own keypair carry no `iss`; server tokens carry ours, so the
 * authorizer can branch on that without a database lookup.
 */

export interface ServerKeys {
  privateJwk: JWK;
  publicJwk: JWK;
  kid: string;
  issuer: string;
}

export const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Load the signing key from the environment. Returns undefined when OAuth is not configured. */
export function loadServerKeys(env: NodeJS.ProcessEnv = process.env): ServerKeys | undefined {
  const raw = env.OAUTH_SIGNING_KEY;
  const issuer = env.OAUTH_ISSUER;
  if (!raw || raw === "unset" || !issuer) return undefined;
  let jwk: JWK;
  try {
    jwk = JSON.parse(raw) as JWK;
  } catch {
    throw new Error("OAUTH_SIGNING_KEY is not valid JSON");
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.kid) {
    throw new Error("OAUTH_SIGNING_KEY must be a P-256 private JWK with a kid");
  }
  const { d: _d, ...publicJwk } = jwk;
  return { privateJwk: jwk, publicJwk, kid: jwk.kid, issuer };
}

/** True when the token claims to be issued by our authorization server. */
export function isServerIssued(token: string, issuer: string): boolean {
  try {
    return decodeJwt(token).iss === issuer;
  } catch {
    return false;
  }
}

export interface AccessTokenClaims {
  userId: string;
  clientId?: string;
  scope?: string;
}

export async function verifyAccessToken(
  token: string,
  keys: Pick<ServerKeys, "publicJwk" | "issuer">,
): Promise<AccessTokenClaims> {
  const key = await importJWK(keys.publicJwk, "ES256");
  const { payload } = await jwtVerify(token, key, {
    algorithms: ["ES256"],
    issuer: keys.issuer,
    audience: keys.issuer,
    clockTolerance: "5s",
  });
  if (!payload.sub) throw new Error("Missing sub claim");
  return {
    userId: payload.sub,
    clientId: typeof payload.client_id === "string" ? payload.client_id : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
  };
}
