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
