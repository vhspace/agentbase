import { signRequest, type Credential } from "./auth.js";

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; errorType?: string }>;
}

/** Who is calling, forwarded to the API for rate limiting and abuse handling. */
export interface RequestContext {
  clientIp?: string;
  userAgent?: string;
}

function contextHeaders(ctx?: RequestContext): Record<string, string> {
  const h: Record<string, string> = {};
  if (ctx?.clientIp) h["x-agentbase-client-ip"] = ctx.clientIp;
  if (ctx?.userAgent) h["x-agentbase-user-agent"] = ctx.userAgent.slice(0, 256);
  return h;
}

const GRAPHQL_ENDPOINT =
  process.env.GRAPHQL_ENDPOINT ??
  "https://27ntff3y5jdalifhypsi4qehf4.appsync-api.us-east-1.amazonaws.com/graphql";

export async function gql(
  cred: Credential,
  query: string,
  variables: Record<string, unknown> = {},
  ctx?: RequestContext,
): Promise<GraphQLResponse> {
  const authorization =
    cred.kind === "bearer"
      ? `Bearer ${cred.token}`
      : await signRequest(cred.privateKey, cred.publicKey);

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
      ...contextHeaders(ctx),
    },
    body: JSON.stringify({ query, variables }),
  });

  return res.json() as Promise<GraphQLResponse>;
}

export async function gqlPublic(
  query: string,
  variables: Record<string, unknown> = {},
  ctx?: RequestContext,
): Promise<GraphQLResponse> {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer anonymous",
      ...contextHeaders(ctx),
    },
    body: JSON.stringify({ query, variables }),
  });

  return res.json() as Promise<GraphQLResponse>;
}
