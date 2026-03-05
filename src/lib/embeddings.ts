import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  S3VectorsClient,
  PutVectorsCommand,
  QueryVectorsCommand,
  DeleteVectorsCommand,
  CreateVectorBucketCommand,
  CreateIndexCommand,
  ListIndexesCommand,
} from "@aws-sdk/client-s3vectors";
import { logger } from "./powertools.js";

const bedrockClient = new BedrockRuntimeClient({ region: "us-east-1" });
const s3VectorsClient = new S3VectorsClient({ region: "us-east-1" });

const VECTOR_BUCKET = process.env.VECTOR_BUCKET_NAME ?? "agentbase-vectors";
const VECTOR_INDEX = process.env.VECTOR_INDEX_NAME ?? "knowledge";
const MODEL_ID = "amazon.titan-embed-text-v2:0";
const DIMENSIONS = 1024;

let vectorIndexReady = false;

async function ensureVectorIndex(): Promise<void> {
  if (vectorIndexReady) return;

  try {
    const { indexes } = await s3VectorsClient.send(
      new ListIndexesCommand({ vectorBucketName: VECTOR_BUCKET }),
    );
    if (indexes?.some((idx) => idx.indexName === VECTOR_INDEX)) {
      vectorIndexReady = true;
      return;
    }
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "VectorBucketNotFoundException" ||
        (err as { name?: string }).name === "NotFoundException") {
      logger.info("Creating vector bucket", { bucket: VECTOR_BUCKET });
      await s3VectorsClient.send(
        new CreateVectorBucketCommand({ vectorBucketName: VECTOR_BUCKET }),
      );
    } else {
      throw err;
    }
  }

  logger.info("Creating vector index", {
    bucket: VECTOR_BUCKET,
    index: VECTOR_INDEX,
  });
  await s3VectorsClient.send(
    new CreateIndexCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName: VECTOR_INDEX,
      dimension: DIMENSIONS,
      distanceMetric: "cosine",
      dataType: "float32",
      metadataConfiguration: {
        nonFilterableMetadataKeys: [],
      },
    }),
  );
  vectorIndexReady = true;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const body = JSON.stringify({
    inputText: text,
    dimensions: DIMENSIONS,
    normalize: true,
  });

  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: new TextEncoder().encode(body),
    }),
  );

  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.embedding as number[];
}

function extractText(content: unknown, contentType: string): string {
  if (contentType === "text/plain" && typeof content === "string") {
    return content;
  }
  return JSON.stringify(content);
}

export async function storeEmbedding(
  knowledgeId: string,
  content: unknown,
  contentType: string,
  metadata: Record<string, string>,
): Promise<void> {
  await ensureVectorIndex();

  const text = extractText(content, contentType);
  const embedding = await generateEmbedding(text);

  await s3VectorsClient.send(
    new PutVectorsCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName: VECTOR_INDEX,
      vectors: [
        {
          key: knowledgeId,
          data: { float32: embedding },
          metadata,
        },
      ],
    }),
  );
}

export async function queryVectors(
  queryText: string,
  filters: Record<string, string>,
  topK: number,
): Promise<Array<{ key: string; score: number }>> {
  await ensureVectorIndex();

  const embedding = await generateEmbedding(queryText);

  const filterConditions = Object.entries(filters).map(([key, value]) => ({
    [key]: { $eq: value },
  }));

  const response = await s3VectorsClient.send(
    new QueryVectorsCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName: VECTOR_INDEX,
      queryVector: { float32: embedding },
      topK,
      filter: filterConditions.length > 0
        ? { $and: [{ visibility: { $eq: "public" } }, ...filterConditions] }
        : { visibility: { $eq: "public" } },
      returnMetadata: true,
      returnDistance: true,
    }),
  );

  return (response.vectors ?? []).map((v) => ({
    key: v.key!,
    score: v.distance ?? 0,
  }));
}

export async function deleteVector(knowledgeId: string): Promise<void> {
  await ensureVectorIndex();

  await s3VectorsClient.send(
    new DeleteVectorsCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName: VECTOR_INDEX,
      keys: [knowledgeId],
    }),
  );
}
