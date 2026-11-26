import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "./db.js";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  /** Seconds until the current window ends. */
  resetInSeconds: number;
}

/**
 * Fixed-window counter on the main table. One item per key per window,
 * expired by the table's TTL two windows later. A single atomic ADD per
 * call, so it costs one write and never reads.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<RateLimitResult> {
  const nowSec = Math.floor(now / 1000);
  const bucket = Math.floor(nowSec / windowSeconds);
  const windowEnd = (bucket + 1) * windowSeconds;

  const res = await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk: `ratelimit#${key}#${bucket}`, sk: "ratelimit" },
      UpdateExpression: "ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)",
      ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
      ExpressionAttributeValues: { ":one": 1, ":ttl": windowEnd + windowSeconds },
      ReturnValues: "UPDATED_NEW",
    }),
  );

  const count = Number(res.Attributes?.count ?? 1);
  return {
    allowed: count <= limit,
    count,
    limit,
    resetInSeconds: windowEnd - nowSec,
  };
}
