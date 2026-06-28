/**
 * v0.8.0: Subgoal 状态同步 — 当任务状态变为 done_by_agent 时回写关联 subgoal 状态。
 *
 * 设计原则：
 *   - 向后兼容：无 goal_id/subgoal_id 关联的任务直接返回，不影响现有流程。
 *   - 错误隔离：subgoal 同步失败只记录到 stderr，不阻断任务完成主流程。
 *   - 仅同步 running → done_by_agent 转换；其他状态由 audit_task / 显式 API 处理。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readGoalStatus, writeGoalStatus } from "./goalStore.js";
import { updateSubgoalStatus } from "./goalStatus.js";

// ── 同步函数 ──────────────────────────────────────────────────────

/**
 * v0.8.0: 当任务状态变为 done_by_agent 时，同步更新关联的 subgoal 状态。
 *
 * 行为：
 *   - 如果 taskMeta.subgoal_id 或 goal_id 为 null/undefined，直接返回（向后兼容）。
 *   - 读取 goal_status.json，找到对应 subgoal。
 *   - 仅当 subgoal 当前状态为 "running" 时，更新为 "done_by_agent"。
 *   - 其他状态（ready/accepted/rejected/needs_fix/done_by_agent）保持不变。
 *   - 所有操作用 try/catch 包裹，失败时只记录到 stderr 不阻断主流程。
 *
 * @param taskId 任务 id（仅用于日志）
 * @param taskMeta 任务的 goal 关联元信息（goal_id / subgoal_id）
 * @param workspaceRoot 可选的工作区根目录（测试用），默认从 getConfig() 读取
 */
export function syncSubgoalOnTaskDone(
  taskId: string,
  taskMeta: { goal_id?: string | null; subgoal_id?: string | null },
  workspaceRoot?: string
): void {
  const goalId = taskMeta.goal_id;
  const subgoalId = taskMeta.subgoal_id;
  if (!goalId || !subgoalId) return;

  try {
    const goalStatus = readGoalStatus(goalId, workspaceRoot);
    const subgoal = goalStatus.subgoals.find((s) => s.id === subgoalId);
    if (!subgoal) return;
    if (subgoal.status !== "running") return;

    const updated = updateSubgoalStatus(goalStatus, subgoalId, "done_by_agent");
    writeGoalStatus(goalId, updated, workspaceRoot);
  } catch (err) {
    // subgoal 同步失败不应影响任务完成流程，只记录到 stderr
    console.error(
      `[goal] syncSubgoalOnTaskDone failed for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── Task 元信息读取 ───────────────────────────────────────────────

/**
 * v0.8.0: 从 task 的 status.json 读取 goal_id/subgoal_id 关联信息。
 *
 * 行为：
 *   - 读取 {taskDir}/status.json，解析其中的 goal_id / subgoal_id 字段。
 *   - 任何错误（文件不存在、JSON 解析失败等）都返回 { goal_id: null, subgoal_id: null }，
 *     不抛错，保证调用方流程不受影响。
 *
 * @param taskDir 任务目录路径（包含 status.json）
 */
export function readTaskGoalMeta(
  taskDir: string
): { goal_id: string | null; subgoal_id: string | null } {
  try {
    const statusFile = join(taskDir, "status.json");
    const raw = readFileSync(statusFile, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      goal_id: typeof data.goal_id === "string" ? data.goal_id : null,
      subgoal_id: typeof data.subgoal_id === "string" ? data.subgoal_id : null,
    };
  } catch {
    return { goal_id: null, subgoal_id: null };
  }
}
