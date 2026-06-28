import { setTimeout as sleep } from "node:timers/promises";
import { getTaskStatus } from "./getTaskStatus.js";
import { getTaskSummary, type TaskSummaryResult } from "./getTaskSummary.js";

const TERMINAL_STATUSES = new Set([
  "done",
  "done_by_agent",
  "failed",
  "failed_verification",
  "failed_scope_violation",
  "failed_policy_violation",
  "canceled",
]);

export interface WaitForTaskProgressSummary {
  phase: string;
  heartbeat_at: string;
  elapsed_seconds: number;
  current_command: string | null;
  hint: string;
}

export interface WaitForTaskOutput {
  task_id: string;
  status: string;
  phase: string;
  terminal: boolean;
  timed_out: boolean;
  continuation_required: boolean;
  waited_ms: number;
  next_action: string;
  next_tool_call: {
    name: "wait_for_task" | "audit_task" | "health_check";
    arguments: Record<string, unknown>;
  };
  summary?: TaskSummaryResult;
  progress_summary?: WaitForTaskProgressSummary;
}

export async function waitForTask(taskId: string, waitSeconds = 25): Promise<WaitForTaskOutput> {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 30) {
    throw new Error("wait_seconds must be an integer from 1 to 30.");
  }
  const started = Date.now();
  const deadline = started + waitSeconds * 1000;
  let status = getTaskStatus(taskId);

  while (!TERMINAL_STATUSES.has(status.status) && Date.now() < deadline) {
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
    status = getTaskStatus(taskId);
  }

  const terminal = TERMINAL_STATUSES.has(status.status);
  const executionBlocked = !terminal && status.execution_blocked;
  const elapsed = Math.round((Date.now() - started) / 1000);

  const progressSummary: WaitForTaskProgressSummary = {
    phase: status.phase,
    heartbeat_at: status.last_heartbeat_at || status.updated_at || "",
    elapsed_seconds: elapsed,
    current_command: status.current_command || null,
    hint: executionBlocked
      ? `Watcher is ${status.watcher_status}. Call health_check and restart the owned watcher; do not keep polling this task yet.`
      : status.phase === "queued"
      ? "Watcher is healthy and has not picked up this task yet. Continue waiting."
      : status.phase === "executing_agent"
        ? `Agent "${status.agent}" is running. Continue waiting, or call get_task_status for phase and current_command.`
        : `Phase "${status.phase}". Task is still in progress.`,
  };

  return {
    task_id: taskId,
    status: status.status,
    phase: status.phase,
    terminal,
    timed_out: !terminal,
    continuation_required: !terminal && !executionBlocked,
    waited_ms: Date.now() - started,
    next_action: terminal
      ? "Review the returned summary, then call audit_task for independent acceptance evidence."
      : executionBlocked
        ? "Call health_check and restore the owned watcher. The saved task will remain queued for recovery."
      : `Call wait_for_task again immediately for task_id ${taskId}; do not end the assistant turn while continuation_required is true.`,
    next_tool_call: terminal
      ? { name: "audit_task", arguments: { task_id: taskId } }
      : executionBlocked
        ? { name: "health_check", arguments: {} }
      : { name: "wait_for_task", arguments: { task_id: taskId, timeout_seconds: waitSeconds } },
    ...(terminal ? { summary: getTaskSummary(taskId, { view: "compact" }) } : { progress_summary: progressSummary }),
  };
}
