import { config } from "./config.js";
import { logger } from "./logger.js";

export interface FaqEntry {
  question: string;
  answer: string;
}

interface FaqCache {
  entries: FaqEntry[];
  thesis: string;
  fetchedAt: number;
}

let cache: FaqCache | null = null;

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "of", "in", "on", "to",
  "and", "or", "for", "what", "who", "how", "does", "do", "did", "it",
  "its", "that", "this", "with", "as", "at", "be", "can", "i", "you",
]);

const SYNONYM_MAP: Record<string, string> = {
  "started": "founded",
  "create": "founded",
  "chain": "blockchain",
  "chains": "blockchain",
  "join": "member",
  "company": "label",
};

function normalizeToken(token: string): string {
  return SYNONYM_MAP[token] || token;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
      .map((w) => normalizeToken(w)),
  );
}

/**
 * Extracts the FAQPage JSON-LD block from the live /what-is-the-zao page.
 * This is the single source of truth - never hardcode Q&A pairs here.
 * A page with N `<script type="application/ld+json">` blocks may mix
 * FAQPage and Article schemas; we scan all and pick the FAQPage one.
 */
async function fetchFaq(): Promise<FaqCache> {
  const res = await fetch(config.faqUrl, {
    headers: { "user-agent": "ZAOPaperzBot/0.1 (+https://thezao.xyz)" },
  });
  if (!res.ok) {
    throw new Error(`FAQ fetch failed: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();

  const scriptRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  let entries: FaqEntry[] = [];
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (data["@type"] === "FAQPage" && Array.isArray(data.mainEntity)) {
        entries = data.mainEntity.map((q: any) => ({
          question: q.name as string,
          answer: q.acceptedAnswer?.text as string,
        }));
      }
    } catch {
      // Not valid JSON or not the block we want - skip.
    }
  }
  if (entries.length === 0) {
    throw new Error("No FAQPage JSON-LD found on the source page");
  }

  const thesisMatch = html.match(/<p class="thesis">([\s\S]*?)<\/p>/);
  const thesis = thesisMatch
    ? thesisMatch[1].replace(/<[^>]+>/g, "").trim()
    : "The ZAO is a decentralized impact network returning profit margin, data, and IP rights to artists.";

  logger.info({ count: entries.length }, "FAQ refreshed from source");
  return { entries, thesis, fetchedAt: Date.now() };
}

export async function getFaq(): Promise<FaqCache> {
  const maxAgeMs = config.faqRefreshMinutes * 60 * 1000;
  if (cache && Date.now() - cache.fetchedAt < maxAgeMs) {
    return cache;
  }
  try {
    cache = await fetchFaq();
  } catch (err) {
    if (cache) {
      logger.warn({ err }, "FAQ refresh failed, serving stale cache");
      return cache;
    }
    throw err;
  }
  return cache;
}

/** Minutes since the FAQ cache was last successfully fetched, or null if it's never been fetched. */
export function getFaqCacheAgeMinutes(): number | null {
  return cache ? (Date.now() - cache.fetchedAt) / 60000 : null;
}

/** Compute document frequency (how many entries contain each token). */
function computeDocumentFrequencies(entries: FaqEntry[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const entry of entries) {
    const tokens = tokenize(entry.question);
    for (const token of tokens) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return df;
}

/** Compute IDF for a token: ln((N+1)/(df(t)+1)) + 1 */
function computeIdf(token: string, totalDocs: number, df: Map<string, number>): number {
  const docFreq = df.get(token) ?? 0;
  return Math.log((totalDocs + 1) / (docFreq + 1)) + 1;
}

/** IDF-weighted keyword match - no LLM call, so this responds instantly. */
export function findBestMatch(
  entries: FaqEntry[],
  query: string,
): { entry: FaqEntry; score: number } | null {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return null;

  if (entries.length === 0) return null;

  // Compute document frequencies from all FAQ entries
  const df = computeDocumentFrequencies(entries);

  // Compute IDF scores for query tokens
  const queryIdfSum: Record<string, number> = {};
  for (const token of queryTokens) {
    queryIdfSum[token] = computeIdf(token, entries.length, df);
  }
  const totalQueryIdf = Object.values(queryIdfSum).reduce((sum, v) => sum + v, 0);

  let best: { entry: FaqEntry; score: number } | null = null;
  for (const entry of entries) {
    const entryTokens = tokenize(entry.question);

    // Sum IDF scores for tokens that match between query and entry
    let matchedIdfSum = 0;
    for (const queryToken of queryTokens) {
      if (entryTokens.has(queryToken)) {
        matchedIdfSum += queryIdfSum[queryToken];
      }
    }

    // score = sum(idf(matched tokens)) / sum(idf(query tokens))
    const score = totalQueryIdf > 0 ? matchedIdfSum / totalQueryIdf : 0;
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}
