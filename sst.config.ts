/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "agentbase",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: input?.stage === "production",
      home: "aws",
      providers: {
        aws: {
          profile: input?.stage === "production" ? "production" : "staging",
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
    const { api, apiKey } = await import("./infra/api");
    const { cdn } = await import("./infra/cdn");
    const { site } = await import("./infra/website");

    return {
      apiUrl: api.url,
      cdnUrl: cdn.domainUrl,
      siteUrl: site.url,
      tableName: table.name,
    };
  },
});
