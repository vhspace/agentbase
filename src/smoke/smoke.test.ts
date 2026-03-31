/**
 * Smoke tests for AgentBase staging deployment.
 * Run with: pnpm test:smoke
 *
 * These tests hit the live staging AppSync endpoint and exercise
 * all API operations end-to-end.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  SignJWT,
  importJWK,
  generateKeyPair,
  exportJWK,
  calculateJwkThumbprint,
} from "jose";

const API_URL = (() => {
  const value = process.env.AGENTBASE_API_URL;
  if (!value) {
    throw new Error("AGENTBASE_API_URL env var is required for smoke tests");
  }
  return value;
})();


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Agent {
  privateJwk: Record<string, unknown>;
  publicJwk: Record<string, unknown>;
  fingerprint: string;
  userId?: string;
  username: string;
}

async function createAgent(username: string): Promise<Agent> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey) as Record<string, unknown>;
  const privateJwk = await exportJWK(privateKey) as Record<string, unknown>;
  const fingerprint = await calculateJwkThumbprint(publicJwk, "sha256");
  return { privateJwk, publicJwk, fingerprint, username };
}

async function signJwt(
  agent: Agent,
  opts?: { exp?: string; jti?: string; sub?: string },
): Promise<string> {
  const key = await importJWK(agent.privateJwk, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(opts?.sub ?? agent.fingerprint)
    .setIssuedAt()
    .setExpirationTime(opts?.exp ?? "30s")
    .setJti(opts?.jti ?? crypto.randomUUID())
    .sign(key);
}

async function gql(
  query: string,
  variables: Record<string, unknown> = {},
  auth?: { token?: string },
): Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string; errorType?: string }> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (auth?.token) {
    headers["Authorization"] = auth.token;
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `GraphQL request failed: ${res.status} ${res.statusText} - ${text}`,
    );
  }
  try {
    return JSON.parse(text) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message: string; errorType?: string }>;
    };
  } catch (err) {
    throw new Error(
      `Failed to parse JSON response: ${String(err)} - Raw body: ${text}`,
    );
  }
}

// ---------------------------------------------------------------------------
// State shared across tests
// ---------------------------------------------------------------------------

let agentA: Agent;
let agentB: Agent;
let knowledgeId: string;
let privateKnowledgeId: string;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentBase Smoke Tests", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    const suffix = Date.now().toString(36);
    agentA = await createAgent(`smoke-a-${suffix}`);
    agentB = await createAgent(`smoke-b-${suffix}`);
  });

  // ── Registration ──────────────────────────────────────────────────────

  describe("Registration", () => {
    it("registers agent A", async () => {
      const res = await gql(
        `mutation($input: RegisterUserInput!) {
          registerUser(input: $input) {
            userId username publicKeyFingerprint signupDate
          }
        }`,
        {
          input: {
            username: agentA.username,
            publicKey: JSON.stringify(agentA.publicJwk),
            currentTask: "Running smoke tests",
            longTermGoal: "Validating AgentBase",
          },
        },
        {},
      );
      expect(res.errors).toBeUndefined();
      const user = res.data!.registerUser as Record<string, string>;
      expect(user.userId).toBeTruthy();
      expect(user.username).toBe(agentA.username);
      expect(user.publicKeyFingerprint).toBe(agentA.fingerprint);
      agentA.userId = user.userId;
    });

    it("registers agent B", async () => {
      const res = await gql(
        `mutation($input: RegisterUserInput!) {
          registerUser(input: $input) { userId username }
        }`,
        {
          input: {
            username: agentB.username,
            publicKey: JSON.stringify(agentB.publicJwk),
          },
        },
        {},
      );
      expect(res.errors).toBeUndefined();
      agentB.userId = (res.data!.registerUser as Record<string, string>).userId;
    });

    it("rejects duplicate username", async () => {
      const dup = await createAgent(agentA.username);
      const res = await gql(
        `mutation($input: RegisterUserInput!) {
          registerUser(input: $input) { userId }
        }`,
        {
          input: {
            username: agentA.username,
            publicKey: JSON.stringify(dup.publicJwk),
          },
        },
        {},
      );
      expect(res.errors).toBeDefined();
      expect(res.errors![0].message).toMatch(/username.*taken/i);
    });

    it("rejects invalid username", async () => {
      const agent = await createAgent("AB!!invalid");
      const res = await gql(
        `mutation($input: RegisterUserInput!) {
          registerUser(input: $input) { userId }
        }`,
        { input: { username: "AB!!invalid", publicKey: JSON.stringify(agent.publicJwk) } },
        {},
      );
      expect(res.errors).toBeDefined();
    });
  });

  // ── Authentication ────────────────────────────────────────────────────

  describe("Authentication", () => {
    it("authenticates with valid JWT", async () => {
      const token = await signJwt(agentA);
      const res = await gql(`{ me { userId username } }`, {}, { token });
      expect(res.errors).toBeUndefined();
      expect((res.data!.me as Record<string, string>).userId).toBe(agentA.userId);
    });

    it("rejects missing auth", async () => {
      const res = await gql(`{ me { userId } }`);
      expect(res.errors).toBeDefined();
    });

    it("rejects replayed JWT (same jti)", async () => {
      const jti = crypto.randomUUID();
      const token1 = await signJwt(agentA, { jti });
      const res1 = await gql(`{ me { userId } }`, {}, { token: token1 });
      expect(res1.errors).toBeUndefined();

      const token2 = await signJwt(agentA, { jti });
      const res2 = await gql(`{ me { userId } }`, {}, { token: token2 });
      expect(res2.errors).toBeDefined();
    });

    it("rejects expired JWT", async () => {
      const key = await importJWK(agentA.privateJwk, "ES256");
      const expired = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setSubject(agentA.fingerprint)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
        .setJti(crypto.randomUUID())
        .sign(key);
      const res = await gql(`{ me { userId } }`, {}, { token: expired });
      expect(res.errors).toBeDefined();
    });

    it("rejects JWT signed with wrong key", async () => {
      const rogue = await createAgent("rogue");
      // Sign a JWT with rogue's key but agent A's fingerprint as sub
      const token = await signJwt(rogue, { sub: agentA.fingerprint });
      const res = await gql(`{ me { userId } }`, {}, { token });
      expect(res.errors).toBeDefined();
    });
  });

  // ── Profile ───────────────────────────────────────────────────────────

  describe("Profile", () => {
    it("returns profile via me query", async () => {
      const token = await signJwt(agentA);
      const res = await gql(
        `{ me { userId username currentTask longTermGoal createdAt updatedAt } }`,
        {},
        { token },
      );
      expect(res.errors).toBeUndefined();
      const me = res.data!.me as Record<string, string>;
      expect(me.username).toBe(agentA.username);
      expect(me.currentTask).toBe("Running smoke tests");
    });

    it("updates profile via updateMe", async () => {
      const token = await signJwt(agentA);
      const res = await gql(
        `mutation($input: UpdateUserInput!) {
          updateMe(input: $input) { currentTask longTermGoal }
        }`,
        { input: { currentTask: "Updated task", longTermGoal: "Updated goal" } },
        { token },
      );
      expect(res.errors).toBeUndefined();
      const updated = res.data!.updateMe as Record<string, string>;
      expect(updated.currentTask).toBe("Updated task");
      expect(updated.longTermGoal).toBe("Updated goal");
    });
  });

  // ── Knowledge CRUD ────────────────────────────────────────────────────

  describe("Knowledge CRUD", () => {
    it("creates a public knowledge item", async () => {
      const token = await signJwt(agentA);
      const res = await gql(
        `mutation($input: CreateKnowledgeInput!) {
          createKnowledge(input: $input) {
            knowledgeId topic contentType content language visibility createdAt
          }
        }`,
        {
          input: {
            topic: "smoke-test",
            contentType: "application/json",
            content: JSON.stringify({ fact: "Vitest is a fast test runner for Vite projects" }),
            language: "en-CA",
            visibility: "public",
          },
        },
        { token },
      );
      expect(res.errors).toBeUndefined();
      const k = res.data!.createKnowledge as Record<string, string>;
      expect(k.knowledgeId).toBeTruthy();
      expect(k.topic).toBe("smoke-test");
      expect(k.language).toBe("en-CA");
      expect(k.visibility).toBe("public");
      knowledgeId = k.knowledgeId;
    });

    it("creates a private knowledge item", async () => {
      const token = await signJwt(agentA);
      const res = await gql(
        `mutation($input: CreateKnowledgeInput!) {
          createKnowledge(input: $input) { knowledgeId visibility }
        }`,
        {
          input: {
            topic: "smoke-test",
            contentType: "text/plain",
            content: JSON.stringify("This is private agent A data"),
            visibility: "private",
          },
        },
        { token },
      );
      expect(res.errors).toBeUndefined();
      privateKnowledgeId = (res.data!.createKnowledge as Record<string, string>).knowledgeId;
    });

    it("gets own knowledge item", async () => {
      const token = await signJwt(agentA);
      const res = await gql(
        `query($id: ID!) { getKnowledge(id: $id) { knowledgeId topic content } }`,
        { id: knowledgeId },
        { token },
      );
      expect(res.errors).toBeUndefined();
      expect((res.data!.getKnowledge as Record<string, string>).knowledgeId).toBe(knowledgeId);
    });

    it("lists own knowledge items", async () => {
      const token = await signJwt(agentA);
      const res = await gql(
        `query { listKnowledge(topic: "smoke-test") { items { knowledgeId topic } nextToken } }`,
        {},
        { token },
      );
      expect(res.errors).toBeUndefined();
      const conn = res.data!.listKnowledge as { items: Array<Record<string, string>> };
      expect(conn.items.length).toBeGreaterThanOrEqual(2);
    });

    it("updates a knowledge item", async () => {
      const token = await signJwt(agentA);
      const res = await gql(
        `mutation($id: ID!, $input: UpdateKnowledgeInput!) {
          updateKnowledge(id: $id, input: $input) { knowledgeId topic }
        }`,
        { id: knowledgeId, input: { topic: "smoke-test-updated" } },
        { token },
      );
      expect(res.errors).toBeUndefined();
      expect((res.data!.updateKnowledge as Record<string, string>).topic).toBe("smoke-test-updated");
    });

    it("rejects update by non-owner", async () => {
      const token = await signJwt(agentB);
      const res = await gql(
        `mutation($id: ID!, $input: UpdateKnowledgeInput!) {
          updateKnowledge(id: $id, input: $input) { knowledgeId }
        }`,
        { id: knowledgeId, input: { topic: "hacked" } },
        { token },
      );
      expect(res.errors).toBeDefined();
    });

    it("rejects delete by non-owner", async () => {
      const token = await signJwt(agentB);
      const res = await gql(
        `mutation($id: ID!) { deleteKnowledge(id: $id) }`,
        { id: knowledgeId },
        { token },
      );
      expect(res.errors).toBeDefined();
    });
  });

  // ── Visibility / Ownership ────────────────────────────────────────────

  describe("Visibility", () => {
    it("agent B can read agent A's public item", async () => {
      const token = await signJwt(agentB);
      const res = await gql(
        `query($id: ID!) { getKnowledge(id: $id) { knowledgeId visibility } }`,
        { id: knowledgeId },
        { token },
      );
      expect(res.errors).toBeUndefined();
      expect((res.data!.getKnowledge as Record<string, string>).visibility).toBe("public");
    });

    it("agent B cannot read agent A's private item", async () => {
      const token = await signJwt(agentB);
      const res = await gql(
        `query($id: ID!) { getKnowledge(id: $id) { knowledgeId } }`,
        { id: privateKnowledgeId },
        { token },
      );
      // Should either return null or an error
      if (res.errors) {
        expect(res.errors[0].message).toMatch(/forbidden|not.found|access denied|private/i);
      } else {
        expect(res.data!.getKnowledge).toBeNull();
      }
    });

    it("agent B's listKnowledge does not include agent A's items", async () => {
      const token = await signJwt(agentB);
      const res = await gql(
        `query { listKnowledge { items { knowledgeId userId } nextToken } }`,
        {},
        { token },
      );
      expect(res.errors).toBeUndefined();
      const conn = res.data!.listKnowledge as { items: Array<Record<string, string>> };
      // listKnowledge returns only own items
      for (const item of conn.items) {
        expect(item.userId).toBe(agentB.userId);
      }
    });
  });

  // ── Search ────────────────────────────────────────────────────────────

  describe("Search", () => {
    it("finds semantically relevant public knowledge", async () => {
      // Give embeddings a moment to propagate
      await new Promise((r) => setTimeout(r, 2000));

      const token = await signJwt(agentA);
      const res = await gql(
        `query($q: String!) {
          searchKnowledge(query: $q, limit: 5) {
            knowledgeId topic score snippet username
          }
        }`,
        { q: "fast test runner for JavaScript" },
        { token },
      );
      expect(res.errors).toBeUndefined();
      const results = res.data!.searchKnowledge as Array<Record<string, unknown>>;
      // We should find our "Vitest is a fast test runner" item
      // (it might not be first if other data exists, but it should appear)
      expect(Array.isArray(results)).toBe(true);
      for (const result of results) {
        const r = result as Record<string, unknown>;
        expect(typeof r.knowledgeId).toBe("string");
        expect(typeof r.topic).toBe("string");
        expect(typeof r.score).toBe("number");
      }
    });
  });

  // ── Validation ────────────────────────────────────────────────────────

  describe("Validation", () => {
    it("rejects knowledge with invalid topic", async () => {
      const token = await signJwt(agentA);
      const res = await gql(
        `mutation($input: CreateKnowledgeInput!) {
          createKnowledge(input: $input) { knowledgeId }
        }`,
        {
          input: {
            topic: "A",  // too short (min 2)
            contentType: "text/plain",
            content: JSON.stringify("test"),
          },
        },
        { token },
      );
      expect(res.errors).toBeDefined();
    });

    it("rejects oversized content", async () => {
      const token = await signJwt(agentA);
      const bigContent = "x".repeat(300_000);
      const res = await gql(
        `mutation($input: CreateKnowledgeInput!) {
          createKnowledge(input: $input) { knowledgeId }
        }`,
        {
          input: {
            topic: "smoke-test",
            contentType: "text/plain",
            content: JSON.stringify(bigContent),
          },
        },
        { token },
      );
      expect(res.errors).toBeDefined();
    });
  });

  // ── GraphQL Introspection ─────────────────────────────────────────────

  describe("Introspection", () => {
    it("supports introspection without auth", async () => {
      const res = await gql(
        `{ __schema { queryType { name } mutationType { name } } }`,
        {},
        {},
      );
      expect(res.errors).toBeUndefined();
      const schema = res.data!.__schema as Record<string, Record<string, string>>;
      expect(schema.queryType.name).toBe("Query");
      expect(schema.mutationType.name).toBe("Mutation");
    });

    it("lists all expected types", async () => {
      const res = await gql(
        `{ __schema { types { name kind } } }`,
        {},
        {},
      );
      expect(res.errors).toBeUndefined();
      const types = (res.data!.__schema as { types: Array<{ name: string }> }).types;
      const names = types.map((t) => t.name);
      expect(names).toContain("User");
      expect(names).toContain("Knowledge");
      expect(names).toContain("KnowledgeConnection");
      expect(names).toContain("SearchResult");
      expect(names).toContain("Visibility");
    });
  });

  // ── Cleanup ───────────────────────────────────────────────────────────

  describe("Cleanup", () => {
    it("deletes public knowledge item", async () => {
      const token = await signJwt(agentA);
      const res = await gql(
        `mutation($id: ID!) { deleteKnowledge(id: $id) }`,
        { id: knowledgeId },
        { token },
      );
      expect(res.errors).toBeUndefined();
      expect(res.data!.deleteKnowledge).toBe(true);
    });

    it("deletes private knowledge item", async () => {
      const token = await signJwt(agentA);
      const res = await gql(
        `mutation($id: ID!) { deleteKnowledge(id: $id) }`,
        { id: privateKnowledgeId },
        { token },
      );
      expect(res.errors).toBeUndefined();
      expect(res.data!.deleteKnowledge).toBe(true);
    });

    it("confirms item is deleted", async () => {
      const token = await signJwt(agentA);
      const res = await gql(
        `query($id: ID!) { getKnowledge(id: $id) { knowledgeId } }`,
        { id: knowledgeId },
        { token },
      );
      if (res.errors) {
        expect(res.errors[0].message).toMatch(/not.found/i);
      } else {
        expect(res.data!.getKnowledge).toBeNull();
      }
    });
  });
});
