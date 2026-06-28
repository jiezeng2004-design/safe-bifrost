import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskPhase } from "./tools/createTask.js";

export interface TaskRuntimeData {
  phase: TaskPhase;
  last_heartbeat_at: string;
  current_command: string | null;
  runner_pid?: number;
  child_pid?: number;
  /**
   * v0.7.0: ISO timestamp when the child process was spawned.
   * Used by diagnose_task to detect PID reuse: if a live PID exists but
   * its start time does not match child_started_at, the OS likely reused the PID.
   */
  child_started_at?: string;
  /**
   * v0.7.0: ISO timestamp when the task itself started (runner began executing).
   * Distinct from child_started_at, which records when the agent child process spawned.
   */
  task_started_at?: string;
  /**
   * v0.7.0: Watcher instance ID that picked up and is executing this task.
   * Used by diagnose_task to detect orphaned tasks when the current watcher
   * instance_id differs from the one recorded at task start.
   */
  watcher_instance_id?: string;
}

export function readTaskRuntime(taskDir: string): Partial<TaskRuntimeData> {
  const runtimeFile = join(taskDir, "runtime.json");
  if (!existsSync(runtimeFile)) return {};
  try {
    return JSON.parse(readFileSync(runtimeFile, "utf-8")) as Partial<TaskRuntimeData>;
  } catch {
    return {};
  }
}

export function writeTaskRuntime(
  taskDir: string,
  patch: Partial<TaskRuntimeData>
): TaskRuntimeData {
  const current = readTaskRuntime(taskDir);
  const next = {
    phase: "preparing" as TaskPhase,
    last_heartbeat_at: new Date().toISOString(),
    current_command: null,
    ...current,
    ...patch,
  };
  writeFileSync(join(taskDir, "runtime.json"), JSON.stringify(next, null, 2), "utf-8");
  return next;
}
