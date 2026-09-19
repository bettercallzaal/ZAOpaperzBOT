import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import { embedText } from "./embeddings.js";
import { logger } from "../logger.js";

export interface RagMatch {
  paperId: string;
  sectionId: string;
  title: string;
  content: string;
  url: string;
  similarity: number;
}

const RAG_SIMILARITY_THRESHOLD = 0.25;

let client: SupabaseClient | null | undefined;

function getClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  client =
    config.ragSupabaseUrl && config.ragSupabaseServiceRoleKey
      ? createClient(config.ragSupabaseUrl, config.ragSupabaseServiceRoleKey)
      : null;
  if (!client) {
    logger.debug("RAG not configured - skipping semantic search");
  }
  return client;
}

export async function queryPapers(question: string, matchCount = 3): Promise<RagMatch[]> {
  const supabase = getClient();
  if (!supabase || !config.openaiApiKey) return [];

  let embedding: number[];
  try {
    embedding = await embedText(question);
  } catch (err) {
    logger.error({ err }, "Failed to embed question for RAG");
    return [];
  }

  const { data, error } = await supabase.rpc("match_paper_sections", {
    query_embedding: embedding,
    match_count: matchCount,
  });

  if (error) {
    logger.error({ error }, "match_paper_sections RPC failed");
    return [];
  }

  return ((data as any[]) ?? [])
    .filter((r: any) => (r.similarity ?? 0) >= RAG_SIMILARITY_THRESHOLD)
    .map((r: any) => ({
      paperId: r.paper_id,
      sectionId: r.section_id,
      title: r.title,
      content: r.content,
      url: r.url,
      similarity: r.similarity,
    }));
}
