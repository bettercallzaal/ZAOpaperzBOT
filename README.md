# ZAO Paperz Bot

A Discord bot + dashboard platform that makes The ZAO's canonical papers discoverable and searchable. Answers `/zao` questions from the live papers (not hardcoded Q&A), keeps everything in sync with the source of truth, and reports operational status to a public dashboard.

**What this solves:** The ZAO has 12+ whitepapers at thezao.xyz/papers, but they're not discoverable. This bot embeds them into a vector store, lets Discord users ask questions across all papers via `/zao`, and gives Zaal visibility into bot health via a Vercel dashboard. Future web-based "ask the papers" surfaces can reuse the same backend.

**Status:** Core bot and dashboard are live and stable. Papers RAG foundation (semantic search backend) shipped 2026-07-11, deployed to production.

**Repository:** github.com/bettercallzaal/ZAOpaperzBOT  
**Platforms:** Discord (via discord.js), Supabase (vector store + operational data), OpenAI (embeddings)

---

## Stack

- **Bot:** Node.js 20+, discord.js 14, TypeScript, Pino (logging)
- **Dashboard:** Next.js 14 (App Router), React 18, Vercel, Supabase client
- **RAG backend:** pgvector (Postgres extension), OpenAI embeddings API, Supabase (two separate projects)
- **Dev:** tsx (TypeScript runner), Biome (linter/formatter), Node test runner

---

## Setup

### Prerequisites

- Node.js >= 20
- npm
- A Discord Application (token + app ID from discord.com/developers/applications)
- Supabase projects (two of them):
  - **Cowork project** (for bot status/heartbeats): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - **Zuke project** (for papers vector store): `RAG_SUPABASE_URL`, `RAG_SUPABASE_SERVICE_ROLE_KEY`
- OpenAI API key (for embedding papers): `OPENAI_API_KEY`

### Environment Variables

Copy `.env.example` to `.env` and fill in these values. **NEVER commit `.env`.**

```bash
# Discord bot identity (from discord.com/developers/applications)
DISCORD_BOT_TOKEN=<bot-token>
DISCORD_APP_ID=<app-id>
# Optional: for testing slash commands instantly in one server
DISCORD_TEST_GUILD_ID=

# Source of truth for the FAQ
ZAO_FAQ_URL=https://www.thezao.xyz/what-is-the-zao
FAQ_REFRESH_MINUTES=360

# Optional: bot status reporting (heartbeats + command events)
# Points to the cowork Supabase project (etwvzrmlxeobinrlytza)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# Optional: papers RAG reindex (separate Zuke project, yhpszfepoerqgnewukkh)
RAG_SUPABASE_URL=
RAG_SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=

# Logging
LOG_LEVEL=info
NODE_ENV=production
```

### Installation

```bash
# Install bot dependencies
npm install

# Register the /zao slash command globally (takes ~1h to propagate)
npm run register-commands

# Or test in one server only (instant propagation)
# - Set DISCORD_TEST_GUILD_ID in .env first
# - Then run: npm run register-commands

# Install dashboard dependencies (separate app)
cd dashboard && npm install && cd ..
```

### Running Locally

**Bot (terminal 1):**
```bash
npm run dev
# Watches src/ and restarts on changes
```

**Dashboard (terminal 2):**
```bash
cd dashboard && npm run dev
# Runs on http://localhost:3000
```

**Testing:**
```bash
npm test                    # Run bot + RAG unit tests
cd dashboard && npm test    # Run dashboard tests
```

**Linting:**
```bash
npm run lint                # Check bot code
npm run format              # Auto-format bot code
```

### Deployment

#### Bot (Systemd on VPS)

The bot runs as a systemd service on VPS `187.77.3.104`. See `scripts/systemd/zaopaperz.service` for the unit file. To deploy:

1. SSH to the VPS
2. Copy/update `scripts/systemd/zaopaperz.service` to `/etc/systemd/system/` or `~/.config/systemd/user/`
3. `git pull origin main` (or merge via PR)
4. `npm install && npm run build`
5. Reload and restart:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now zaopaperz.service
   journalctl --user -u zaopaperz -f  # Watch logs
   ```

#### Dashboard (Vercel)

The `dashboard/` directory is deployed automatically to Vercel on every push to `main`. Vercel project settings must be:

- **Root Directory:** `dashboard/`
- **Framework Preset:** Next.js
- **Build Command:** `npm run build`
- **Output Directory:** `.next`

Env vars in Vercel project settings:
- `SUPABASE_URL` (server-only)
- `SUPABASE_SERVICE_ROLE_KEY` (server-only, never NEXT_PUBLIC_)

---

## Architecture

### High Level

```
Discord user asks /zao <question>
  |
  v
src/commands/zao.ts
  |
  +---> (1) Try FAQ keyword match
  |       src/faq.ts --> fetch thezao.xyz/what-is-the-zao (cached 6h)
  |                      extract FAQPage JSON-LD, keyword-overlap score
  |
  +---> (2) Try papers RAG (if OPENAI_API_KEY is set)
          src/rag/ --> embed question with OpenAI
                       call Supabase RPC match_paper_sections (pgvector cosine similarity)
                       return top-5 matching paper sections with URLs
  |
  +---> Reply with the best match or offer topic menu
  |
  v
src/status-reporter.ts logs the event to Supabase
  (bot_events table: question, matched/not, timestamp)

Dashboard (Next.js on Vercel)
  |
  v
dashboard/app/page.tsx
  reads bot_heartbeats (latest status, guild count, cache age)
  reads bot_events (activity feed, last 50 questions)
  renders operational view
```

### Project Structure

```
src/
  index.ts                    # Bot entry point, loads commands, starts reindex loop
  config.ts                   # ENV var parsing + validation
  logger.ts                   # Pino logger setup
  
  commands/
    zao.ts                    # The /zao slash command implementation
  
  faq.ts                      # FAQ page fetcher + keyword-matching logic
  faq.test.ts                 # FAQ unit tests
  
  status-reporter.ts          # Heartbeat + event logging to Supabase
  status-reporter.test.ts
  
  rag/
    reindex.ts                # Orchestrator: fetches all papers, chunks, embeds, upserts
    extract-sections.ts       # HTML parser: finds <section>/<h2> chunks
    extract-sections.test.ts
    embeddings.ts             # OpenAI embedding calls
    embeddings.test.ts
    diff-sections.ts          # Determines which sections changed (by content hash)
    diff-sections.test.ts

dashboard/
  app/
    page.tsx                  # Single status page (server component)
  
  lib/
    supabase.ts               # Supabase service-role client (server-side only)
    supabase.test.ts

scripts/
  register-commands.ts        # Registers /zao globally or in test guild
  systemd/
    zaopaperz.service         # Systemd unit file for VPS deployment

docs/
  superpowers/                # Design specs and implementation plans
```

### Data Flow: Papers RAG

```
Reindex Loop (runs every 6h, starts on bot ready)
  |
  v
1. Fetch public/papers.json from thezao.xyz
2. For each paper URL in the list:
   - Fetch live HTML from thezao.xyz/papers/<slug>.html
   - Parse with Cheerio: find all <section> elements with <h2> (real content)
   - Extract: title (from <h2>), content (from <section>), id (from @id or auto-generated)
3. Hash each section's content
4. Diff against public.paper_sections.content_hash (Zuke Supabase)
   - Skip unchanged sections (save API quota)
   - Embed only changed sections with OpenAI text-embedding-3-small
5. Upsert into public.paper_sections (paper_id, section_id, title, content, embedding, url)

Query (User asks /zao)
  |
  v
1. Embed question with OpenAI (same model)
2. Call Supabase RPC: select match_paper_sections(embedding, match_count=5)
   - Postgres: ORDER BY embedding <=> $1 (cosine distance) LIMIT 5
3. Return top-5 sections (title, content, url, similarity score)
4. Reply in Discord with best match or topic menu

Error handling:
  - Fetch fails: log, skip, next scheduled run retries
  - Embedding fails: log, fall back to FAQ-only keyword matching
  - Supabase stale: return whatever's there (stale beats absent)
  - User question embedding fails: honest error message to Discord user
```

### Supabase Schema (Zuke Project)

**Table: `public.paper_sections`**

```sql
- paper_id text          (e.g. "what-is-the-zao", "wavewarz")
- section_id text        (e.g. "q-01", "section-1")
- title text             (extracted from <h2>)
- content text           (extracted from <section>)
- content_hash text      (SHA-256 of content, for change detection)
- embedding vector(1536) (1536-dim OpenAI text-embedding-3-small)
- url text               (live thezao.xyz/papers/<slug>.html#section_id)
- updated_at timestamptz (auto-set to now() on upsert)

Primary key: (paper_id, section_id)
```

**RPC: `public.match_paper_sections(query_embedding vector(1536), match_count int default 5)`**

Returns: paper_id, section_id, title, content, url, similarity (cosine distance score, lower is better)

**Table: `public.paper_edits`** (Shell for future sub-project 2)

```sql
- id uuid primary key
- paper_id text
- section_id text       (FK to paper_sections)
- created_at timestamptz

[Future: will add proposed_by, status, etc. in sub-project 2]
```

---

## How to Continue

### Current State (as of 2026-07-13)

- [x] Bot core (`/zao` command) - live, answering FAQ-only questions
- [x] Status dashboard - live on Vercel, shows heartbeats + activity
- [x] Papers RAG foundation - shipped 2026-07-11, reindex loop running
- [x] pgvector extension enabled on Zuke Supabase
- [x] OpenAI embeddings integrated
- [ ] RAG wired into `/zao` command (fallback path exists, needs full integration)
- [ ] Papers shown in Discord replies (ready to implement)
- [ ] "Ask the papers" web surface (out of scope, sub-project 2+)

### Next Steps

1. **Test RAG end-to-end on VPS:**
   - SSH to 187.77.3.104
   - Watch `/zao` questions in the dashboard activity feed
   - Check bot logs for any RAG embedding/query failures
   - If failures, debug embeddings.ts or Supabase RPC

2. **Integrate RAG as primary search path in `/zao`:**
   - Current code tries FAQ keyword match, then offers menu
   - Update `src/commands/zao.ts` to call `matchPaperSections()` when FAQ score is low
   - Return matched section title/content/url in the embed reply
   - Fallback to FAQ + menu if RAG returns nothing

3. **Add papers to the dashboard:**
   - Extended activity feed to show which paper(s) each question matched
   - Dashboard already logs question + match success/fail; add paper_id to the meta

4. **Create "ask the papers" web surface (sub-project 2):**
   - Web form at thezao.xyz/ask (or /papers/search)
   - Same backend: embed question, call match_paper_sections RPC
   - Return results as a list with links to the live paper sections
   - No editing UI yet (that's sub-project 3)

### Known Gotchas

**Secrets:**
- `DISCORD_BOT_TOKEN`, `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are live production keys
- Never commit `.env`
- Use `setting-secrets` skill to inject secrets on VPS, never paste in chat
- See `.claude/rules/secret-hygiene.md` for scanning procedures before push

**Two Supabase Projects:**
- Cowork project (`etwvzrmlxeobinrlytza`): bot_heartbeats, bot_events tables
- Zuke project (`yhpszfepoerqgnewukkh`): paper_sections, paper_edits tables
- **Do not reuse env var names** - always use `RAG_SUPABASE_URL`/`RAG_SUPABASE_SERVICE_ROLE_KEY` for the Zuke project
- Mismixing projects breaks both the dashboard and the RAG reindex

**FAQ vs. RAG:**
- FAQPage JSON-LD lives on `/what-is-the-zao` only - this is a special page
- Other papers do not have FAQPage blocks, only `<section>/<h2>` markup
- RAG search works on all papers; FAQ keyword match works only on the one page
- No hardcoded Q&A anywhere - if the source pages drift, the bot must update its data, not its code

**pgvector Installation:**
- Already enabled on Zuke Supabase as of 2026-07-11
- If a new branch/project is created, run `ALTER EXTENSION pgvector UPDATE` before upserting to paper_sections
- Check status: `SELECT * FROM pg_extension WHERE extname = 'pgvector'`

**OpenAI API Costs:**
- Embeddings use `text-embedding-3-small` (cheapest OpenAI model, $0.02/1M tokens)
- Papers RAG reindexes every 6 hours; if all 12 papers change, ~10,000 tokens per run = ~$0.0002 per reindex
- User questions each cost ~100 tokens = ~$0.000002 per query
- Monitor `OPENAI_API_KEY` usage on your OpenAI account; add a monthly spend limit alert

**Discord Server Installations:**
- The bot installs globally (via URL generated in `/register-commands`), not guild-locked
- Any Discord server owner can add it using the public invite URL
- Bot cannot be "uninstalled" by Zaal from individual servers - each admin removes it themselves

**Vercel Dashboard:**
- Deployed automatically on every push to `main`
- If Supabase is down, dashboard shows "Status unknown" gracefully, doesn't crash
- Service role key must NOT have `NEXT_PUBLIC_` prefix (server-side only)
- Root Directory in Vercel settings MUST be `dashboard/`, not repo root

---

## Testing

### Run Locally

```bash
# All tests
npm test

# Watch mode
npm run dev  # tsx watch auto-reruns adjacent .test.ts files

# Specific test file
npm test -- src/faq.test.ts
```

### Test Patterns

- **Unit tests:** Pure functions (FAQ matching, section extraction, hashing, diff logic). No live API calls. Use mocked cheerio/fetch.
- **Integration tests:** pgvector queries (need Supabase branch via supabase-cowork MCP). Added during implementation.
- **Manual testing:** Deploy to VPS, ask `/zao` in a Discord server, watch heartbeats + events in dashboard.

---

## Troubleshooting

**Bot won't start:**
- Missing env vars? Check `.env` against `.env.example`
- Discord bot token invalid? Reset it in discord.com/developers/applications
- Supabase keys unreachable? Check VPS network, DNS, firewall

**RAG reindex failures in logs:**
- `Failed to fetch papers.json`: thezao.xyz might be down, check status
- `Failed to embed section`: OpenAI API key invalid or quota exceeded
- `Upsert failed`: Zuke Supabase connection error, check RAG_SUPABASE_URL

**Dashboard shows "Status unknown":**
- Latest heartbeat older than 10 minutes? Bot might be down or Supabase is unreachable
- Check bot logs on VPS: `journalctl --user -u zaopaperz -f`
- Check Supabase project health in the console

**Questions not matching papers:**
- Embeddings not generated? Reindex loop might be failing; check logs
- Table empty? First reindex run takes a few minutes; wait and refresh
- Similarity scores too low? Adjust `match_count` threshold in `src/commands/zao.ts`

---

## Key Files for Next Developer

- **Core bot:** `src/index.ts`, `src/commands/zao.ts`
- **FAQ logic:** `src/faq.ts`, `src/faq.test.ts`
- **RAG pipeline:** `src/rag/reindex.ts`, `src/rag/extract-sections.ts`, `src/rag/embeddings.ts`
- **Status reporting:** `src/status-reporter.ts`
- **Dashboard:** `dashboard/app/page.tsx`
- **Config:** `src/config.ts`, `.env.example`
- **Design specs:** `docs/superpowers/specs/2026-07-11-papers-*.md` (design docs, not code)
- **Systemd:** `scripts/systemd/zaopaperz.service` (deployment config)

---

## Design Documents

The project has two design specs (approved 2026-07-11) in `docs/superpowers/specs/`:

- **2026-07-11-papers-rag-foundation-design.md:** The RAG backend (schema, reindex loop, match function, data flow)
- **2026-07-11-zaopaperzbot-dashboard-design.md:** The status dashboard (heartbeats, activity feed, Vercel deployment)

Refer to these for:
- Why we fetch live papers instead of hardcoding Q&A
- Why two separate Supabase projects
- Why pgvector and OpenAI embeddings
- Next sub-projects (community editing, Zuke-conversation-to-edit pipeline, manifesto signing)

---

## License

MIT

---

## Questions?

Refer to:
- `docs/` for design context
- `.claude/rules/` in the ZAOOS repo for coding standards
- Zaal's memory files for project context
- `@zaoclaw_bot` on Telegram for quick questions

This repo is intentionally kept simple: fetch live, no hardcoding, one source of truth. Keep it that way.
