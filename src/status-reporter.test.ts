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
    assert.ok(!Number.isNaN(new Date(payload.ts).getTime()), "ts should be a valid ISO timestamp");
  });

  test("truncates questions longer than 200 characters", () => {
    const longQuestion = "a".repeat(250);
    const payload = buildCommandEventPayload(longQuestion, false, null);
    assert.equal(payload.message.length, 200);
    assert.ok(!Number.isNaN(new Date(payload.ts).getTime()), "ts should be a valid ISO timestamp");
  });
});
