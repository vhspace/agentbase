import type { AppSyncResolverEvent, AppSyncIdentityLambda } from "aws-lambda";
import { ulid } from "ulidx";
import { logger, metrics, MetricUnit, withMetrics } from "../../lib/powertools.js";
import { KnowledgeEntity } from "../../lib/entities/knowledge.js";
import { storeEmbedding } from "../../lib/embeddings.js";
import { AppError } from "../../lib/errors.js";
import type { CreateKnowledgeInput } from "../../lib/types.js";
import {
  ANONYMOUS_USER_ID,
  ANONYMOUS_STORE_LIMIT_PER_HOUR,
  CLIENT_IP_HEADER,
  CLIENT_UA_HEADER,
} from "../../lib/anonymous.js";
import { consumeRateLimit } from "../../lib/ratelimit.js";

const TOPIC_RE = /^[a-z0-9][a-z0-9.\-]{0,126}[a-z0-9]$/;
const MAX_CONTENT_SIZE = 256 * 1024; // 256KB
const MAX_ITEMS_PER_USER = 10_000;

async function resolve(
  event: AppSyncResolverEvent<{ input: CreateKnowledgeInput }>,
) {
  const identity = event.identity as AppSyncIdentityLambda | null;
  const authedUserId = identity?.resolverContext?.userId;
  const anonymous = !authedUserId;
  const userId = authedUserId ?? ANONYMOUS_USER_ID;

  const { input } = event.arguments;
  const { topic, contentType, content } = input;
  const language = input.language ?? "en-CA";
  const visibility = input.visibility ?? "public";

  // Anonymous writes: nobody can ever read a private anonymous item, and the
  // only brake on abuse is a per-address rate limit.
  const headers = event.request?.headers ?? {};
  const sourceIp = headers[CLIENT_IP_HEADER]?.split(",")[0]?.trim() || undefined;
  const sourceUserAgent = headers[CLIENT_UA_HEADER] || undefined;
  if (anonymous) {
    if (visibility === "private") {
      throw new AppError(
        "VALIDATION_ERROR",
        "Anonymous items are always public. Connect with an account to store private items.",
      );
    }
    const rl = await consumeRateLimit(
      `anon-store:${sourceIp ?? "unknown"}`,
      ANONYMOUS_STORE_LIMIT_PER_HOUR,
      3600,
    );
    if (!rl.allowed) {
      metrics.addMetric("AnonymousStoreRateLimited", MetricUnit.Count, 1);
      throw new AppError(
        "RATE_LIMITED",
        `Anonymous stores are limited to ${rl.limit} per hour per address; try again in ${rl.resetInSeconds}s or connect with an account.`,
      );
    }
  }

  // Validate topic
  if (!TOPIC_RE.test(topic)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Topic must be 2-128 chars, lowercase alphanumeric, dots, and hyphens",
    );
  }

  // Validate content size
  const contentStr = JSON.stringify(content);
  if (Buffer.byteLength(contentStr, "utf8") > MAX_CONTENT_SIZE) {
    throw new AppError("PAYLOAD_TOO_LARGE", "Content exceeds 256KB limit");
  }

  // Check per-user item limit. The anonymous pool is shared, so the cap
  // makes no sense there; the rate limit above is its brake.
  if (!anonymous) {
    const { data: existing } = await KnowledgeEntity.query
      .byUserAndTopic({ userId })
      .go({ limit: MAX_ITEMS_PER_USER, attributes: ["knowledgeId"] });
    if (existing.length >= MAX_ITEMS_PER_USER) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Maximum ${MAX_ITEMS_PER_USER} knowledge items per user`,
      );
    }
  }

  const now = new Date().toISOString();
  const knowledgeId = ulid();

  const item = {
    knowledgeId,
    userId,
    topic,
    contentType,
    content,
    language,
    visibility,
    createdAt: now,
    updatedAt: now,
    ...(anonymous ? { sourceIp, sourceUserAgent } : {}),
  };

  await KnowledgeEntity.create(item).go();

  // Generate and store embedding
  await storeEmbedding(knowledgeId, content, contentType, {
    knowledgeId,
    userId,
    topic,
    contentType,
    language,
    visibility,
  });

  metrics.addMetric("KnowledgeCreate", MetricUnit.Count, 1);

  logger.info("Knowledge created", {
    userId,
    anonymous,
    knowledgeId,
    topic,
    contentType,
  });

  return item;
}

export const handler = withMetrics(resolve);
