import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findBestMatch, type FaqEntry } from "./faq.js";

const ENTRIES: FaqEntry[] = [
  { question: "What is The ZAO?", answer: "A decentralized impact network." },
  { question: "What does ZAO stand for?", answer: "ZTalent Artist Organization." },
  { question: "Who founded The ZAO?", answer: "Zaal Panthaki." },
  { question: "Is The ZAO a record label?", answer: "No, not a record label." },
  { question: "What blockchain does The ZAO use?", answer: "Optimism, Base, and Solana depending on the lane." },
];

describe("findBestMatch", () => {
  test("exact question text matches itself with a high score", () => {
    const result = findBestMatch(ENTRIES, "What is The ZAO?");
    assert.equal(result?.entry.question, "What is The ZAO?");
    assert.ok(result!.score > 0.5, `expected high score, got ${result?.score}`);
  });

  test("a rephrased question still finds the right entry", () => {
    const result = findBestMatch(ENTRIES, "who started zao");
    assert.equal(result?.entry.question, "Who founded The ZAO?");
  });

  test("a question about chains matches the blockchain entry, not an unrelated one", () => {
    const result = findBestMatch(ENTRIES, "what chain is zao on");
    assert.equal(result?.entry.question, "What blockchain does The ZAO use?");
  });

  test("an empty query returns null rather than a false match", () => {
    const result = findBestMatch(ENTRIES, "");
    assert.equal(result, null);
  });

  test("a query of pure stopwords returns null rather than a false match", () => {
    const result = findBestMatch(ENTRIES, "what is the a an");
    assert.equal(result, null);
  });

  test("a totally unrelated question scores low against every entry", () => {
    const result = findBestMatch(ENTRIES, "what is the weather in tokyo today");
    // It will always return *a* best-of-the-worst match - the caller's
    // MATCH_THRESHOLD (in commands/zao.ts) is what decides to reject it.
    // This test just guards that the score stays low, not that it's null.
    assert.ok(result!.score < 0.34, `expected a low score for an unrelated query, got ${result?.score}`);
  });

  test("empty entries list never throws", () => {
    const result = findBestMatch([], "what is the zao");
    assert.equal(result, null);
  });
});
