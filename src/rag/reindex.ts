import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { extractSections } from "./extract-sections.js";
import { findChangedSections, type ExistingSectionHash } from "./diff-sections.js";
import { embedText } from "./embeddings.js";

const REINDEX_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PAPERS_JSON_URL = "https://www.thezao.xyz/papers.json";

interface PaperListEntry {
  id: string;
  url: string;
}

let client: SupabaseClient | null | undefined;

function getClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  client =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey)
      : null;
  if (!client) {
    logger.warn("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set - papers reindex disabled");
  }
  return client;
}

async function fetchPaperList(): Promise<PaperListEntry[]> {
  const res = await fetch(PAPERS_JSON_URL);
  if (!res.ok) throw new Error(`papers.json fetch failed: ${res.status}`);
  const data = (await res.json()) as { papers: { id: string; url: string }[] };
  return data.papers.map((p) => ({ id: p.id, url: p.url }));
}

async function fetchExistingHashes(supabase: SupabaseClient, paperId: string): Promise<ExistingSectionHash[]> {
  const { data, error } = await supabase
    .from("paper_sections")
    .select("paper_id, section_id, content_hash")
    .eq("paper_id", paperId);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    paperId: r.paper_id,
    sectionId: r.section_id,
    contentHash: r.content_hash,
  }));
}

async function reindexPaper(supabase: SupabaseClient, paper: PaperListEntry): Promise<void> {
  const res = await fetch(paper.url);
  if (!res.ok) {
    logger.warn({ paperId: paper.id, status: res.status }, "Failed to fetch paper page, skipping");
    return;
  }
  const html = await res.text();
  const extracted = extractSections(html, paper.url);

  let existingHashes: ExistingSectionHash[];
  try {
    existingHashes = await fetchExistingHashes(supabase, paper.id);
  } catch (err) {
    logger.warn({ err, paperId: paper.id }, "Failed to read existing hashes, skipping this paper this run");
    return;
  }

  const changed = findChangedSections(paper.id, extracted, existingHashes);

  for (const section of changed) {
    try {
      const embedding = await embedText(section.content);
      const { error } = await supabase.from("paper_sections").upsert({
        paper_id: section.paperId,
        section_id: section.sectionId,
        title: section.title,
        content: section.content,
        content_hash: section.contentHash,
        embedding,
        url: section.url,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
    } catch (err) {
      logger.warn({ err, paperId: paper.id, sectionId: section.sectionId }, "Failed to embed/upsert section, skipping");
    }
  }
}

export async function runReindex(): Promise<void> {
  const supabase = getClient();
  if (!supabase) return;

  let papers: PaperListEntry[];
  try {
    papers = await fetchPaperList();
  } catch (err) {
    logger.warn({ err }, "Failed to fetch papers.json, skipping this reindex run");
    return;
  }

  for (const paper of papers) {
    try {
      await reindexPaper(supabase, paper);
    } catch (err) {
      logger.warn({ err, paperId: paper.id }, "Failed to reindex paper, continuing with next");
    }
  }
}

export function startReindexLoop(): void {
  void runReindex();
  setInterval(runReindex, REINDEX_INTERVAL_MS);
}
