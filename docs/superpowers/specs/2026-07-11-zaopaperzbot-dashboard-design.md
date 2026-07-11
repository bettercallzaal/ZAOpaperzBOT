# ZAOpaperzBOT status dashboard - design

Status: approved 2026-07-11
Owner: Zaal

## Problem

A Vercel project is already connected to `bettercallzaal/ZAOpaperzBOT` (likely from an earlier ask to add a dashboard) and fails on every push: `No Output Directory named "public" found`. The repo is a pure discord.js bot (`src/index.ts`, deployed via systemd on VPS 187.77.3.104) - there is no web app or `public/` output anywhere in it. This spec covers building the actual dashboard so the Vercel project has something real to build and deploy.

This is intentionally scoped narrow: an operational status page for the bot. A much bigger "ZAO Paperz platform" vision (RAG-based papers-as-memory, community paper editing with contributor attribution, manifesto-signing propagation) came up in the same conversation but is explicitly out of scope here - it needs its own design pass (tracked separately) since it touches a different database question and a different set of users.

## Goals

- Fix the failing Vercel builds with a real, working dashboard.
- Show live operational status: is the bot online, how many Discord servers it's installed in, how fresh its FAQ cache is, uptime.
- Lay groundwork for phase-2 usage analytics (which questions get asked, hit/miss rate) without over-building it now - log the events, don't build the analytics UI yet.

## Non-goals

- No paper editing, no contributor attribution, no manifesto-signing flow - that's the separate ZAO Paperz platform v2 design (see follow-up task).
- No auth/login on the dashboard for this phase - it shows non-sensitive operational data only (bot online/offline, server count, anonymized question text). Revisit if that changes.
- No new Supabase project - reuses the existing `bot_heartbeats` / `bot_events` tables in the cowork Supabase project (project `etwvzrmlxeobinrlytza`), which already carry a generic `bot` text column and are used by `zaocoworking`, `zoe`, `zaodevz`, `zaostock`, `farscout`.

## Architecture

```
Discord /zao command
        |
        v
src/commands/zao.ts --uses--> src/faq.ts (existing, unchanged)
        |
        v
src/status-reporter.ts (NEW)
        |
        +--> on process start + every 5 min: upsert public.bot_heartbeats
        |     (bot='zaopaperz', status='online', meta: {guildCount, faqCacheAgeMinutes})
        |
        +--> on each /zao command: insert public.bot_events
              (bot='zaopaperz', kind='command', message=<question text, truncated to 200 chars>,
               meta: {matched: boolean, score: number})

dashboard/ (NEW, separate Next.js app in the same repo)
        |
        v
dashboard/lib/supabase.ts --reads (read-only, publishable key)--> public.bot_heartbeats, public.bot_events
        |
        v
dashboard/app/page.tsx renders:
  - online/offline (latest heartbeat within a 10-minute staleness window) + last-seen timestamp
  - server count (from latest heartbeat's meta.guildCount)
  - FAQ cache freshness (from latest heartbeat's meta.faqCacheAgeMinutes)
  - recent activity feed (last 50 bot_events rows: question text, matched/not, timestamp)
```

The bot and dashboard never talk to each other directly - they only share the Supabase tables. This means the dashboard has no dependency on the VPS being reachable from Vercel's edge network, and the bot has no dependency on Vercel being up.

## Components

- `src/status-reporter.ts` (new) - exports `startHeartbeatLoop()` (called once from `src/index.ts` on startup) and `logCommandEvent(question, matched, score)` (called from `src/commands/zao.ts` after each match attempt). Uses `@supabase/supabase-js` with a service-role-free anon key restricted to insert/upsert on these two tables (existing RLS policies apply - if they don't currently allow bot-authenticated writes, that's a small policy addition, not a new table).
- `dashboard/` (new) - a minimal Next.js 14 App Router project:
  - `dashboard/app/page.tsx` - the single status page, server component, queries Supabase at request time (no client-side fetch needed for this simple a page)
  - `dashboard/lib/supabase.ts` - thin read-only client using `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `dashboard/package.json` - separate from the bot's root `package.json` (different runtime concerns: bot is a long-running process, dashboard is a Next.js build)

## Data flow

1. Bot starts (systemd) -> `startHeartbeatLoop()` fires an immediate heartbeat, then one every 5 minutes.
2. Each `/zao` command execution -> after the existing FAQ-match logic runs, `logCommandEvent()` fires one insert.
3. Dashboard page load -> two read queries (latest heartbeat row, last 50 event rows) -> render.

## Error handling

- Supabase writes from the bot are fire-and-forget with a short timeout (e.g. 3s) and logged via the existing `pino` logger on failure - a Supabase outage must never delay or break a Discord reply.
- Dashboard queries are wrapped so a failed read or an empty `bot_heartbeats` table renders "Status unknown" rather than a crashed page.
- No retry/backoff logic needed for v1 - a missed heartbeat just means the dashboard shows slightly stale data until the next 5-minute tick.

## Testing

- `src/status-reporter.test.ts` - unit tests on the heartbeat and event payload shapes (pure functions building the object to upsert/insert), no live Supabase call in CI, following the existing pattern in `src/faq.test.ts`.
- `dashboard` - one smoke test that `app/page.tsx` renders without throwing when the Supabase client is mocked to return empty/error results (covers the "status unknown" path).

## Deployment / manual steps

- Vercel project settings: Root Directory must be changed from repo root to `dashboard/`, and Framework Preset from "Other" to "Next.js". This is a one-time manual change in the Vercel project's own settings UI - not scriptable from this environment (no `vercel` CLI/token configured here).
- New env vars needed in two places:
  - Bot's `.env` on the VPS (187.77.3.104): `SUPABASE_URL`, `SUPABASE_ANON_KEY` (or a scoped key if the write policy needs one) - added via the `setting-secrets` flow, not pasted in chat.
  - Vercel project env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable key - safe to expose client-side, read-only RLS enforces the boundary).
- If `bot_heartbeats`/`bot_events` RLS policies don't currently permit inserts from an anon-key-authenticated bot process, that policy needs a small addition scoped to `bot='zaopaperz'` (or matching whatever pattern the other bots already use - check their policies first rather than inventing a new one).

## Follow-up (out of scope here, tracked separately)

ZAO Paperz platform v2: RAG-based papers-as-memory, community paper editing with contributor attribution, and manifesto-signing propagation via ZAOpaperzBOT. Needs its own design pass - shares a database question but is a materially bigger, different-audience project than this status dashboard.
