# ZAO Paperz

Discord FAQ bot for The ZAO. Answers `/zao <question>` using the live FAQPage
content at [thezao.xyz/what-is-the-zao](https://www.thezao.xyz/what-is-the-zao) -
no hardcoded Q&A in this repo, on purpose. Designed to be installed across
multiple Discord servers (global slash commands, not locked to one guild).

**Repo:** `github.com/bettercallzaal/ZAOpaperzBOT`
**Status:** v0.1 - built, not yet deployed (needs a real Discord bot token, see below)

## Why it reads live instead of hardcoding answers

Three earlier ZAO surfaces (the FAQ page, `llms.txt`, and the Technical
Whitepaper) each carried their own copy of the same facts and drifted out of
sync within days (see PRs #174, #176, #177 on ZAODEVZ/ZAOcowork - a stale
Respect-holder count and a Gini-coefficient contradiction both traced back to
duplicated facts). This bot deliberately has zero Q&A content of its own -
`src/faq.ts` fetches `/what-is-the-zao`, extracts its `FAQPage` JSON-LD block,
and answers from that. Update the website once; the bot updates within
`FAQ_REFRESH_MINUTES` (default 6h), automatically.

## What it does

- `/zao` (no argument) - posts the one-line thesis + a topic-picker select menu.
- `/zao question:<text>` - keyword-matches the question against the live FAQ's
  15 entries and replies with the closest match as an embed. Below the match
  threshold, it says so honestly and offers the topic picker instead of
  guessing.
- No LLM call in the hot path - matching is a simple keyword-overlap score,
  so replies are instant and there's no inference cost per message.

## Setup - what Zaal needs to do first

This bot needs a real Discord Application + Bot Token, which only an account
holder can create (not something I can generate):

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications).
2. **New Application** -> name it "ZAO Paperz" (or whatever you want users to see).
3. **Bot** tab -> **Reset Token** -> copy it. This is `DISCORD_BOT_TOKEN`.
4. **General Information** tab -> copy the **Application ID**. This is `DISCORD_APP_ID`.
5. **OAuth2 -> URL Generator** -> scopes: `bot` + `applications.commands` ->
   permissions: `Send Messages`, `Embed Links`, `Use Slash Commands` -> copy
   the generated URL. That URL is what you paste into any server to install
   the bot there - repeat for every server, no code changes needed.
6. Fill `.env` (copy from `.env.example`), `chmod 600 .env`.
7. `npm install && npm run register-commands` (registers the `/zao` command
   globally - takes up to ~1hr to show up in a server the first time; set
   `DISCORD_TEST_GUILD_ID` in `.env` during development for instant
   propagation to one test server).
8. `npm run start` (or deploy via systemd - see `scripts/systemd/` below).

## Architecture

```
Discord slash command /zao
        |
        v
 src/commands/zao.ts  --uses-->  src/faq.ts
                                     |
                                     v
                        fetch thezao.xyz/what-is-the-zao
                                     |
                                     v
                     extract <script type="application/ld+json">
                     FAQPage block, cache in memory (6h TTL)
                                     |
                                     v
                     keyword-overlap match against the question
                                     |
                                     v
                          reply as an embed, or offer
                          the topic-picker select menu
```

## Deployment (VPS, systemd - same pattern as ZAOscribe)

See `scripts/systemd/zaopaperz.service`. Copy to
`/etc/systemd/system/zaopaperz.service` (or `~/.config/systemd/user/` for
`--user` scope, matching the cowork bot's convention), fill in the working
directory, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now zaopaperz.service
journalctl --user -u zaopaperz -f
```

## Status dashboard

`dashboard/` is a separate Next.js app (its own `package.json`, deployed to
Vercel independently of the bot process) that shows whether the bot is
online, how many Discord servers it's installed in, FAQ cache freshness,
and a recent-activity feed of `/zao` questions.

The bot and dashboard never talk to each other directly - the bot writes
heartbeats (every 5 min) and command events (per `/zao` call) into the
`bot_heartbeats`/`bot_events` Supabase tables (same project other ZAO bots
report into), and the dashboard reads from there. Setting `SUPABASE_URL`/
`SUPABASE_SERVICE_ROLE_KEY` in the bot's `.env` is optional - without them,
the bot runs exactly as before and the dashboard just shows "status
unknown".

To run the dashboard locally: `cd dashboard && npm install && npm run dev`.

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

## Extending it

- More commands: add a file under `src/commands/`, export `data` (a
  `SlashCommandBuilder`) and `execute`, wire it into `src/index.ts` and
  `scripts/register-commands.ts`'s `commands` array.
- More source pages (e.g. pull from the Technical Whitepaper too, not just
  the FAQ): extend `src/faq.ts` to fetch additional URLs and merge their
  `FAQPage`/other structured data into one entry list - keep the "no
  hardcoded facts in this repo" rule though.
