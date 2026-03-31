const ACM_CERT_ARN = "arn:aws:acm:us-east-1:070638634478:certificate/77e38f2d-8d3b-42e2-a4bc-91b1efd34aeb";

export const site = new sst.aws.StaticSite("AgentbaseSite", {
  path: "web",
  buildOutput: ".",
  buildCommand: "",
  domain:
    $app.stage === "prd"
      ? {
          name: "agentbase.tools",
          aliases: ["www.agentbase.tools"],
          cert: ACM_CERT_ARN,
        }
      : undefined,
});
