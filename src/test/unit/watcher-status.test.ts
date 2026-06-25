import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, mkdir } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { PatchWardenConfig } from "../../config.js";
import { readWatcherStatus, getWatcherHeartbeatPath } from "../../watcherStatus.js";

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

describe("readWatcherStatus — watcher stale fallback", () => {
  let tempDir: string;
  let config: PatchWardenConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-watcher-test-"));
    config = makeConfig(tempDir);
    mkdirSync(join(tempDir, ".patchwarden", "tasks"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns missing when no heartbeat and no running task", () => {
    const result = readWatcherStatus(config, Date.now());
    assert.equal(result.status, "missing");
    assert.equal(result.available, false);
    assert.equal(result.activity, null);
  });

  it("returns healthy when watcher heartbeat is fresh", () => {
    const heartbeatPath = getWatcherHeartbeatPath(config);
    mkdirSync(dirname(heartbeatPath), { recursive: true });
    writeFileSync(heartbeatPath, JSON.stringify({
      status: "running",
      pid: process.pid,
      last_heartbeat_at: new Date().toISOString(),
    }), "utf-8");

    const result = readWatcherStatus(config, Date.now());
    assert.equal(result.status, "healthy");
    assert.equal(result.available, true);
    assert.equal(result.activity, null);
  });

  it("returns stale when watcher heartbeat is old and no running task", () => {
    const heartbeatPath = getWatcherHeartbeatPath(config);
    mkdirSync(dirname(heartbeatPath), { recursive: true });
    const oldTime = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(heartbeatPath, JSON.stringify({
      status: "running",
      pid: process.pid,
      last_heartbeat_at: oldTime,
    }), "utf-8");

    const result = readWatcherStatus(config, Date.now());
    assert.equal(result.status, "stale");
    assert.equal(result.available, false);
    assert.equal(result.activity, null);
  });

  it("returns healthy when watcher heartbeat is stale but a running task has fresh heartbeat", () => {
    // Write stale watcher heartbeat
    const heartbeatPath = getWatcherHeartbeatPath(config);
    mkdirSync(dirname(heartbeatPath), { recursive: true });
    const oldTime = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(heartbeatPath, JSON.stringify({
      status: "running",
      pid: process.pid,
      last_heartbeat_at: oldTime,
    }), "utf-8");

    // Create a running task with fresh heartbeat
    const taskDir = join(tempDir, ".patchwarden", "tasks", "test-task-001");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.json"), JSON.stringify({
      status: "running",
      task_id: "test-task-001",
    }), "utf-8");
    writeFileSync(join(taskDir, "runtime.json"), JSON.stringify({
      phase: "executing_agent",
      last_heartbeat_at: new Date().toISOString(),
      current_command: "codex exec",
    }), "utf-8");

    const result = readWatcherStatus(config, Date.now());
    assert.equal(result.status, "healthy");
    assert.equal(result.available, true);
    assert.ok(result.activity);
    assert.match(result.activity!, /test-task-001/);
  });

  it("returns healthy when watcher heartbeat is missing but a running task has fresh heartbeat", () => {
    // No watcher heartbeat file at all
    // Create a running task with fresh heartbeat
    const taskDir = join(tempDir, ".patchwarden", "tasks", "test-task-002");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.json"), JSON.stringify({
      status: "running",
      task_id: "test-task-002",
    }), "utf-8");
    writeFileSync(join(taskDir, "runtime.json"), JSON.stringify({
      phase: "running_tests",
      last_heartbeat_at: new Date().toISOString(),
      current_command: "npm test",
    }), "utf-8");

    const result = readWatcherStatus(config, Date.now());
    assert.equal(result.status, "healthy");
    assert.equal(result.available, true);
    assert.ok(result.activity);
    assert.match(result.activity!, /test-task-002/);
  });

  it("returns stale when both watcher heartbeat and task heartbeat are old", () => {
    const heartbeatPath = getWatcherHeartbeatPath(config);
    mkdirSync(dirname(heartbeatPath), { recursive: true });
    const oldTime = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(heartbeatPath, JSON.stringify({
      status: "running",
      pid: process.pid,
      last_heartbeat_at: oldTime,
    }), "utf-8");

    const taskDir = join(tempDir, ".patchwarden", "tasks", "test-task-003");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.json"), JSON.stringify({
      status: "running",
      task_id: "test-task-003",
    }), "utf-8");
    writeFileSync(join(taskDir, "runtime.json"), JSON.stringify({
      phase: "executing_agent",
      last_heartbeat_at: oldTime,
      current_command: "codex exec",
    }), "utf-8");

    const result = readWatcherStatus(config, Date.now());
    assert.equal(result.status, "stale");
    assert.equal(result.available, false);
    assert.equal(result.activity, null);
  });

  it("does not fall back to non-running tasks", () => {
    const heartbeatPath = getWatcherHeartbeatPath(config);
    mkdirSync(dirname(heartbeatPath), { recursive: true });
    const oldTime = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(heartbeatPath, JSON.stringify({
      status: "running",
      pid: process.pid,
      last_heartbeat_at: oldTime,
    }), "utf-8");

    // Done task with fresh heartbeat should not trigger fallback
    const taskDir = join(tempDir, ".patchwarden", "tasks", "test-task-004");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.json"), JSON.stringify({
      status: "done",
      task_id: "test-task-004",
    }), "utf-8");
    writeFileSync(join(taskDir, "runtime.json"), JSON.stringify({
      phase: "completed",
      last_heartbeat_at: new Date().toISOString(),
      current_command: null,
    }), "utf-8");

    const result = readWatcherStatus(config, Date.now());
    assert.equal(result.status, "stale");
    assert.equal(result.available, false);
  });
});
