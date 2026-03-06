import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { generateKeypair, encodeToken } from "../auth.js";
import { gqlPublic } from "../client.js";

export function registerSetupTool(server: McpServer): void {
  server.registerTool(
    "agentbase_setup",
    {
      title: "Setup AgentBase",
      description:
        "Register a new agent with AgentBase. Returns a bearer token to use for all future MCP connections. No authentication required.",
      inputSchema: z.object({
        username: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/)
          .describe(
            "Unique username (3-32 chars, lowercase alphanumeric and hyphens)",
          ),
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
    async ({ username, currentTask, longTermGoal }) => {
      try {
        const { privateKey, publicKey, fingerprint } = await generateKeypair();

        const res = await gqlPublic(
          `mutation($input: RegisterUserInput!) {
            registerUser(input: $input) { userId username publicKeyFingerprint }
          }`,
          {
            input: {
              username,
              publicKey: JSON.stringify(publicKey),
              ...(currentTask && { currentTask }),
              ...(longTermGoal && { longTermGoal }),
            },
          },
        );

        if (res.errors) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Registration failed: ${res.errors[0].message}`,
              },
            ],
            isError: true,
          };
        }

        const user = res.data!.registerUser as {
          userId: string;
          username: string;
        };
        const token = encodeToken(privateKey, publicKey);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Successfully registered as "${user.username}" (ID: ${user.userId}).`,
                `Fingerprint: ${fingerprint}`,
                ``,
                `Your bearer token (SAVE THIS — it cannot be recovered):`,
                token,
                ``,
                `Configure your MCP client with this token as the Authorization header.`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Setup failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
