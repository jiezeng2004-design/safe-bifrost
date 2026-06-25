import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guardAgentCommand, guardTestCommand, guardDirectCommand, sanitizePromptArg } from "../../security/commandGuard.js";
import { PatchWardenError } from "../../errors.js";
import type { PatchWardenConfig } from "../../config.js";

function makeConfig(workspaceRoot: string): PatchWardenConfig {
  return {
    workspaceRoot,
    plansDir: ".patchwarden/plans",
    tasksDir: ".patchwarden/tasks",
    assessmentsDir: ".patchwarden/assessments",
    assessmentTtlSeconds: 3600,
    agents: {
      codex: { command: "codex", args: ["exec", "{repo}", "{prompt}"] },
      opencode: { command: "opencode", args: ["run", "{prompt}"] },
    },
    allowedTestCommands: ["npm test", "npm run build", "npm run lint"],
    repoAllowedTestCommands: {},
    maxReadFileBytes: 200_000,
    defaultTaskTimeoutSeconds: 900,
    maxTaskTimeoutSeconds: 3600,
    watcherStaleSeconds: 30,
    directSessionsDir: ".patchwarden/direct-sessions",
    directSessionTtlSeconds: 3600,
    directMaxPatchBytes: 200_000,
    directMaxFileBytes: 500_000,
    directAllowedCommands: ["npm test", "npm run build"],
    repoDirectAllowedCommands: {},
  };
}

describe("guardTestCommand", () => {
  let tempDir: string;
  let config: PatchWardenConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-cmdguard-"));
    config = makeConfig(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("allows exact match from allowlist", () => {
    assert.equal(guardTestCommand("npm test", config), "npm test");
    assert.equal(guardTestCommand("npm run build", config), "npm run build");
    assert.equal(guardTestCommand("npm run lint", config), "npm run lint");
  });

  it("trims leading spaces and matches", () => {
    assert.equal(guardTestCommand(" npm test", config), "npm test");
  });

  it("trims trailing spaces and matches", () => {
    assert.equal(guardTestCommand("npm test ", config), "npm test");
  });

  it("trims and matches with double spaces in middle (trim only affects ends)", () => {
    // "npm  test" has double space — trim() only trims ends, so "npm  test" != "npm test"
    assert.throws(
      () => guardTestCommand("npm  test", config),
      PatchWardenError
    );
  });

  it("rejects non-allowlisted commands", () => {
    assert.throws(
      () => guardTestCommand("rm -rf /", config),
      PatchWardenError
    );
    assert.throws(
      () => guardTestCommand("curl http://evil.com", config),
      PatchWardenError
    );
  });

  it("returns empty string for empty or undefined command", () => {
    assert.equal(guardTestCommand("", config), "");
    assert.equal(guardTestCommand(undefined as unknown as string, config), "");
  });

  it("returns empty string for whitespace-only command", () => {
    assert.equal(guardTestCommand("   ", config), "");
  });

  it("cannot be bypassed by parameter concatenation", () => {
    // "npm test && rm -rf /" is not in the allowlist
    assert.throws(
      () => guardTestCommand("npm test && rm -rf /", config),
      PatchWardenError
    );
    // "npm test; evil" is not in the allowlist
    assert.throws(
      () => guardTestCommand("npm test; evil", config),
      PatchWardenError
    );
  });
});

describe("guardAgentCommand", () => {
  let tempDir: string;
  let config: PatchWardenConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-agentguard-"));
    config = makeConfig(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("allows configured agents", () => {
    const result = guardAgentCommand("codex", config);
    assert.equal(result.command, "codex");
    assert.deepEqual(result.args, ["exec", "{repo}", "{prompt}"]);

    const result2 = guardAgentCommand("opencode", config);
    assert.equal(result2.command, "opencode");
  });

  it("rejects unconfigured agents", () => {
    assert.throws(
      () => guardAgentCommand("evil-agent", config),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "agent_not_configured"
    );
  });

  it("rejects empty agent name", () => {
    assert.throws(
      () => guardAgentCommand("", config),
      PatchWardenError
    );
  });
});

describe("guardDirectCommand", () => {
  let tempDir: string;
  let config: PatchWardenConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-directcmd-"));
    config = makeConfig(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("allows commands from direct allowlist", () => {
    assert.equal(guardDirectCommand("npm test", config), "npm test");
    assert.equal(guardDirectCommand("npm run build", config), "npm run build");
  });

  it("rejects non-allowlisted direct commands", () => {
    assert.throws(
      () => guardDirectCommand("rm -rf /", config),
      PatchWardenError
    );
  });

  it("rejects empty command", () => {
    assert.throws(
      () => guardDirectCommand("", config),
      PatchWardenError
    );
  });
});

describe("sanitizePromptArg", () => {
  it("removes null bytes", () => {
    const input = "hello\x00world";
    const result = sanitizePromptArg(input);
    assert.equal(result, "helloworld");
  });

  it("removes control characters (except tab and newline)", () => {
    const input = "hello\x01\x02\x03world";
    const result = sanitizePromptArg(input);
    assert.equal(result, "helloworld");
  });

  it("preserves tab characters", () => {
    const input = "hello\tworld";
    const result = sanitizePromptArg(input);
    assert.equal(result, "hello\tworld");
  });

  it("preserves newline characters", () => {
    const input = "hello\nworld";
    const result = sanitizePromptArg(input);
    assert.equal(result, "hello\nworld");
  });

  it("preserves carriage return", () => {
    const input = "hello\rworld";
    const result = sanitizePromptArg(input);
    assert.equal(result, "hello\rworld");
  });

  it("preserves normal text", () => {
    const input = "Fix the bug in main.ts";
    const result = sanitizePromptArg(input);
    assert.equal(result, input);
  });

  it("removes vertical tab and form feed", () => {
    const input = "hello\x0B\x0Cworld";
    const result = sanitizePromptArg(input);
    assert.equal(result, "helloworld");
  });

  it("handles empty string", () => {
    assert.equal(sanitizePromptArg(""), "");
  });
});
