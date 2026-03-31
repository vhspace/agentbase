import type { AppSyncResolverEvent, AppSyncIdentityLambda } from "aws-lambda";
import { KnowledgeEntity } from "../../lib/entities/knowledge.js";
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
  const { data: item } = await KnowledgeEntity.get({ knowledgeId: id }).go();

  if (!item) {
    throw new AppError("NOT_FOUND", "Knowledge item not found");
  }

  // Private items only accessible by owner
  if (item.visibility === "private" && item.userId !== userId) {
    throw new AppError("FORBIDDEN", "Access denied to private knowledge item");
  }

  return item;
}
