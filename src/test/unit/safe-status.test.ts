import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { safeStatus } from "../../tools/safeStatus.js";
import type { PatchWardenConfig } from "../../config.js";

function makeConfig(workspaceRoot: string): PatchWardenConfig {
  return {
    workspaceRoot,
    plansDir: ".patchwarden/plans",
    tasksDir: ".patchwarden/tasks",
    assessmentsDir: ".patchwarden/assessments",
    assessmentTtlSeconds: 3600,
    agents: { codex: { command: "codex", args: ["exec", "{prompt}"] } },
    allowedTestCommands: ["npm test"],
    repoAllowedTestCommands: {},
    maxReadFileBytes: 200_000,
    defaultTaskTimeoutSeconds: 900,
    maxTaskTimeoutSeconds: 3600,
    watcherStaleSeconds: 30,
    directSessionsDir: ".patchwarden/direct-sessions",
    directSessionTtlSeconds: 3600,
    directMaxPatchBytes: 200_000,
    directMaxFileBytes: 500_000,
  };
}

describe("safeStatus", () => {
  let tempDir: string;
  let config: PatchWardenConfig;
  let tasksDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-safestatus-"));
    config = makeConfig(tempDir);
    tasksDir = join(tempDir, ".patchwarden", "tasks");
    mkdirSync(tasksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeTaskStatus(taskId: string, status: Record<string, unknown>) {
    const taskDir = join(tasksDir, taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
    return taskDir;
  }

  function writeTaskRuntime(taskDir: string, runtime: Record<string, unknown>) {
    writeFileSync(join(taskDir, "runtime.json"), JSON.stringify(runtime, null, 2), "utf-8");
  }

  it("returns not_found for non-existent task", () => {
    const result = safeStatus("non-existent-task", config);
    assert.equal(result.task_id, "non-existent-task");
    assert.equal(result.status, "not_found");
    assert.equal(result.phase, null);
    assert.equal(result.error_code, null);
    assert.equal(result.error_summary, null);
  });

  it("returns correct status for pending task", () => {
    writeTaskStatus("task-pending-001", {
      task_id: "task-pending-001",
      status: "pending",
      phase: "queued",
      created_at: "2026-06-24T10:00:00Z",
      updated_at: "2026-06-24T10:00:01Z",
    });

    const result = safeStatus("task-pending-001", config);
    assert.equal(result.task_id, "task-pending-001");
    assert.equal(result.status, "pending");
    assert.equal(result.created_at, "2026-06-24T10:00:00Z");
    assert.equal(result.error_code, null);
    assert.equal(result.error_summary, null);
  });

  it("returns correct status for running task", () => {
    const taskDir = writeTaskStatus("task-running-001", {
      task_id: "task-running-001",
      status: "running",
      phase: "executing_agent",
      created_at: "2026-06-24T10:00:00Z",
      started_at: "2026-06-24T10:00:05Z",
      updated_at: "2026-06-24T10:00:10Z",
    });
    writeTaskRuntime(taskDir, {
      phase: "executing_agent",
      last_heartbeat_at: "2026-06-24T10:00:12Z",
      current_command: "codex exec",
    });

    const result = safeStatus("task-running-001", config);
    assert.equal(result.status, "running");
    assert.equal(result.phase, "executing_agent");
    assert.equal(result.current_command, "codex exec");
    assert.equal(result.last_heartbeat_at, "2026-06-24T10:00:12Z");
    assert.equal(result.started_at, "2026-06-24T10:00:05Z");
  });

  it("returns correct status for done task", () => {
    writeTaskStatus("task-done-001", {
      task_id: "task-done-001",
      status: "done",
      phase: "completed",
      created_at: "2026-06-24T10:00:00Z",
      started_at: "2026-06-24T10:00:05Z",
      finished_at: "2026-06-24T10:05:00Z",
      verify_status: "passed",
    });

    const result = safeStatus("task-done-001", config);
    assert.equal(result.status, "done");
    assert.equal(result.phase, "completed");
    assert.equal(result.finished_at, "2026-06-24T10:05:00Z");
    assert.equal(result.verify_status, "passed");
    assert.equal(result.error_code, null);
  });

  it("returns correct status for failed task", () => {
    writeTaskStatus("task-failed-001", {
      task_id: "task-failed-001",
      status: "failed_verification",
      phase: "failed_verification",
      created_at: "2026-06-24T10:00:00Z",
      started_at: "2026-06-24T10:00:05Z",
      finished_at: "2026-06-24T10:05:00Z",
      error: 'Verification command "npm test" exited with code 1.',
      verify_status: "failed",
    });

    const result = safeStatus("task-failed-001", config);
    assert.equal(result.status, "failed_verification");
    assert.equal(result.error_code, "failed_verification");
    assert.ok(result.error_summary);
    assert.ok(result.error_summary!.includes("npm test"));
  });

  it("does not return diff or file content", () => {
    const taskDir = writeTaskStatus("task-safe-001", {
      task_id: "task-safe-001",
      status: "done",
      phase: "completed",
      created_at: "2026-06-24T10:00:00Z",
    });
    writeFileSync(join(taskDir, "result.md"), "# Secret result content", "utf-8");
    writeFileSync(join(taskDir, "git.diff"), "secret diff content", "utf-8");
    writeFileSync(join(taskDir, "test.log"), "secret test log", "utf-8");

    const result = safeStatus("task-safe-001", config);
    const resultStr = JSON.stringify(result);
    assert.ok(!resultStr.includes("Secret result content"));
    assert.ok(!resultStr.includes("secret diff content"));
    assert.ok(!resultStr.includes("secret test log"));
  });

  it("truncates long error messages", () => {
    const longError = "x".repeat(300);
    writeTaskStatus("task-longerror-001", {
      task_id: "task-longerror-001",
      status: "failed",
      phase: "failed",
      error: longError,
    });

    const result = safeStatus("task-longerror-001", config);
    assert.ok(result.error_summary!.length < 300);
    assert.ok(result.error_summary!.endsWith("..."));
  });

  it("returns artifact_status when present", () => {
    writeTaskStatus("task-artifact-001", {
      task_id: "task-artifact-001",
      status: "done",
      phase: "completed",
      artifact_status: "collected",
    });

    const result = safeStatus("task-artifact-001", config);
    assert.equal(result.artifact_status, "collected");
  });
});
