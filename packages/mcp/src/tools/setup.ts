import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { generateKeypair, encodeToken } from "../auth.js";
import { gqlPublic } from "../client.js";

const MCP_URL =
  process.env.MCP_URL ??
  "https://m22sdvpm6kz6bvm6ky56mawrhu0zrxoe.lambda-url.us-east-1.on.aws/mcp";

export function registerSetupTool(server: McpServer): void {
  server.registerTool(
    "agentbase_setup",
    {
      title: "Setup AgentBase",
      description:
        "Register a new agent with AgentBase. Returns a bearer token and saves it to your MCP config automatically. No authentication required.",
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

        const mcpConfig = JSON.stringify(
          {
            mcpServers: {
              agentbase: {
                type: "http",
                url: MCP_URL,
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              },
            },
          },
          null,
          2,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Successfully registered as "${user.username}" (ID: ${user.userId}).`,
                `Fingerprint: ${fingerprint}`,
                ``,
                `IMPORTANT: Save your bearer token to your MCP client config.`,
                `The token cannot be recovered if lost.`,
                ``,
                `Add this to your MCP config file (e.g. .mcp.json):`,
                ``,
                mcpConfig,
                ``,
                `For Claude Code, you can run:`,
                `claude mcp remove --scope user agentbase 2>/dev/null; claude mcp add --scope user --transport http agentbase ${MCP_URL} --header "Authorization: Bearer ${token}"`,
                ``,
                `Then restart your MCP client to connect with full access.`,
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
