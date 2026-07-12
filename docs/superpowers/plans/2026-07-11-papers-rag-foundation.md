# Papers RAG Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every ZAO paper's content semantically searchable via a shared Postgres RPC function, so both ZAOpaperzBOT and a future web surface can query it - no new backend service, just a schema + a reindex job.

**Architecture:** A periodic reindex job (running alongside ZAOpaperzBOT on VPS 187.77.3.104) fetches each live paper page, extracts real `<section>`/`<h2>` content blocks, hashes them, embeds only what changed (OpenAI `text-embedding-3-small`), and upserts into `public.paper_sections` in the Zuke Supabase project (`yhpszfepoerqgnewukkh`). A single Postgres function, `match_paper_sections`, does pgvector similarity search and is the only query surface.

**Tech Stack:** TypeScript (Node >=20, ESM/NodeNext) in bettercallzaal/ZAOpaperzBOT; `cheerio` (new dependency) for HTML parsing; `@supabase/supabase-js` (already a dependency) for the DB; raw `fetch` against OpenAI's REST API (no SDK dependency); `node:test` + `node:assert/strict` for all tests, matching the existing suite's style; Postgres/pgvector in Supabase, applied via the `mcp__supabase__*` tools.

## Global Constraints

- Chunk boundaries come from real page markup, NOT `papers.json`'s `sections` array (verified 2026-07-11: most papers have that field as `null`, e.g. wavewarz, and where present its ids don't match real DOM ids anyway). Extraction rule: every `<section>` containing an `<h2>` is a chunk; skip `<section>` elements with no `<h2>` (page furniture like a draft-flag banner). Use the section's real `id` attribute when present (e.g. `what-is-the-zao.html` has real `id="q-01"` etc.), else generate `section-N` positionally.
- Bot code lives under `src/`, ESM with NodeNext resolution - relative imports need the `.js` extension even in `.ts` source (see existing `src/faq.ts`).
- Both bot-side writes and the DB function live in the Zuke Supabase project, `project_ref` `yhpszfepoerqgnewukkh` - NOT the cowork project. Apply schema changes directly to this project (it's freshly resumed, near-empty, low risk) - no Supabase branch needed for this sub-project.
- `OPENAI_API_KEY` and the existing `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` config fields are all optional (matching the existing graceful-degradation pattern in `src/config.ts`/`src/status-reporter.ts`) - the reindex job no-ops with a warning log if unset, never crashes the bot.
- No live OpenAI/Supabase calls in any automated test.
- Out of scope for this plan (per the design spec's stated non-goals): no `/zao` command changes beyond what's needed to prove `match_paper_sections` works, no editing UI, no Zuke-conversation integration, no manifesto work.

---

### Task 1: Supabase schema, pgvector, and the match function

**Files:** None in the bot repo - this task applies schema directly to the Zuke Supabase project (`yhpszfepoerqgnewukkh`) using the `mcp__supabase__*` tools (already connected in this environment; if unavailable to whoever executes this task, use `ToolSearch` with query `"select:mcp__supabase__apply_migration,mcp__supabase__execute_sql,mcp__supabase__list_extensions"` to load them first).

**Interfaces:**
- Produces: `public.paper_sections` table, `public.paper_edits` table, `public.match_paper_sections(query_embedding vector(1536), match_count int default 5)` function - all later tasks depend on this schema existing.

- [ ] **Step 1: Enable pgvector and create the schema**

Run via `mcp__supabase__apply_migration` (name: `papers_rag_foundation`):

```sql
create extension if not exists vector with schema extensions;

create table if not exists public.paper_sections (
  paper_id text not null,
  section_id text not null,
  title text not null,
  content text not null,
  content_hash text not null,
  embedding vector(1536) not null,
  url text not null,
  updated_at timestamptz not null default now(),
  primary key (paper_id, section_id)
);

create table if not exists public.paper_edits (
  id uuid primary key default gen_random_uuid(),
  paper_id text not null,
  section_id text not null,
  created_at timestamptz not null default now(),
  foreign key (paper_id, section_id) references public.paper_sections(paper_id, section_id)
);

create or replace function public.match_paper_sections(
  query_embedding vector(1536),
  match_count int default 5
)
returns table (
  paper_id text,
  section_id text,
  title text,
  content text,
  url text,
  similarity float
)
language sql stable
as $$
  select
    paper_id,
    section_id,
    title,
    content,
    url,
    1 - (embedding <=> query_embedding) as similarity
  from public.paper_sections
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

- [ ] **Step 2: Verify the extension and tables exist**

Run via `mcp__supabase__list_extensions` - confirm `vector` shows `"installed_version":"0.8.0"` (not null).
Run via `mcp__supabase__list_tables` (schemas: `["public"]`) - confirm `paper_sections` and `paper_edits` both appear alongside the existing `juke_spaces`/`juke_webhook_events`.

- [ ] **Step 3: Smoke-test the function with disposable data**

Run via `mcp__supabase__execute_sql`:

```sql
insert into public.paper_sections (paper_id, section_id, title, content, content_hash, embedding, url)
values
  ('smoketest', 'a', 'Section A', 'content a', 'hash-a',
   (select array_agg(1.0) from generate_series(1,1536))::vector, 'https://example.com/a'),
  ('smoketest', 'b', 'Section B', 'content b', 'hash-b',
   (select array_agg(0.0) from generate_series(1,1536))::vector, 'https://example.com/b');

select paper_id, section_id, similarity
from public.match_paper_sections(
  (select array_agg(1.0) from generate_series(1,1536))::vector,
  2
);
```

Expected: two rows back, `('smoketest', 'a', 1.0)` first (exact match, similarity 1.0), then `('smoketest', 'b', ...)` with a lower similarity.

- [ ] **Step 4: Clean up the disposable data**

Run via `mcp__supabase__execute_sql`:

```sql
delete from public.paper_sections where paper_id = 'smoketest';
```

- [ ] **Step 5: Report**

Confirm in your report: extension version, both tables present, the smoke-test query's actual output (paste it), and that the cleanup delete ran (0 `smoketest` rows remaining - verify with a `select count(*) from public.paper_sections where paper_id = 'smoketest'` returning 0).

---

### Task 2: Section extraction from live HTML (TDD)

**Files:**
- Create: `src/rag/extract-sections.ts`
- Test: `src/rag/extract-sections.test.ts`
- Modify: `package.json` - add `cheerio` to `dependencies`

**Interfaces:**
- Produces: `interface ExtractedSection { sectionId: string; title: string; content: string; url: string }`, `extractSections(html: string, baseUrl: string): ExtractedSection[]`

- [ ] **Step 1: Install cheerio**

```bash
npm install cheerio
```

- [ ] **Step 2: Write the failing tests**

```typescript
// src/rag/extract-sections.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractSections } from "./extract-sections.js";

describe("extractSections", () => {
  test("extracts sections with real id attributes and links to them", () => {
    const html = `
      <main>
        <section id="q-01"><h2>What is The ZAO?</h2><p>A decentralized impact network.</p></section>
        <section id="q-02"><h2>Who founded it?</h2><p>Zaal Panthaki.</p></section>
      </main>`;
    const result = extractSections(html, "https://www.thezao.xyz/what-is-the-zao");
    assert.equal(result.length, 2);
    assert.equal(result[0].sectionId, "q-01");
    assert.equal(result[0].title, "What is The ZAO?");
    assert.match(result[0].content, /decentralized impact network/);
    assert.equal(result[0].url, "https://www.thezao.xyz/what-is-the-zao#q-01");
  });

  test("generates positional ids when sections have no real id attribute", () => {
    const html = `
      <main>
        <section><h2>The problem</h2><p>Streaming pays badly.</p></section>
        <section><h2>What it is</h2><p>An onchain prediction market.</p></section>
      </main>`;
    const result = extractSections(html, "https://www.thezao.xyz/papers/drafts/wavewarz");
    assert.equal(result.length, 2);
    assert.equal(result[0].sectionId, "section-1");
    assert.equal(result[1].sectionId, "section-2");
    assert.equal(result[0].url, "https://www.thezao.xyz/papers/drafts/wavewarz");
  });

  test("skips sections with no <h2> (page furniture, not content)", () => {
    const html = `
      <main>
        <section><div class="wrap"><p class="draft-flag">Working draft</p></div></section>
        <section><div class="wrap"><h2>Real content</h2><p>Some text.</p></div></section>
      </main>`;
    const result = extractSections(html, "https://www.thezao.xyz/papers/technical");
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "Real content");
  });

  test("an empty page returns an empty array", () => {
    const result = extractSections("<main></main>", "https://www.thezao.xyz/empty");
    assert.deepEqual(result, []);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL - `Cannot find module './extract-sections.js'`

- [ ] **Step 4: Implement**

```typescript
// src/rag/extract-sections.ts
import * as cheerio from "cheerio";

export interface ExtractedSection {
  sectionId: string;
  title: string;
  content: string;
  url: string;
}

export function extractSections(html: string, baseUrl: string): ExtractedSection[] {
  const $ = cheerio.load(html);
  const sections: ExtractedSection[] = [];
  let positionalIndex = 0;

  $("section").each((_, el) => {
    const $section = $(el);
    const heading = $section.find("h2").first();
    if (heading.length === 0) return;

    positionalIndex += 1;
    const title = heading.text().trim();
    const content = $section.text().replace(/\s+/g, " ").trim();
    const realId = $section.attr("id");
    const sectionId = realId || `section-${positionalIndex}`;
    const url = realId ? `${baseUrl}#${realId}` : baseUrl;

    sections.push({ sectionId, title, content, url });
  });

  return sections;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS - all 4 `extractSections` cases green, plus all existing tests still green.

- [ ] **Step 6: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/rag/extract-sections.ts src/rag/extract-sections.test.ts
git commit -m "Add section extraction from live paper HTML"
```

---

### Task 3: Content hashing and change detection (TDD)

**Files:**
- Create: `src/rag/diff-sections.ts`
- Test: `src/rag/diff-sections.test.ts`

**Interfaces:**
- Consumes: `ExtractedSection` (Task 2)
- Produces: `hashContent(content: string): string`, `interface ExistingSectionHash { paperId: string; sectionId: string; contentHash: string }`, `interface SectionToEmbed extends ExtractedSection { paperId: string; contentHash: string }`, `findChangedSections(paperId: string, extracted: ExtractedSection[], existingHashes: ExistingSectionHash[]): SectionToEmbed[]`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/rag/diff-sections.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { hashContent, findChangedSections } from "./diff-sections.js";
import type { ExtractedSection } from "./extract-sections.js";

describe("hashContent", () => {
  test("the same content always produces the same hash", () => {
    assert.equal(hashContent("hello world"), hashContent("hello world"));
  });

  test("different content produces different hashes", () => {
    assert.notEqual(hashContent("hello"), hashContent("world"));
  });
});

describe("findChangedSections", () => {
  const extracted: ExtractedSection[] = [
    { sectionId: "a", title: "A", content: "content a", url: "https://x/a" },
    { sectionId: "b", title: "B", content: "content b", url: "https://x/b" },
  ];

  test("a section with no existing hash is treated as changed", () => {
    const result = findChangedSections("paper1", extracted, []);
    assert.equal(result.length, 2);
    assert.equal(result[0].paperId, "paper1");
    assert.equal(result[0].contentHash, hashContent("content a"));
  });

  test("a section whose hash matches the existing record is not re-embedded", () => {
    const existing = [
      { paperId: "paper1", sectionId: "a", contentHash: hashContent("content a") },
      { paperId: "paper1", sectionId: "b", contentHash: hashContent("content b") },
    ];
    const result = findChangedSections("paper1", extracted, existing);
    assert.deepEqual(result, []);
  });

  test("only the section whose content actually changed is returned", () => {
    const existing = [
      { paperId: "paper1", sectionId: "a", contentHash: hashContent("content a") },
      { paperId: "paper1", sectionId: "b", contentHash: "stale-hash-for-b" },
    ];
    const result = findChangedSections("paper1", extracted, existing);
    assert.equal(result.length, 1);
    assert.equal(result[0].sectionId, "b");
  });

  test("existing hashes for a different paper are ignored", () => {
    const existing = [
      { paperId: "other-paper", sectionId: "a", contentHash: hashContent("content a") },
    ];
    const result = findChangedSections("paper1", extracted, existing);
    assert.equal(result.length, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL - `Cannot find module './diff-sections.js'`

- [ ] **Step 3: Implement**

```typescript
// src/rag/diff-sections.ts
import { createHash } from "node:crypto";
import type { ExtractedSection } from "./extract-sections.js";

export interface ExistingSectionHash {
  paperId: string;
  sectionId: string;
  contentHash: string;
}

export interface SectionToEmbed extends ExtractedSection {
  paperId: string;
  contentHash: string;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function findChangedSections(
  paperId: string,
  extracted: ExtractedSection[],
  existingHashes: ExistingSectionHash[],
): SectionToEmbed[] {
  const existingMap = new Map(
    existingHashes.filter((e) => e.paperId === paperId).map((e) => [e.sectionId, e.contentHash]),
  );
  const changed: SectionToEmbed[] = [];
  for (const section of extracted) {
    const contentHash = hashContent(section.content);
    if (existingMap.get(section.sectionId) !== contentHash) {
      changed.push({ ...section, paperId, contentHash });
    }
  }
  return changed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/rag/diff-sections.ts src/rag/diff-sections.test.ts
git commit -m "Add content hashing and change detection for paper sections"
```

---

### Task 4: OpenAI embedding call (TDD for the request shape)

**Files:**
- Create: `src/rag/embeddings.ts`
- Test: `src/rag/embeddings.test.ts`
- Modify: `src/config.ts` - add `openaiApiKey`

**Interfaces:**
- Produces: `buildEmbeddingRequest(text: string): { model: string; input: string }`, `embedText(text: string): Promise<number[]>`, `config.openaiApiKey: string | undefined`

- [ ] **Step 1: Write the failing test**

```typescript
// src/rag/embeddings.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildEmbeddingRequest } from "./embeddings.js";

describe("buildEmbeddingRequest", () => {
  test("uses the text-embedding-3-small model with the given input", () => {
    const req = buildEmbeddingRequest("what is the zao");
    assert.equal(req.model, "text-embedding-3-small");
    assert.equal(req.input, "what is the zao");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL - `Cannot find module './embeddings.js'`

- [ ] **Step 3: Add the config field**

Add this line to the exported `config` object in `src/config.ts`, after `supabaseServiceRoleKey`:

```typescript
  openaiApiKey: process.env.OPENAI_API_KEY || undefined,
```

- [ ] **Step 4: Implement embeddings.ts**

```typescript
// src/rag/embeddings.ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/rag/embeddings.ts src/rag/embeddings.test.ts
git commit -m "Add OpenAI embedding call for paper sections"
```

---

### Task 5: Reindex orchestrator

**Files:**
- Create: `src/rag/reindex.ts`

**Interfaces:**
- Consumes: `extractSections` (Task 2), `hashContent`/`findChangedSections`/`ExistingSectionHash` (Task 3), `embedText` (Task 4), `config.supabaseUrl`/`config.supabaseServiceRoleKey` (existing)
- Produces: `runReindex(): Promise<void>`, `startReindexLoop(): void`

No new automated test for this task per the Global Constraints (no live Supabase/OpenAI calls in tests) - this orchestrates already-tested pure functions plus side-effecting network calls; correctness is verified by build + the existing suite staying green, same pattern as `src/status-reporter.ts`'s side-effecting layer.

- [ ] **Step 1: Implement the orchestrator**

```typescript
// src/rag/reindex.ts
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
    await reindexPaper(supabase, paper);
  }
}

export function startReindexLoop(): void {
  void runReindex();
  setInterval(runReindex, REINDEX_INTERVAL_MS);
}
```

- [ ] **Step 2: Run the existing suite to confirm no regression**

Run: `npm test`
Expected: PASS - all prior tests unaffected.

- [ ] **Step 3: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/rag/reindex.ts
git commit -m "Add papers reindex orchestrator"
```

---

### Task 6: Wire the reindex loop into bot startup

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `startReindexLoop` (Task 5)

- [ ] **Step 1: Wire it into `ClientReady`**

```typescript
// src/index.ts - full file after the change
import { Client, GatewayIntentBits, Events, type Interaction } from "discord.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import * as zaoCommand from "./commands/zao.js";
import { startHeartbeatLoop } from "./status-reporter.js";
import { getFaqCacheAgeMinutes } from "./faq.js";
import { startReindexLoop } from "./rag/reindex.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  logger.info({ tag: c.user.tag, guilds: c.guilds.cache.size }, "ZAO Paperz bot ready");
  startHeartbeatLoop(() => c.guilds.cache.size, getFaqCacheAgeMinutes);
  startReindexLoop();
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "zao") {
      await zaoCommand.execute(interaction);
    } else if (interaction.isStringSelectMenu() && interaction.customId === "zao_faq_topic") {
      await zaoCommand.handleSelect(interaction);
    }
  } catch (err) {
    logger.error({ err }, "Interaction handler failed");
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction.reply({ content: "Something went wrong. Try again in a moment.", ephemeral: true }).catch(() => {});
    }
  }
});

client.on(Events.Error, (err) => logger.error({ err }, "Discord client error"));

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down");
  client.destroy();
  process.exit(0);
});

client.login(config.discordBotToken);
```

- [ ] **Step 2: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "Start the papers reindex loop on bot ready"
```

---

### Task 7: Docs, env example, and full-repo verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add the new env var to `.env.example`**

Append after the existing "Status dashboard" section:

```
# ----- Papers RAG (optional) -----
# Enables the periodic reindex job that embeds every ZAO paper's content
# into public.paper_sections (Zuke Supabase project) for semantic search
# via public.match_paper_sections(). If unset, the reindex loop no-ops -
# the bot runs exactly as before. Uses the SAME SUPABASE_URL/
# SUPABASE_SERVICE_ROLE_KEY as the status dashboard, but a DIFFERENT
# Supabase project (the Zuke one, not the cowork one) - make sure these
# point at yhpszfepoerqgnewukkh, not the cowork project, if both features
# are enabled on this bot.
OPENAI_API_KEY=
```

- [ ] **Step 2: Add a section to `README.md`**

Append after the existing "Status dashboard" section:

```markdown
## Papers RAG (foundation)

Every ZAO paper (not just the `/what-is-the-zao` FAQ page) gets embedded into
`public.paper_sections` in the Zuke Supabase project on a periodic reindex
(every 6 hours). Sections are extracted directly from each paper's live HTML
(`<section>` elements containing an `<h2>`) - not from `papers.json`'s
`sections` field, which is unreliable (often `null`). Search happens through
one Postgres function, `match_paper_sections`, callable by any consumer with
a Supabase client - this repo doesn't yet call it from `/zao` (that's a
follow-up), it just keeps the index current.

Requires `OPENAI_API_KEY` in addition to the dashboard's `SUPABASE_URL`/
`SUPABASE_SERVICE_ROLE_KEY` - all optional, the bot runs fine without them.
```

- [ ] **Step 3: Full-repo verification**

```bash
npm install && npm test && npx tsc --noEmit
```

Expected: everything passes, including all of Task 2-4's new tests.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "Document the papers RAG reindex feature and its env vars"
```

---

## Manual steps (not implementation tasks - require account access this environment doesn't have)

1. **Set `OPENAI_API_KEY` via the `setting-secrets` flow** (not pasted in chat) in the bot's `.env` on VPS 187.77.3.104. Without it, the reindex loop starts, logs a warning, and no-ops forever - not a crash, but nothing gets indexed either.
2. **Redeploy the bot** after adding the key: `ssh root@187.77.3.104 'cd /opt/zaopaperz && git pull && npm install && systemctl --user restart zaopaperz.service'`.
3. **Confirm the first reindex run**: check the bot's logs (`ssh root@187.77.3.104 'journalctl --user -u zaopaperz -n 100'`) for the reindex completing, then spot-check via `mcp__supabase__execute_sql` on the Zuke project: `select paper_id, count(*) from public.paper_sections group by paper_id;` should show a row count per paper roughly matching that paper's real section count.
