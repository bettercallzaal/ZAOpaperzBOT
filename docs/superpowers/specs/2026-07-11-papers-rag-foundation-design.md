# Papers RAG foundation - design

Status: approved 2026-07-11
Owner: Zaal
Sub-project: 1 of 4 in the "ZAO Paperz platform v2" decomposition (see Section "Follow-up" below for the other three)

## Problem

thezao.xyz hosts ~12 ZAO whitepapers (public/papers/*, ZADODEVZ/ZAOcowork repo, all still DRAFT-flagged), plus a canonical `/what-is-the-zao` FAQ page. ZAOpaperzBOT (a separate small Discord bot, bettercallzaal/ZAOpaperzBOT) currently answers `/zao` questions by reading only that one FAQ page's FAQPage JSON-LD at runtime - it has zero visibility into the other ~12 papers. There is also no way for a web visitor to ask a cross-paper question at all.

This is sub-project 1 of a larger "ZAO Paperz platform v2" vision (papers-as-agent-memory, community editing, Zuke-conversation-sourced edits, manifesto signing) that got flagged as too large for one spec and decomposed. This spec covers ONLY the foundation: get all the papers into a searchable, always-current vector store. Sub-projects 2-4 are out of scope here and tracked separately.

## Goals

- Every ZAO paper's content becomes semantically searchable (RAG), not just the one FAQ page.
- ZAOpaperzBOT's existing `/zao` command becomes the first consumer, extended from FAQ-only to all papers.
- A future web-based "ask the papers" surface can be built on the exact same backend with no duplicated search logic.
- Never create a fourth place facts can drift - this is a derived index of the live pages, not a new copy of record. If the RAG store and a live page ever disagree, the live page wins and the RAG store is stale, not wrong-in-a-new-way.

## Non-goals

- No editing UI, no proposed-edits flow, no contributor attribution - that's sub-project 2.
- No Zuke-conversation-to-edit pipeline - that's sub-project 3.
- No manifesto-signing mechanism - that's sub-project 4, unrelated to this one.
- No new web UI is built in this sub-project - only the shared backend (schema + reindex job + query function) that a future web surface could call.

## Architecture

```
thezao.xyz/papers/*.html (live pages, ZADODEVZ/ZAOcowork)
        |
        v
Reindex job (periodic, runs on VPS 187.77.3.104 - same box ZAOpaperzBOT
already runs on)
        |
        +--> fetch public/papers.json for the current paper list + URLs
        +--> fetch each paper's live HTML page
        +--> extract sections directly from the page markup: every <section>
        |     element that contains an <h2> is a real content chunk (verified
        |     2026-07-11 against 6 live pages - papers.json's own "sections"
        |     array is NOT reliable: most papers have it as null, e.g.
        |     wavewarz, and where present its ids like "section-01" don't
        |     match any real DOM id anyway). Use the section's real id
        |     attribute when present (what-is-the-zao.html has real
        |     id="q-01" etc.), else a positionally-generated "section-N".
        |     Sections with no <h2> (e.g. a draft-flag banner) are skipped -
        |     they're page furniture, not content.
        +--> hash each section's content
        +--> for sections whose hash changed since last run: call OpenAI
        |     text-embedding-3-small, get a 1536-dim vector
        +--> upsert into public.paper_sections (Zuke's Supabase project,
              project_ref yhpszfepoerqgnewukkh)

public.paper_sections (schema, this sub-project)
        |
        v
public.match_paper_sections(query_embedding, match_count) - a Postgres
function using pgvector cosine similarity (<=>)
        |
        +--> called by ZAOpaperzBOT's /zao command (embeds the user's
        |     question with the same model, calls the RPC, returns the
        |     top-N matching sections with their live URLs)
        +--> callable the same way by any future web surface - same
              function, same Supabase client pattern, no separate API
              service to stand up
```

## Components

- `public.paper_sections` table (new, in the Zuke Supabase project):
  - `paper_id text`, `section_id text`, `title text`, `content text`, `content_hash text`, `embedding vector(1536)`, `url text`, `updated_at timestamptz default now()`
  - Primary key: `(paper_id, section_id)` - one row per section, upserted on change.
- `public.paper_edits` table (new, empty shell for sub-project 2 to fill in - not designed here beyond existing so sub-project 2 has a foreign-key target): `id uuid default gen_random_uuid() primary key`, `paper_id text`, `section_id text references public.paper_sections(paper_id, section_id)`, `created_at timestamptz default now()`. Sub-project 2 adds whatever columns its editing/attribution design needs.
- `public.match_paper_sections(query_embedding vector(1536), match_count int default 5)` - Postgres function, returns `paper_id, section_id, title, content, url, similarity` ordered by cosine distance.
- Reindex job (new script, lives in bettercallzaal/ZAOpaperzBOT repo alongside the bot, deployed to the same VPS): fetches, chunks, hashes, embeds, upserts. Runs on an interval (proposed default: every 6 hours, matching the bot's existing `FAQ_REFRESH_MINUTES` convention) via the same systemd-managed process pattern already used for the bot's heartbeat loop.
- `/zao` command changes (bettercallzaal/ZAOpaperzBOT): when a question doesn't match the FAQ page well, or as the primary path once this ships, embed the question and call `match_paper_sections` instead of (or in addition to) the existing FAQ-only `findBestMatch`. Exact integration approach (replace vs. fallback vs. merge) is an implementation-planning decision, not a design-level one - both existing FAQ matching and the new RAG search coexist; this spec doesn't mandate deleting the FAQ path.

## Data flow

1. Reindex job runs (scheduled) -> fetches current paper list + each page's HTML -> extracts section text -> hashes -> diffs against `paper_sections.content_hash` -> embeds only changed sections -> upserts.
2. A user asks `/zao <question>` (or a future web surface submits a question) -> the consumer embeds the question with the same model -> calls `match_paper_sections` -> gets back the top-N sections with live URLs -> renders an answer citing/linking those sections.

## Error handling

- A failed page fetch or a failed embedding call for one section logs and skips - doesn't abort the whole reindex run. Next scheduled run retries.
- If `paper_sections` is empty or stale (reindex has never run or is failing), `match_paper_sections` still returns whatever's there - stale beats absent. Callers (ZAOpaperzBOT) fall back to their existing behavior if the RPC returns nothing.
- OpenAI API failures during a live query (not reindex) surface as "couldn't search the papers right now" to the end user, same honest-failure pattern ZAOpaperzBOT already uses for FAQ fetch failures.

## Testing

- Pure unit tests (no live OpenAI/Supabase calls) for: section-extraction-from-HTML, content hashing, and the diff-which-sections-changed logic - same `node:test` style as the bot's existing suite.
- `match_paper_sections` gets a couple of integration-style tests against a Supabase branch (via `create_branch`) once implementation starts - not unit-testable without a real pgvector-enabled Postgres.

## Deployment / manual steps

- `pgvector` extension needs enabling on the Zuke Supabase project (available, version 0.8.0, not yet installed per current `list_extensions` check).
- `OPENAI_API_KEY` needed wherever the reindex job runs (VPS `.env`) - set via `setting-secrets`, not pasted in chat.
- Reindex job deploys alongside ZAOpaperzBOT on the existing VPS - no new infrastructure to provision.

## Follow-up (out of scope here, tracked separately as sub-projects 2-4)

- **Community editing + attribution** (sub-project 2): builds on `paper_edits` above - who can propose an edit, review/approval flow, how contributor credit is stored and displayed.
- **Zuke-conversation-to-edit pipeline** (sub-project 3): depends on sub-project 2's editing flow existing first - a live Zuke conversation transcript becomes a proposed edit through that same flow.
- **Manifesto-signing mechanism** (sub-project 4): independent of the other three. Open since 2026-07-09 - the manifesto page currently claims "signing = minting an on-chain hat" but no contract/UI exists yet.
