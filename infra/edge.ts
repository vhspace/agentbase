// Lambda@Edge function that puts WWW-Authenticate back on responses from the
// Lambda function URL origins. See src/functions/edgeRestoreWwwAuthenticate.cjs.
// Lambda@Edge functions must live in us-east-1 and be a published version.

const edgeRole = new aws.iam.Role("EdgeHeaderRole", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"] },
        Action: "sts:AssumeRole",
      },
    ],
  }),
  managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
});

export const edgeHeaderFn = new aws.lambda.Function("EdgeRestoreWwwAuthenticate", {
  role: edgeRole.arn,
  runtime: "nodejs22.x",
  handler: "index.handler",
  memorySize: 128,
  timeout: 5,
  publish: true,
  code: new $util.asset.AssetArchive({
    "index.js": new $util.asset.FileAsset(`${$cli.paths.root}/src/functions/edgeRestoreWwwAuthenticate.cjs`),
  }),
});

export const edgeHeaderAssociation = {
  eventType: "origin-response",
  lambdaArn: edgeHeaderFn.qualifiedArn,
  includeBody: false,
};
