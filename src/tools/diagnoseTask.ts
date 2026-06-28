import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getTasksDir, getConfig, type PatchWardenConfig } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { guardSensitivePath } from "../security/sensitiveGuard.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import { readTaskRuntime } from "../taskRuntime.js";
import { isWatcherOwningTask, readWatcherInstanceId } from "../watcherStatus.js";

// ── v0.7.0: Task diagnosis types ──────────────────────────────────

export type DiagnosisType =
  | "active_running"
  | "stale_running"
  | "possibly_stale_running"
  | "orphaned_running"
  | "artifact_collection_stuck"
  | "done_candidate"
  | "unknown"
  | "terminal";

export type DiagnosisConfidence = "high" | "medium" | "low";

export type SafeAction =
  | "leave_unchanged"
  | "mark_failed_stale"
  | "mark_orphaned"
  | "mark_done_by_agent"
  | "collect_artifacts"
  | "recollect_artifacts"
  | "needs_fix";

export interface DiagnosisEvidence {
  heartbeat_age_seconds: number | null;
  stdout_age_seconds: number | null;
  stderr_age_seconds: number | null;
  stdout_size_bytes: number | null;
  stderr_size_bytes: number | null;
  child_pid: number | null;
  child_pid_alive: boolean | null;
  child_started_at: string | null;
  pid_reuse_suspected: boolean;
  watcher_instance_id: string | null;
  current_watcher_instance_id: string | null;
  watcher_owns_task: boolean;
  watcher_ownership_reason: string;
  has_result_md: boolean;
  has_test_log: boolean;
  has_git_diff: boolean;
  has_artifact_manifest: boolean;
  task_started_at: string | null;
  status_updated_at: string | null;
  collecting_artifacts_phase: boolean;
}

export interface DiagnoseTaskOutput {
  task_id: string;
  status: string;
  phase: string | null;
  diagnosis: DiagnosisType;
  confidence: DiagnosisConfidence;
  reasons: string[];
  safe_actions: SafeAction[];
  evidence: DiagnosisEvidence;
  logs: { stdout_tail: string | null; stderr_tail: string | null } | null;
}

export interface DiagnoseTaskInput {
  task_id: string;
  include_logs?: boolean;
}

// ── Thresholds (seconds) ──────────────────────────────────────────
//
// These are intentionally conservative. A task is only "stale" when multiple
// signals agree. A single stale signal produces "possibly_stale_running" or
// "unknown", never an automatic safe_fix.

const HEARTBEAT_STALE_SECONDS = 300;          // 5 min: heartbeat this old is a strong stale signal
const HEARTBEAT_POSSIBLY_STALE_SECONDS = 120; // 2 min: heartbeat this old is a weak stale signal
const LOG_STALE_SECONDS = 300;                 // 5 min: stdout/stderr unchanged this long is stale
const LOG_TAIL_LINES = 40;

// ── PID liveness check ─────────────────────────────────────────────

/**
 * Check whether a PID is alive without sending a signal that could disturb it.
 * Returns null when the check itself fails (e.g., permission denied),
 * so callers can avoid treating "couldn't check" as "process is dead".
 */
function isPidAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // process.kill(pid, 0) does not actually kill; it just checks liveness.
    // It throws if the process does not exist or the caller lacks permission.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false; // No such process
    if (code === "EPERM") return null;  // Alive but not ours — treat as unknown
    return null;
  }
}

// ── File age helper ────────────────────────────────────────────────

function fileAgeSeconds(filePath: string, nowMs: number): { age: number; size: number } | null {
  if (!existsSync(filePath)) return null;
  try {
    const stat = statSync(filePath);
    return { age: Math.max(0, Math.round((nowMs - stat.mtimeMs) / 1000)), size: stat.size };
  } catch {
    return null;
  }
}

function readTailLines(filePath: string, lines: number): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const tail = raw.split("\n").slice(-lines).join("\n");
    return redactSensitiveContent(tail).content;
  } catch {
    return null;
  }
}

// ── Main diagnosis entry point ─────────────────────────────────────

export function diagnoseTask(
  input: DiagnoseTaskInput,
  config: PatchWardenConfig = getConfig()
): DiagnoseTaskOutput {
  const taskId = input.task_id;
  const tasksDir = getTasksDir(config);
  const taskDir = resolve(tasksDir, taskId);
  const statusFile = join(taskDir, "status.json");

  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);
  guardSensitivePath(statusFile);

  if (!existsSync(statusFile)) {
    throw new Error(`Task not found: "${taskId}". Check the task ID or call list_tasks.`);
  }

  const raw = readFileSync(statusFile, "utf-8");
  const status = JSON.parse(raw) as Record<string, unknown>;
  const runtime = readTaskRuntime(taskDir);
  const nowMs = Date.now();

  const statusStr = typeof status.status === "string" ? status.status : "unknown";
  const phaseStr = (runtime.phase || (typeof status.phase === "string" ? status.phase : "queued")) as string;

  // ── Terminal tasks: no diagnosis needed ──
  const terminalStatuses = new Set([
    "done", "done_by_agent", "failed", "failed_verification",
    "failed_scope_violation", "failed_policy_violation",
    "failed_stale", "orphaned", "canceled",
  ]);
  if (terminalStatuses.has(statusStr)) {
    return buildTerminalDiagnosis(taskId, statusStr, phaseStr);
  }

  // ── Only diagnose running / collecting_artifacts / pending ──
  if (statusStr !== "running" && statusStr !== "collecting_artifacts" && statusStr !== "pending") {
    return buildUnknownDiagnosis(taskId, statusStr, phaseStr, [`unexpected status "${statusStr}" for diagnosis`]);
  }

  // ── Gather evidence ──
  const heartbeatStr =
    (typeof runtime.last_heartbeat_at === "string" && runtime.last_heartbeat_at) ||
    (typeof status.last_heartbeat_at === "string" && status.last_heartbeat_at) ||
    (typeof status.updated_at === "string" && status.updated_at) ||
    null;
  const heartbeatMs = heartbeatStr ? Date.parse(heartbeatStr) : NaN;
  const heartbeatAgeSeconds = Number.isFinite(heartbeatMs)
    ? Math.max(0, Math.round((nowMs - heartbeatMs) / 1000))
    : null;

  const stdoutPath = join(taskDir, "stdout.log");
  const stderrPath = join(taskDir, "stderr.log");
  const stdoutStat = fileAgeSeconds(stdoutPath, nowMs);
  const stderrStat = fileAgeSeconds(stderrPath, nowMs);

  const resultMdPath = join(taskDir, "result.md");
  const testLogPath = join(taskDir, "test.log");
  const gitDiffPath = join(taskDir, "git.diff");
  const artifactManifestPath = join(taskDir, "artifact_manifest.json");

  const hasResultMd = existsSync(resultMdPath);
  const hasTestLog = existsSync(testLogPath);
  const hasGitDiff = existsSync(gitDiffPath);
  const hasArtifactManifest = existsSync(artifactManifestPath);

  const childPid = typeof runtime.child_pid === "number" ? runtime.child_pid : null;
  const childStartedAt = typeof runtime.child_started_at === "string" ? runtime.child_started_at : null;
  const childPidAlive = childPid !== null ? isPidAlive(childPid) : null;

  // PID reuse heuristic: PID is alive but child_started_at is much older than
  // the heartbeat threshold AND logs are stale. We cannot reliably read the
  // OS process start time without platform-specific code, so we treat
  // "PID alive + everything else stale" as a PID-reuse signal rather than
  // "active". This is the conservative choice required by the safety contract.
  const pidReuseSuspected =
    childPidAlive === true &&
    heartbeatAgeSeconds !== null &&
    heartbeatAgeSeconds > HEARTBEAT_STALE_SECONDS &&
    (stdoutStat === null || stdoutStat.age > LOG_STALE_SECONDS) &&
    (stderrStat === null || stderrStat.age > LOG_STALE_SECONDS);

  const ownership = isWatcherOwningTask(taskDir, config);
  const currentWatcherInstanceId = readWatcherInstanceId(config);

  const collectingArtifactsPhase =
    phaseStr === "collecting_artifacts" || statusStr === "collecting_artifacts";

  const taskStartedAt =
    typeof runtime.task_started_at === "string"
      ? runtime.task_started_at
      : typeof status.started_at === "string"
        ? (status.started_at as string)
        : null;
  const statusUpdatedAt = typeof status.updated_at === "string" ? (status.updated_at as string) : null;

  const evidence: DiagnosisEvidence = {
    heartbeat_age_seconds: heartbeatAgeSeconds,
    stdout_age_seconds: stdoutStat?.age ?? null,
    stderr_age_seconds: stderrStat?.age ?? null,
    stdout_size_bytes: stdoutStat?.size ?? null,
    stderr_size_bytes: stderrStat?.size ?? null,
    child_pid: childPid,
    child_pid_alive: childPidAlive,
    child_started_at: childStartedAt,
    pid_reuse_suspected: pidReuseSuspected,
    watcher_instance_id: ownership.task_watcher_instance_id,
    current_watcher_instance_id: currentWatcherInstanceId,
    watcher_owns_task: ownership.owned,
    watcher_ownership_reason: ownership.reason,
    has_result_md: hasResultMd,
    has_test_log: hasTestLog,
    has_git_diff: hasGitDiff,
    has_artifact_manifest: hasArtifactManifest,
    task_started_at: taskStartedAt,
    status_updated_at: statusUpdatedAt,
    collecting_artifacts_phase: collectingArtifactsPhase,
  };

  // ── Decision tree ──
  //
  // The diagnosis must NEVER rely on a single signal. Each branch below
  // combines at least two signals before producing a high-confidence
  // conclusion. When signals conflict, confidence drops to medium/low.

  const reasons: string[] = [];
  const heartbeatStale = heartbeatAgeSeconds !== null && heartbeatAgeSeconds > HEARTBEAT_STALE_SECONDS;
  const heartbeatPossiblyStale =
    heartbeatAgeSeconds !== null &&
    heartbeatAgeSeconds > HEARTBEAT_POSSIBLY_STALE_SECONDS &&
    heartbeatAgeSeconds <= HEARTBEAT_STALE_SECONDS;
  const heartbeatFresh = heartbeatAgeSeconds !== null && heartbeatAgeSeconds <= HEARTBEAT_POSSIBLY_STALE_SECONDS;
  const logsStale =
    (stdoutStat === null || stdoutStat.age > LOG_STALE_SECONDS) &&
    (stderrStat === null || stderrStat.age > LOG_STALE_SECONDS);
  const logsGrowing =
    stdoutStat !== null && stdoutStat.age <= HEARTBEAT_POSSIBLY_STALE_SECONDS;

  // Collect artifact evidence strings
  if (heartbeatStale) reasons.push(`heartbeat older than ${HEARTBEAT_STALE_SECONDS}s (age: ${heartbeatAgeSeconds}s)`);
  if (heartbeatPossiblyStale) reasons.push(`heartbeat older than ${HEARTBEAT_POSSIBLY_STALE_SECONDS}s (age: ${heartbeatAgeSeconds}s)`);
  if (stdoutStat && stdoutStat.age > LOG_STALE_SECONDS) reasons.push(`stdout.log unchanged for ${stdoutStat.age}s`);
  if (stderrStat && stderrStat.age > LOG_STALE_SECONDS) reasons.push(`stderr.log unchanged for ${stderrStat.age}s`);
  if (childPidAlive === false) reasons.push(`child_pid ${childPid} is not alive`);
  if (pidReuseSuspected) reasons.push(`PID ${childPid} is alive but all other signals are stale — suspected PID reuse`);
  if (!ownership.owned && ownership.reason === "instance_mismatch") {
    reasons.push(`watcher_instance_id mismatch: task=${ownership.task_watcher_instance_id}, current=${ownership.current_watcher_instance_id}`);
  }
  if (!ownership.owned && ownership.reason === "watcher_missing") {
    reasons.push("watcher heartbeat is missing — no live watcher owns this task");
  }
  if (!ownership.owned && ownership.reason === "no_runtime_record") {
    reasons.push("task runtime has no watcher_instance_id recorded — ownership cannot be confirmed");
  }
  if (hasResultMd) reasons.push("result.md already exists while status is still running");
  if (hasTestLog) reasons.push("test.log already exists while status is still running");

  // ── done_candidate: artifacts exist but status not converged ──
  // Strong signal: result.md + test.log + git.diff all exist, status still running.
  // Medium signal: only result.md exists.
  if (hasResultMd && (hasTestLog || hasGitDiff)) {
    return buildResult(taskId, statusStr, phaseStr, "done_candidate", "high", reasons, [
      "mark_done_by_agent",
      "leave_unchanged",
    ], evidence, input.include_logs ? { stdoutPath, stderrPath } : null);
  }
  if (hasResultMd && collectingArtifactsPhase) {
    return buildResult(taskId, statusStr, phaseStr, "done_candidate", "medium", reasons, [
      "mark_done_by_agent",
      "collect_artifacts",
      "leave_unchanged",
    ], evidence, input.include_logs ? { stdoutPath, stderrPath } : null);
  }

  // ── orphaned_running: watcher does not own the task ──
  if (!ownership.owned && (ownership.reason === "instance_mismatch" || ownership.reason === "watcher_missing")) {
    return buildResult(taskId, statusStr, phaseStr, "orphaned_running", "high", reasons, [
      "mark_orphaned",
      "leave_unchanged",
    ], evidence, input.include_logs ? { stdoutPath, stderrPath } : null);
  }

  // ── artifact_collection_stuck: in collecting_artifacts phase and stuck ──
  if (collectingArtifactsPhase) {
    const collectionStuck =
      (heartbeatStale || heartbeatPossiblyStale) && (logsStale || childPidAlive === false);
    if (collectionStuck) {
      return buildResult(taskId, statusStr, phaseStr, "artifact_collection_stuck", "high", reasons, [
        "recollect_artifacts",
        "mark_failed_stale",
        "leave_unchanged",
      ], evidence, input.include_logs ? { stdoutPath, stderrPath } : null);
    }
    // Collecting but not clearly stuck — possibly still active
    if (heartbeatFresh || logsGrowing) {
      return buildResult(taskId, statusStr, phaseStr, "active_running", "medium", reasons, [
        "leave_unchanged",
      ], evidence, input.include_logs ? { stdoutPath, stderrPath } : null);
    }
    return buildResult(taskId, statusStr, phaseStr, "artifact_collection_stuck", "medium", reasons, [
      "recollect_artifacts",
      "leave_unchanged",
    ], evidence, input.include_logs ? { stdoutPath, stderrPath } : null);
  }

  // ── active_running: heartbeat fresh, watcher owns, logs growing or PID alive ──
  if (heartbeatFresh && ownership.owned && (logsGrowing || childPidAlive === true)) {
    return buildResult(taskId, statusStr, phaseStr, "active_running", "high", reasons, [
      "leave_unchanged",
    ], evidence, input.include_logs ? { stdoutPath, stderrPath } : null);
  }

  // ── stale_running: heartbeat stale, PID dead, watcher doesn't own ──
  if (heartbeatStale && (childPidAlive === false || !ownership.owned) && logsStale) {
    return buildResult(taskId, statusStr, phaseStr, "stale_running", "high", reasons, [
      "mark_failed_stale",
      "collect_artifacts",
      "leave_unchanged",
    ], evidence, input.include_logs ? { stdoutPath, stderrPath } : null);
  }

  // ── possibly_stale_running: some stale signals but not enough for high confidence ──
  // This branch catches the PID-reuse-suspected case as well: PID is alive
  // but everything else is stale. We refuse to call it "active".
  if (pidReuseSuspected) {
    return buildResult(taskId, statusStr, phaseStr, "possibly_stale_running", "medium", reasons, [
      "leave_unchanged",
      "mark_failed_stale",
    ], evidence, input.include_logs ? { stdoutPath, stderrPath } : null);
  }
  if (heartbeatStale || (heartbeatPossiblyStale && (logsStale || !ownership.owned))) {
    return buildResult(taskId, statusStr, phaseStr, "possibly_stale_running", "medium", reasons, [
      "leave_unchanged",
      "mark_failed_stale",
    ], evidence, input.include_logs ? { stdoutPath, stderrPath } : null);
  }

  // ── unknown: insufficient evidence ──
  return buildResult(taskId, statusStr, phaseStr, "unknown", "low", reasons, [
    "leave_unchanged",
  ], evidence, input.include_logs ? { stdoutPath, stderrPath } : null);
}

// ── Result builders ─────────────────────────────────────────────────

function buildResult(
  taskId: string,
  status: string,
  phase: string | null,
  diagnosis: DiagnosisType,
  confidence: DiagnosisConfidence,
  reasons: string[],
  safeActions: SafeAction[],
  evidence: DiagnosisEvidence,
  logPaths: { stdoutPath: string; stderrPath: string } | null
): DiagnoseTaskOutput {
  return {
    task_id: taskId,
    status,
    phase,
    diagnosis,
    confidence,
    reasons,
    safe_actions: safeActions,
    evidence,
    logs: logPaths
      ? {
          stdout_tail: readTailLines(logPaths.stdoutPath, LOG_TAIL_LINES),
          stderr_tail: readTailLines(logPaths.stderrPath, Math.min(LOG_TAIL_LINES, 20)),
        }
      : null,
  };
}

function buildTerminalDiagnosis(taskId: string, status: string, phase: string | null): DiagnoseTaskOutput {
  return {
    task_id: taskId,
    status,
    phase,
    diagnosis: "terminal",
    confidence: "high",
    reasons: [`status "${status}" is already terminal; no reconciliation needed`],
    safe_actions: ["leave_unchanged"],
    evidence: emptyEvidence(),
    logs: null,
  };
}

function buildUnknownDiagnosis(
  taskId: string,
  status: string,
  phase: string | null,
  extraReasons: string[]
): DiagnoseTaskOutput {
  return {
    task_id: taskId,
    status,
    phase,
    diagnosis: "unknown",
    confidence: "low",
    reasons: ["insufficient evidence to diagnose", ...extraReasons],
    safe_actions: ["leave_unchanged"],
    evidence: emptyEvidence(),
    logs: null,
  };
}

function emptyEvidence(): DiagnosisEvidence {
  return {
    heartbeat_age_seconds: null,
    stdout_age_seconds: null,
    stderr_age_seconds: null,
    stdout_size_bytes: null,
    stderr_size_bytes: null,
    child_pid: null,
    child_pid_alive: null,
    child_started_at: null,
    pid_reuse_suspected: false,
    watcher_instance_id: null,
    current_watcher_instance_id: null,
    watcher_owns_task: false,
    watcher_ownership_reason: "no_runtime_record",
    has_result_md: false,
    has_test_log: false,
    has_git_diff: false,
    has_artifact_manifest: false,
    task_started_at: null,
    status_updated_at: null,
    collecting_artifacts_phase: false,
  };
}
