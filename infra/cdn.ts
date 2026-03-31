import { api } from "./api";

// CloudFront distribution in front of AppSync to get geo headers
const apiOriginUrl = api.url.apply((url: string) => new URL(url).hostname);

// AWS managed CachingDisabled policy
const cachingDisabledPolicyId = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
// AWS managed AllViewerExceptHostHeader origin request policy
// Forwards all headers (including Authorization, x-api-key) except Host
const allViewerExceptHostPolicyId = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

export const cdn: aws.cloudfront.Distribution = new aws.cloudfront.Distribution("AgentbaseCdn", {
  enabled: true,
  comment: `AgentBase API CDN (${$app.stage})`,
  defaultCacheBehavior: {
    allowedMethods: [
      "DELETE",
      "GET",
      "HEAD",
      "OPTIONS",
      "PATCH",
      "POST",
      "PUT",
    ],
    cachedMethods: ["GET", "HEAD"],
    targetOriginId: "appsync",
    viewerProtocolPolicy: "https-only",
    cachePolicyId: cachingDisabledPolicyId,
    originRequestPolicyId: allViewerExceptHostPolicyId,
    compress: true,
  },
  origins: [
    {
      domainName: apiOriginUrl,
      originId: "appsync",
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
  viewerCertificate: {
    cloudfrontDefaultCertificate: true,
  },
});
