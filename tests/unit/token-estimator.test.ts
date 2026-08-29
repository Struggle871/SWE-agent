import assert from "node:assert/strict";
import test from "node:test";
import { estimateTextTokens, tokenCountWithAnchor } from "../../src/core/context/token-estimator.js";

test("counts CJK more densely and honors usage anchors", () => {
  assert.equal(estimateTextTokens("测试"), 2);
  assert.equal(estimateTextTokens("abcd"), 1);
  const count = tokenCountWithAnchor([
    { role: "assistant", content: "ignored", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } },
    { role: "user", content: "abcd" },
  ]);
  assert.equal(count, 15);
});
