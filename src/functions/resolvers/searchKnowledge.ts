import type { AppSyncResolverEvent, AppSyncIdentityLambda } from "aws-lambda";
import { logger, metrics, MetricUnit } from "../../lib/powertools.js";
import { KnowledgeEntity } from "../../lib/entities/knowledge.js";
import { UserEntity } from "../../lib/entities/user.js";
import { queryVectors } from "../../lib/embeddings.js";
import { AppError } from "../../lib/errors.js";
import type { SearchResult } from "../../lib/types.js";

const MAX_QUERY_SIZE = 10 * 1024; // 10KB

interface SearchArgs {
  query: string;
  topic?: string;
  limit?: number;
}

export async function handler(
  event: AppSyncResolverEvent<SearchArgs>,
): Promise<SearchResult[]> {
  const identity = event.identity as AppSyncIdentityLambda | null;
  const userId = identity?.resolverContext?.userId;
  if (!userId) {
    throw new AppError("AUTH_FAILED", "Not authenticated");
  }

  const { query, topic, limit: rawLimit } = event.arguments;
  const limit = Math.min(Math.max(rawLimit ?? 10, 1), 100);

  if (!query || query.trim().length === 0) {
    throw new AppError("VALIDATION_ERROR", "Query cannot be empty");
  }
  if (Buffer.byteLength(query, "utf8") > MAX_QUERY_SIZE) {
    throw new AppError("PAYLOAD_TOO_LARGE", "Query exceeds 10KB limit");
  }

  // Build filters
  const filters: Record<string, string> = {};
  if (topic) filters.topic = topic;

  // Query vectors
  const vectorResults = await queryVectors(query, filters, limit);

  if (vectorResults.length === 0) return [];

  // Hydrate from DynamoDB
  const knowledgeIds = vectorResults.map((r) => r.key);
  const scoreMap = new Map(vectorResults.map((r) => [r.key, r.score]));

  // Batch get knowledge items
  const knowledgeItems = await Promise.all(
    knowledgeIds.map((id) => KnowledgeEntity.get({ knowledgeId: id }).go()),
  );

  // Collect unique userIds for username lookup
  const userIds = new Set<string>();
  for (const { data } of knowledgeItems) {
    if (data) userIds.add(data.userId);
  }

  // Batch get users
  const userMap = new Map<string, string>();
  await Promise.all(
    [...userIds].map(async (uid) => {
      const { data: user } = await UserEntity.get({ userId: uid }).go();
      if (user) userMap.set(uid, user.username);
    }),
  );

  // Build results
  const results: SearchResult[] = [];
  for (const { data: item } of knowledgeItems) {
    if (!item) continue;
    const contentStr = JSON.stringify(item.content);
    results.push({
      knowledgeId: item.knowledgeId,
      userId: item.userId,
      username: userMap.get(item.userId) ?? "unknown",
      topic: item.topic,
      contentType: item.contentType,
      language: item.language,
      score: scoreMap.get(item.knowledgeId) ?? 0,
      snippet: contentStr.slice(0, 500),
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  metrics.addMetric("KnowledgeSearch", MetricUnit.Count, 1);
  metrics.addMetric("SearchResultCount", MetricUnit.Count, results.length);

  logger.info("Search completed", {
    userId,
    query: query.slice(0, 100),
    topic,
    resultCount: results.length,
  });

  return results;
}
