import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JWK } from "jose";
import * as z from "zod/v4";
import { gql } from "../client.js";

export function registerSearchTool(
  server: McpServer,
  keys: { privateKey: JWK; publicKey: JWK },
): void {
  const { privateKey, publicKey } = keys;

  server.registerTool(
    "agentbase_search",
    {
      title: "Search Knowledge",
      description:
        "Semantic search across all public knowledge using natural language.",
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
        const res = await gql(
          privateKey,
          publicKey,
          `query($query: String!, $topic: String, $limit: Int) {
            searchKnowledge(query: $query, topic: $topic, limit: $limit) {
              knowledgeId userId username topic contentType language score snippet
            }
          }`,
          { query, topic, limit },
        );

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

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${results.length} result(s):\n\n${JSON.stringify(results, null, 2)}`,
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
