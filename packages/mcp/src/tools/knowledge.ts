import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JWK } from "jose";
import * as z from "zod/v4";
import { gql } from "../client.js";

export function registerKnowledgeTools(
  server: McpServer,
  keys: { privateKey: JWK; publicKey: JWK },
): void {
  const { privateKey, publicKey } = keys;

  server.registerTool(
    "agentbase_store_knowledge",
    {
      title: "Store Knowledge",
      description:
        "Store a knowledge item. Content is automatically embedded for semantic search.",
      inputSchema: z.object({
        topic: z
          .string()
          .regex(/^[a-z0-9][a-z0-9.\-]{0,126}[a-z0-9]$/)
          .describe(
            "Topic category (2-128 chars, lowercase alphanumeric, dots, hyphens)",
          ),
        content: z.string().describe("The knowledge content as a JSON string"),
        contentType: z
          .string()
          .default("application/json")
          .describe("MIME content type (default: application/json)"),
        language: z
          .string()
          .default("en-CA")
          .describe("BCP 47 language tag (default: en-CA)"),
        visibility: z
          .enum(["public", "private"])
          .default("public")
          .describe("Who can see this item (default: public)"),
      }),
    },
    async ({ topic, content, contentType, language, visibility }) => {
      try {
        const res = await gql(
          privateKey,
          publicKey,
          `mutation($input: CreateKnowledgeInput!) {
            createKnowledge(input: $input) {
              knowledgeId topic contentType visibility createdAt
            }
          }`,
          { input: { topic, content, contentType, language, visibility } },
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

        const k = res.data!.createKnowledge as Record<string, string>;
        return {
          content: [
            {
              type: "text" as const,
              text: `Stored knowledge item ${k.knowledgeId} (topic: ${k.topic}, visibility: ${k.visibility})`,
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

  server.registerTool(
    "agentbase_get_knowledge",
    {
      title: "Get Knowledge",
      description:
        "Get a knowledge item by ID. Returns public items for anyone, or your own private items.",
      inputSchema: z.object({
        id: z.string().describe("Knowledge item ID"),
      }),
    },
    async ({ id }) => {
      try {
        const res = await gql(
          privateKey,
          publicKey,
          `query($id: ID!) {
            getKnowledge(id: $id) {
              knowledgeId userId topic contentType content language visibility createdAt updatedAt
            }
          }`,
          { id },
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

        if (!res.data!.getKnowledge) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Knowledge item not found. Use agentbase_list_knowledge to see your items.",
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(res.data!.getKnowledge, null, 2),
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

  server.registerTool(
    "agentbase_list_knowledge",
    {
      title: "List Knowledge",
      description:
        "List your knowledge items, optionally filtered by topic prefix.",
      inputSchema: z.object({
        topic: z
          .string()
          .optional()
          .describe("Filter by topic prefix (begins_with matching)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Max items to return (1-100, default 20)"),
        nextToken: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous response"),
      }),
    },
    async ({ topic, limit, nextToken }) => {
      try {
        const res = await gql(
          privateKey,
          publicKey,
          `query($topic: String, $limit: Int, $nextToken: String) {
            listKnowledge(topic: $topic, limit: $limit, nextToken: $nextToken) {
              items {
                knowledgeId topic contentType content visibility createdAt updatedAt
              }
              nextToken
            }
          }`,
          { topic, limit, nextToken },
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

        const conn = res.data!.listKnowledge as {
          items: unknown[];
          nextToken?: string;
        };
        let text = `Found ${conn.items.length} item(s).\n\n${JSON.stringify(conn.items, null, 2)}`;
        if (conn.nextToken) {
          text += `\n\nMore items available. Pass nextToken: "${conn.nextToken}" to get the next page.`;
        }

        return { content: [{ type: "text" as const, text }] };
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

  server.registerTool(
    "agentbase_update_knowledge",
    {
      title: "Update Knowledge",
      description: "Update a knowledge item you own.",
      inputSchema: z.object({
        id: z.string().describe("Knowledge item ID"),
        topic: z
          .string()
          .regex(/^[a-z0-9][a-z0-9.\-]{0,126}[a-z0-9]$/)
          .optional()
          .describe("New topic"),
        content: z.string().optional().describe("New content as a JSON string"),
        contentType: z.string().optional().describe("New MIME content type"),
        language: z.string().optional().describe("New BCP 47 language tag"),
        visibility: z
          .enum(["public", "private"])
          .optional()
          .describe("New visibility"),
      }),
    },
    async ({ id, topic, content, contentType, language, visibility }) => {
      try {
        const input: Record<string, string> = {};
        if (topic !== undefined) input.topic = topic;
        if (content !== undefined) input.content = content;
        if (contentType !== undefined) input.contentType = contentType;
        if (language !== undefined) input.language = language;
        if (visibility !== undefined) input.visibility = visibility;

        const res = await gql(
          privateKey,
          publicKey,
          `mutation($id: ID!, $input: UpdateKnowledgeInput!) {
            updateKnowledge(id: $id, input: $input) {
              knowledgeId topic contentType visibility updatedAt
            }
          }`,
          { id, input },
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

        const k = res.data!.updateKnowledge as Record<string, string>;
        return {
          content: [
            {
              type: "text" as const,
              text: `Updated knowledge item ${k.knowledgeId} (topic: ${k.topic})`,
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

  server.registerTool(
    "agentbase_delete_knowledge",
    {
      title: "Delete Knowledge",
      description:
        "Delete a knowledge item you own. Removes the item and its vector embedding.",
      inputSchema: z.object({
        id: z.string().describe("Knowledge item ID"),
      }),
    },
    async ({ id }) => {
      try {
        const res = await gql(
          privateKey,
          publicKey,
          `mutation($id: ID!) { deleteKnowledge(id: $id) }`,
          { id },
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

        return {
          content: [
            { type: "text" as const, text: `Deleted knowledge item ${id}.` },
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
