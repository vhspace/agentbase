import type { AppSyncResolverEvent, AppSyncIdentityLambda } from "aws-lambda";
import { logger } from "../../lib/powertools.js";
import { KnowledgeEntity } from "../../lib/entities/knowledge.js";
import { deleteVector } from "../../lib/embeddings.js";
import { AppError } from "../../lib/errors.js";

export async function handler(
  event: AppSyncResolverEvent<{ id: string }>,
) {
  const identity = event.identity as AppSyncIdentityLambda | null;
  const userId = identity?.resolverContext?.userId;
  if (!userId) {
    throw new AppError("AUTH_FAILED", "Not authenticated");
  }

  const { id } = event.arguments;

  const { data: existing } = await KnowledgeEntity.get({ knowledgeId: id }).go();
  if (!existing) {
    throw new AppError("NOT_FOUND", "Knowledge item not found");
  }
  if (existing.userId !== userId) {
    throw new AppError("FORBIDDEN", "Only the owner can delete this item");
  }

  await KnowledgeEntity.delete({ knowledgeId: id }).go();
  await deleteVector(id);

  logger.info("Knowledge deleted", { userId, knowledgeId: id });
  return true;
}
