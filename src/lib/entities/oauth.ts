import { Entity } from "electrodb";
import { docClient, tableName } from "../db.js";

// Dynamically registered OAuth client (RFC 7591). Public clients only.
export const OAuthClientEntity = new Entity(
  {
    model: { entity: "oauthclient", version: "1", service: "agentbase" },
    attributes: {
      clientId: { type: "string", required: true },
      clientName: { type: "string" },
      clientUri: { type: "string" },
      redirectUris: { type: "list", items: { type: "string" }, required: true },
      createdAt: { type: "string", required: true },
      ttl: { type: "number", required: true },
    },
    indexes: {
      byClientId: {
        pk: { field: "pk", composite: ["clientId"] },
        sk: { field: "sk", composite: [] },
      },
    },
  },
  { client: docClient, table: tableName },
);

// A pending /authorize request, keyed by the state we hand to GitHub.
export const AuthRequestEntity = new Entity(
  {
    model: { entity: "authrequest", version: "1", service: "agentbase" },
    attributes: {
      upstreamState: { type: "string", required: true },
      clientId: { type: "string", required: true },
      redirectUri: { type: "string", required: true },
      codeChallenge: { type: "string", required: true },
      clientState: { type: "string" },
      scope: { type: "string" },
      resource: { type: "string" },
      createdAt: { type: "string", required: true },
      ttl: { type: "number", required: true },
    },
    indexes: {
      byState: {
        pk: { field: "pk", composite: ["upstreamState"] },
        sk: { field: "sk", composite: [] },
      },
    },
  },
  { client: docClient, table: tableName },
);

// An issued authorization code, stored hashed, single use.
export const AuthCodeEntity = new Entity(
  {
    model: { entity: "authcode", version: "1", service: "agentbase" },
    attributes: {
      codeHash: { type: "string", required: true },
      clientId: { type: "string", required: true },
      redirectUri: { type: "string", required: true },
      codeChallenge: { type: "string", required: true },
      userId: { type: "string", required: true },
      scope: { type: "string" },
      createdAt: { type: "string", required: true },
      ttl: { type: "number", required: true },
    },
    indexes: {
      byCode: {
        pk: { field: "pk", composite: ["codeHash"] },
        sk: { field: "sk", composite: [] },
      },
    },
  },
  { client: docClient, table: tableName },
);

// Refresh tokens, stored hashed, rotated on every use.
export const RefreshTokenEntity = new Entity(
  {
    model: { entity: "refreshtoken", version: "1", service: "agentbase" },
    attributes: {
      tokenHash: { type: "string", required: true },
      clientId: { type: "string", required: true },
      userId: { type: "string", required: true },
      scope: { type: "string" },
      createdAt: { type: "string", required: true },
      ttl: { type: "number", required: true },
    },
    indexes: {
      byToken: {
        pk: { field: "pk", composite: ["tokenHash"] },
        sk: { field: "sk", composite: [] },
      },
    },
  },
  { client: docClient, table: tableName },
);

// Links a GitHub account to an AgentBase user.
export const GithubIdentityEntity = new Entity(
  {
    model: { entity: "githubidentity", version: "1", service: "agentbase" },
    attributes: {
      githubId: { type: "string", required: true },
      githubLogin: { type: "string", required: true },
      userId: { type: "string", required: true },
      createdAt: { type: "string", required: true },
    },
    indexes: {
      byGithubId: {
        pk: { field: "pk", composite: ["githubId"] },
        sk: { field: "sk", composite: [] },
      },
    },
  },
  { client: docClient, table: tableName },
);
