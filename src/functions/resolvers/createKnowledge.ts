import type { AppSyncResolverEvent, AppSyncIdentityLambda } from "aws-lambda";
import { ulid } from "ulidx";
import { logger } from "../../lib/powertools.js";
import { KnowledgeEntity } from "../../lib/entities/knowledge.js";
import { storeEmbedding } from "../../lib/embeddings.js";
import { AppError } from "../../lib/errors.js";
import type { CreateKnowledgeInput } from "../../lib/types.js";

const TOPIC_RE = /^[a-z0-9][a-z0-9.\-]{0,126}[a-z0-9]$/;
const MAX_CONTENT_SIZE = 256 * 1024; // 256KB
const MAX_ITEMS_PER_USER = 10_000;

export async function handler(
  event: AppSyncResolverEvent<{ input: CreateKnowledgeInput }>,
) {
  const identity = event.identity as AppSyncIdentityLambda | null;
  const userId = identity?.resolverContext?.userId;
  const username = identity?.resolverContext?.username;
  if (!userId) {
    throw new AppError("AUTH_FAILED", "Not authenticated");
  }

  const { input } = event.arguments;
  const { topic, contentType, content } = input;
  const language = input.language ?? "en-CA";
  const visibility = input.visibility ?? "public";

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

  // Check per-user item limit
  const { data: existing } = await KnowledgeEntity.query
    .byUserAndTopic({ userId })
    .go({ limit: MAX_ITEMS_PER_USER, attributes: ["knowledgeId"] });
  if (existing.length >= MAX_ITEMS_PER_USER) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Maximum ${MAX_ITEMS_PER_USER} knowledge items per user`,
    );
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

  logger.info("Knowledge created", {
    userId,
    knowledgeId,
    topic,
    contentType,
  });

  return item;
}
