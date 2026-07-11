# ZAOpaperzBOT Status Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the ZAOpaperzBOT repo a real, working status dashboard so the already-connected Vercel project has something to build (it currently fails every deploy looking for a `public/` output that doesn't exist), and give the bot a way to report its own operational status.

**Architecture:** The bot (systemd process on VPS 187.77.3.104) writes heartbeats and command events into two existing Supabase tables (`public.bot_heartbeats`, `public.bot_events`, project `etwvzrmlxeobinrlytza`) that other ZAO bots already use. A new, separate Next.js app in `dashboard/` reads those same tables and renders a status page. The bot and dashboard never talk to each other directly - only through Supabase.

**Tech Stack:** TypeScript (Node >=20, ESM/NodeNext) for the bot; Next.js 14 App Router + React 18 for the dashboard; `@supabase/supabase-js` on both sides; `node:test` + `node:assert/strict` for all tests (matches the existing `src/faq.test.ts` convention - no new test framework).

## Global Constraints

- Bot code lives under `src/`, uses ESM with NodeNext resolution - relative imports must include the `.js` extension even though the source is `.ts` (see existing `src/faq.ts`: `import { config } from "./config.js"`).
- Dashboard code lives under `dashboard/` with its own `package.json`/`tsconfig.json` - fully separate from the bot's build, matching Vercel's expectation of a distinct Root Directory.
- Reuse `public.bot_heartbeats` (one row per bot, upsert keyed on `bot`) and `public.bot_events` (append-only) exactly as-is - no new tables, no new columns, no new RLS policies.
- Both the bot and the dashboard authenticate to Supabase with the **service-role key** - confirmed 2026-07-11 that these two tables have RLS enabled with zero policies defined (default-deny for anon/authenticated roles), so the anon/publishable key cannot read or write them. Env vars are `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` everywhere, never `NEXT_PUBLIC_`-prefixed (must never reach the browser bundle).
- `bot` column value for all rows this project writes: `"zaopaperz"`.
- No live Supabase calls in any automated test - side-effecting Supabase calls are integration-tested by manual verification after deploy, not CI.
- No secrets pasted into chat or committed to the repo - actual values go through the `setting-secrets` flow (listed as a manual step below).

---

### Task 1: Bot config + pure status-reporter payload builders

**Files:**
- Modify: `package.json` (repo root) - add `@supabase/supabase-js` to `dependencies`
- Modify: `src/config.ts`
- Create: `src/status-reporter.ts`
- Test: `src/status-reporter.test.ts`

**Interfaces:**
- Produces: `config.supabaseUrl: string | undefined`, `config.supabaseServiceRoleKey: string | undefined`
- Produces: `buildHeartbeatPayload(guildCount: number, faqCacheAgeMinutes: number | null): HeartbeatPayload`
- Produces: `buildCommandEventPayload(question: string, matched: boolean, score: number | null): CommandEventPayload`
- Produces types: `HeartbeatPayload { bot: string; status: string; ts: string; meta: { guildCount: number; faqCacheAgeMinutes: number | null } }`, `CommandEventPayload { bot: string; kind: string; message: string; meta: { matched: boolean; score: number | null } }`

- [ ] **Step 1: Write the failing test**

```typescript
// src/status-reporter.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildHeartbeatPayload, buildCommandEventPayload } from "./status-reporter.js";

describe("buildHeartbeatPayload", () => {
  test("includes bot name, status, and meta fields", () => {
    const payload = buildHeartbeatPayload(7, 42);
    assert.equal(payload.bot, "zaopaperz");
    assert.equal(payload.status, "up");
    assert.equal(payload.meta.guildCount, 7);
    assert.equal(payload.meta.faqCacheAgeMinutes, 42);
    assert.ok(!Number.isNaN(new Date(payload.ts).getTime()), "ts should be a valid ISO timestamp");
  });

  test("handles a null FAQ cache age (no fetch has happened yet)", () => {
    const payload = buildHeartbeatPayload(0, null);
    assert.equal(payload.meta.faqCacheAgeMinutes, null);
  });
});

describe("buildCommandEventPayload", () => {
  test("carries the question, matched flag, and score", () => {
    const payload = buildCommandEventPayload("who founded the zao", true, 0.82);
    assert.equal(payload.bot, "zaopaperz");
    assert.equal(payload.kind, "command");
    assert.equal(payload.message, "who founded the zao");
    assert.equal(payload.meta.matched, true);
    assert.equal(payload.meta.score, 0.82);
  });

  test("truncates questions longer than 200 characters", () => {
    const longQuestion = "a".repeat(250);
    const payload = buildCommandEventPayload(longQuestion, false, null);
    assert.equal(payload.message.length, 200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL - `Cannot find module './status-reporter.js'`

- [ ] **Step 3: Add config fields**

```typescript
// src/config.ts - add these two lines to the exported `config` object,
// after the existing `logLevel` line:
  supabaseUrl: process.env.SUPABASE_URL || undefined,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
```

The full `config.ts` after this change:

```typescript
import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  discordBotToken: required("DISCORD_BOT_TOKEN"),
  discordAppId: required("DISCORD_APP_ID"),
  discordTestGuildId: process.env.DISCORD_TEST_GUILD_ID || undefined,
  faqUrl: process.env.ZAO_FAQ_URL || "https://www.thezao.xyz/what-is-the-zao",
  faqRefreshMinutes: Number(process.env.FAQ_REFRESH_MINUTES || "360"),
  logLevel: process.env.LOG_LEVEL || "info",
  supabaseUrl: process.env.SUPABASE_URL || undefined,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
};
```

- [ ] **Step 4: Write the pure payload builders**

```typescript
// src/status-reporter.ts
import { logger } from "./logger.js";

const BOT_NAME = "zaopaperz";
const MAX_MESSAGE_LENGTH = 200;

export interface HeartbeatPayload {
  bot: string;
  status: string;
  ts: string;
  meta: { guildCount: number; faqCacheAgeMinutes: number | null };
}

export interface CommandEventPayload {
  bot: string;
  kind: string;
  message: string;
  meta: { matched: boolean; score: number | null };
}

export function buildHeartbeatPayload(
  guildCount: number,
  faqCacheAgeMinutes: number | null,
): HeartbeatPayload {
  return {
    bot: BOT_NAME,
    status: "up",
    ts: new Date().toISOString(),
    meta: { guildCount, faqCacheAgeMinutes },
  };
}

export function buildCommandEventPayload(
  question: string,
  matched: boolean,
  score: number | null,
): CommandEventPayload {
  return {
    bot: BOT_NAME,
    kind: "command",
    message: question.length > MAX_MESSAGE_LENGTH ? question.slice(0, MAX_MESSAGE_LENGTH) : question,
    meta: { matched, score },
  };
}
```

(`logger` import is unused until Task 2 - leave it in now since Task 2 adds to this same file and removing/re-adding the import would be churn. If your linter flags unused imports, that's expected and resolves itself in Task 2.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS - all `status-reporter.test.ts` cases green, plus the existing `faq.test.ts` cases still green.

- [ ] **Step 6: Add the dependency and verify the build**

```bash
npm install @supabase/supabase-js
npx tsc --noEmit
```

Expected: clean install, no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/config.ts src/status-reporter.ts src/status-reporter.test.ts
git commit -m "Add Supabase config and status-reporter payload builders"
```

---

### Task 2: Heartbeat loop and command-event logging (side-effecting)

**Files:**
- Modify: `src/status-reporter.ts`

**Interfaces:**
- Consumes: `buildHeartbeatPayload`, `buildCommandEventPayload` (Task 1), `config.supabaseUrl`, `config.supabaseServiceRoleKey` (Task 1)
- Produces: `startHeartbeatLoop(getGuildCount: () => number, getFaqCacheAgeMinutes: () => number | null): void`, `logCommandEvent(question: string, matched: boolean, score: number | null): void`

No new automated test here per the Global Constraints (no live Supabase calls in CI) - this task's correctness is verified by the manual post-deploy check in Task 8's final step.

- [ ] **Step 1: Add the client, timeout helper, heartbeat loop, and event logger**

Append to `src/status-reporter.ts` (after the existing `buildCommandEventPayload` function):

```typescript
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const SUPABASE_TIMEOUT_MS = 3000;

let client: SupabaseClient | null | undefined;

function getClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  client =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey)
      : null;
  if (!client) {
    logger.warn("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set - status reporting disabled");
  }
  return client;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Supabase call timed out")), ms)),
  ]);
}

export function startHeartbeatLoop(
  getGuildCount: () => number,
  getFaqCacheAgeMinutes: () => number | null,
): void {
  const sendHeartbeat = async () => {
    const supabase = getClient();
    if (!supabase) return;
    try {
      const payload = buildHeartbeatPayload(getGuildCount(), getFaqCacheAgeMinutes());
      const { error } = await withTimeout(
        supabase.from("bot_heartbeats").upsert(payload, { onConflict: "bot" }),
        SUPABASE_TIMEOUT_MS,
      );
      if (error) throw error;
    } catch (err) {
      logger.warn({ err }, "Heartbeat write failed");
    }
  };
  void sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

export function logCommandEvent(question: string, matched: boolean, score: number | null): void {
  const supabase = getClient();
  if (!supabase) return;
  const payload = buildCommandEventPayload(question, matched, score);
  void withTimeout(supabase.from("bot_events").insert(payload), SUPABASE_TIMEOUT_MS).catch((err) => {
    logger.warn({ err }, "Command event write failed");
  });
}
```

Move the `import { createClient, ... }` and `import { config } from "./config.js";` lines to the top of the file alongside the existing `import { logger } from "./logger.js";` line (TypeScript doesn't care about import order, but keep all imports grouped at the top for readability).

- [ ] **Step 2: Run the existing tests to confirm no regression**

Run: `npm test`
Expected: PASS - Task 1's tests are unaffected since `buildHeartbeatPayload`/`buildCommandEventPayload` didn't change.

- [ ] **Step 3: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/status-reporter.ts
git commit -m "Add Supabase-backed heartbeat loop and command-event logging"
```

---

### Task 3: Wire the heartbeat loop into the bot's startup

**Files:**
- Modify: `src/faq.ts`
- Modify: `src/faq.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `getFaqCacheAgeMinutes(): number | null` (from `src/faq.ts`)
- Consumes: `startHeartbeatLoop` (Task 2)

- [ ] **Step 1: Write the failing test**

Add to `src/faq.test.ts`, right after the existing imports (add `getFaqCacheAgeMinutes` to the import line: `import { findBestMatch, getFaqCacheAgeMinutes, type FaqEntry } from "./faq.js";`), and add this new `describe` block after the existing `findBestMatch` one:

```typescript
describe("getFaqCacheAgeMinutes", () => {
  test("returns null before any fetch has happened", () => {
    // This only holds if no earlier test in this file calls getFaq() and
    // populates the module-level cache - none of the existing tests do.
    assert.equal(getFaqCacheAgeMinutes(), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL - `getFaqCacheAgeMinutes is not a function` (or a TS type error if it doesn't exist yet).

- [ ] **Step 3: Implement `getFaqCacheAgeMinutes`**

Add to `src/faq.ts`, right after the existing `getFaq` function:

```typescript
/** Minutes since the FAQ cache was last successfully fetched, or null if it's never been fetched. */
export function getFaqCacheAgeMinutes(): number | null {
  return cache ? (Date.now() - cache.fetchedAt) / 60000 : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Wire the heartbeat loop into `src/index.ts`**

```typescript
// src/index.ts - full file after the change
import { Client, GatewayIntentBits, Events, type Interaction } from "discord.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import * as zaoCommand from "./commands/zao.js";
import { startHeartbeatLoop } from "./status-reporter.js";
import { getFaqCacheAgeMinutes } from "./faq.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  logger.info({ tag: c.user.tag, guilds: c.guilds.cache.size }, "ZAO Paperz bot ready");
  startHeartbeatLoop(() => c.guilds.cache.size, getFaqCacheAgeMinutes);
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

- [ ] **Step 6: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/faq.ts src/faq.test.ts src/index.ts
git commit -m "Expose FAQ cache age and start the heartbeat loop on bot ready"
```

---

### Task 4: Log each /zao command as a bot_event

**Files:**
- Modify: `src/commands/zao.ts`

**Interfaces:**
- Consumes: `logCommandEvent` (Task 2)

- [ ] **Step 1: Add the import and call it after computing the match**

In `src/commands/zao.ts`, add to the imports:

```typescript
import { getFaq, findBestMatch } from "../faq.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { logCommandEvent } from "../status-reporter.js";
```

Replace this block in `execute()`:

```typescript
  const match = findBestMatch(faq.entries, question);
  if (!match || match.score < MATCH_THRESHOLD) {
```

with:

```typescript
  const match = findBestMatch(faq.entries, question);
  const matched = !!match && match.score >= MATCH_THRESHOLD;
  logCommandEvent(question, matched, match?.score ?? null);

  if (!matched) {
```

(This only fires when a `question` string was actually provided - the no-argument thesis-view branch above it returns early and is unaffected, which is correct: showing the topic picker isn't a question worth logging.)

- [ ] **Step 2: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean, no type errors.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS - no existing test exercises `commands/zao.ts` directly, so this is a build-level check, not a behavior regression check.

- [ ] **Step 4: Commit**

```bash
git add src/commands/zao.ts
git commit -m "Log each /zao command as a bot_event"
```

---

### Task 5: Scaffold the dashboard Next.js app

**Files:**
- Create: `dashboard/package.json`
- Create: `dashboard/tsconfig.json`
- Create: `dashboard/next.config.mjs`
- Modify: `.gitignore` (repo root)

**Interfaces:**
- Produces: a working `dashboard/` npm project (no app code yet - that's Tasks 6-7)

- [ ] **Step 1: Create `dashboard/package.json`**

```json
{
  "name": "zaopaperz-dashboard",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "node --import tsx --test lib/*.test.ts"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "next": "^14.2.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}
```

- [ ] **Step 2: Create `dashboard/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `dashboard/next.config.mjs`**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
```

- [ ] **Step 4: Add dashboard build artifacts to `.gitignore`**

Add this line to the repo root `.gitignore` (which already has `node_modules/`, so `dashboard/node_modules` is already covered):

```
.next/
```

Full `.gitignore` after the change:

```
node_modules/
dist/
.env
*.log
.next/
```

- [ ] **Step 5: Install and verify**

```bash
cd dashboard && npm install
```

Expected: installs cleanly. (There's no app code yet, so `npm run build` will fail until Task 7 adds `app/layout.tsx` and `app/page.tsx` - that's expected at this point, don't try to build yet.)

- [ ] **Step 6: Commit**

```bash
cd .. && git add dashboard/package.json dashboard/package-lock.json dashboard/tsconfig.json dashboard/next.config.mjs .gitignore
git commit -m "Scaffold dashboard Next.js project"
```

---

### Task 6: Dashboard status-derivation logic (TDD)

**Files:**
- Create: `dashboard/lib/status.ts`
- Test: `dashboard/lib/status.test.ts`

**Interfaces:**
- Produces: `Heartbeat`, `BotEvent`, `DashboardStatus`, `DashboardData` types
- Produces: `deriveStatus(heartbeat: Heartbeat | null, nowMs: number): DashboardStatus`
- Produces: `fetchLatestHeartbeat(client: SupabaseClient): Promise<Heartbeat | null>`, `fetchRecentEvents(client: SupabaseClient): Promise<BotEvent[]>`
- Produces: `getDashboardData(client: SupabaseClient | null, fetchers?: {...}, nowMs?: number): Promise<DashboardData>`

This is the one place the "mocked Supabase client -> status unknown" testing requirement from the design spec lives: `getDashboardData` takes its two fetch functions as parameters, so the test below mocks them directly instead of mocking the `@supabase/supabase-js` client shape - same coverage, much less test-harness complexity.

- [ ] **Step 1: Write the failing tests**

```typescript
// dashboard/lib/status.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveStatus, getDashboardData, type Heartbeat, type BotEvent } from "./status.js";

describe("deriveStatus", () => {
  test("a null heartbeat is offline with no data", () => {
    const result = deriveStatus(null, Date.now());
    assert.equal(result.online, false);
    assert.equal(result.lastSeen, null);
    assert.equal(result.guildCount, null);
    assert.equal(result.faqCacheAgeMinutes, null);
  });

  test("a heartbeat within the stale threshold is online", () => {
    const now = new Date("2026-07-11T12:00:00Z").getTime();
    const heartbeat: Heartbeat = {
      bot: "zaopaperz",
      status: "up",
      ts: "2026-07-11T11:55:00Z",
      meta: { guildCount: 3, faqCacheAgeMinutes: 42 },
      updated_at: "2026-07-11T11:55:00Z",
    };
    const result = deriveStatus(heartbeat, now);
    assert.equal(result.online, true);
    assert.equal(result.guildCount, 3);
    assert.equal(result.faqCacheAgeMinutes, 42);
  });

  test("a heartbeat older than the stale threshold is offline", () => {
    const now = new Date("2026-07-11T12:00:00Z").getTime();
    const heartbeat: Heartbeat = {
      bot: "zaopaperz",
      status: "up",
      ts: "2026-07-11T11:30:00Z",
      meta: {},
      updated_at: "2026-07-11T11:30:00Z",
    };
    const result = deriveStatus(heartbeat, now);
    assert.equal(result.online, false);
  });
});

describe("getDashboardData", () => {
  test("no client configured returns unknown status and no events", async () => {
    const result = await getDashboardData(null);
    assert.equal(result.status.online, false);
    assert.deepEqual(result.events, []);
  });

  test("a failing fetch falls back to status unknown instead of throwing", async () => {
    const fakeClient = {} as any;
    const failingFetchers = {
      fetchLatestHeartbeat: async () => {
        throw new Error("network down");
      },
      fetchRecentEvents: async () => {
        throw new Error("network down");
      },
    };
    const result = await getDashboardData(fakeClient, failingFetchers);
    assert.equal(result.status.online, false);
    assert.deepEqual(result.events, []);
  });

  test("a healthy mocked client returns real status and events", async () => {
    const fakeClient = {} as any;
    const now = Date.now();
    const fetchers = {
      fetchLatestHeartbeat: async () => ({
        bot: "zaopaperz",
        status: "up",
        ts: new Date(now).toISOString(),
        meta: { guildCount: 5, faqCacheAgeMinutes: 10 },
        updated_at: new Date(now).toISOString(),
      }),
      fetchRecentEvents: async () =>
        [
          {
            id: 1,
            bot: "zaopaperz",
            kind: "command",
            message: "what is the zao",
            meta: { matched: true, score: 0.9 },
            ts: new Date(now).toISOString(),
          },
        ] as BotEvent[],
    };
    const result = await getDashboardData(fakeClient, fetchers, now);
    assert.equal(result.status.online, true);
    assert.equal(result.status.guildCount, 5);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].message, "what is the zao");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test`
Expected: FAIL - `Cannot find module './status.js'`

- [ ] **Step 3: Implement `dashboard/lib/status.ts`**

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

const BOT_NAME = "zaopaperz";
const STALE_THRESHOLD_MINUTES = 10;

export interface Heartbeat {
  bot: string;
  status: string;
  ts: string;
  meta: Record<string, unknown> | null;
  updated_at: string;
}

export interface BotEvent {
  id: number;
  bot: string;
  kind: string;
  message: string;
  meta: Record<string, unknown> | null;
  ts: string;
}

export interface DashboardStatus {
  online: boolean;
  lastSeen: string | null;
  guildCount: number | null;
  faqCacheAgeMinutes: number | null;
}

export interface DashboardData {
  status: DashboardStatus;
  events: BotEvent[];
}

export function deriveStatus(heartbeat: Heartbeat | null, nowMs: number): DashboardStatus {
  if (!heartbeat) {
    return { online: false, lastSeen: null, guildCount: null, faqCacheAgeMinutes: null };
  }
  const ageMinutes = (nowMs - new Date(heartbeat.ts).getTime()) / 60000;
  const meta = heartbeat.meta ?? {};
  const guildCount = typeof meta.guildCount === "number" ? meta.guildCount : null;
  const faqCacheAgeMinutes = typeof meta.faqCacheAgeMinutes === "number" ? meta.faqCacheAgeMinutes : null;
  return {
    online: ageMinutes <= STALE_THRESHOLD_MINUTES,
    lastSeen: heartbeat.ts,
    guildCount,
    faqCacheAgeMinutes,
  };
}

export async function fetchLatestHeartbeat(client: SupabaseClient): Promise<Heartbeat | null> {
  const { data, error } = await client
    .from("bot_heartbeats")
    .select("bot, status, ts, meta, updated_at")
    .eq("bot", BOT_NAME)
    .maybeSingle();
  if (error) throw error;
  return data as Heartbeat | null;
}

export async function fetchRecentEvents(client: SupabaseClient): Promise<BotEvent[]> {
  const { data, error } = await client
    .from("bot_events")
    .select("id, bot, kind, message, meta, ts")
    .eq("bot", BOT_NAME)
    .order("ts", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as BotEvent[];
}

interface Fetchers {
  fetchLatestHeartbeat: (client: SupabaseClient) => Promise<Heartbeat | null>;
  fetchRecentEvents: (client: SupabaseClient) => Promise<BotEvent[]>;
}

const defaultFetchers: Fetchers = { fetchLatestHeartbeat, fetchRecentEvents };

export async function getDashboardData(
  client: SupabaseClient | null,
  fetchers: Fetchers = defaultFetchers,
  nowMs: number = Date.now(),
): Promise<DashboardData> {
  if (!client) {
    return { status: deriveStatus(null, nowMs), events: [] };
  }
  try {
    const [heartbeat, events] = await Promise.all([
      fetchers.fetchLatestHeartbeat(client),
      fetchers.fetchRecentEvents(client),
    ]);
    return { status: deriveStatus(heartbeat, nowMs), events };
  } catch {
    return { status: deriveStatus(null, nowMs), events: [] };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test`
Expected: PASS - all `status.test.ts` cases green.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/status.ts dashboard/lib/status.test.ts
git commit -m "Add dashboard status-derivation logic with tests"
```

---

### Task 7: Dashboard Supabase client and page UI

**Files:**
- Create: `dashboard/lib/supabase.ts`
- Create: `dashboard/app/layout.tsx`
- Create: `dashboard/app/page.tsx`

**Interfaces:**
- Consumes: `getDashboardData` (Task 6)
- Produces: `getSupabaseClient(): SupabaseClient | null`

- [ ] **Step 1: Create `dashboard/lib/supabase.ts`**

```typescript
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null | undefined;

export function getSupabaseClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  client = url && key ? createClient(url, key) : null;
  return client;
}
```

- [ ] **Step 2: Create `dashboard/app/layout.tsx`**

```tsx
import type { ReactNode } from "react";

export const metadata = { title: "ZAOpaperzBOT Status" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 3: Create `dashboard/app/page.tsx`**

```tsx
import { getSupabaseClient } from "@/lib/supabase";
import { getDashboardData } from "@/lib/status";

export const dynamic = "force-dynamic";

export default async function StatusPage() {
  const { status, events } = await getDashboardData(getSupabaseClient());

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
      <h1>ZAOpaperzBOT Status</h1>
      <p>
        <strong>{status.online ? "Online" : "Offline / unknown"}</strong>
        {status.lastSeen ? ` - last seen ${new Date(status.lastSeen).toLocaleString()}` : ""}
      </p>
      <p>Servers installed: {status.guildCount ?? "unknown"}</p>
      <p>
        FAQ cache age:{" "}
        {status.faqCacheAgeMinutes != null ? `${Math.round(status.faqCacheAgeMinutes)} min` : "unknown"}
      </p>

      <h2>Recent activity</h2>
      {events.length === 0 ? (
        <p>No recent activity recorded yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Question</th>
              <th>Matched</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.ts).toLocaleString()}</td>
                <td>{e.message}</td>
                <td>{e.meta && typeof e.meta.matched === "boolean" ? (e.meta.matched ? "yes" : "no") : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Run the dashboard build**

```bash
cd dashboard && npm run build
```

Expected: builds successfully (this is the same check Vercel will run - confirming it passes here means the Vercel deploy will too, once Root Directory is set correctly per the manual steps below).

- [ ] **Step 5: Run the dashboard tests again to confirm no regression**

```bash
npm test
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd .. && git add dashboard/lib/supabase.ts dashboard/app/layout.tsx dashboard/app/page.tsx
git commit -m "Add dashboard status page"
```

---

### Task 8: Docs, env example, and full-repo verification

**Files:**
- Modify: `README.md` (repo root)
- Modify: `.env.example` (repo root)

- [ ] **Step 1: Add Supabase vars to `.env.example`**

Append this section to `.env.example`, after the existing "Logging" section:

```
# ----- Status dashboard (optional) -----
# Enables the bot to report heartbeats/command events to Supabase for the
# dashboard/ Next.js app to read. If unset, the bot runs exactly as before -
# reporting is a no-op. Uses the SAME project as the other ZAO bots' status
# tables (etwvzrmlxeobinrlytza), service-role key required (these tables
# have RLS enabled with no anon-accessible policies).
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

- [ ] **Step 2: Add a dashboard section to `README.md`**

Append this section to `README.md`, after the existing "Deployment" section and before "Extending it":

```markdown
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
```

- [ ] **Step 3: Full-repo verification**

```bash
npm install && npm test && npx tsc --noEmit
cd dashboard && npm install && npm test && npm run build
```

Expected: everything passes - bot tests (including the new `status-reporter.test.ts` and the `faq.test.ts` addition), bot typecheck, dashboard tests, dashboard build.

- [ ] **Step 4: Commit**

```bash
cd .. && git add README.md .env.example
git commit -m "Document the status dashboard and add its env vars to .env.example"
```

---

## Manual steps (not implementation tasks - require account access this environment doesn't have)

1. **Vercel project settings**: change Root Directory from repo root to `dashboard/`, and Framework Preset from "Other" to "Next.js". Without this, Vercel keeps trying to build the bot's `src/` as a static site and will keep failing.
2. **Set secrets via the `setting-secrets` flow** (not pasted in chat):
   - Bot's `.env` on VPS 187.77.3.104: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - Vercel project env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (mark as sensitive/encrypted in Vercel, no `NEXT_PUBLIC_` prefix)
3. **Redeploy the bot** on the VPS after adding its env vars: `ssh root@187.77.3.104 'cd /opt/zaopaperz && git pull && npm install && systemctl --user restart zaopaperz.service'`, then confirm `systemctl --user status zaopaperz.service` is active.
4. **Trigger a Vercel redeploy** (push already lands on `main`, which should auto-trigger once Root Directory is fixed) and confirm the dashboard URL loads and shows real data within 5-10 minutes (one heartbeat cycle).
