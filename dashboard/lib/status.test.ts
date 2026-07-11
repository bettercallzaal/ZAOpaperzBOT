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
