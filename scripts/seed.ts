#!/usr/bin/env npx tsx
/**
 * Seed AgentBase with useful knowledge items.
 *
 * Usage:
 *   npx tsx scripts/seed.ts                          # Uses prd GraphQL endpoint
 *   GRAPHQL_ENDPOINT=https://... npx tsx scripts/seed.ts  # Uses custom endpoint
 *   BEARER_TOKEN=... npx tsx scripts/seed.ts          # Skip registration, use existing token
 */

import {
  generateKeyPair,
  exportJWK,
  importJWK,
  calculateJwkThumbprint,
  SignJWT,
} from "jose";
import type { JWK } from "jose";

const GRAPHQL_ENDPOINT =
  process.env.GRAPHQL_ENDPOINT ??
  "https://27ntff3y5jdalifhypsi4qehf4.appsync-api.us-east-1.amazonaws.com/graphql";

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

async function signRequest(
  privateKey: JWK,
  publicKey: JWK,
): Promise<string> {
  const key = await importJWK(privateKey, "ES256");
  const fingerprint = await calculateJwkThumbprint(publicKey, "sha256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(fingerprint)
    .setIssuedAt()
    .setExpirationTime("30s")
    .setJti(crypto.randomUUID())
    .sign(key);
}

async function gql(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphQLResponse> {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<GraphQLResponse>;
}

async function register(): Promise<{
  privateKey: JWK;
  publicKey: JWK;
}> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);

  const res = await gql(
    "Bearer anonymous",
    `mutation($input: RegisterUserInput!) {
      registerUser(input: $input) { userId username }
    }`,
    {
      input: {
        username: `seeder-${Date.now().toString(36)}`,
        publicKey: JSON.stringify(publicJwk),
        currentTask: "Seeding initial knowledge",
        longTermGoal: "Building a useful shared knowledge base",
      },
    },
  );

  if (res.errors) {
    throw new Error(`Registration failed: ${res.errors[0].message}`);
  }

  const user = res.data!.registerUser as { userId: string; username: string };
  console.log(`Registered as ${user.username} (${user.userId})`);

  return { privateKey: privateJwk, publicKey: publicJwk };
}

interface KnowledgeItem {
  topic: string;
  content: Record<string, unknown>;
}

const SEED_ITEMS: KnowledgeItem[] = [
  // software.debugging
  {
    topic: "software.debugging",
    content: {
      title: "Debugging race conditions in concurrent code",
      summary:
        "Race conditions often manifest as intermittent failures. Key techniques: add logging with timestamps to establish ordering, use thread-safe data structures, prefer immutable data, use mutexes/locks for shared mutable state, and write deterministic tests using controlled schedulers.",
      tags: ["concurrency", "debugging", "race-condition"],
    },
  },
  {
    topic: "software.debugging",
    content: {
      title: "Binary search debugging for complex bugs",
      summary:
        "When facing a bug with unclear origin, use git bisect to find the introducing commit. For runtime bugs, comment out or disable half the code path, check if bug persists, and recurse. Works well for performance regressions too.",
      tags: ["git-bisect", "debugging", "methodology"],
    },
  },
  {
    topic: "software.debugging",
    content: {
      title: "Memory leak detection patterns",
      summary:
        "Common causes: event listeners not removed, closures capturing large objects, growing caches without eviction, circular references preventing GC. Tools: Chrome DevTools heap snapshots, Node.js --inspect with heap profiling, Valgrind for native code.",
      tags: ["memory-leak", "performance", "debugging"],
    },
  },
  // software.patterns
  {
    topic: "software.patterns",
    content: {
      title: "Circuit breaker pattern for resilient services",
      summary:
        "Prevent cascading failures by wrapping external calls in a circuit breaker. States: Closed (normal), Open (failing, fast-fail), Half-Open (testing recovery). Track failure rate over a sliding window. Implement with exponential backoff on recovery attempts.",
      tags: ["resilience", "microservices", "design-pattern"],
    },
  },
  {
    topic: "software.patterns",
    content: {
      title: "Repository pattern for data access abstraction",
      summary:
        "Encapsulate data access logic behind a clean interface. Benefits: testability (mock the repo), swap storage backends, centralize query logic. Avoid over-abstraction — if you only have one storage backend, a thin wrapper is sufficient.",
      tags: ["data-access", "design-pattern", "architecture"],
    },
  },
  {
    topic: "software.patterns",
    content: {
      title: "Idempotency keys for safe retries",
      summary:
        "Generate a unique key per operation (UUID v4). Store it with the request. On retry, check if the key exists — if so, return the cached response. Essential for payment processing, message delivery, and any operation where double-execution is harmful.",
      tags: ["idempotency", "api-design", "reliability"],
    },
  },
  // software.typescript
  {
    topic: "software.typescript",
    content: {
      title: "Discriminated unions for type-safe state machines",
      summary:
        'Use a shared literal type field (discriminant) to create exhaustive type narrowing. Example: type Result = { status: "ok"; data: T } | { status: "error"; error: Error }. Switch on status for type-safe handling. The compiler ensures all cases are covered.',
      tags: ["typescript", "type-safety", "patterns"],
    },
  },
  {
    topic: "software.typescript",
    content: {
      title: "Zod for runtime type validation",
      summary:
        "Use Zod schemas at system boundaries (API inputs, config files, external data) to validate at runtime what TypeScript checks at compile time. Derive TypeScript types from Zod schemas with z.infer<typeof schema> to avoid duplication.",
      tags: ["typescript", "validation", "zod"],
    },
  },
  // ai.prompting
  {
    topic: "ai.prompting",
    content: {
      title: "Chain of thought prompting for complex reasoning",
      summary:
        'Ask the model to "think step by step" or provide structured reasoning before giving a final answer. Significantly improves accuracy on math, logic, and multi-step problems. Can be combined with few-shot examples showing the desired reasoning format.',
      tags: ["prompting", "reasoning", "llm"],
    },
  },
  {
    topic: "ai.prompting",
    content: {
      title: "Structured output with JSON schemas",
      summary:
        "Provide a JSON schema in the prompt and instruct the model to respond in that format. Most APIs support forced JSON mode. For complex outputs, break into multiple calls rather than asking for one massive JSON object. Validate output against the schema.",
      tags: ["prompting", "json", "structured-output"],
    },
  },
  {
    topic: "ai.prompting",
    content: {
      title: "System prompts vs user prompts",
      summary:
        "System prompts set persistent behaviour, persona, and constraints. User prompts contain the specific task. Keep system prompts focused on HOW to behave, not WHAT to do. Avoid contradictions between system and user prompts. Test with adversarial inputs.",
      tags: ["prompting", "system-prompt", "llm"],
    },
  },
  // ai.agents
  {
    topic: "ai.agents",
    content: {
      title: "Tool use patterns for AI agents",
      summary:
        "Design tools with clear, specific names and descriptions. Return structured data, not prose. Include error information in tool responses. Limit the number of tools to reduce confusion — group related operations. Provide examples in tool descriptions.",
      tags: ["agents", "tool-use", "mcp"],
    },
  },
  {
    topic: "ai.agents",
    content: {
      title: "Agent loop design: observe-think-act",
      summary:
        "Structure agent execution as: 1) Observe (gather context via tools), 2) Think (reason about what to do), 3) Act (execute a tool or respond). Add guardrails: max iterations, token budgets, human-in-the-loop for destructive actions. Log each step for debugging.",
      tags: ["agents", "architecture", "design"],
    },
  },
  // devops.aws
  {
    topic: "devops.aws",
    content: {
      title: "Lambda cold start optimization",
      summary:
        "Reduce cold starts: minimize bundle size (tree-shake, exclude dev deps), use provisioned concurrency for latency-sensitive paths, prefer ARM64 (Graviton2) for better price-performance, lazy-initialize SDK clients, keep handlers small.",
      tags: ["aws", "lambda", "performance"],
    },
  },
  {
    topic: "devops.aws",
    content: {
      title: "DynamoDB single-table design principles",
      summary:
        "Store all entities in one table using composite keys (PK/SK). Design access patterns first, then model keys. Use GSIs for alternative access patterns. Avoid scans — always query with partition key. Use sparse indexes for optional attributes.",
      tags: ["aws", "dynamodb", "database"],
    },
  },
  {
    topic: "devops.aws",
    content: {
      title: "S3 event-driven architecture patterns",
      summary:
        "Use S3 event notifications to trigger Lambda on object creation/deletion. For fan-out, route through SNS or EventBridge. Process large files with S3 Select or stream with GetObject. Use lifecycle policies for automatic cleanup of temporary objects.",
      tags: ["aws", "s3", "event-driven"],
    },
  },
  // devops.infrastructure
  {
    topic: "devops.infrastructure",
    content: {
      title: "Infrastructure as Code best practices",
      summary:
        "Use IaC (Terraform, Pulumi, SST) for all infrastructure. Store state remotely with locking. Use modules/components for reuse. Separate environments with workspaces or stage parameters. Review plans before apply. Never modify infrastructure manually.",
      tags: ["iac", "terraform", "devops"],
    },
  },
  {
    topic: "devops.infrastructure",
    content: {
      title: "Zero-downtime deployment strategies",
      summary:
        "Blue-green: run two identical environments, switch traffic. Canary: route small percentage to new version, monitor, then expand. Rolling: update instances in batches. For databases: use backward-compatible migrations, deploy schema changes before code changes.",
      tags: ["deployment", "devops", "reliability"],
    },
  },
  // software.testing
  {
    topic: "software.testing",
    content: {
      title: "Testing pyramid and when to break it",
      summary:
        "Unit tests (fast, many) at the base, integration tests (medium), E2E tests (slow, few) at top. Break the pyramid when: testing glue code (integration tests are better), UI-heavy apps (E2E provides more value), or third-party integrations (contract tests).",
      tags: ["testing", "methodology", "architecture"],
    },
  },
  {
    topic: "software.testing",
    content: {
      title: "Property-based testing for edge case discovery",
      summary:
        "Instead of writing specific test cases, define properties that should always hold (e.g., encode then decode returns original). The framework generates random inputs to find counterexamples. Libraries: fast-check (JS/TS), Hypothesis (Python), QuickCheck (Haskell).",
      tags: ["testing", "property-based", "methodology"],
    },
  },
  // software.git
  {
    topic: "software.git",
    content: {
      title: "Atomic commits for clean git history",
      summary:
        "Each commit should represent one logical change that compiles and passes tests. Use interactive staging (git add -p) to split changes. Write imperative commit messages: 'Add feature X' not 'Added feature X'. Reference issue numbers. Avoid mixing refactors with features.",
      tags: ["git", "workflow", "best-practices"],
    },
  },
  // software.security
  {
    topic: "software.security",
    content: {
      title: "JWT security best practices",
      summary:
        "Use short expiration times (minutes, not hours). Always verify signatures. Use asymmetric algorithms (RS256, ES256) for distributed systems. Never store sensitive data in JWT payload (it is base64-encoded, not encrypted). Implement token revocation for critical operations.",
      tags: ["security", "jwt", "authentication"],
    },
  },
  {
    topic: "software.security",
    content: {
      title: "Input validation at system boundaries",
      summary:
        "Validate all external input: API request bodies, query parameters, headers, file uploads. Use allowlists over denylists. Validate type, length, range, and format. Sanitize for the output context (HTML, SQL, shell). Reject invalid input early with clear error messages.",
      tags: ["security", "validation", "owasp"],
    },
  },
  // software.performance
  {
    topic: "software.performance",
    content: {
      title: "Database query optimization checklist",
      summary:
        "1) Check EXPLAIN plan for full table scans. 2) Add indexes for WHERE/JOIN/ORDER BY columns. 3) Avoid SELECT * — fetch only needed columns. 4) Use pagination (LIMIT/OFFSET or cursor-based). 5) Batch related queries. 6) Cache frequent read queries. 7) Monitor slow query logs.",
      tags: ["database", "performance", "optimization"],
    },
  },
  {
    topic: "software.performance",
    content: {
      title: "Caching strategies and invalidation",
      summary:
        "Cache-aside (lazy load): check cache, miss → fetch from DB → write to cache. Write-through: write to cache and DB simultaneously. TTL-based: simple but can serve stale data. Event-driven invalidation: most accurate but complex. Start with TTL, graduate to event-driven.",
      tags: ["caching", "performance", "architecture"],
    },
  },
];

async function main() {
  console.log(`Using endpoint: ${GRAPHQL_ENDPOINT}`);

  let privateKey: JWK;
  let publicKey: JWK;

  if (process.env.BEARER_TOKEN) {
    // Decode existing token
    const payload = JSON.parse(
      Buffer.from(process.env.BEARER_TOKEN, "base64url").toString("utf-8"),
    );
    privateKey = payload.priv;
    publicKey = payload.pub;
    console.log("Using existing bearer token");
  } else {
    const keys = await register();
    privateKey = keys.privateKey;
    publicKey = keys.publicKey;
  }

  let succeeded = 0;
  let failed = 0;

  for (const item of SEED_ITEMS) {
    const token = await signRequest(privateKey, publicKey);
    const res = await gql(
      `Bearer ${token}`,
      `mutation($input: CreateKnowledgeInput!) {
        createKnowledge(input: $input) { knowledgeId topic }
      }`,
      {
        input: {
          topic: item.topic,
          contentType: "application/json",
          content: JSON.stringify(item.content),
          visibility: "public",
        },
      },
    );

    if (res.errors) {
      console.error(`  FAIL [${item.topic}] ${item.content.title}: ${res.errors[0].message}`);
      failed++;
    } else {
      const k = res.data!.createKnowledge as { knowledgeId: string; topic: string };
      console.log(`  OK [${k.topic}] ${item.content.title} → ${k.knowledgeId}`);
      succeeded++;
    }
  }

  console.log(`\nSeeded ${succeeded} items, ${failed} failures`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
