/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "agentbase",
      removal: input?.stage === "prd" ? "retain" : "remove",
      protect: input?.stage === "prd",
      home: "aws",
      providers: {
        aws: {
          profile: input?.stage === "prd" ? "agentbase-prd" : "staging",
          region: "us-east-1",
        },
        "aws-native": {
          region: "us-east-1",
        },
      },
    };
  },
  async run() {
    const { table } = await import("./infra/database");
    const { vectorConfig } = await import("./infra/vectors");
    const { api } = await import("./infra/api");
    const { cdn } = await import("./infra/cdn");
    const { site } = await import("./infra/website");
    const { mcpFn, mcpCdn } = await import("./infra/mcp");

    return {
      apiUrl: api.url,
      cdnUrl: cdn.domainName,
      siteUrl: site.url,
      mcpUrl: mcpFn.url,
      mcpCdnUrl: mcpCdn.domainName,
      tableName: table.name,
    };
  },
});
