import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

export const DEFAULT_EMBED_MODEL_ID = "cohere.embed-multilingual-v3";
export const DEFAULT_EMBED_DIMENSIONS = 1024;

export type EmbedInputType = "search_document" | "search_query" | "classification" | "clustering";

export interface EmbedOptions {
  region?: string;
  modelId?: string;
  inputType?: EmbedInputType;
  client?: BedrockRuntimeClient;
}

export interface EmbedResult {
  embeddings: number[][];
  modelId: string;
  dimensions: number;
  inputCount: number;
}

let cachedClient: BedrockRuntimeClient | null = null;
let cachedRegion: string | null = null;

function getClient(region: string): BedrockRuntimeClient {
  if (cachedClient && cachedRegion === region) return cachedClient;
  cachedClient = new BedrockRuntimeClient({ region });
  cachedRegion = region;
  return cachedClient;
}

function resolveRegion(opts: EmbedOptions): string {
  const region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error(
      "bedrock-gateway embed: AWS region not configured (pass opts.region or set AWS_REGION).",
    );
  }
  return region;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const COHERE_BATCH_LIMIT = 96;

export async function embedTexts(
  texts: string[],
  opts: EmbedOptions = {},
): Promise<EmbedResult> {
  if (texts.length === 0) {
    return {
      embeddings: [],
      modelId: opts.modelId ?? DEFAULT_EMBED_MODEL_ID,
      dimensions: DEFAULT_EMBED_DIMENSIONS,
      inputCount: 0,
    };
  }

  const modelId = opts.modelId ?? DEFAULT_EMBED_MODEL_ID;
  const inputType = opts.inputType ?? "search_document";
  const client = opts.client ?? getClient(resolveRegion(opts));

  const allEmbeddings: number[][] = [];

  for (const batch of chunk(texts, COHERE_BATCH_LIMIT)) {
    const body = modelId.startsWith("cohere.embed-")
      ? { texts: batch, input_type: inputType }
      : modelId.startsWith("amazon.titan-embed-")
        ? { inputText: batch[0] }
        : null;

    if (!body) {
      throw new Error(`bedrock-gateway embed: unsupported model ${modelId}`);
    }

    if (modelId.startsWith("amazon.titan-embed-")) {
      for (const text of batch) {
        const resp = await client.send(
          new InvokeModelCommand({
            modelId,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({ inputText: text }),
          }),
        );
        const decoded = JSON.parse(new TextDecoder().decode(resp.body));
        if (!Array.isArray(decoded.embedding)) {
          throw new Error("bedrock-gateway embed: titan response missing embedding");
        }
        allEmbeddings.push(decoded.embedding);
      }
    } else {
      const resp = await client.send(
        new InvokeModelCommand({
          modelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify(body),
        }),
      );
      const decoded = JSON.parse(new TextDecoder().decode(resp.body));
      if (!Array.isArray(decoded.embeddings)) {
        throw new Error("bedrock-gateway embed: cohere response missing embeddings");
      }
      for (const e of decoded.embeddings) allEmbeddings.push(e);
    }
  }

  return {
    embeddings: allEmbeddings,
    modelId,
    dimensions: allEmbeddings[0]?.length ?? DEFAULT_EMBED_DIMENSIONS,
    inputCount: texts.length,
  };
}

export async function embedText(text: string, opts: EmbedOptions = {}): Promise<number[]> {
  const result = await embedTexts([text], opts);
  if (result.embeddings.length === 0) {
    throw new Error("bedrock-gateway embed: no embedding returned");
  }
  return result.embeddings[0];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
