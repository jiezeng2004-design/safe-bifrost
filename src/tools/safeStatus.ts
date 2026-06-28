import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getConfig, type PatchWardenConfig } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { guardSensitivePath } from "../security/sensitiveGuard.js";
import type { TaskStatus, TaskPhase, AcceptanceStatus } from "./createTask.js";
import { readTaskRuntime } from "../taskRuntime.js";
import { readWatcherStatus } from "../watcherStatus.js";
import { diagnoseTask, type DiagnosisType, type DiagnosisConfidence } from "./diagnoseTask.js";

export interface SafeStatusOutput {
  task_id: string;
  status: TaskStatus | "not_found";
  /**
   * v0.7.0: For done_by_agent tasks, legacy_status echoes "done" so older
   * UI/clients that do not understand done_by_agent still see a familiar value.
   * Null for all other statuses.
   */
  legacy_status: "done" | null;
  /**
   * v0.7.0: Acceptance status — only meaningful for done_by_agent.
   * - "pending": done_by_agent reached but not yet audited/accepted
   * - null: status has no acceptance semantics
   */
  acceptance_status: AcceptanceStatus;
  phase: TaskPhase | null;
  created_at: string | null;
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  last_heartbeat_at: string | null;
  current_command: string | null;
  verify_status: "passed" | "failed" | "skipped" | null;
  artifact_status: string | null;
  watcher_state: string | null;
  error_code: string | null;
  error_summary: string | null;
  /**
   * v0.7.0: Seconds since the last heartbeat. Null when heartbeat is missing
   * or unparseable. Used by callers to detect stale running tasks.
   */
  stale_seconds: number | null;
  /**
   * v0.7.0: Lightweight diagnosis snapshot derived from the same multi-signal
   * logic as diagnose_task. Only the type/confidence are surfaced here;
   * call diagnose_task for the full evidence and safe_actions.
   *
   * This field is null when status is already terminal (no diagnosis needed)
   * or when diagnosis itself fails (do not block safe_status).
   */
  diagnosis: { type: DiagnosisType; confidence: DiagnosisConfidence } | null;
}

export function safeStatus(taskId: string, config?: PatchWardenConfig): SafeStatusOutput {
  const cfg = config || getConfig();
  const tasksDir = getTasksDir(cfg);

  const taskDir = resolve(tasksDir, taskId);
  const statusFile = join(taskDir, "status.json");

  // Check existence BEFORE guardReadPath so that a non-existent task
  // returns a structured not_found response instead of throwing.
  if (!existsSync(statusFile)) {
    return {
      task_id: taskId,
      status: "not_found",
      legacy_status: null,
      acceptance_status: null,
      phase: null,
      created_at: null,
      started_at: null,
      updated_at: null,
      finished_at: null,
      last_heartbeat_at: null,
      current_command: null,
      verify_status: null,
      artifact_status: null,
      watcher_state: null,
      error_code: null,
      error_summary: null,
      stale_seconds: null,
      diagnosis: null,
    };
  }

  guardReadPath(statusFile, cfg.workspaceRoot, cfg.tasksDir);
  guardSensitivePath(statusFile);

  const raw = readFileSync(statusFile, "utf-8");
  const status = JSON.parse(raw) as Record<string, unknown>;
  const runtime = readTaskRuntime(taskDir);
  const phase = (runtime.phase || status.phase || "queued") as TaskPhase;
  const watcher = readWatcherStatus(cfg);

  // Extract short error summary — never the full error text
  let errorCode: string | null = null;
  let errorSummary: string | null = null;
  if (status.error && typeof status.error === "string") {
    const errorStr = status.error as string;
    // Keep only the first 200 chars as summary
    errorSummary = errorStr.length > 200 ? errorStr.slice(0, 200) + "..." : errorStr;
    // Try to extract an error code from the status
    if (typeof status.status === "string" && (status.status as string).startsWith("failed")) {
      errorCode = status.status as string;
    }
  } else if (typeof status.status === "string" && (status.status as string).startsWith("failed")) {
    errorCode = status.status as string;
    errorSummary = `Task ended with status: ${status.status}`;
  }

  // v0.7.2: derive legacy_status and acceptance_status
  const statusStr = (status.status as TaskStatus) || "not_found";
  const legacyStatus: "done" | null = (statusStr === "done_by_agent" || statusStr === "accepted") ? "done" : null;
  const VALID_ACCEPTANCE: AcceptanceStatus[] = ["pending", "accepted", "rejected", "needs_fix", "blocked"];
  const acceptanceStatus: AcceptanceStatus = statusStr === "done_by_agent"
    ? (typeof status.acceptance_status === "string" && VALID_ACCEPTANCE.includes(status.acceptance_status as AcceptanceStatus)
      ? (status.acceptance_status as AcceptanceStatus)
      : "pending") // default for done_by_agent when field missing
    : null;

  // v0.7.0: compute stale_seconds from the most recent heartbeat
  const heartbeatStr =
    (typeof runtime.last_heartbeat_at === "string" && runtime.last_heartbeat_at) ||
    (typeof status.last_heartbeat_at === "string" && status.last_heartbeat_at) ||
    (typeof status.updated_at === "string" && status.updated_at) ||
    null;
  let staleSeconds: number | null = null;
  if (heartbeatStr) {
    const heartbeatMs = Date.parse(heartbeatStr);
    if (Number.isFinite(heartbeatMs)) {
      staleSeconds = Math.max(0, Math.round((Date.now() - heartbeatMs) / 1000));
    }
  }

  // v0.7.0: lightweight diagnosis snapshot — only for non-terminal tasks.
  // Wrap in try/catch so a diagnosis failure never breaks safe_status.
  let diagnosis: { type: DiagnosisType; confidence: DiagnosisConfidence } | null = null;
  if (statusStr === "running" || statusStr === "collecting_artifacts" || statusStr === "pending") {
    try {
      const result = diagnoseTask({ task_id: taskId }, cfg);
      diagnosis = { type: result.diagnosis, confidence: result.confidence };
    } catch {
      diagnosis = null;
    }
  }

  return {
    task_id: taskId,
    status: statusStr,
    legacy_status: legacyStatus,
    acceptance_status: acceptanceStatus,
    phase,
    created_at: typeof status.created_at === "string" ? status.created_at : null,
    started_at: typeof status.started_at === "string" ? status.started_at : null,
    updated_at: typeof status.updated_at === "string" ? status.updated_at : null,
    finished_at: typeof status.finished_at === "string" ? status.finished_at : null,
    last_heartbeat_at: runtime.last_heartbeat_at || (typeof status.last_heartbeat_at === "string" ? status.last_heartbeat_at : null),
    current_command: runtime.current_command ?? (typeof status.current_command === "string" ? status.current_command : null) ?? null,
    verify_status: typeof status.verify_status === "string" ? (status.verify_status as "passed" | "failed" | "skipped") : null,
    artifact_status: typeof status.artifact_status === "string" ? status.artifact_status : null,
    watcher_state: watcher.status,
    error_code: errorCode,
    error_summary: errorSummary,
    stale_seconds: staleSeconds,
    diagnosis,
  };
}
