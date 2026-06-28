/**
 * v0.8.0: Goal Session 子目标验收业务逻辑 — accept / reject / summarize。
 *
 * 三个公共函数：
 *   - acceptSubgoal：校验所有关联 task 已 accepted 后，将 subgoal 置为 accepted
 *   - rejectSubgoal：从任意非终态拒绝 subgoal，记录 rejected_reason
 *   - summarizeGoalProgress：统计 goal 进度，返回 completion_rate / blocked / risks
 *
 * 任务 status.json 路径解析：
 *   优先用 getConfig().tasksDir（绝对路径直接用，相对路径 join workspaceRoot）。
 *   所有函数接受可选的 workspaceRoot 参数用于测试。
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getConfig } from "../config.js";
import { PatchWardenError } from "../errors.js";
import { readGoalStatus, writeGoalStatus } from "./goalStore.js";
import { updateSubgoalStatus, type GoalStatus, type Subgoal } from "./goalStatus.js";
import { getBlockedSubgoals } from "./goalGraph.js";

// ── 类型定义 ──────────────────────────────────────────────────────

export interface GoalProgressSummary {
  goal_id: string;
  title: string;
  total: number;
  accepted: number;
  rejected: number;
  running: number;
  ready: number;
  needs_fix: number;
  done_by_agent: number;
  completion_rate: string;
  blocked_subgoals: Array<{ subgoal_id: string; title: string; blocked_by: string[] }>;
  risks: Array<{ subgoal_id: string; title: string; status: string; reason: string }>;
}

// ── 辅助：解析 workspaceRoot ──────────────────────────────────────

function resolveWorkspaceRoot(workspaceRoot?: string): string {
  return workspaceRoot ?? getConfig().workspaceRoot;
}

/**
 * 解析任务 status.json 路径。
 * 读取 getConfig().tasksDir：绝对路径直接用，相对路径 join workspaceRoot。
 */
function resolveTaskStatusPath(taskId: string, workspaceRoot?: string): string {
  const config = getConfig();
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  const tasksDir = config.tasksDir;
  const resolvedTasksDir = isAbsolute(tasksDir) ? tasksDir : join(wsRoot, tasksDir);
  return join(resolvedTasksDir, taskId, "status.json");
}

/**
 * 读取单个任务的 status 字段。
 * 如果 status.json 不存在或无法解析，返回 null（视为未 accepted）。
 */
function readTaskStatus(taskId: string, workspaceRoot?: string): string | null {
  const statusPath = resolveTaskStatusPath(taskId, workspaceRoot);
  if (!existsSync(statusPath)) {
    return null;
  }
  try {
    const raw = readFileSync(statusPath, "utf-8");
    const parsed = JSON.parse(raw) as { status?: string };
    return typeof parsed.status === "string" ? parsed.status : null;
  } catch {
    return null;
  }
}

// ── 公共 API ──────────────────────────────────────────────────────

/**
 * 验收子目标：校验所有关联 task 已 accepted 后，将 subgoal 置为 accepted。
 *
 * 校验规则（理解 B — 更严格）：
 *   1. task_ids 不能为空（无关联任务无法验收）
 *   2. 所有 task_ids 对应的 task status 必须为 "accepted"
 *   3. 通过 updateSubgoalStatus 状态机校验（要求 subgoal 当前为 done_by_agent）
 *
 * @param goalId        Goal 标识
 * @param subgoalId     Subgoal 标识
 * @param workspaceRoot 可选，用于测试
 * @returns { subgoal_id, status, accepted_at }
 * @throws {PatchWardenError} reason="goal_not_found" | "subgoal_not_found" | "subgoal_not_ready" | "invalid_status_transition"
 */
export function acceptSubgoal(
  goalId: string,
  subgoalId: string,
  workspaceRoot?: string
): { subgoal_id: string; status: "accepted"; accepted_at: string } {
  const goalStatus = readGoalStatus(goalId, workspaceRoot);

  const subgoal = goalStatus.subgoals.find((s) => s.id === subgoalId);
  if (!subgoal) {
    throw new PatchWardenError(
      "subgoal_not_found",
      `Subgoal "${subgoalId}" not found in goal "${goalId}"`,
      "Ensure the subgoal id exists before accepting.",
      true,
      { subgoal_id: subgoalId, goal_id: goalId }
    );
  }

  // 校验 1：task_ids 不能为空
  if (subgoal.task_ids.length === 0) {
    throw new PatchWardenError(
      "subgoal_not_ready",
      `Subgoal "${subgoalId}" has no associated tasks; cannot accept without task verification.`,
      "Link tasks to the subgoal and run audit_task on each before accepting.",
      true,
      { subgoal_id: subgoalId, goal_id: goalId, task_ids: [] }
    );
  }

  // 校验 2：所有 task 必须为 accepted
  const unacceptedTasks: Array<{ task_id: string; current_status: string }> = [];
  for (const taskId of subgoal.task_ids) {
    const taskStatus = readTaskStatus(taskId, workspaceRoot);
    if (taskStatus !== "accepted") {
      unacceptedTasks.push({
        task_id: taskId,
        current_status: taskStatus ?? "missing",
      });
    }
  }

  if (unacceptedTasks.length > 0) {
    throw new PatchWardenError(
      "subgoal_not_ready",
      `Subgoal "${subgoalId}" cannot be accepted: ${unacceptedTasks.length} task(s) are not in "accepted" status.`,
      "Run audit_task on each unaccepted task first.",
      true,
      {
        subgoal_id: subgoalId,
        goal_id: goalId,
        unaccepted_tasks: unacceptedTasks,
      }
    );
  }

  // 校验 3：通过状态机转换（要求 subgoal 当前为 done_by_agent）
  const updatedGoalStatus = updateSubgoalStatus(goalStatus, subgoalId, "accepted");

  writeGoalStatus(goalId, updatedGoalStatus, workspaceRoot);

  const updatedSubgoal = updatedGoalStatus.subgoals.find((s) => s.id === subgoalId)!;
  return {
    subgoal_id: subgoalId,
    status: "accepted",
    accepted_at: updatedSubgoal.accepted_at!,
  };
}

/**
 * 拒绝子目标：从任意非终态（ready/running/done_by_agent/needs_fix）拒绝 subgoal。
 *
 * 不使用 updateSubgoalStatus 的状态机校验（因为状态机只允许 done_by_agent → rejected），
 * 直接手动设置 status 和 rejected_reason。
 *
 * @param goalId        Goal 标识
 * @param subgoalId     Subgoal 标识
 * @param reason        拒绝原因
 * @param workspaceRoot 可选，用于测试
 * @returns { subgoal_id, status, rejected_reason }
 * @throws {PatchWardenError} reason="goal_not_found" | "subgoal_not_found" | "invalid_status_transition"
 */
export function rejectSubgoal(
  goalId: string,
  subgoalId: string,
  reason: string,
  workspaceRoot?: string
): { subgoal_id: string; status: "rejected"; rejected_reason: string } {
  const goalStatus = readGoalStatus(goalId, workspaceRoot);

  const index = goalStatus.subgoals.findIndex((s) => s.id === subgoalId);
  if (index === -1) {
    throw new PatchWardenError(
      "subgoal_not_found",
      `Subgoal "${subgoalId}" not found in goal "${goalId}"`,
      "Ensure the subgoal id exists before rejecting.",
      true,
      { subgoal_id: subgoalId, goal_id: goalId }
    );
  }

  const current = goalStatus.subgoals[index];

  // 终态检查：accepted 和 rejected 不允许再 reject
  if (current.status === "accepted" || current.status === "rejected") {
    throw new PatchWardenError(
      "invalid_status_transition",
      `Cannot reject subgoal "${subgoalId}" in terminal state "${current.status}".`,
      "Reject is only allowed from non-terminal states (ready, running, done_by_agent, needs_fix).",
      true,
      {
        subgoal_id: subgoalId,
        goal_id: goalId,
        from_status: current.status,
        to_status: "rejected",
      }
    );
  }

  // 手动更新 status 和 rejected_reason（绕过状态机）
  const updatedSubgoal: Subgoal = {
    ...current,
    status: "rejected",
    rejected_reason: reason,
  };

  const newSubgoals = [...goalStatus.subgoals];
  newSubgoals[index] = updatedSubgoal;

  const updatedGoalStatus: GoalStatus = {
    ...goalStatus,
    subgoals: newSubgoals,
    updated_at: new Date().toISOString(),
  };

  writeGoalStatus(goalId, updatedGoalStatus, workspaceRoot);

  return {
    subgoal_id: subgoalId,
    status: "rejected",
    rejected_reason: reason,
  };
}

/**
 * 汇总 Goal 进度：统计各状态数量、完成率、阻塞子目标、风险项。
 *
 * @param goalId        Goal 标识
 * @param workspaceRoot 可选，用于测试
 * @returns GoalProgressSummary
 * @throws {PatchWardenError} reason="goal_not_found"
 */
export function summarizeGoalProgress(
  goalId: string,
  workspaceRoot?: string
): GoalProgressSummary {
  const goalStatus = readGoalStatus(goalId, workspaceRoot);

  const subgoals = goalStatus.subgoals;
  const total = subgoals.length;
  const accepted = subgoals.filter((s) => s.status === "accepted").length;
  const rejected = subgoals.filter((s) => s.status === "rejected").length;
  const running = subgoals.filter((s) => s.status === "running").length;
  const ready = subgoals.filter((s) => s.status === "ready").length;
  const needsFix = subgoals.filter((s) => s.status === "needs_fix").length;
  const doneByAgent = subgoals.filter((s) => s.status === "done_by_agent").length;
  const completionRate = total > 0
    ? `${Math.round((accepted / total) * 100)}%`
    : "0%";

  // 阻塞子目标
  const blockedSubgoals = getBlockedSubgoals(goalStatus).map((b) => ({
    subgoal_id: b.subgoal.id,
    title: b.subgoal.title,
    blocked_by: [...b.blocked_by],
  }));

  // 风险项：needs_fix 和 running
  const risks: GoalProgressSummary["risks"] = [];
  for (const s of subgoals) {
    if (s.status === "needs_fix") {
      risks.push({
        subgoal_id: s.id,
        title: s.title,
        status: s.status,
        reason: "needs_fix",
      });
    } else if (s.status === "running") {
      risks.push({
        subgoal_id: s.id,
        title: s.title,
        status: s.status,
        reason: "running",
      });
    }
  }

  return {
    goal_id: goalStatus.goal_id,
    title: goalStatus.title,
    total,
    accepted,
    rejected,
    running,
    ready,
    needs_fix: needsFix,
    done_by_agent: doneByAgent,
    completion_rate: completionRate,
    blocked_subgoals: blockedSubgoals,
    risks,
  };
}
