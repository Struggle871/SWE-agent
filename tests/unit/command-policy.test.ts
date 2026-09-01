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

test("merges every command in a chain conservatively", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const analyzer = new DefaultCommandAnalyzer(await WorkspacePolicy.create({ readableRoots: [root] }), "bash");
  const assessment = await analyzer.analyze(`echo "a;b" && rm -rf /`, root);
  assert.equal(assessment.minimumDecision, "deny");
  assert.equal(assessment.risk, "destructive");
  assert.equal(assessment.nodes?.length, 2);
  assert.ok(assessment.reasons.some((reason) => reason.includes("控制关系")));
});

test("dynamic expansion and redirection are never automatic allow", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const analyzer = new DefaultCommandAnalyzer(await WorkspacePolicy.create({ readableRoots: [root] }), "bash");
  const dynamic = await analyzer.analyze("ls *.ts", root);
  const redirected = await analyzer.analyze("ls > result.txt", root);
  assert.equal(dynamic.minimumDecision, "ask");
  assert.equal(redirected.minimumDecision, "ask");
});
