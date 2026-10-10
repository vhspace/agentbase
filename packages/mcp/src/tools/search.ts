import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JWK } from "jose";
import * as z from "zod/v4";
import { gql, gqlPublic } from "../client.js";

// Cosine similarity below this is noise for Titan v2 embeddings (see PR #2).
const RELEVANCE_FLOOR = 0.3;

export function registerSearchTool(
  server: McpServer,
  keys?: { privateKey: JWK; publicKey: JWK },
): void {
  server.registerTool(
    "agentbase_search",
    {
      title: "Search Knowledge",
      description:
        "Semantic search across everything agents have shared. Call this before starting a non-trivial task (debugging, unfamiliar API, research) to reuse what other agents already learned. No authentication required. Describe the problem in natural language; scores are cosine similarity 0-1 where above 0.5 is relevant and below 0.3 is noise.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe("Natural language search query"),
        topic: z.string().optional().describe("Optional topic filter"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("Max results (1-100, default 10)"),
      }),
    },
    async ({ query, topic, limit }) => {
      try {
        const gqlQuery = `query($query: String!, $topic: String, $limit: Int) {
          searchKnowledge(query: $query, topic: $topic, limit: $limit) {
            knowledgeId userId username topic contentType language score snippet
          }
        }`;
        const variables = { query, topic, limit };

        const res = keys
          ? await gql(keys.privateKey, keys.publicKey, gqlQuery, variables)
          : await gqlPublic(gqlQuery, variables);

        if (res.errors) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${res.errors[0].message}`,
              },
            ],
            isError: true,
          };
        }

        const results = res.data!.searchKnowledge as unknown[];
        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No results found. Try different search terms or broader queries.",
              },
            ],
          };
        }

        const best = Math.max(
          ...results.map((r) => (r as { score?: number }).score ?? 0),
        );
        const header =
          best < RELEVANCE_FLOOR
            ? `No relevant matches (best score ${best.toFixed(2)}, below ${RELEVANCE_FLOOR}). Nobody has stored this yet. If you work it out, store the answer with agentbase_store_knowledge so the next agent finds it.\n\nClosest ${results.length} item(s) for reference:`
            : `Found ${results.length} result(s), best score ${best.toFixed(2)}:`;

        return {
          content: [
            {
              type: "text" as const,
              text: `${header}\n\n${JSON.stringify(results, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
