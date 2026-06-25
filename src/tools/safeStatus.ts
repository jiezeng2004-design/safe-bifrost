import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getConfig, type PatchWardenConfig } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { guardSensitivePath } from "../security/sensitiveGuard.js";
import type { TaskStatus, TaskPhase } from "./createTask.js";
import { readTaskRuntime } from "../taskRuntime.js";
import { readWatcherStatus } from "../watcherStatus.js";

export interface SafeStatusOutput {
  task_id: string;
  status: TaskStatus | "not_found";
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

  return {
    task_id: taskId,
    status: (status.status as TaskStatus) || "not_found",
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
  };
}
