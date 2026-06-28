import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getTasksDir, getConfig } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { writeTaskProgress } from "../taskProgress.js";
import type { TaskStatus } from "./createTask.js";

export function cancelTask(taskId: string) {
  return requestTaskTermination(taskId, false);
}

export function requestTaskTermination(taskId: string, force: boolean) {
  const config = getConfig();
  const taskDir = join(getTasksDir(config), taskId);
  const statusFile = join(taskDir, "status.json");
  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);

  if (!existsSync(statusFile)) throw new Error(`Task not found: "${taskId}"`);

  const data = JSON.parse(readFileSync(statusFile, "utf-8"));
  const currentStatus: TaskStatus = data.status;
  if (["done", "done_by_agent", "failed", "failed_verification", "failed_scope_violation", "failed_policy_violation", "canceled"].includes(currentStatus)) {
    return {
      task_id: taskId,
      previous_status: currentStatus,
      new_status: currentStatus,
      message: `Task is already ${currentStatus}. No action taken.`,
    };
  }

  const now = new Date().toISOString();
  if (currentStatus === "pending") {
    data.status = "canceled";
    data.phase = "canceled";
    data.canceled_at = now;
    data.cancel_reason = force ? "Killed before execution by user request." : "Canceled by user request.";
    data.updated_at = now;
    writeFileSync(statusFile, JSON.stringify(data, null, 2), "utf-8");
    writeTaskProgress(taskDir, "canceled", { note: data.cancel_reason, heartbeatAt: now });
    return {
      task_id: taskId,
      previous_status: "pending",
      new_status: "canceled",
      message: "Pending task canceled. It will not be executed by watcher.",
    };
  }

  data.cancel_requested = true;
  data.cancel_requested_at = now;
  data.force_kill_requested = force;
  if (force) data.kill_requested_at = now;
  data.phase = force ? "terminating" : "canceling";
  data.updated_at = now;
  writeFileSync(statusFile, JSON.stringify(data, null, 2), "utf-8");
  writeTaskProgress(taskDir, data.phase, {
    note: force ? "Immediate termination requested." : "Graceful cancellation requested.",
    heartbeatAt: now,
  });

  return {
    task_id: taskId,
    previous_status: "running",
    new_status: "running",
    cancel_requested: true,
    force_kill_requested: force,
    message: force
      ? "Kill requested. The runner that owns the child process will terminate it."
      : "Cancel requested. The runner will stop the child process safely.",
  };
}
