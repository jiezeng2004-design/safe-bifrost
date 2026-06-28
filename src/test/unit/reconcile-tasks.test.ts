import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { reconcileTasks } from "../../tools/reconcileTasks.js";
import type { PatchWardenConfig } from "../../config.js";

// ── Test fixtures ──────────────────────────────────────────────────

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

const ALIVE_PID = process.pid;
const DEAD_PID = 999999;

function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function ageFile(filePath: string, secondsAgo: number): void {
  if (!existsSync(filePath)) return;
  const targetSec = (Date.now() - secondsAgo * 1000) / 1000;
  utimesSync(filePath, targetSec, targetSec);
}

interface TaskFixtureOptions {
  taskId: string;
  status?: string;
  phase?: string;
  heartbeatSecondsAgo?: number;
  childPid?: number;
  watcherInstanceId?: string | null;
  taskStartedSecondsAgo?: number;
  createdSecondsAgo?: number;
  stdoutSecondsAgo?: number;
  stdoutContent?: string;
  stderrSecondsAgo?: number;
  stderrContent?: string;
  resultMd?: boolean;
  testLog?: boolean;
  gitDiff?: boolean;
}

describe("reconcileTasks", () => {
  let tempDir: string;
  let config: PatchWardenConfig;
  let tasksDir: string;
  let watcherHeartbeatPath: string;
  let reconcileLogPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-reconcile-"));
    config = makeConfig(tempDir);
    tasksDir = join(tempDir, ".patchwarden", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    watcherHeartbeatPath = join(dirname(tasksDir), "watcher-heartbeat.json");
    reconcileLogPath = join(dirname(tasksDir), "reconcile.log");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildTask(opts: TaskFixtureOptions): string {
    const taskId = opts.taskId;
    const taskDir = join(tasksDir, taskId);
    mkdirSync(taskDir, { recursive: true });

    const statusSecondsAgo = opts.createdSecondsAgo ?? 600;
    const status: Record<string, unknown> = {
      task_id: taskId,
      status: opts.status ?? "running",
      phase: opts.phase ?? "executing_agent",
      created_at: isoSecondsAgo(statusSecondsAgo),
      updated_at: isoSecondsAgo(statusSecondsAgo),
    };
    if (opts.heartbeatSecondsAgo !== undefined) {
      status.last_heartbeat_at = isoSecondsAgo(opts.heartbeatSecondsAgo);
    }
    writeFileSync(join(taskDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");

    const runtime: Record<string, unknown> = {
      phase: opts.phase ?? "executing_agent",
    };
    if (opts.heartbeatSecondsAgo !== undefined) {
      runtime.last_heartbeat_at = isoSecondsAgo(opts.heartbeatSecondsAgo);
    }
    if (opts.childPid !== undefined) {
      runtime.child_pid = opts.childPid;
    }
    if (opts.watcherInstanceId !== undefined) {
      runtime.watcher_instance_id = opts.watcherInstanceId;
    }
    if (opts.taskStartedSecondsAgo !== undefined) {
      runtime.task_started_at = isoSecondsAgo(opts.taskStartedSecondsAgo);
    }
    runtime.current_command = null;
    writeFileSync(join(taskDir, "runtime.json"), JSON.stringify(runtime, null, 2), "utf-8");

    if (opts.stdoutContent !== undefined) {
      const stdoutPath = join(taskDir, "stdout.log");
      writeFileSync(stdoutPath, opts.stdoutContent, "utf-8");
      if (opts.stdoutSecondsAgo !== undefined) ageFile(stdoutPath, opts.stdoutSecondsAgo);
    }
    if (opts.stderrContent !== undefined) {
      const stderrPath = join(taskDir, "stderr.log");
      writeFileSync(stderrPath, opts.stderrContent, "utf-8");
      if (opts.stderrSecondsAgo !== undefined) ageFile(stderrPath, opts.stderrSecondsAgo);
    }
    if (opts.resultMd) {
      writeFileSync(join(taskDir, "result.md"), "# Result\nTask completed.", "utf-8");
    }
    if (opts.testLog) {
      writeFileSync(join(taskDir, "test.log"), "TAP version 13\n1..1\nok 1 test", "utf-8");
    }
    if (opts.gitDiff) {
      writeFileSync(join(taskDir, "git.diff"), "diff --git a/foo b/foo\n", "utf-8");
    }
    return taskDir;
  }

  function writeWatcherHeartbeat(instanceId: string, secondsAgo = 5): void {
    const heartbeat = {
      last_heartbeat_at: isoSecondsAgo(secondsAgo),
      pid: process.pid,
      instance_id: instanceId,
      launcher_pid: process.ppid ?? null,
    };
    writeFileSync(watcherHeartbeatPath, JSON.stringify(heartbeat, null, 2), "utf-8");
  }

  function readTaskStatus(taskId: string): Record<string, unknown> {
    const statusFile = join(tasksDir, taskId, "status.json");
    return JSON.parse(readFileSync(statusFile, "utf-8"));
  }

  // ── 1. report_only: never modifies task state ──
  it("report_only mode never modifies status.json", () => {
    buildTask({
      taskId: "task-rpo-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 600,          // stale
      childPid: DEAD_PID,              // dead
      createdSecondsAgo: 2000,
      stdoutContent: "old output\n",
      stdoutSecondsAgo: 600,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 600,
    });

    const result = reconcileTasks({ mode: "report_only" }, config);

    assert.equal(result.mode, "report_only");
    assert.equal(result.scanned, 1);
    assert.equal(result.candidates, 1);
    assert.equal(result.reconciled, 0); // no changes
    assert.equal(result.reports.length, 1);

    const report = result.reports[0];
    assert.equal(report.task_id, "task-rpo-001");
    assert.equal(report.action_taken, "left_unchanged");
    assert.equal(report.previous_status, null);
    assert.equal(report.new_status, null);

    // status.json must be unchanged
    const status = readTaskStatus("task-rpo-001");
    assert.equal(status.status, "running");

    // No backup file should exist
    assert.ok(!existsSync(join(tasksDir, "task-rpo-001", "status.json.bak")));
    // No reconcile.log should be written
    assert.ok(!existsSync(reconcileLogPath));
    assert.equal(result.reconcile_log_path, null);
  });

  // ── 2. safe_fix: only high-confidence diagnoses get applied ──
  it("safe_fix applies mark_failed_stale for high-confidence stale_running", () => {
    buildTask({
      taskId: "task-sf-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 600,
      childPid: DEAD_PID,
      createdSecondsAgo: 2000,
      stdoutContent: "old output\n",
      stdoutSecondsAgo: 600,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 600,
    });
    // No watcher heartbeat → task has no watcher_instance_id → no_runtime_record
    // → stale_running with high confidence

    const result = reconcileTasks({ mode: "safe_fix" }, config);

    assert.equal(result.mode, "safe_fix");
    assert.equal(result.reconciled, 1);
    assert.equal(result.skipped_low_confidence, 0);
    assert.equal(result.skipped_active_watcher, 0);

    const report = result.reports[0];
    assert.equal(report.action_taken, "marked_failed_stale");
    assert.equal(report.previous_status, "running");
    assert.equal(report.new_status, "failed_stale");
    assert.equal(report.applied_by, "reconcile_tasks");
    assert.ok(report.applied_at !== null);

    // status.json should reflect the new status
    const status = readTaskStatus("task-sf-001");
    assert.equal(status.status, "failed_stale");
    assert.equal(status.previous_status, "running");
    assert.equal(status.legacy_status, undefined); // only set for done_by_agent

    // Audit fields should be present
    const diagnosis = status.diagnosis as Record<string, unknown>;
    assert.equal(diagnosis.type, "stale_running");
    assert.equal(diagnosis.confidence, "high");
    assert.equal(diagnosis.applied_by, "reconcile_tasks");
    assert.ok(diagnosis.applied_at !== null);
    assert.ok(Array.isArray(diagnosis.reasons));
  });

  // ── 3. safe_fix: skips medium-confidence diagnoses ──
  it("safe_fix skips medium-confidence possibly_stale_running tasks", () => {
    buildTask({
      taskId: "task-sf-skip-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 200,          // possibly stale
      childPid: ALIVE_PID,              // alive
      watcherInstanceId: "watcher-A",
      createdSecondsAgo: 2000,
      stdoutContent: "output\n",
      stdoutSecondsAgo: 400,           // stale
      stderrContent: "stderr\n",
      stderrSecondsAgo: 400,
    });
    writeWatcherHeartbeat("watcher-A", 5);

    const result = reconcileTasks({ mode: "safe_fix" }, config);

    assert.equal(result.reconciled, 0);
    assert.equal(result.skipped_low_confidence, 1);
    assert.equal(result.skipped_active_watcher, 0);

    const report = result.reports[0];
    assert.equal(report.action_taken, "left_unchanged");
    // status.json unchanged
    const status = readTaskStatus("task-sf-skip-001");
    assert.equal(status.status, "running");
    assert.ok(!existsSync(join(tasksDir, "task-sf-skip-001", "status.json.bak")));
  });

  // ── 4. safe_fix: skips tasks still owned by an active watcher ──
  it("safe_fix skips tasks owned by an active watcher", () => {
    buildTask({
      taskId: "task-sf-owned-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 600,          // stale
      childPid: DEAD_PID,              // dead
      watcherInstanceId: "watcher-A",   // matches current watcher
      createdSecondsAgo: 2000,
      stdoutContent: "old output\n",
      stdoutSecondsAgo: 600,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 600,
    });
    writeWatcherHeartbeat("watcher-A", 5);

    const result = reconcileTasks({ mode: "safe_fix" }, config);

    assert.equal(result.reconciled, 0);
    assert.equal(result.skipped_active_watcher, 1);

    const report = result.reports[0];
    assert.equal(report.action_taken, "left_unchanged");
    assert.ok(report.reasons.some((r) => r.includes("active watcher")));

    // status.json unchanged
    const status = readTaskStatus("task-sf-owned-001");
    assert.equal(status.status, "running");
    assert.ok(!existsSync(join(tasksDir, "task-sf-owned-001", "status.json.bak")));
  });

  // ── 5. safe_fix: writes status.json.bak backup ──
  it("safe_fix writes status.json.bak with original content before changing", () => {
    buildTask({
      taskId: "task-sf-bak-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 600,
      childPid: DEAD_PID,
      createdSecondsAgo: 2000,
      stdoutContent: "old output\n",
      stdoutSecondsAgo: 600,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 600,
    });

    const originalStatusRaw = readFileSync(join(tasksDir, "task-sf-bak-001", "status.json"), "utf-8");

    reconcileTasks({ mode: "safe_fix" }, config);

    const backupPath = join(tasksDir, "task-sf-bak-001", "status.json.bak");
    assert.ok(existsSync(backupPath), "status.json.bak should exist after safe_fix");

    const backupContent = readFileSync(backupPath, "utf-8");
    assert.equal(backupContent, originalStatusRaw, "backup must match original status.json content");
  });

  // ── 6. safe_fix: writes reconcile.log with append semantics ──
  it("safe_fix writes reconcile.log at .patchwarden root", () => {
    buildTask({
      taskId: "task-sf-log-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 600,
      childPid: DEAD_PID,
      createdSecondsAgo: 2000,
      stdoutContent: "old output\n",
      stdoutSecondsAgo: 600,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 600,
    });

    const result = reconcileTasks({ mode: "safe_fix" }, config);

    assert.ok(result.reconcile_log_path !== null);
    assert.ok(existsSync(reconcileLogPath), "reconcile.log should exist");

    const logContent = readFileSync(reconcileLogPath, "utf-8");
    const logLines = logContent.trim().split("\n");
    assert.ok(logLines.length >= 1);

    const logEntry = JSON.parse(logLines[0]);
    assert.equal(logEntry.task_id, "task-sf-log-001");
    assert.equal(logEntry.previous_status, "running");
    assert.equal(logEntry.new_status, "failed_stale");
    assert.equal(logEntry.diagnosis, "stale_running");
    assert.equal(logEntry.confidence, "high");
    assert.equal(logEntry.applied_by, "reconcile_tasks");
  });

  // ── 7. safe_fix: appends to existing reconcile.log (does not overwrite) ──
  it("safe_fix appends to existing reconcile.log without overwriting", () => {
    // Pre-existing log content
    mkdirSync(dirname(reconcileLogPath), { recursive: true });
    writeFileSync(reconcileLogPath, JSON.stringify({
      timestamp: isoSecondsAgo(3600),
      task_id: "prior-task",
      previous_status: "running",
      new_status: "failed_stale",
    }) + "\n", "utf-8");

    buildTask({
      taskId: "task-sf-append-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 600,
      childPid: DEAD_PID,
      createdSecondsAgo: 2000,
      stdoutContent: "old output\n",
      stdoutSecondsAgo: 600,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 600,
    });

    reconcileTasks({ mode: "safe_fix" }, config);

    const logContent = readFileSync(reconcileLogPath, "utf-8");
    const logLines = logContent.trim().split("\n");
    assert.ok(logLines.length >= 2, "log should contain prior + new entries");

    const firstEntry = JSON.parse(logLines[0]);
    assert.equal(firstEntry.task_id, "prior-task");

    const newEntry = logLines
      .map((l) => JSON.parse(l))
      .find((e: Record<string, unknown>) => e.task_id === "task-sf-append-001");
    assert.ok(newEntry, "new task entry should be appended");
    assert.equal(newEntry.new_status, "failed_stale");
  });

  // ── 8. safe_fix: done_candidate → done_by_agent with acceptance_status=pending ──
  it("safe_fix marks done_by_agent and sets acceptance_status=pending + legacy_status=done", () => {
    buildTask({
      taskId: "task-sf-donecand-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 600,
      childPid: DEAD_PID,
      createdSecondsAgo: 2000,
      stdoutContent: "done\n",
      stdoutSecondsAgo: 600,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 600,
      resultMd: true,
      testLog: true,
      gitDiff: true,
    });
    // No watcher heartbeat → orphaned_running, but done_candidate takes priority

    const result = reconcileTasks({ mode: "safe_fix" }, config);

    assert.equal(result.reconciled, 1);

    const report = result.reports[0];
    assert.equal(report.action_taken, "marked_done_by_agent");
    assert.equal(report.new_status, "done_by_agent");

    const status = readTaskStatus("task-sf-donecand-001");
    assert.equal(status.status, "done_by_agent");
    assert.equal(status.acceptance_status, "pending");
    assert.equal(status.legacy_status, "done");
    assert.equal(status.previous_status, "running");
  });

  // ── 9. safe_fix: orphaned_running → orphaned ──
  it("safe_fix marks orphaned when watcher instance mismatches", () => {
    buildTask({
      taskId: "task-sf-orphan-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 30,           // fresh
      childPid: ALIVE_PID,
      watcherInstanceId: "watcher-old",  // mismatch
      createdSecondsAgo: 2000,
      stdoutContent: "output\n",
      stdoutSecondsAgo: 10,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 10,
    });
    writeWatcherHeartbeat("watcher-new", 5);

    const result = reconcileTasks({ mode: "safe_fix" }, config);

    // High confidence orphaned_running, not owned by current watcher
    assert.equal(result.reconciled, 1);

    const report = result.reports[0];
    assert.equal(report.action_taken, "marked_orphaned");
    assert.equal(report.new_status, "orphaned");

    const status = readTaskStatus("task-sf-orphan-001");
    assert.equal(status.status, "orphaned");
    assert.equal(status.previous_status, "running");
  });

  // ── 10. Age filter: tasks younger than max_age_minutes are skipped ──
  it("skips tasks younger than max_age_minutes", () => {
    buildTask({
      taskId: "task-young-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 10,           // fresh — active
      childPid: ALIVE_PID,
      watcherInstanceId: "watcher-A",
      createdSecondsAgo: 60,             // only 1 minute old
      stdoutContent: "running\n",
      stdoutSecondsAgo: 5,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 5,
    });
    writeWatcherHeartbeat("watcher-A", 3);

    const result = reconcileTasks({ mode: "report_only", max_age_minutes: 30 }, config);

    assert.equal(result.scanned, 1);
    assert.equal(result.candidates, 0); // too young
    assert.equal(result.reports.length, 0);
  });

  // ── 11. Non-running tasks are not candidates ──
  it("does not consider terminal tasks as candidates", () => {
    buildTask({
      taskId: "task-done-001",
      status: "done",
      phase: "completed",
      createdSecondsAgo: 1000,
    });
    buildTask({
      taskId: "task-failed-001",
      status: "failed",
      phase: "failed",
      createdSecondsAgo: 1000,
    });

    const result = reconcileTasks({ mode: "report_only" }, config);

    assert.equal(result.scanned, 2);
    assert.equal(result.candidates, 0);
  });

  // ── 12. Empty tasks dir returns zero-scanned result ──
  it("returns empty result when tasks dir is empty", () => {
    const result = reconcileTasks({ mode: "report_only" }, config);
    assert.equal(result.scanned, 0);
    assert.equal(result.candidates, 0);
    assert.equal(result.reports.length, 0);
    assert.equal(result.reconcile_log_path, null);
  });

  // ── 13. No temp file left behind after successful atomic write ──
  it("does not leave status.json.tmp behind after safe_fix", () => {
    buildTask({
      taskId: "task-sf-notmp-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 600,
      childPid: DEAD_PID,
      createdSecondsAgo: 2000,
      stdoutContent: "old output\n",
      stdoutSecondsAgo: 600,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 600,
    });

    reconcileTasks({ mode: "safe_fix" }, config);

    const tmpPath = join(tasksDir, "task-sf-notmp-001", "status.json.tmp");
    assert.ok(!existsSync(tmpPath), "status.json.tmp should not exist after rename");
  });
});
