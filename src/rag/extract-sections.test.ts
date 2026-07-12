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
