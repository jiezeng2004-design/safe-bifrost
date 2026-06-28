import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { getTasksDir, getConfig, type PatchWardenConfig } from "../config.js";
import { diagnoseTask, type DiagnosisType, type DiagnosisConfidence, type SafeAction } from "./diagnoseTask.js";
import { syncSubgoalOnTaskDone, readTaskGoalMeta } from "../goal/subgoalSync.js";

// ── v0.7.0: reconcile_tasks types ──────────────────────────────────

export type ReconcileMode = "report_only" | "safe_fix";

export interface ReconcileTasksInput {
  max_age_minutes?: number;
  mode?: ReconcileMode;
  include_done_candidates?: boolean;
}

export interface ReconcileTaskReport {
  task_id: string;
  status: string;
  phase: string | null;
  diagnosis: DiagnosisType;
  confidence: DiagnosisConfidence;
  reasons: string[];
  safe_actions: SafeAction[];
  age_seconds: number | null;
  action_taken: "left_unchanged" | "marked_failed_stale" | "marked_orphaned" | "marked_done_by_agent";
  previous_status: string | null;
  new_status: string | null;
  applied_at: string | null;
  applied_by: string | null;
  evidence_summary: {
    heartbeat_age_seconds: number | null;
    stdout_age_seconds: number | null;
    child_pid: number | null;
    child_pid_alive: boolean | null;
    watcher_owns_task: boolean;
  };
}

export interface ReconcileTasksOutput {
  mode: ReconcileMode;
  scanned: number;
  candidates: number;
  reconciled: number;
  skipped_low_confidence: number;
  skipped_active_watcher: number;
  reports: ReconcileTaskReport[];
  reconcile_log_path: string | null;
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_MAX_AGE_MINUTES = 30;
const RECONCILE_LOG_NAME = "reconcile.log";

// ── Main entry point ──────────────────────────────────────────────

export function reconcileTasks(
  input: ReconcileTasksInput = {},
  config: PatchWardenConfig = getConfig()
): ReconcileTasksOutput {
  const mode: ReconcileMode = input.mode === "safe_fix" ? "safe_fix" : "report_only";
  const maxAgeMinutes =
    typeof input.max_age_minutes === "number" && input.max_age_minutes > 0
      ? Math.min(input.max_age_minutes, 24 * 60)
      : DEFAULT_MAX_AGE_MINUTES;
  const includeDoneCandidates = input.include_done_candidates !== false; // default true
  const maxAgeSeconds = maxAgeMinutes * 60;

  const tasksDir = getTasksDir(config);
  const reports: ReconcileTaskReport[] = [];
  let scanned = 0;
  let candidates = 0;
  let reconciled = 0;
  let skippedLowConfidence = 0;
  let skippedActiveWatcher = 0;
  const nowMs = Date.now();

  if (!existsSync(tasksDir)) {
    return {
      mode,
      scanned: 0,
      candidates: 0,
      reconciled: 0,
      skipped_low_confidence: 0,
      skipped_active_watcher: 0,
      reports: [],
      reconcile_log_path: null,
    };
  }

  let entries: Dirent[] = [];
  try {
    entries = readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return {
      mode,
      scanned: 0,
      candidates: 0,
      reconciled: 0,
      skipped_low_confidence: 0,
      skipped_active_watcher: 0,
      reports: [],
      reconcile_log_path: null,
    };
  }

  const taskDirs = entries.filter((e) => e.isDirectory());

  for (const entry of taskDirs) {
    scanned += 1;
    const taskId = entry.name;
    const taskDir = resolve(tasksDir, taskId);
    const statusFile = join(taskDir, "status.json");
    if (!existsSync(statusFile)) continue;

    let statusData: Record<string, unknown>;
    try {
      statusData = JSON.parse(readFileSync(statusFile, "utf-8"));
    } catch {
      continue; // corrupted status, skip
    }

    const statusStr = typeof statusData.status === "string" ? statusData.status : "unknown";

    // Filter: only running / collecting_artifacts / (optionally) done_by_agent candidates
    const isCandidate =
      statusStr === "running" ||
      statusStr === "collecting_artifacts" ||
      (includeDoneCandidates && statusStr === "done_by_agent");
    if (!isCandidate) continue;

    // Filter by age — use the oldest reliable timestamp on the task
    const ageSeconds = taskAgeSeconds(taskDir, statusData, nowMs);
    if (ageSeconds !== null && ageSeconds < maxAgeSeconds) continue;

    candidates += 1;

    // Diagnose the task
    let diagnosis;
    try {
      diagnosis = diagnoseTask({ task_id: taskId }, config);
    } catch {
      continue; // diagnosis failed — skip
    }

    const report: ReconcileTaskReport = {
      task_id: taskId,
      status: diagnosis.status,
      phase: diagnosis.phase,
      diagnosis: diagnosis.diagnosis,
      confidence: diagnosis.confidence,
      reasons: diagnosis.reasons,
      safe_actions: diagnosis.safe_actions,
      age_seconds: ageSeconds,
      action_taken: "left_unchanged",
      previous_status: null,
      new_status: null,
      applied_at: null,
      applied_by: null,
      evidence_summary: {
        heartbeat_age_seconds: diagnosis.evidence.heartbeat_age_seconds,
        stdout_age_seconds: diagnosis.evidence.stdout_age_seconds,
        child_pid: diagnosis.evidence.child_pid,
        child_pid_alive: diagnosis.evidence.child_pid_alive,
        watcher_owns_task: diagnosis.evidence.watcher_owns_task,
      },
    };

    // ── safe_fix rules ──
    //
    // safe_fix is ONLY applied when:
    //   1. mode === "safe_fix"
    //   2. diagnosis.confidence === "high"
    //   3. The task is NOT still owned by an active watcher (we must not
    //      touch tasks the live watcher is executing).
    //   4. The diagnosis type maps to a reconcilable action.
    //
    // Anything else is left_unchanged and recorded for audit.

    if (mode === "safe_fix" && diagnosis.confidence === "high") {
      if (diagnosis.evidence.watcher_owns_task) {
        // Hard rule: do not touch tasks the live watcher still owns.
        skippedActiveWatcher += 1;
        report.reasons = [
          ...report.reasons,
          "safe_fix skipped: task is still owned by an active watcher instance",
        ];
      } else {
        const fixResult = applySafeFix(taskDir, taskId, statusData, diagnosis.diagnosis, diagnosis.reasons, diagnosis.evidence, config);
        if (fixResult.applied) {
          report.action_taken = fixResult.action_taken;
          report.previous_status = fixResult.previous_status;
          report.new_status = fixResult.new_status;
          report.applied_at = fixResult.applied_at;
          report.applied_by = "reconcile_tasks";
          reconciled += 1;
        } else {
          // Diagnosis type does not map to a safe_fix action — leave unchanged
          report.reasons = [
            ...report.reasons,
            `safe_fix skipped: diagnosis "${diagnosis.diagnosis}" has no automatic safe_fix action`,
          ];
          skippedLowConfidence += 1;
        }
      }
    } else if (mode === "safe_fix" && diagnosis.confidence !== "high") {
      skippedLowConfidence += 1;
      report.reasons = [
        ...report.reasons,
        `safe_fix skipped: confidence is "${diagnosis.confidence}", only "high" is eligible`,
      ];
    }

    if (reports.length < 200) {
      reports.push(report);
    }
    if (reports.length >= 200) break;
  }

  // ── Write reconcile.log when safe_fix applied any change ──
  let reconcileLogPath: string | null = null;
  if (mode === "safe_fix" && reconciled > 0) {
    reconcileLogPath = writeReconcileLog(tasksDir, config, reports.filter((r) => r.action_taken !== "left_unchanged"));
  }

  return {
    mode,
    scanned,
    candidates,
    reconciled,
    skipped_low_confidence: skippedLowConfidence,
    skipped_active_watcher: skippedActiveWatcher,
    reports,
    reconcile_log_path: reconcileLogPath,
  };
}

// ── safe_fix application ──────────────────────────────────────────

interface SafeFixResult {
  applied: boolean;
  action_taken: ReconcileTaskReport["action_taken"];
  previous_status: string;
  new_status: string;
  applied_at: string;
}

function applySafeFix(
  taskDir: string,
  taskId: string,
  currentStatus: Record<string, unknown>,
  diagnosis: DiagnosisType,
  reasons: string[],
  evidence: {
    heartbeat_age_seconds: number | null;
    stdout_age_seconds: number | null;
    child_pid: number | null;
    child_pid_alive: boolean | null;
    watcher_owns_task: boolean;
    watcher_instance_id: string | null;
    current_watcher_instance_id: string | null;
  },
  config: PatchWardenConfig
): SafeFixResult {
  // Map diagnosis type to new status. Only high-confidence, well-understood
  // diagnoses are eligible. "possibly_stale_running" and "unknown" are NOT
  // eligible even if confidence were high (which they never are).
  const previousStatus = typeof currentStatus.status === "string" ? currentStatus.status : "unknown";
  let newStatus: string | null = null;
  let actionTaken: ReconcileTaskReport["action_taken"] = "left_unchanged";

  switch (diagnosis) {
    case "stale_running":
      newStatus = "failed_stale";
      actionTaken = "marked_failed_stale";
      break;
    case "orphaned_running":
      newStatus = "orphaned";
      actionTaken = "marked_orphaned";
      break;
    case "done_candidate":
      newStatus = "done_by_agent";
      actionTaken = "marked_done_by_agent";
      break;
    case "artifact_collection_stuck":
      // Treat as failed_stale — artifact collection should not hang.
      newStatus = "failed_stale";
      actionTaken = "marked_failed_stale";
      break;
    default:
      // active_running, possibly_stale_running, unknown, terminal — not eligible
      return {
        applied: false,
        action_taken: "left_unchanged",
        previous_status: previousStatus,
        new_status: previousStatus,
        applied_at: new Date().toISOString(),
      };
  }

  const appliedAt = new Date().toISOString();
  const statusFile = join(taskDir, "status.json");
  const backupFile = join(taskDir, "status.json.bak");

  // 1. Write status.json.bak with current contents (overwrite any prior backup)
  try {
    const currentRaw = readFileSync(statusFile, "utf-8");
    writeFileSync(backupFile, currentRaw, "utf-8");
  } catch {
    // If we cannot back up, refuse to apply the fix.
    return {
      applied: false,
      action_taken: "left_unchanged",
      previous_status: previousStatus,
      new_status: previousStatus,
      applied_at: appliedAt,
    };
  }

  // 2. Build the new status record with full audit trail
  const next: Record<string, unknown> = {
    ...currentStatus,
    status: newStatus,
    phase: newStatus,
    updated_at: appliedAt,
    last_heartbeat_at: appliedAt,
    finished_at: appliedAt,
    // v0.7.0 audit fields
    previous_status: previousStatus,
    diagnosis: {
      type: diagnosis,
      confidence: "high" as DiagnosisConfidence,
      applied_by: "reconcile_tasks",
      applied_at: appliedAt,
      reasons,
      evidence: {
        heartbeat_age_seconds: evidence.heartbeat_age_seconds,
        stdout_age_seconds: evidence.stdout_age_seconds,
        child_pid: evidence.child_pid,
        child_pid_alive: evidence.child_pid_alive,
        watcher_instance_id: evidence.watcher_instance_id,
        current_watcher_instance_id: evidence.current_watcher_instance_id,
      },
    },
  };

  // For done_by_agent, set acceptance_status=pending (per roadmap 3.6)
  if (newStatus === "done_by_agent") {
    next.acceptance_status = "pending";
    next.legacy_status = "done";
  }

  // 3. Atomic write: write to temp file then rename
  const tmpFile = join(taskDir, "status.json.tmp");
  try {
    writeFileSync(tmpFile, JSON.stringify(next, null, 2), "utf-8");
    renameSync(tmpFile, statusFile);
  } catch {
    // Best-effort cleanup of temp file
    try {
      if (existsSync(tmpFile)) {
        unlinkSync(tmpFile);
      }
    } catch { /* ignore */ }
    return {
      applied: false,
      action_taken: "left_unchanged",
      previous_status: previousStatus,
      new_status: previousStatus,
      applied_at: appliedAt,
    };
  }

  // v0.8.0: 当状态变为 done_by_agent 时，同步关联 subgoal 状态（running → done_by_agent）
  if (newStatus === "done_by_agent") {
    const goalMeta = readTaskGoalMeta(taskDir);
    if (goalMeta.subgoal_id) {
      syncSubgoalOnTaskDone(taskId, goalMeta, config.workspaceRoot);
    }
  }

  return {
    applied: true,
    action_taken: actionTaken,
    previous_status: previousStatus,
    new_status: newStatus,
    applied_at: appliedAt,
  };
}

// ── reconcile.log writer ───────────────────────────────────────────

function writeReconcileLog(
  tasksDir: string,
  config: PatchWardenConfig,
  appliedReports: ReconcileTaskReport[]
): string {
  // The reconcile.log lives at the .patchwarden/ root (parent of tasksDir),
  // so it captures every reconcile run across all tasks.
  const logDir = dirname(tasksDir);
  const logPath = join(logDir, RECONCILE_LOG_NAME);
  try {
    mkdirSync(logDir, { recursive: true });
  } catch { /* ignore */ }

  const lines: string[] = [];
  for (const report of appliedReports) {
    lines.push(JSON.stringify({
      timestamp: report.applied_at,
      task_id: report.task_id,
      previous_status: report.previous_status,
      new_status: report.new_status,
      diagnosis: report.diagnosis,
      confidence: report.confidence,
      applied_by: report.applied_by,
      reasons: report.reasons,
      evidence: report.evidence_summary,
    }));
  }
  // Append — do not overwrite history
  const existing = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
  const nextContent = existing + (existing && !existing.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n";
  try {
    writeFileSync(logPath, nextContent, "utf-8");
  } catch {
    // If we cannot write the log, the status change still happened —
    // the status.json itself contains the diagnosis audit fields.
  }
  return logPath;
}

// ── Task age helper ────────────────────────────────────────────────

function taskAgeSeconds(
  taskDir: string,
  status: Record<string, unknown>,
  nowMs: number
): number | null {
  // Prefer created_at; fall back to status.json mtime.
  const createdStr = typeof status.created_at === "string" ? status.created_at : null;
  if (createdStr) {
    const ms = Date.parse(createdStr);
    if (Number.isFinite(ms)) {
      return Math.max(0, Math.round((nowMs - ms) / 1000));
    }
  }
  try {
    const stat = statSync(join(taskDir, "status.json"));
    return Math.max(0, Math.round((nowMs - stat.mtimeMs) / 1000));
  } catch {
    return null;
  }
}
