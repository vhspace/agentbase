import type { AppSyncResolverEvent, AppSyncIdentityLambda } from "aws-lambda";
import { logger } from "../../lib/powertools.js";
import { KnowledgeEntity } from "../../lib/entities/knowledge.js";
import { storeEmbedding } from "../../lib/embeddings.js";
import { AppError } from "../../lib/errors.js";
import type { UpdateKnowledgeInput } from "../../lib/types.js";

const TOPIC_RE = /^[a-z0-9][a-z0-9.\-]{0,126}[a-z0-9]$/;
const MAX_CONTENT_SIZE = 256 * 1024;

export async function handler(
  event: AppSyncResolverEvent<{ id: string; input: UpdateKnowledgeInput }>,
) {
  const identity = event.identity as AppSyncIdentityLambda | null;
  const userId = identity?.resolverContext?.userId;
  if (!userId) {
    throw new AppError("AUTH_FAILED", "Not authenticated");
  }

  const { id, input } = event.arguments;

  // Fetch existing item to check ownership
  const { data: existing } = await KnowledgeEntity.get({ knowledgeId: id }).go();
  if (!existing) {
    throw new AppError("NOT_FOUND", "Knowledge item not found");
  }
  if (existing.userId !== userId) {
    throw new AppError("FORBIDDEN", "Only the owner can update this item");
  }

  // Validate topic if provided
  if (input.topic && !TOPIC_RE.test(input.topic)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Topic must be 2-128 chars, lowercase alphanumeric, dots, and hyphens",
    );
  }

  // Validate content size if provided
  if (input.content !== undefined) {
    const contentStr = JSON.stringify(input.content);
    if (Buffer.byteLength(contentStr, "utf8") > MAX_CONTENT_SIZE) {
      throw new AppError("PAYLOAD_TOO_LARGE", "Content exceeds 256KB limit");
    }
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (input.topic !== undefined) updates.topic = input.topic;
  if (input.contentType !== undefined) updates.contentType = input.contentType;
  if (input.content !== undefined) updates.content = input.content;
  if (input.language !== undefined) updates.language = input.language;
  if (input.visibility !== undefined) updates.visibility = input.visibility;

  const { data: updated } = await KnowledgeEntity.patch({ knowledgeId: id })
    .set(updates)
    .composite({ createdAt: existing.createdAt })
    .go({ response: "all_new" });

  // Re-generate embedding if content changed
  if (input.content !== undefined || input.contentType !== undefined) {
    const content = updated.content ?? existing.content;
    const contentType = updated.contentType ?? existing.contentType;
    await storeEmbedding(id, content, contentType, {
      knowledgeId: id,
      userId,
      topic: updated.topic ?? existing.topic,
      contentType,
      language: updated.language ?? existing.language,
      visibility: updated.visibility ?? existing.visibility,
    });
  }

  logger.info("Knowledge updated", { userId, knowledgeId: id });
  return updated;
}
