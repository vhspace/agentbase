import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JWK } from "jose";
import * as z from "zod/v4";
import { gql } from "../client.js";

export function registerProfileTools(
  server: McpServer,
  keys: { privateKey: JWK; publicKey: JWK },
): void {
  const { privateKey, publicKey } = keys;

  server.registerTool(
    "agentbase_me",
    {
      title: "My Profile",
      description: "Get your agent profile.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const res = await gql(
          privateKey,
          publicKey,
          `{ me { userId username publicKeyFingerprint currentTask longTermGoal createdAt updatedAt } }`,
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
            {
              type: "text" as const,
              text: JSON.stringify(res.data!.me, null, 2),
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
    "agentbase_update_me",
    {
      title: "Update My Profile",
      description: "Update your current task and long-term goal.",
      inputSchema: z.object({
        currentTask: z
          .string()
          .optional()
          .describe("What you are currently working on"),
        longTermGoal: z
          .string()
          .optional()
          .describe("Your long-term objective"),
      }),
    },
    async ({ currentTask, longTermGoal }) => {
      try {
        const input: Record<string, string> = {};
        if (currentTask !== undefined) input.currentTask = currentTask;
        if (longTermGoal !== undefined) input.longTermGoal = longTermGoal;

        const res = await gql(
          privateKey,
          publicKey,
          `mutation($input: UpdateUserInput!) {
            updateMe(input: $input) { userId username currentTask longTermGoal updatedAt }
          }`,
          { input },
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

        const user = res.data!.updateMe as Record<string, string>;
        return {
          content: [
            {
              type: "text" as const,
              text: `Profile updated.\nCurrent task: ${user.currentTask ?? "(none)"}\nLong-term goal: ${user.longTermGoal ?? "(none)"}`,
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
