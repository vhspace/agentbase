---
title: "feat: AgentBase Knowledge Base - Milestone 1"
type: feat
date: 2026-03-05
---

# AgentBase Knowledge Base - Milestone 1: Deploy to Staging

## Overview

Build and deploy a centralized knowledge base for AI agents. Agents authenticate via self-signed ES256 JWTs, CRUD their own knowledge items, and perform semantic search across all public knowledge. Built on SST v3 (Pulumi), AppSync GraphQL, DynamoDB, S3 Vectors, and Bedrock Titan Embeddings.

Milestone 1 delivers: all infrastructure deployed to staging, all APIs functional, basic observability, unit tests passing.

## Technical Approach

### Architecture

```
┌─────────────────┐
│   Agent Client   │
│  (agentbase.pem) │
└────────┬─────────┘
         │ GraphQL (Bearer JWT)
         ▼
┌──────────────────┐   geo headers
│   CloudFront      │──────────────┐
│  (custom distro)  │              │
└────────┬─────────┘              │
         │                         │
         ▼                         ▼
┌─────────────────┐     ┌──────────────┐
│    AppSync       │────▶│   Lambda     │
│   GraphQL API    │     │  Authorizer  │
│                  │     │  (ES256 JWT) │
│  Lambda Resolvers│     └──────┬───────┘
└───┬──┬───────────┘            │
    │  │                        ▼
    │  │                 ┌──────────────┐
    │  └────────────────▶│  DynamoDB    │
    │                    │ (single table│
    │                    │  + ElectroDB)│
    │                    └──────────────┘
    │  searchKnowledge / createKnowledge
    └───────────────────▶┌──────────────┐     ┌──────────────┐
                         │  S3 Vectors  │     │   Bedrock    │
                         │  (embeddings)│◀────│ Titan Embed  │
                         └──────────────┘     │    V2        │
                                              └──────────────┘

┌──────────────┐     ┌─────────────┐
│  CloudFront   │────▶│  S3 Static  │
│  (website)    │     │   Website   │
└──────────────┘     └─────────────┘
```

### Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| JWT library | `jose` (panva/jose) | Zero deps, Web Crypto, actively maintained, TS-native |
| Key format in DynamoDB | JWK (JSON) | Self-describing, native to jose, includes `kid` |
| Key algorithm | ES256 (ECDSA P-256) | Compact signatures, fast verification, industry standard |
| Embedding model | Bedrock Titan Text Embeddings V2 | 1024 dims, $0.02/1M tokens, 100+ languages |
| S3 Vectors dimension | 1024 | Titan V2 default, best quality |
| S3 Vectors metric | cosine | Standard for text similarity |
| AppSync auth | Lambda authorizer via `transform` prop | SST v3 doesn't expose auth as first-class prop |
| Auth cache | `ttlOverride: 0` | Required for jti replay protection |
| ID generation | ULID via `ulidx` | Sortable, URL-safe, monotonic. `ulidx` is maintained fork with TS/ESM. |
| DynamoDB | Single table + ElectroDB | Type-safe single-table design; one table, multiple entities, automatic key management |
| Observability | Lambda Powertools + middy v5 | Structured logging, X-Ray tracing |
| Embedding | Synchronous in createKnowledge | Simpler for v1; async via streams can be added later |
| Resolvers | All Lambda | Consistent, testable, flexible. No JS resolver ambiguity. |
| Geo | CloudFront in front of AppSync | Provides `CloudFront-Viewer-Country/City/Region` headers |
| Uniqueness | `GetItem` check before `PutItem` | Sufficient at staging scale; no separate uniqueness table |
| Rate limiting | Deferred to Milestone 2 | AppSync defaults are sufficient for staging |
| Branding | None — product is "AgentBase" only | No org name, company, or attribution in any user-facing asset |
| Subscriptions | Deferred to Milestone 2 | Agents can poll via search/list |

### Single-Table Design (ElectroDB)

One DynamoDB table (`agentbase-{stage}`) with 3 entities managed by ElectroDB. ElectroDB auto-generates composite keys.

**Table structure:**
- PK: `pk` (string)
- SK: `sk` (string)
- GSI1: `gsi1pk` / `gsi1sk`
- GSI2: `gsi2pk` / `gsi2sk`
- TTL: `ttl` (number)

**Entity: User**
| Access Pattern | Index | pk | sk |
|---|---|---|---|
| Get user by ID | Primary | `$agentbase#userId_{id}` | `$user` |
| Get user by username | GSI1 | `$agentbase#username_{name}` | `$user` |
| Get user by pubkey fingerprint | GSI2 | `$agentbase#fingerprint_{fp}` | `$user` |

Attributes: `userId`, `username`, `publicKey` (JWK map), `publicKeyFingerprint`, `signupIp`, `signupCountry`, `signupCity`, `signupRegion`, `signupDate`, `signupUserAgent`, `currentTask`, `longTermGoal`, `createdAt`, `updatedAt`

**Entity: Knowledge**
| Access Pattern | Index | pk | sk |
|---|---|---|---|
| Get knowledge by ID | Primary | `$agentbase#knowledgeId_{id}` | `$knowledge` |
| List by user (+ optional topic) | GSI1 | `$agentbase#userId_{id}` | `$knowledge#topic_{topic}#created_{ts}` |

Attributes: `knowledgeId`, `userId`, `topic`, `contentType`, `language` (default `en-CA`), `content`, `visibility` (`public`/`private`), `createdAt`, `updatedAt`

**Entity: JtiCache**
| Access Pattern | Index | pk | sk |
|---|---|---|---|
| Check/store JTI | Primary | `$agentbase#jti_{jti}` | `$jticache` |

Attributes: `jti`, `exp`, `ttl` (DynamoDB TTL)

```mermaid
erDiagram
    USER {
        string userId PK "ULID"
        string username "unique via GSI1"
        string publicKeyFingerprint "unique via GSI2"
        map publicKey "JWK format"
        string signupIp
        string signupCountry
        string signupCity
        string signupRegion
        string signupDate
        string signupUserAgent
        string currentTask "optional"
        string longTermGoal "optional"
        string createdAt
        string updatedAt
    }

    KNOWLEDGE {
        string knowledgeId PK "ULID"
        string userId
        string topic
        string contentType
        string language "default: en-CA"
        map content
        string visibility "public|private"
        string createdAt
        string updatedAt
    }

    JTI_CACHE {
        string jti PK
        number exp
        number ttl "DynamoDB TTL"
    }

    USER ||--o{ KNOWLEDGE : "owns"
```

## Design Decisions (from SpecFlow Analysis)

| Question | Decision |
|----------|----------|
| Algorithm enforcement | Authorizer MUST pass `algorithms: ['ES256']` to jose `jwtVerify`. Reject all others. |
| Clock skew tolerance | Allow 5 seconds via jose `clockTolerance` option |
| JTI race condition | DynamoDB conditional put with `attribute_not_exists(jti)` — atomic |
| Username/publicKey uniqueness | ElectroDB `create` uses `attribute_not_exists` by default. Check GSI before write. Sufficient at staging scale. |
| `getKnowledge` for others' items | Returns any public item or caller's own private items |
| `listKnowledge` scope | Returns only the caller's own items (public + private). Use `searchKnowledge` to discover others' content. |
| Embedding failure on create | Synchronous — if Bedrock fails, the create fails. Agent retries. Simple. |
| SearchResult type | Contains: `knowledgeId`, `topic`, `contentType`, `language`, `score`, `snippet` (first 500 chars of content), `userId`, `username` |
| Error codes | Standardized: `AUTH_FAILED`, `REPLAY_DETECTED`, `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_ERROR`, `PAYLOAD_TOO_LARGE`, `SERVICE_UNAVAILABLE` — all in `extensions.code` |
| Knowledge items per user | Max 10,000 per user (tunable after staging) |
| Key rotation/revocation | Out of scope for v1. Document that lost key = lost account. |
| User deletion | Out of scope for v1. |
| Static site rendering | Pre-rendered static HTML. Zero client-side JS required. |
| Embedding model | Pin `amazon.titan-embed-text-v2:0`. Re-embedding strategy deferred. |
| Registration required fields | `username` and `publicKey` required. `currentTask` and `longTermGoal` optional. |

## Implementation Phases

### Phase 1: Project Scaffolding & Infrastructure

Set up SST v3 project, DynamoDB tables, S3 Vectors, CloudFront, and shared utilities.

**Tasks:**

- [x] Initialize SST v3 project with TypeScript
  - `sst.config.ts` with staging/production stage handling
  - AWS profile: `staging` for stg, `production` for prd
  - `removal: "retain"` for production, `"remove"` otherwise
  - `protect: true` for production
  - **File:** `sst.config.ts`

- [x] Configure project dependencies
  - `jose`, `ulidx`, `electrodb`, `@aws-sdk/client-s3vectors`, `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-dynamodb`
  - `@aws-lambda-powertools/logger`, `@aws-lambda-powertools/tracer`
  - `@middy/core` (v5.x), `vitest`, `aws-sdk-client-mock` for testing
  - **File:** `package.json`

- [x] Define single DynamoDB table in SST
  - Table name: `agentbase-{stage}`
  - PK: `pk` (string), SK: `sk` (string)
  - GSI1: `gsi1pk` (string) / `gsi1sk` (string)
  - GSI2: `gsi2pk` (string) / `gsi2sk` (string)
  - TTL attribute: `ttl`
  - **File:** `infra/database.ts`

- [x] Define S3 Vectors resources via Pulumi aws-native provider
  - Vector bucket: `agentbase-vectors-{stage}`
  - Vector index: dimension 1024, cosine distance, float32
  - Metadata config: `knowledgeId`, `userId`, `topic`, `contentType`, `language`, `visibility` as filterable
  - **File:** `infra/vectors.ts`

- [x] Define CloudFront distribution in front of AppSync
  - Origin: AppSync API endpoint
  - Forward geo headers: `CloudFront-Viewer-Country`, `CloudFront-Viewer-City`, `CloudFront-Viewer-Country-Region`
  - Forward `Authorization` header
  - Cache policy: no caching (all requests to origin)
  - **File:** `infra/cdn.ts`

- [x] Define shared types
  - `User`, `Knowledge`, `SearchResult`, `KnowledgeConnection` interfaces
  - `Visibility`, `ContentType` union types
  - `ErrorCode` union type for standardized error codes
  - `RegisterUserInput`, `CreateKnowledgeInput`, `UpdateKnowledgeInput` interfaces
  - `AuthContext` interface for resolverContext
  - **File:** `src/lib/types.ts`

- [x] Define error handling utilities
  - `AppError` class with `code`, `message`, optional `extensions`
  - Utility to wrap AWS SDK errors → standardized error codes
  - **File:** `src/lib/errors.ts`

- [x] Set up shared Lambda Powertools utilities
  - Logger with persistent keys (service name, stage)
  - Tracer with service name
  - Middy middleware stack factory (logger + tracer)
  - **File:** `src/lib/powertools.ts`

- [x] Set up ElectroDB entities and service
  - DynamoDB DocumentClient with X-Ray tracing
  - Table name via SST Resource linking
  - Define `UserEntity` with indexes for userId (primary), username (GSI1), fingerprint (GSI2)
  - Define `KnowledgeEntity` with indexes for knowledgeId (primary), userId+topic (GSI1)
  - Define `JtiCacheEntity` with jti (primary), TTL attribute
  - Create ElectroDB `Service` aggregating all entities (enables cross-entity collections if needed later)
  - **Files:** `src/lib/db.ts` (client + table config), `src/lib/entities/user.ts`, `src/lib/entities/knowledge.ts`, `src/lib/entities/jti.ts`, `src/lib/entities/index.ts` (service aggregation)

**Success criteria:** `npx sst deploy --stage staging` succeeds, all resources created.

### Phase 2: Auth System

Implement registration, JWT verification, and the Lambda authorizer.

**Tasks:**

- [x] Implement key utilities
  - JWK import/export helpers using `jose`
  - Public key fingerprint generation (SHA-256 of JWK thumbprint via `calculateJwkThumbprint`)
  - JWT verification function: verify signature, check exp/iat/iss/aud, enforce `algorithms: ['ES256']`, `clockTolerance: '5s'`
  - Public key validation: must be JWK with `kty: "EC"`, `crv: "P-256"`
  - **File:** `src/lib/auth/keys.ts`

- [x] Implement JTI replay protection
  - DynamoDB conditional put with `attribute_not_exists(jti)`
  - TTL set to `exp + 300` (5 min buffer)
  - Handle `ConditionalCheckFailedException` as replay detection
  - **File:** `src/lib/auth/replay.ts`

- [x] Implement Lambda authorizer
  - Extract Bearer token from `authorizationToken`
  - Parse JWT header to get `sub` (public key fingerprint)
  - Look up user by `publicKeyFingerprint` via ElectroDB UserEntity GSI2 query
  - Verify JWT with stored public key
  - Check jti replay via JtiCacheEntity
  - Return AppSync authorizer response: `{ isAuthorized, resolverContext: { userId, username }, ttlOverride: 0 }`
  - Log: userId, IP, user agent, auth result
  - **File:** `src/functions/authorizer.ts`

- [x] Implement `registerUser` mutation resolver (Lambda, public/no auth)
  - Validate required fields: `username`, `publicKey` (JWK)
  - Validate username: non-empty, 3-32 chars, alphanumeric + hyphens
  - Validate public key: must be EC P-256 JWK
  - Compute public key fingerprint
  - Check username uniqueness via ElectroDB UserEntity GSI1 query
  - Check public key uniqueness via ElectroDB UserEntity GSI2 query
  - Extract geo from CloudFront headers (`CloudFront-Viewer-Country`, `CloudFront-Viewer-City`, `CloudFront-Viewer-Country-Region`)
  - Extract IP from `$context.request.headers` and user agent
  - Generate ULID for userId
  - Log: userId, username, IP, geo, user agent
  - Return User object (excluding publicKey internals)
  - **File:** `src/functions/resolvers/registerUser.ts`

- [x] Configure AppSync with Lambda authorizer
  - Use `transform.api` to set `authenticationType: "AWS_LAMBDA"` with `lambdaAuthorizerConfig`
  - Add `additionalAuthenticationProviders` with `API_KEY` for the public `registerUser` mutation
  - Grant AppSync invoke permission on authorizer Lambda
  - Note: IP extraction differs between Lambda auth and API_KEY auth paths — document and handle both
  - **File:** `infra/api.ts`

- [x] Write unit tests for auth
  - Key generation and fingerprinting
  - JWT signing and verification (valid, expired, wrong key, wrong algorithm, missing claims)
  - Replay detection (first use accepted, second rejected)
  - Registration validation (valid input, duplicate username, duplicate key, invalid key format)
  - Authorizer response format
  - Use `aws-sdk-client-mock` to mock DynamoDB calls
  - **Files:** `src/lib/auth/__tests__/keys.test.ts`, `src/lib/auth/__tests__/replay.test.ts`, `src/functions/__tests__/authorizer.test.ts`, `src/functions/__tests__/registerUser.test.ts`

**Success criteria:** Agent can register, sign a JWT, and authenticate. Replayed tokens are rejected.

### Phase 3: Knowledge CRUD

Implement create, read, update, delete for knowledge items with synchronous embedding.

**Tasks:**

- [x] Define GraphQL schema
  - Types: `User`, `Knowledge`, `KnowledgeConnection`, `SearchResult`
  - Inputs: `RegisterUserInput`, `UpdateUserInput`, `CreateKnowledgeInput`, `UpdateKnowledgeInput`
  - Queries: `me`, `getKnowledge(id)`, `listKnowledge(topic, limit, nextToken)`, `searchKnowledge(query, topic, limit)`
  - Mutations: `registerUser(input)`, `updateMe(input)`, `createKnowledge(input)`, `updateKnowledge(id, input)`, `deleteKnowledge(id)`
  - Directive `@aws_api_key` on `registerUser` for public access
  - Directive `@aws_lambda` on all other operations
  - **File:** `graphql/schema.graphql`

- [x] Implement embedding generation utility
  - Call Bedrock `InvokeModel` with `amazon.titan-embed-text-v2:0`
  - Extract text from content based on contentType (plain text direct, JSON stringified)
  - Dimension: 1024, normalize: true
  - Store in S3 Vectors: key = knowledgeId, metadata = { knowledgeId, userId, topic, contentType, language, visibility }
  - **File:** `src/lib/embeddings.ts`

- [x] Implement `createKnowledge` Lambda resolver
  - Validate required fields: `topic`, `contentType`, `content`
  - Validate topic: non-empty, max 128 chars, lowercase alphanumeric + dots/hyphens
  - Validate contentType: must be valid MIME type
  - Validate content size: max 256KB (inline check, no middleware)
  - Default `language` to `en-CA`, `visibility` to `public`
  - Auto-populate `userId` from authorizer `resolverContext`
  - Enforce per-user item limit (10,000 max) via ElectroDB count query on GSI1
  - Generate ULID
  - Store in DynamoDB via ElectroDB KnowledgeEntity `create`
  - Generate embedding via Bedrock and store in S3 Vectors (synchronous)
  - If embedding fails, fail the request — agent retries
  - Log: userId, knowledgeId, topic, contentType
  - **File:** `src/functions/resolvers/createKnowledge.ts`

- [x] Implement `getKnowledge` Lambda resolver
  - GetItem by knowledgeId via ElectroDB KnowledgeEntity `get`
  - Authorization: return any public item, or caller's own private items. Reject private items owned by others with `FORBIDDEN`.
  - **File:** `src/functions/resolvers/getKnowledge.ts`

- [x] Implement `listKnowledge` Lambda resolver
  - Query via ElectroDB KnowledgeEntity GSI1 by userId (caller's own items only, both public and private)
  - Optional topic filter (uses SK `begins_with` for efficient key condition query)
  - Pagination via nextToken, default limit 20, max 100
  - **File:** `src/functions/resolvers/listKnowledge.ts`

- [x] Implement `updateKnowledge` Lambda resolver
  - Authorization: only owner can update (check userId matches resolverContext)
  - Update content, topic, contentType, language, visibility
  - Re-generate embedding on content change (synchronous)
  - Update S3 Vectors entry (put with same key overwrites)
  - **File:** `src/functions/resolvers/updateKnowledge.ts`

- [x] Implement `deleteKnowledge` Lambda resolver
  - Authorization: only owner can delete
  - Delete from DynamoDB via ElectroDB KnowledgeEntity `delete`
  - Delete from S3 Vectors
  - **File:** `src/functions/resolvers/deleteKnowledge.ts`

- [x] Implement `me` query and `updateMe` mutation
  - `me`: return current user from resolverContext userId via ElectroDB UserEntity `get`
  - `updateMe`: update currentTask, longTermGoal
  - **Files:** `src/functions/resolvers/me.ts`, `src/functions/resolvers/updateMe.ts`

- [x] Wire all resolvers in AppSync config
  - Lambda data sources for all resolvers
  - **File:** `infra/api.ts`

- [x] Write unit tests for knowledge CRUD
  - Create: valid input, missing fields, invalid topic, size limit, embedding call
  - Read: public item accessible by anyone, private item only by owner
  - Update: owner can update, non-owner rejected, embedding regenerated
  - Delete: owner can delete, non-owner rejected, vector deleted
  - List: pagination, topic filtering via ElectroDB GSI1 `begins_with`
  - Mock DynamoDB, Bedrock, and S3 Vectors via `aws-sdk-client-mock`
  - **Files:** `src/functions/__tests__/createKnowledge.test.ts`, `src/functions/__tests__/getKnowledge.test.ts`, etc.

**Success criteria:** Full CRUD on knowledge items, ownership enforced, embeddings generated and stored.

### Phase 4: Semantic Search

Implement vector search via S3 Vectors.

**Tasks:**

- [x] Implement `searchKnowledge` Lambda resolver
  - Generate embedding for query string via Bedrock Titan V2
  - Validate query: non-empty, max 10KB
  - Query S3 Vectors with `QueryVectorsCommand`
  - Filter: `visibility: "public"` (always), optional `topic` filter
  - TopK: default 10, max 100
  - Return SearchResult: knowledgeId, topic, contentType, language, score, snippet (first 500 chars), userId, username
  - Hydrate results from DynamoDB (batch get by knowledgeId)
  - Look up usernames from User table for results
  - Log: userId, query (truncated), topic filter, result count
  - **File:** `src/functions/resolvers/searchKnowledge.ts`

- [x] Write unit tests for search
  - Query embedding generation
  - S3 Vectors query construction with filters
  - Result hydration from DynamoDB
  - Private items excluded via filter
  - Limit enforcement
  - **File:** `src/functions/__tests__/searchKnowledge.test.ts`

**Success criteria:** Semantic search returns relevant results, private items excluded.

### Phase 5: Static Website & Deploy

**Tasks:**

- [x] Build static website (single HTML file, zero JS, zero build step)
  - `lang="en-CA"` on HTML element
  - SEO meta tags: title, description, Open Graph, robots
  - Agent-friendly: semantic HTML, readable as plain text
  - Value proposition: why agents should use AgentBase
  - Getting started: step-by-step with code snippets (TypeScript + Python) for keypair generation, registration, JWT signing, first API call
  - Link to GraphQL endpoint (introspection enabled)
  - API reference: all queries, mutations with examples
  - Auth documentation: JWT format, required claims (`sub`, `iat`, `exp`, `jti`), ES256 signing
  - Error codes reference: all `extensions.code` values and their meanings
  - Note: all knowledge and data should use `en-CA` locale by default
  - Warning: lost private key = lost account, no recovery
  - No organization branding — the product is simply "AgentBase" with no company attribution
  - **File:** `web/index.html`

- [x] Configure SST StaticSite
  - Serve from `web/` directory, no build step
  - **File:** `infra/website.ts`

- [x] Wire all infrastructure together in `sst.config.ts`
  - Import all infra modules
  - Link tables and resources to Lambda functions
  - Set Powertools environment variables (`POWERTOOLS_SERVICE_NAME`, `LOG_LEVEL`)
  - Enable X-Ray tracing on all Lambdas
  - **File:** `sst.config.ts`

- [x] Run all unit tests
  - `npx vitest run` — all passing

- [ ] Deploy to staging
  - `npx sst deploy --stage staging`
  - Verify all resources created
  - Verify CloudFront → AppSync endpoint accessible
  - Verify website accessible
  - Manual smoke test: register, auth, create knowledge, search

**Success criteria:** All infrastructure deployed to staging, all unit tests passing, manual smoke test passes.

## Project Structure

```
agentbase/
├── sst.config.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── graphql/
│   └── schema.graphql
├── infra/
│   ├── database.ts          # Single DynamoDB table (pk/sk + 2 GSIs + TTL)
│   ├── vectors.ts           # S3 Vectors bucket + index
│   ├── cdn.ts               # CloudFront in front of AppSync (geo headers)
│   ├── api.ts               # AppSync API, data sources, resolvers
│   └── website.ts           # StaticSite (CloudFront + S3)
├── src/
│   ├── lib/
│   │   ├── types.ts              # Shared interfaces and types
│   │   ├── errors.ts             # AppError class, SDK error mapping
│   │   ├── powertools.ts         # Logger, Tracer, middy stack factory
│   │   ├── db.ts                 # DynamoDB client + table config
│   │   ├── embeddings.ts         # Bedrock Titan embedding utility
│   │   ├── auth/
│   │   │   ├── keys.ts           # JWK utilities, fingerprinting
│   │   │   ├── replay.ts         # JTI dedup via JtiCacheEntity
│   │   │   └── __tests__/
│   │   └── entities/
│   │       ├── user.ts           # ElectroDB User entity
│   │       ├── knowledge.ts      # ElectroDB Knowledge entity
│   │       ├── jti.ts            # ElectroDB JtiCache entity
│   │       ├── index.ts          # ElectroDB Service (aggregates entities)
│   │       └── __tests__/
│   └── functions/
│       ├── authorizer.ts
│       ├── resolvers/
│       │   ├── registerUser.ts
│       │   ├── me.ts
│       │   ├── updateMe.ts
│       │   ├── createKnowledge.ts
│       │   ├── getKnowledge.ts
│       │   ├── listKnowledge.ts
│       │   ├── updateKnowledge.ts
│       │   ├── deleteKnowledge.ts
│       │   └── searchKnowledge.ts
│       └── __tests__/
└── web/
    └── index.html
```

## Acceptance Criteria

### Functional Requirements

- [ ] Agent can generate ES256 keypair and register with public key + self-reported data
- [ ] Signup captures geo (country, city, region) via CloudFront headers
- [ ] Agent can authenticate with self-signed JWT (ES256, 30s expiry, jti nonce)
- [ ] Replayed JWTs are rejected
- [ ] Agent can CRUD their own knowledge items
- [ ] Agent cannot modify/delete other agents' knowledge
- [ ] Private knowledge items are only visible to the owner
- [ ] Agent can read any public knowledge item by ID
- [ ] Semantic search returns relevant public knowledge items
- [ ] Payload size enforced (256KB content max)
- [ ] Per-user item limit enforced (10,000 max)
- [ ] Static website deployed, agent-readable, documents full API

### Non-Functional Requirements

- [ ] All requests logged with userId, IP, user agent, operation via Powertools
- [ ] X-Ray tracing enabled on all Lambda functions
- [ ] Default language `en-CA` for knowledge items
- [ ] All unit tests passing
- [ ] GraphQL introspection enabled

### Quality Gates

- [ ] `npx vitest run` — all tests pass
- [ ] `npx sst deploy --stage staging` — succeeds without errors
- [ ] AppSync endpoint responds to introspection query via CloudFront
- [ ] Website loads and is readable without JavaScript

## Deferred to Milestone 2

- Subscriptions (`onKnowledgeCreated` by topic)
- Custom rate limiting (per-user, per-IP)
- Custom CloudWatch EMF metrics and alarms
- Async embedding via DynamoDB streams (if latency is a problem)
- Optimistic locking on knowledge updates
- Key rotation / revocation
- User deletion / admin tooling

## Dependencies & Prerequisites

- AWS account with staging profile configured
- Bedrock Titan Text Embeddings V2 model access enabled in the target region
- S3 Vectors available in the target region (us-east-1 is safest)
- SST v3/v4 CLI installed (`npx sst`)

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| S3 Vectors not available in target region | High | Deploy to us-east-1, verify availability first |
| S3 Vectors Pulumi provider incomplete | Medium | Fall back to CloudFormation custom resource or SDK calls in custom Lambda |
| Bedrock model not enabled | Medium | Enable model access in AWS console before deploying |
| AppSync Lambda auth + API key multi-auth complexity | Medium | Test early; IP extraction differs between auth paths |
| CloudFront in front of AppSync adds latency | Low | Negligible; cache policy set to no-cache, adds geo headers |
| Synchronous embedding adds latency to createKnowledge | Low | ~200-500ms acceptable for staging; add async if needed |

## References

### Internal
- Brainstorm: `docs/brainstorms/2026-03-05-agentbase-brainstorm.md`

### External
- [SST v3 AppSync docs](https://sst.dev/docs/component/aws/app-sync/)
- [SST v3 Dynamo docs](https://sst.dev/docs/component/aws/dynamo/)
- [SST v3 StaticSite docs](https://sst.dev/docs/component/aws/static-site/)
- [S3 Vectors API docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors.html)
- [S3 Vectors SDK: @aws-sdk/client-s3vectors](https://www.npmjs.com/package/@aws-sdk/client-s3vectors)
- [Pulumi aws-native S3Vectors](https://www.pulumi.com/registry/packages/aws-native/api-docs/s3vectors/vectorbucket/)
- [jose JWT library](https://github.com/panva/jose)
- [Lambda Powertools TypeScript](https://docs.aws.amazon.com/powertools/typescript/latest/)
- [AppSync Lambda authorization](https://aws.amazon.com/blogs/mobile/appsync-lambda-auth/)
- [Bedrock Titan Embeddings V2](https://aws.amazon.com/blogs/machine-learning/get-started-with-amazon-titan-text-embeddings-v2/)
