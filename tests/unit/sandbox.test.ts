import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createSandboxProfile, LocalSandboxProvider, SandboxCapabilityError, SandboxManager, WindowsDockerSandboxProvider, type SandboxProvider } from "../../src/security/sandbox.js";
import { makeWorkspace } from "../helpers.js";

test("local provider is explicitly best effort and cannot satisfy a required strict profile", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new LocalSandboxProvider(root);
  assert.equal(provider.capabilities().enforcement, "best_effort");
  assert.equal(provider.capabilities().filesystemEnforced, false);
  assert.throws(
    () => new SandboxManager(provider).admit(createSandboxProfile(root, 100, "required"), { filesystem: "workspace" }),
    (error: unknown) => error instanceof SandboxCapabilityError && error.missing.includes("OS-enforced sandbox"),
  );
});

test("sandbox manager accepts a provider only when strict guarantees are declared", async () => {
  const provider: SandboxProvider = {
    capabilities: () => ({
      filesystem: "workspace", network: "deny", subprocess: true, workingDirectory: true,
      environment: "filtered", timeout: true, cancellation: true, osEnforced: true,
      enforcement: "container", filesystemEnforced: true, networkEnforced: true,
      processTreeTracked: true, shellDialect: "bash", platform: "test-container",
    }),
    async execute() { return { stdout: "", stderr: "", exitCode: 0, timedOut: false, cancelled: false }; },
  };
  const root = await makeWorkspace();
  try {
    const admission = new SandboxManager(provider).admit(createSandboxProfile(root, 100, "required"), { filesystem: "workspace", subprocess: true });
    assert.equal(admission.capabilities.enforcement, "container");
    assert.equal(admission.profile.network.mode, "deny");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("local provider does not pass arbitrary environment patch keys to children", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new LocalSandboxProvider(root);
  const result = await provider.execute({
    command: process.platform === "win32" ? "echo %SWE_AGENT_TEST_SECRET%" : "printf '%s' \"$SWE_AGENT_TEST_SECRET\"",
    cwd: root,
    timeoutMs: 1_000,
    env: { SWE_AGENT_TEST_SECRET: "should-not-cross-boundary" },
    requirements: { filesystem: "workspace", subprocess: true, workingDirectory: true, environment: "filtered", timeout: true, cancellation: true },
  });
  assert.doesNotMatch(result.stdout, /should-not-cross-boundary/);
});

test("Windows Docker provider advertises a container boundary only on Windows", () => {
  const provider = new WindowsDockerSandboxProvider(process.cwd());
  if (process.platform === "win32") {
    assert.equal(provider.capabilities().enforcement, "container");
    assert.equal(provider.capabilities().networkEnforced, true);
  } else {
    assert.equal(provider.capabilities().enforcement, "none");
  }
});
