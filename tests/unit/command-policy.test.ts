import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { DefaultCommandAnalyzer } from "../../src/security/command-policy.js";
import { WorkspacePolicy } from "../../src/security/workspace-policy.js";
import { makeWorkspace } from "../helpers.js";

test("classifies read, destructive, network, and workspace escape commands", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const analyzer = new DefaultCommandAnalyzer(await WorkspacePolicy.create({ readableRoots: [root] }));
  assert.equal((await analyzer.analyze(process.platform === "win32" ? "dir" : "ls", root)).minimumDecision, "allow");
  assert.equal((await analyzer.analyze("git reset --hard", root)).risk, "destructive");
  assert.equal((await analyzer.analyze("curl https://example.com", root)).risk, "network");
  assert.equal((await analyzer.analyze("cd ..", root)).minimumDecision, "deny");
});
