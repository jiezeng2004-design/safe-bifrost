import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getPlansDir, getConfig } from "../config.js";
import { guardPath } from "../security/pathGuard.js";
import { readTaskRuntime } from "../taskRuntime.js";
import type { TaskPhase, TaskStatus, AcceptanceStatus } from "./createTask.js";
import {
  derivePendingReason,
  readWatcherStatus,
  type PendingReason,
  type WatcherState,
  type WatcherStatusSnapshot,
} from "../watcherStatus.js";

export interface TaskEntry {
  task_id: string;
  plan_id: string;
  title: string;
  agent: string;
  status: TaskStatus;
  phase: TaskPhase;
  acceptance_status: AcceptanceStatus;
  created_at: string;
  updated_at: string;
  workspace_root: string;
  repo_path: string;
  resolved_repo_path: string;
  test_command: string;
  verify_commands: string[];
  error: string | null;
  last_heartbeat_at: string;
  current_command: string | null;
  timeout_seconds: number;
  pending_reason: PendingReason;
  watcher_status: WatcherState;
}

export interface ListTasksInput {
  status?: string;
  repo_path?: string;
  active_only?: boolean;
  acceptance_status?: string;
  limit?: number;
}

export interface ListTasksOutput {
  tasks: TaskEntry[];
  total: number;
  returned: number;
  watcher: WatcherStatusSnapshot;
}

export function listTasks(input?: ListTasksInput): ListTasksOutput {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const plansDir = getPlansDir(config);
  const limit = input?.limit && input.limit > 0 ? Math.min(input.limit, 100) : 20;
  const filterStatus = input?.status || null;
  const filterAcceptance = input?.acceptance_status || null;
  const filterRepo = input?.repo_path?.trim().replace(/\\/g, "/") || null;
  const watcher = readWatcherStatus(config);

  if (!existsSync(tasksDir)) {
    return { tasks: [], total: 0, returned: 0, watcher };
  }

  const entries = readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => {
      // Sort by mtime descending (newest first)
      try {
        const sa = statSync(join(tasksDir, a.name, "status.json"));
        const sb = statSync(join(tasksDir, b.name, "status.json"));
        return sb.mtimeMs - sa.mtimeMs;
      } catch {
        return b.name.localeCompare(a.name);
      }
    });

  const tasks: TaskEntry[] = [];
  let totalMatched = 0;

  for (const entry of entries) {
    const taskId = entry.name;
    const taskDir = join(tasksDir, taskId);
    const statusFile = join(taskDir, "status.json");

    if (!existsSync(statusFile)) continue;

    try {
      const data = JSON.parse(readFileSync(statusFile, "utf-8"));
      const runtime = readTaskRuntime(taskDir);
      if (filterStatus && data.status !== filterStatus) continue;
      if (filterAcceptance) {
        const taskAcceptance = data.status === "done_by_agent"
          ? (typeof data.acceptance_status === "string" ? data.acceptance_status : "pending")
          : null;
        if (taskAcceptance !== filterAcceptance) continue;
      }
      if (input?.active_only && data.status !== "pending" && data.status !== "running") continue;
      const normalizedRepo = String(data.repo_path || ".").replace(/\\/g, "/");
      const normalizedResolvedRepo = String(data.resolved_repo_path || "").replace(/\\/g, "/");
      if (filterRepo && normalizedRepo !== filterRepo && normalizedResolvedRepo !== filterRepo) continue;
      totalMatched++;
      if (tasks.length >= limit) continue;

      // Read plan title from plans directory (not task dir)
      let title = `Plan: ${data.plan_id || "unknown"}`;
      if (data.plan_id) {
        const planFile = join(plansDir, data.plan_id, "plan.md");
        if (existsSync(planFile)) {
          try {
            const planContent = readFileSync(planFile, "utf-8");
            const titleMatch = planContent.match(/^#\s*(.+)/m);
            if (titleMatch) title = titleMatch[1];
          } catch { /* keep default */ }
        }
      }

      const phase = runtime.phase || data.phase || "queued";
      const VALID_ACCEPTANCE = ["pending", "accepted", "rejected", "needs_fix", "blocked"];
      const acceptanceStatus: AcceptanceStatus = data.status === "done_by_agent"
        ? (typeof data.acceptance_status === "string" && VALID_ACCEPTANCE.includes(data.acceptance_status) ? data.acceptance_status : "pending")
        : null;
      tasks.push({
        task_id: taskId,
        plan_id: data.plan_id || "",
        title,
        agent: data.agent || "",
        status: data.status || "pending",
        phase,
        acceptance_status: acceptanceStatus,
        created_at: data.created_at || "",
        updated_at: data.updated_at || "",
        workspace_root: data.workspace_root || config.workspaceRoot,
        repo_path: data.repo_path || ".",
        resolved_repo_path: data.resolved_repo_path || data.repo_path || config.workspaceRoot,
        test_command: data.test_command || "",
        verify_commands: Array.isArray(data.verify_commands) ? data.verify_commands : [],
        error: data.error || null,
        last_heartbeat_at: runtime.last_heartbeat_at || data.last_heartbeat_at || data.updated_at || "",
        current_command: runtime.current_command ?? data.current_command ?? null,
        timeout_seconds: data.timeout_seconds || config.defaultTaskTimeoutSeconds,
        pending_reason: derivePendingReason({ status: data.status, phase }, watcher),
        watcher_status: watcher.status,
      });
    } catch {
      // skip corrupted entries
    }
  }

  return { tasks, total: totalMatched, returned: tasks.length, watcher };
}
