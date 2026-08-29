import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import path from "node:path";

const suite = process.argv[2] ?? "all";
const pattern = suite === "all" ? "**/*.test.js" : `${suite}/**/*.test.js`;
const cwd = path.resolve(".test-dist/tests");
const files = globSync(pattern, { cwd }).map((file) => path.join(cwd, file));
if (files.length === 0) {
  console.error(`No tests matched suite: ${suite}`);
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
