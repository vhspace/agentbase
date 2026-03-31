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
    ...($app.stage === "prd" ? { MCP_URL: "https://mcp.agentbase.tools/mcp" } : {}),
  },
});

// CloudFront distribution in front of the MCP Lambda URL for custom domain support
// mcp.agentbase.tools → Lambda Function URL
const ACM_CERT_ARN = "arn:aws:acm:us-east-1:070638634478:certificate/77e38f2d-8d3b-42e2-a4bc-91b1efd34aeb";
const MCP_DOMAIN = "mcp.agentbase.tools";

const mcpOriginHostname = mcpFn.url.apply((url: string) => new URL(url).hostname);

// AWS managed policies
const cachingDisabledPolicyId = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const allViewerExceptHostPolicyId = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

export const mcpCdn: aws.cloudfront.Distribution = new aws.cloudfront.Distribution("McpCdn", {
  enabled: true,
  comment: `AgentBase MCP CDN (${$app.stage})`,
  aliases: $app.stage === "prd" ? [MCP_DOMAIN] : undefined,
  defaultCacheBehavior: {
    allowedMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
    cachedMethods: ["GET", "HEAD"],
    targetOriginId: "mcp-lambda",
    viewerProtocolPolicy: "redirect-to-https",
    cachePolicyId: cachingDisabledPolicyId,
    originRequestPolicyId: allViewerExceptHostPolicyId,
    compress: true,
  },
  origins: [
    {
      domainName: mcpOriginHostname,
      originId: "mcp-lambda",
      customOriginConfig: {
        httpPort: 80,
        httpsPort: 443,
        originProtocolPolicy: "https-only",
        originSslProtocols: ["TLSv1.2"],
      },
    },
  ],
  restrictions: {
    geoRestriction: { restrictionType: "none" },
  },
  viewerCertificate: $app.stage === "prd"
    ? {
        acmCertificateArn: ACM_CERT_ARN,
        sslSupportMethod: "sni-only",
        minimumProtocolVersion: "TLSv1.2_2021",
      }
    : { cloudfrontDefaultCertificate: true },
});
