#!/usr/bin/env node
/**
 * Safe-Bifrost Watcher
 *
 * Polls .safe-bifrost/tasks/ for pending tasks and executes them automatically.
 * This is the recommended way to run tasks — ChatGPT creates tasks,
 * the watcher picks them up and runs them locally.
 *
 * Safety invariants (enforced every tick):
 *  - repo_path must be inside workspace
 *  - agent must be in allowlist
 *  - test_command must be in allowlist (or empty)
 *  - Each task runs at most once (no retry loop)
 *  - No auto commit, no auto push, no file deletion
 *
 * Run: node dist/runner/watch.js
 *   or: npm run watch
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadConfig, getConfig, getTasksDir, resolveWorkspaceRoot } from "../config.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import { guardAgentCommand, guardTestCommand } from "../security/commandGuard.js";
import { runTask } from "./runTask.js";

// ── Bootstrap ─────────────────────────────────────────────────────

loadConfig();
const config = getConfig();
const tasksDir = getTasksDir(config);
const wsRoot = resolveWorkspaceRoot(config);

const POLL_INTERVAL_MS = 4000;

console.error(`[watcher] Workspace: ${wsRoot}`);
console.error(`[watcher] Tasks:    ${tasksDir}`);
console.error(`[watcher] Polling every ${POLL_INTERVAL_MS / 1000}s`);
console.error(`[watcher] Press Ctrl+C to stop`);

// Track executed tasks to prevent re-execution
const executedTasks = new Set<string>();

// ── Main loop ─────────────────────────────────────────────────────

async function tick() {
  try {
    // Ensure tasks directory exists
    if (!existsSync(tasksDir)) return;

    const entries = readdirSync(tasksDir, { withFileTypes: true });
    const taskDirs = entries.filter((e) => e.isDirectory());

    for (const entry of taskDirs) {
      const taskId = entry.name;

      // Skip already-executed tasks
      if (executedTasks.has(taskId)) continue;

      const taskDir = resolve(tasksDir, taskId);
      const statusFile = join(taskDir, "status.json");

      if (!existsSync(statusFile)) continue;

      let statusData: any;
      try {
        statusData = JSON.parse(readFileSync(statusFile, "utf-8"));
      } catch {
        continue; // corrupted status, skip
      }

      if (statusData.status !== "pending") continue;

      // ── Pre-flight safety checks ──
      try {
        // Check repo_path
        guardWorkspacePath(statusData.repo_path || wsRoot, wsRoot);

        // Check agent
        guardAgentCommand(statusData.agent, config);

        // Check test_command
        if (statusData.test_command) {
          guardTestCommand(statusData.test_command, config);
        }
      } catch (err) {
        const errMsg = `[watcher] Safety check failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(errMsg);

        // Write error and mark as failed so it doesn't get re-picked
        try {
          writeFileSync(join(taskDir, "error.log"), errMsg, "utf-8");
          const data = JSON.parse(readFileSync(statusFile, "utf-8"));
          data.status = "failed";
          data.error = errMsg;
          data.updated_at = new Date().toISOString();
          writeFileSync(statusFile, JSON.stringify(data, null, 2), "utf-8");
        } catch {}
        executedTasks.add(taskId);
        continue;
      }

      // ── Execute ──
      console.error(`[watcher] Executing: ${taskId}`);
      executedTasks.add(taskId);

      try {
        const result = runTask(taskId);
        console.error(`[watcher] ${taskId} → ${result.status}`);
      } catch (err) {
        console.error(`[watcher] ${taskId} → error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    console.error(`[watcher] Tick error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Start ─────────────────────────────────────────────────────────

console.error("[watcher] Started");
setInterval(tick, POLL_INTERVAL_MS);

// Run first tick immediately
tick();

// Graceful shutdown
process.on("SIGINT", () => {
  console.error("[watcher] Stopped");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.error("[watcher] Stopped");
  process.exit(0);
});
