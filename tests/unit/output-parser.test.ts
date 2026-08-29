import assert from "node:assert/strict";
import test from "node:test";
import { OutputParser, ParseError } from "../../src/core/output-parser.js";

const parser = new OutputParser();
const tools = new Set(["read_file", "run_command"]);

test("parses JSON tool actions", () => {
  assert.deepEqual(parser.parse('{"thought":"read","action":"read_file","action_input":{"path":"a.ts"}}', tools), {
    type: "tool_call", thought: "read", toolName: "read_file", toolInput: { path: "a.ts" },
  });
});

test("falls back to ReAct and rejects unknown tools", () => {
  assert.equal(parser.parse("Thought: done\nFinal Answer: ok", tools).type, "final_answer");
  assert.deepEqual(parser.parse("Thought: inspect\nAction: run_command\nAction Input: {\"command\":\"dir\"}", tools), {
    type: "tool_call", thought: "inspect", toolName: "run_command", toolInput: { command: "dir" },
  });
  assert.throws(() => parser.parse('{"action":"missing","action_input":{}}', tools), ParseError);
});
