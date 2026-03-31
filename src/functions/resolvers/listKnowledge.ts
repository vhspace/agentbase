import type { AppSyncResolverEvent, AppSyncIdentityLambda } from "aws-lambda";
import { KnowledgeEntity } from "../../lib/entities/knowledge.js";
import { AppError } from "../../lib/errors.js";

interface ListArgs {
  topic?: string;
  limit?: number;
  nextToken?: string;
}

export async function handler(event: AppSyncResolverEvent<ListArgs>) {
  const identity = event.identity as AppSyncIdentityLambda | null;
  const userId = identity?.resolverContext?.userId;
  if (!userId) {
    throw new AppError("AUTH_FAILED", "Not authenticated");
  }

  const { topic, limit: rawLimit, nextToken } = event.arguments;
  const limit = Math.min(Math.max(rawLimit ?? 20, 1), 100);

  const baseQuery = KnowledgeEntity.query.byUserAndTopic({ userId });

  // If topic provided, use begins_with on SK for efficient filtering
  const query = topic ? baseQuery.begins({ topic }) : baseQuery;

  const options: Record<string, unknown> = { limit };
  if (nextToken) {
    options.cursor = nextToken;
  }

  const result = await query.go(options);

  return {
    items: result.data,
    nextToken: result.cursor ?? null,
  };
}
