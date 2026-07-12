import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildEmbeddingRequest } from "./embeddings.js";

describe("buildEmbeddingRequest", () => {
  test("uses the text-embedding-3-small model with the given input", () => {
    const req = buildEmbeddingRequest("what is the zao");
    assert.equal(req.model, "text-embedding-3-small");
    assert.equal(req.input, "what is the zao");
  });
});
