import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { diagnoseTask } from "../../tools/diagnoseTask.js";
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

/** A PID that is guaranteed to be alive (the test process itself). */
const ALIVE_PID = process.pid;
/** A PID that is guaranteed to not exist (well above typical PID max). */
const DEAD_PID = 999999;

function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

/** Set a file's mtime to N seconds ago so diagnose_task sees it as stale or fresh. */
function ageFile(filePath: string, secondsAgo: number): void {
  if (!existsSync(filePath)) return;
  const targetMs = Date.now() - secondsAgo * 1000;
  const targetSec = targetMs / 1000;
  utimesSync(filePath, targetSec, targetSec);
}

interface TaskFixtureOptions {
  taskId: string;
  status?: string;
  phase?: string;
  heartbeatSecondsAgo?: number;         // runtime.last_heartbeat_at
  childPid?: number;                     // runtime.child_pid
  childStartedSecondsAgo?: number;       // runtime.child_started_at
  watcherInstanceId?: string | null;     // runtime.watcher_instance_id
  taskStartedSecondsAgo?: number;        // runtime.task_started_at
  stdoutSecondsAgo?: number;             // mtime of stdout.log
  stdoutContent?: string;
  stderrSecondsAgo?: number;             // mtime of stderr.log
  stderrContent?: string;
  resultMd?: boolean;
  testLog?: boolean;
  gitDiff?: boolean;
  artifactManifest?: boolean;
  createdSecondsAgo?: number;
}

describe("diagnoseTask", () => {
  let tempDir: string;
  let config: PatchWardenConfig;
  let tasksDir: string;
  let watcherHeartbeatPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-diagnose-"));
    config = makeConfig(tempDir);
    tasksDir = join(tempDir, ".patchwarden", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    watcherHeartbeatPath = join(dirname(tasksDir), "watcher-heartbeat.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Build a task fixture with status.json, runtime.json, and optional log
   * files with controlled mtimes.
   */
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
    if (opts.childStartedSecondsAgo !== undefined) {
      runtime.child_started_at = isoSecondsAgo(opts.childStartedSecondsAgo);
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
    if (opts.artifactManifest) {
      writeFileSync(join(taskDir, "artifact_manifest.json"), "{}", "utf-8");
    }
    return taskDir;
  }

  /** Write a watcher heartbeat with the given instance_id and freshness. */
  function writeWatcherHeartbeat(instanceId: string, secondsAgo = 5): void {
    const heartbeat = {
      last_heartbeat_at: isoSecondsAgo(secondsAgo),
      pid: process.pid,
      instance_id: instanceId,
      launcher_pid: process.ppid ?? null,
    };
    writeFileSync(watcherHeartbeatPath, JSON.stringify(heartbeat, null, 2), "utf-8");
  }

  // ── 1. active_running: fresh heartbeat, watcher owns, logs growing ──
  it("diagnoses active_running when heartbeat fresh, watcher owns, logs growing", () => {
    buildTask({
      taskId: "task-active-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 10,           // fresh (< 120s)
      childPid: ALIVE_PID,              // alive
      watcherInstanceId: "watcher-A",   // matches watcher
      taskStartedSecondsAgo: 60,
      stdoutContent: "Running...\n",
      stdoutSecondsAgo: 5,              // logs growing (< 120s)
      stderrContent: "stderr\n",
      stderrSecondsAgo: 5,
    });
    writeWatcherHeartbeat("watcher-A", 3);

    const result = diagnoseTask({ task_id: "task-active-001" }, config);

    assert.equal(result.diagnosis, "active_running");
    assert.equal(result.confidence, "high");
    assert.ok(result.safe_actions.includes("leave_unchanged"));
    assert.equal(result.evidence.watcher_owns_task, true);
    assert.equal(result.evidence.child_pid_alive, true);
    assert.equal(result.evidence.pid_reuse_suspected, false);
  });

  // ── 2. stale_running: heartbeat stale, PID dead, no watcher ownership, logs stale ──
  //
  // This task was started directly (e.g., via run_task MCP tool) and has no
  // watcher_instance_id in runtime, so isWatcherOwningTask returns
  // "no_runtime_record" — which does NOT trigger orphaned_running. With
  // heartbeat/PID/logs all stale, it falls through to stale_running.
  it("diagnoses stale_running when heartbeat stale, PID dead, no watcher record, logs stale", () => {
    buildTask({
      taskId: "task-stale-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 600,          // stale (> 300s)
      childPid: DEAD_PID,              // dead
      // No watcherInstanceId — simulates task started directly via run_task
      taskStartedSecondsAgo: 700,
      stdoutContent: "old output\n",
      stdoutSecondsAgo: 600,           // stale (> 300s)
      stderrContent: "old stderr\n",
      stderrSecondsAgo: 600,
    });

    const result = diagnoseTask({ task_id: "task-stale-001" }, config);

    assert.equal(result.diagnosis, "stale_running");
    assert.equal(result.confidence, "high");
    assert.ok(result.safe_actions.includes("mark_failed_stale"));
    assert.equal(result.evidence.child_pid_alive, false);
    assert.equal(result.evidence.watcher_owns_task, false);
    assert.equal(result.evidence.watcher_ownership_reason, "no_runtime_record");
  });

  // ── 3. possibly_stale_running: heartbeat possibly stale + logs stale, PID alive ──
  //
  // heartbeat is between 120-300s (possibly stale), logs are > 300s (stale),
  // and PID is alive but pidReuseSuspected is false because heartbeat is not
  // stale enough (> 300s required). This falls into possibly_stale_running.
  it("diagnoses possibly_stale_running when heartbeat possibly stale and logs stale", () => {
    buildTask({
      taskId: "task-posstale-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 200,          // possibly stale (> 120, <= 300)
      childPid: ALIVE_PID,              // alive
      watcherInstanceId: "watcher-A",
      taskStartedSecondsAgo: 300,
      stdoutContent: "output\n",
      stdoutSecondsAgo: 400,           // stale (> 300s)
      stderrContent: "stderr\n",
      stderrSecondsAgo: 400,
    });
    writeWatcherHeartbeat("watcher-A", 5);

    const result = diagnoseTask({ task_id: "task-posstale-001" }, config);

    // heartbeatPossiblyStale=true && logsStale=true → possibly_stale_running
    assert.equal(result.diagnosis, "possibly_stale_running");
    assert.equal(result.confidence, "medium");
    assert.ok(result.safe_actions.includes("leave_unchanged"));
    assert.equal(result.evidence.pid_reuse_suspected, false);
  });

  // ── 4. orphaned_running: watcher does not own task (instance mismatch) ──
  it("diagnoses orphaned_running when watcher instance_id mismatches", () => {
    buildTask({
      taskId: "task-orphan-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 30,           // fresh
      childPid: ALIVE_PID,
      watcherInstanceId: "watcher-old", // does NOT match current watcher
      taskStartedSecondsAgo: 60,
      stdoutContent: "output\n",
      stdoutSecondsAgo: 10,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 10,
    });
    writeWatcherHeartbeat("watcher-new", 5);

    const result = diagnoseTask({ task_id: "task-orphan-001" }, config);

    assert.equal(result.diagnosis, "orphaned_running");
    assert.equal(result.confidence, "high");
    assert.ok(result.safe_actions.includes("mark_orphaned"));
    assert.equal(result.evidence.watcher_owns_task, false);
    assert.equal(result.evidence.watcher_ownership_reason, "instance_mismatch");
  });

  // ── 5. artifact_collection_stuck: in collecting_artifacts and stuck ──
  it("diagnoses artifact_collection_stuck when in collecting phase and signals stale", () => {
    buildTask({
      taskId: "task-stuckart-001",
      status: "collecting_artifacts",
      phase: "collecting_artifacts",
      heartbeatSecondsAgo: 400,          // stale
      childPid: DEAD_PID,              // dead
      watcherInstanceId: "watcher-A",
      taskStartedSecondsAgo: 500,
      stdoutContent: "agent done\n",
      stdoutSecondsAgo: 400,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 400,
    });
    writeWatcherHeartbeat("watcher-A", 5);

    const result = diagnoseTask({ task_id: "task-stuckart-001" }, config);

    assert.equal(result.diagnosis, "artifact_collection_stuck");
    assert.equal(result.confidence, "high");
    assert.ok(result.safe_actions.includes("recollect_artifacts"));
    assert.ok(result.safe_actions.includes("mark_failed_stale"));
    assert.equal(result.evidence.collecting_artifacts_phase, true);
  });

  // ── 6. done_candidate: artifacts exist while status still running ──
  it("diagnoses done_candidate with high confidence when result.md + test.log exist", () => {
    buildTask({
      taskId: "task-donecand-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 400,
      childPid: DEAD_PID,
      watcherInstanceId: "watcher-old",
      taskStartedSecondsAgo: 500,
      stdoutContent: "done\n",
      stdoutSecondsAgo: 400,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 400,
      resultMd: true,
      testLog: true,
      gitDiff: true,
    });
    // No watcher heartbeat — orphaned

    const result = diagnoseTask({ task_id: "task-donecand-001" }, config);

    // done_candidate takes priority over orphaned_running because artifacts exist
    assert.equal(result.diagnosis, "done_candidate");
    assert.equal(result.confidence, "high");
    assert.ok(result.safe_actions.includes("mark_done_by_agent"));
    assert.equal(result.evidence.has_result_md, true);
    assert.equal(result.evidence.has_test_log, true);
  });

  it("diagnoses done_candidate with medium confidence when only result.md + collecting phase", () => {
    buildTask({
      taskId: "task-donecand-002",
      status: "collecting_artifacts",
      phase: "collecting_artifacts",
      heartbeatSecondsAgo: 30,           // fresh — not stuck
      childPid: ALIVE_PID,
      watcherInstanceId: "watcher-A",
      taskStartedSecondsAgo: 100,
      stdoutContent: "done\n",
      stdoutSecondsAgo: 30,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 30,
      resultMd: true,
      // No test.log/git.diff → medium signal
    });
    writeWatcherHeartbeat("watcher-A", 5);

    const result = diagnoseTask({ task_id: "task-donecand-002" }, config);

    assert.equal(result.diagnosis, "done_candidate");
    assert.equal(result.confidence, "medium");
    assert.ok(result.safe_actions.includes("mark_done_by_agent"));
    assert.ok(result.safe_actions.includes("collect_artifacts"));
  });

  // ── 7. unknown: insufficient evidence ──
  //
  // heartbeat is fresh but PID is dead and logs are stale — no single
  // branch matches with enough confidence, so it falls through to unknown.
  it("diagnoses unknown when signals conflict (fresh heartbeat but dead PID + stale logs)", () => {
    buildTask({
      taskId: "task-unknown-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 10,           // fresh — doesn't hit stale paths
      childPid: DEAD_PID,              // dead — but heartbeat says fresh
      watcherInstanceId: "watcher-A",
      taskStartedSecondsAgo: 60,
      stdoutContent: "running\n",
      stdoutSecondsAgo: 400,           // stale — but heartbeat says fresh
      stderrContent: "stderr\n",
      stderrSecondsAgo: 400,
    });
    writeWatcherHeartbeat("watcher-A", 5);

    const result = diagnoseTask({ task_id: "task-unknown-001" }, config);

    // Fresh heartbeat means not stale_running / possibly_stale_running.
    // Dead PID + stale logs means not active_running.
    // Conflicting signals → unknown.
    assert.equal(result.diagnosis, "unknown");
    assert.equal(result.confidence, "low");
    assert.ok(result.safe_actions.includes("leave_unchanged"));
  });

  // ── 8. PID reuse case: PID alive but everything else stale ──
  //
  // This is the conservative safety check: even though process.kill(pid, 0)
  // returns true, we refuse to call the task "active" because heartbeat and
  // logs are all stale. The PID may have been reused by the OS for an
  // unrelated process.
  it("refuses active_running on PID reuse: PID alive but heartbeat + logs stale", () => {
    buildTask({
      taskId: "task-pidreuse-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 600,          // very stale
      childPid: ALIVE_PID,              // alive — but probably reused!
      watcherInstanceId: "watcher-A",
      taskStartedSecondsAgo: 700,
      stdoutContent: "old output\n",
      stdoutSecondsAgo: 600,           // very stale
      stderrContent: "old stderr\n",
      stderrSecondsAgo: 600,
    });
    writeWatcherHeartbeat("watcher-A", 5);

    const result = diagnoseTask({ task_id: "task-pidreuse-001" }, config);

    // Must NOT be active_running — that would be the unsafe conclusion.
    assert.notEqual(result.diagnosis, "active_running");
    assert.equal(result.diagnosis, "possibly_stale_running");
    assert.equal(result.confidence, "medium");
    assert.equal(result.evidence.pid_reuse_suspected, true);
    assert.equal(result.evidence.child_pid_alive, true);
    assert.ok(result.reasons.some((r) => r.includes("PID reuse")));
  });

  // ── 9. terminal: already-terminal statuses return terminal diagnosis ──
  it("returns terminal diagnosis for done status", () => {
    buildTask({
      taskId: "pw-terminal-done",
      status: "done",
      phase: "completed",
      createdSecondsAgo: 1000,
    });

    const result = diagnoseTask({ task_id: "pw-terminal-done" }, config);

    assert.equal(result.diagnosis, "terminal");
    assert.equal(result.confidence, "high");
    assert.ok(result.safe_actions.includes("leave_unchanged"));
  });

  it("returns terminal diagnosis for failed_stale status (v0.7.0 status)", () => {
    buildTask({
      taskId: "pw-terminal-failed-stale",
      status: "failed_stale",
      phase: "failed_stale",
      createdSecondsAgo: 1000,
    });

    const result = diagnoseTask({ task_id: "pw-terminal-failed-stale" }, config);

    assert.equal(result.diagnosis, "terminal");
  });

  it("returns terminal diagnosis for orphaned status (v0.7.0 status)", () => {
    buildTask({
      taskId: "pw-terminal-orphaned",
      status: "orphaned",
      phase: "orphaned",
      createdSecondsAgo: 1000,
    });

    const result = diagnoseTask({ task_id: "pw-terminal-orphaned" }, config);

    assert.equal(result.diagnosis, "terminal");
  });

  it("returns terminal diagnosis for done_by_agent status (v0.7.0 status)", () => {
    buildTask({
      taskId: "pw-terminal-done-by-agent",
      status: "done_by_agent",
      phase: "done_by_agent",
      createdSecondsAgo: 1000,
    });

    const result = diagnoseTask({ task_id: "pw-terminal-done-by-agent" }, config);

    assert.equal(result.diagnosis, "terminal");
  });

  // ── include_logs flag ──
  it("includes redacted log tails when include_logs=true", () => {
    buildTask({
      taskId: "task-logs-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 10,
      childPid: ALIVE_PID,
      watcherInstanceId: "watcher-A",
      taskStartedSecondsAgo: 60,
      stdoutContent: "line1\nline2 with Bearer abcdefghijklmnop123456\n",
      stdoutSecondsAgo: 5,
      stderrContent: "stderr line\n",
      stderrSecondsAgo: 5,
    });
    writeWatcherHeartbeat("watcher-A", 3);

    const result = diagnoseTask({ task_id: "task-logs-001", include_logs: true }, config);

    assert.ok(result.logs !== null);
    assert.ok(result.logs!.stdout_tail !== null);
    assert.ok(result.logs!.stderr_tail !== null);
    // The bearer token must be redacted
    assert.ok(!result.logs!.stdout_tail!.includes("abcdefghijklmnop123456"));
    assert.ok(result.logs!.stdout_tail!.includes("[REDACTED]"));
  });

  it("omits log tails when include_logs is false (default)", () => {
    buildTask({
      taskId: "task-nologs-001",
      status: "running",
      phase: "executing_agent",
      heartbeatSecondsAgo: 10,
      childPid: ALIVE_PID,
      watcherInstanceId: "watcher-A",
      taskStartedSecondsAgo: 60,
      stdoutContent: "line1\n",
      stdoutSecondsAgo: 5,
      stderrContent: "stderr\n",
      stderrSecondsAgo: 5,
    });
    writeWatcherHeartbeat("watcher-A", 3);

    const result = diagnoseTask({ task_id: "task-nologs-001" }, config);

    assert.equal(result.logs, null);
  });

  // ── Error case: task not found ──
  it("throws when task does not exist", () => {
    // guardReadPath throws "File not found" before the existsSync check
    // produces "Task not found" — both indicate the task doesn't exist.
    assert.throws(
      () => diagnoseTask({ task_id: "non-existent-task" }, config),
      /(Task not found|File not found)/
    );
  });
});
