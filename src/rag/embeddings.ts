import { config } from "../config.js";

export interface EmbeddingRequest {
  model: string;
  input: string;
}

const EMBEDDING_MODEL = "text-embedding-3-small";

export function buildEmbeddingRequest(text: string): EmbeddingRequest {
  return { model: EMBEDDING_MODEL, input: text };
}

export async function embedText(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify(buildEmbeddingRequest(text)),
  });
  if (!res.ok) {
    throw new Error(`OpenAI embeddings request failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}
