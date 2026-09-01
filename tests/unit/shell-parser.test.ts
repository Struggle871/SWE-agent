import assert from "node:assert/strict";
import test from "node:test";
import { parseShell } from "../../src/security/shell-ast.js";
import { tokenizeShell } from "../../src/security/shell-tokenizer.js";

test("tokenizer keeps quoted and escaped operators inside one word", () => {
  const tokens = tokenizeShell(`echo "a;b"; echo a\\;b`, "bash");
  assert.deepEqual(tokens.map((token) => token.value), ["echo", "a;b", ";", "echo", "a;b"]);
  assert.equal(tokens[1].quoted, true);
  assert.equal(tokens[4].quoted, true);
});

test("parser builds command relations, redirects, and nested groups", () => {
  const ast = parseShell(`(cat "a;b" && echo $(pwd)) | tee out.txt >> log.txt &`, "bash");
  assert.deepEqual(ast.operators, ["|", "&"]);
  assert.equal(ast.commands[0].kind, "group");
  assert.deepEqual(ast.commands[0].body.operators, ["&&"]);
  assert.equal(ast.commands[1].kind, "command");
  if (ast.commands[1].kind === "command") {
    assert.deepEqual(ast.commands[1].redirects.map((redirect) => redirect.operator), [">>"]);
    assert.equal(ast.commands[1].redirects[0].target?.value, "log.txt");
  }
});

test("unterminated quotes are parse failures instead of partial commands", () => {
  assert.throws(() => tokenizeShell(`echo "unfinished`, "bash"), /未闭合引号/);
});
