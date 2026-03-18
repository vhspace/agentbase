import { api } from "./api";

export const mcpFn = new sst.aws.Function("McpServer", {
  handler: "packages/mcp/src/handler.handler",
  url: true,
  timeout: "30 seconds",
  memory: "256 MB",
  nodejs: {
    install: [
      "@modelcontextprotocol/sdk",
      "jose",
      "zod",
    ],
  },
  logging: {
    retention: "forever",
  },
  environment: {
    GRAPHQL_ENDPOINT: api.url,
  },
});
