import { table } from "./database";
import { vectorConfig } from "./vectors";

const authorizerFn = new sst.aws.Function("Authorizer", {
  handler: "src/functions/authorizer.handler",
  link: [table],
  environment: {
    POWERTOOLS_SERVICE_NAME: "agentbase",
    LOG_LEVEL: "INFO",
    TABLE_NAME: table.name,
  },
  permissions: [
    {
      actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"],
      resources: [table.arn, $interpolate`${table.arn}/index/*`],
    },
  ],
});

export const api = new sst.aws.AppSync("AgentbaseApi", {
  schema: "graphql/schema.graphql",
  transform: {
    api(args) {
      args.authenticationType = "AWS_LAMBDA";
      args.lambdaAuthorizerConfig = {
        authorizerUri: authorizerFn.arn,
        authorizerResultTtlInSeconds: 0,
      };
      args.additionalAuthenticationProviders = [
        {
          authenticationType: "API_KEY",
        },
      ];
    },
  },
});

// Grant AppSync permission to invoke the authorizer
new aws.lambda.Permission("AuthorizerInvokePermission", {
  action: "lambda:InvokeFunction",
  function: authorizerFn.arn,
  principal: "appsync.amazonaws.com",
  sourceArn: api.arn,
});

// Generate an API key for public operations (registerUser)
export const apiKey = new aws.appsync.ApiKey("AgentbaseApiKey", {
  apiId: api.id,
});

// Shared Lambda config for resolvers
const resolverDefaults = {
  link: [table],
  environment: {
    POWERTOOLS_SERVICE_NAME: "agentbase",
    LOG_LEVEL: "INFO",
    VECTOR_BUCKET_NAME: vectorConfig.bucketName,
    VECTOR_INDEX_NAME: vectorConfig.indexName,
    TABLE_NAME: table.name,
  },
  permissions: [
    {
      actions: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:BatchGetItem",
      ],
      resources: [table.arn, $interpolate`${table.arn}/index/*`],
    },
    {
      actions: ["bedrock:InvokeModel"],
      resources: [
        "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0",
      ],
    },
    {
      actions: [
        "s3vectors:CreateVectorBucket",
        "s3vectors:CreateIndex",
        "s3vectors:PutVectors",
        "s3vectors:QueryVectors",
        "s3vectors:GetVectors",
        "s3vectors:DeleteVectors",
        "s3vectors:ListIndexes",
      ],
      resources: ["*"],
    },
  ],
} as const;

// Data sources
const registerUserDS = api.addDataSource({
  name: "registerUserDS",
  lambda: {
    handler: "src/functions/resolvers/registerUser.handler",
    ...resolverDefaults,
  },
});

const meDS = api.addDataSource({
  name: "meDS",
  lambda: {
    handler: "src/functions/resolvers/me.handler",
    ...resolverDefaults,
  },
});

const updateMeDS = api.addDataSource({
  name: "updateMeDS",
  lambda: {
    handler: "src/functions/resolvers/updateMe.handler",
    ...resolverDefaults,
  },
});

const createKnowledgeDS = api.addDataSource({
  name: "createKnowledgeDS",
  lambda: {
    handler: "src/functions/resolvers/createKnowledge.handler",
    ...resolverDefaults,
  },
});

const getKnowledgeDS = api.addDataSource({
  name: "getKnowledgeDS",
  lambda: {
    handler: "src/functions/resolvers/getKnowledge.handler",
    ...resolverDefaults,
  },
});

const listKnowledgeDS = api.addDataSource({
  name: "listKnowledgeDS",
  lambda: {
    handler: "src/functions/resolvers/listKnowledge.handler",
    ...resolverDefaults,
  },
});

const updateKnowledgeDS = api.addDataSource({
  name: "updateKnowledgeDS",
  lambda: {
    handler: "src/functions/resolvers/updateKnowledge.handler",
    ...resolverDefaults,
  },
});

const deleteKnowledgeDS = api.addDataSource({
  name: "deleteKnowledgeDS",
  lambda: {
    handler: "src/functions/resolvers/deleteKnowledge.handler",
    ...resolverDefaults,
  },
});

const searchKnowledgeDS = api.addDataSource({
  name: "searchKnowledgeDS",
  lambda: {
    handler: "src/functions/resolvers/searchKnowledge.handler",
    ...resolverDefaults,
  },
});

// Resolvers - format is "TypeName fieldName"
api.addResolver("Mutation registerUser", {
  dataSource: registerUserDS.name,
});
api.addResolver("Query me", {
  dataSource: meDS.name,
});
api.addResolver("Mutation updateMe", {
  dataSource: updateMeDS.name,
});
api.addResolver("Mutation createKnowledge", {
  dataSource: createKnowledgeDS.name,
});
api.addResolver("Query getKnowledge", {
  dataSource: getKnowledgeDS.name,
});
api.addResolver("Query listKnowledge", {
  dataSource: listKnowledgeDS.name,
});
api.addResolver("Mutation updateKnowledge", {
  dataSource: updateKnowledgeDS.name,
});
api.addResolver("Mutation deleteKnowledge", {
  dataSource: deleteKnowledgeDS.name,
});
api.addResolver("Query searchKnowledge", {
  dataSource: searchKnowledgeDS.name,
});
