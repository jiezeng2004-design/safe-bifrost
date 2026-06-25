import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfig, getTasksDir, type PatchWardenConfig } from "./config.js";

export type WatcherState = "healthy" | "stale" | "missing" | "unreadable";
export type PendingReason =
  | "queued_waiting_for_watcher"
  | "queued_but_watcher_stale"
  | "queued_but_watcher_missing"
  | "queued_but_watcher_unreadable"
  | "agent_running"
  | "verification_running"
  | "preparing"
  | "collecting_artifacts"
  | null;

export interface WatcherStatusSnapshot {
  status: WatcherState;
  available: boolean;
  stale_after_seconds: number;
  last_heartbeat_at: string | null;
  heartbeat_age_seconds: number | null;
  heartbeat_pid: number | null;
  instance_id: string | null;
  launcher_pid: number | null;
  reason: string | null;
  activity: string | null;
}

export function getWatcherHeartbeatPath(config: PatchWardenConfig = getConfig()): string {
  return join(dirname(getTasksDir(config)), "watcher-heartbeat.json");
}

export function readWatcherStatus(
  config: PatchWardenConfig = getConfig(),
  nowMs = Date.now()
): WatcherStatusSnapshot {
  const staleAfterSeconds = config.watcherStaleSeconds;
  const heartbeatPath = getWatcherHeartbeatPath(config);
  if (!existsSync(heartbeatPath)) {
    // Even if watcher heartbeat is missing, check if a task is actively running
    const taskFallback = checkRunningTaskHeartbeat(config, nowMs, staleAfterSeconds);
    if (taskFallback) {
      return {
        status: "healthy",
        available: true,
        stale_after_seconds: staleAfterSeconds,
        last_heartbeat_at: taskFallback.heartbeat_at,
        heartbeat_age_seconds: taskFallback.age_seconds,
        heartbeat_pid: null,
        instance_id: null,
        launcher_pid: null,
        reason: null,
        activity: taskFallback.activity,
      };
    }
    return {
      status: "missing",
      available: false,
      stale_after_seconds: staleAfterSeconds,
      last_heartbeat_at: null,
      heartbeat_age_seconds: null,
      heartbeat_pid: null,
      instance_id: null,
      launcher_pid: null,
      reason: "Watcher heartbeat has not been observed. Start or restart the PatchWarden watcher.",
      activity: null,
    };
  }

  try {
    const raw = readFileSync(heartbeatPath, "utf-8");
    const data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    const heartbeatMs = Date.parse(String(data.last_heartbeat_at || ""));
    if (!Number.isFinite(heartbeatMs)) throw new Error("invalid heartbeat timestamp");
    const ageMs = Math.max(0, nowMs - heartbeatMs);
    const ageSeconds = Math.round(ageMs / 1000);
    const healthy = ageMs < staleAfterSeconds * 1000;
    if (healthy) {
      return {
        status: "healthy",
        available: true,
        stale_after_seconds: staleAfterSeconds,
        last_heartbeat_at: String(data.last_heartbeat_at),
        heartbeat_age_seconds: ageSeconds,
        heartbeat_pid: Number.isInteger(Number(data.pid)) ? Number(data.pid) : null,
        instance_id: typeof data.instance_id === "string" ? data.instance_id : null,
        launcher_pid: Number.isInteger(Number(data.launcher_pid)) ? Number(data.launcher_pid) : null,
        reason: null,
        activity: null,
      };
    }
    // Watcher heartbeat is stale — check if a task is actively running
    const taskFallback = checkRunningTaskHeartbeat(config, nowMs, staleAfterSeconds);
    if (taskFallback) {
      return {
        status: "healthy",
        available: true,
        stale_after_seconds: staleAfterSeconds,
        last_heartbeat_at: taskFallback.heartbeat_at,
        heartbeat_age_seconds: taskFallback.age_seconds,
        heartbeat_pid: Number.isInteger(Number(data.pid)) ? Number(data.pid) : null,
        instance_id: typeof data.instance_id === "string" ? data.instance_id : null,
        launcher_pid: Number.isInteger(Number(data.launcher_pid)) ? Number(data.launcher_pid) : null,
        reason: null,
        activity: taskFallback.activity,
      };
    }
    return {
      status: "stale",
      available: false,
      stale_after_seconds: staleAfterSeconds,
      last_heartbeat_at: String(data.last_heartbeat_at),
      heartbeat_age_seconds: ageSeconds,
      heartbeat_pid: Number.isInteger(Number(data.pid)) ? Number(data.pid) : null,
      instance_id: typeof data.instance_id === "string" ? data.instance_id : null,
      launcher_pid: Number.isInteger(Number(data.launcher_pid)) ? Number(data.launcher_pid) : null,
      reason: "Watcher heartbeat is stale. Restart the PatchWarden watcher.",
      activity: null,
    };
  } catch {
    return {
      status: "unreadable",
      available: false,
      stale_after_seconds: staleAfterSeconds,
      last_heartbeat_at: null,
      heartbeat_age_seconds: null,
      heartbeat_pid: null,
      instance_id: null,
      launcher_pid: null,
      reason: "Watcher heartbeat file is unreadable.",
      activity: null,
    };
  }
}

interface TaskHeartbeatFallback {
  heartbeat_at: string;
  age_seconds: number;
  activity: string;
}

function checkRunningTaskHeartbeat(
  config: PatchWardenConfig,
  nowMs: number,
  staleAfterSeconds: number
): TaskHeartbeatFallback | null {
  const tasksDir = getTasksDir(config);
  if (!existsSync(tasksDir)) return null;
  let entries;
  try {
    entries = readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskDir = join(tasksDir, entry.name);
    const statusFile = join(taskDir, "status.json");
    const runtimeFile = join(taskDir, "runtime.json");
    if (!existsSync(statusFile) || !existsSync(runtimeFile)) continue;
    try {
      const status = JSON.parse(readFileSync(statusFile, "utf-8"));
      if (status.status !== "running") continue;
      const runtime = JSON.parse(readFileSync(runtimeFile, "utf-8"));
      const heartbeatAt = String(runtime.last_heartbeat_at || "");
      const heartbeatMs = Date.parse(heartbeatAt);
      if (!Number.isFinite(heartbeatMs)) continue;
      const ageMs = Math.max(0, nowMs - heartbeatMs);
      if (ageMs < staleAfterSeconds * 1000) {
        return {
          heartbeat_at: heartbeatAt,
          age_seconds: Math.round(ageMs / 1000),
          activity: `watcher busy executing task ${entry.name}`,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function derivePendingReason(
  task: { status?: string; phase?: string },
  watcher: WatcherStatusSnapshot
): PendingReason {
  if (task.status === "pending") {
    if (watcher.status === "stale") return "queued_but_watcher_stale";
    if (watcher.status === "missing") return "queued_but_watcher_missing";
    if (watcher.status === "unreadable") return "queued_but_watcher_unreadable";
    return "queued_waiting_for_watcher";
  }
  if (task.status !== "running") return null;
  if (task.phase === "executing_agent") return "agent_running";
  if (task.phase === "running_tests") return "verification_running";
  if (task.phase === "collecting_artifacts") return "collecting_artifacts";
  return "preparing";
}
