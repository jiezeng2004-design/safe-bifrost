/**
 * v0.8.0: createSubgoalTask — 原子地将一个新 subgoal 关联到一个新任务。
 *
 * 流程（原子语义）：
 *   1. 读取 goal_status.json（不存在则抛 goal_not_found）
 *   2. addSubgoal（校验 depends_on 引用已有 subgoal）
 *   3. createTask 创建关联任务（写入 goal_id / subgoal_id 到 task status.json）
 *   4. linkTaskToSubgoal（将 task_id 关联到 subgoal）
 *   5. updateSubgoalStatus(running)（ready → running）
 *   6. 写回 goal_status.json
 *
 * 注意：
 *   - createSubgoalTask 强制 execution_mode 为 "execute"，因为 assess_only 不产生可关联的 task。
 *   - createTask 内部使用 getConfig()，因此 workspaceRoot 由全局配置决定。
 */

import { readGoalStatus, writeGoalStatus } from "../goal/goalStore.js";
import { addSubgoal, linkTaskToSubgoal, updateSubgoalStatus, type Subgoal } from "../goal/goalStatus.js";
import { createTask, type CreateTaskInput } from "./createTask.js";
import { createWorktree, discardWorktree } from "../goal/worktreeManager.js";
import { getConfig } from "../config.js";
import { PatchWardenError } from "../errors.js";

// ── 类型定义 ──────────────────────────────────────────────────────

export interface CreateSubgoalTaskInput {
  goal_id: string;
  subgoal_title: string;
  depends_on?: string[];
  // create_task 的标准参数（除 goal_id/subgoal_id 外）
  plan_id?: string;
  inline_plan?: string;
  plan_title?: string;
  template?: CreateTaskInput["template"];
  goal?: string;
  agent?: string;
  repo_path: string;
  test_command?: string;
  verify_commands?: string[];
  timeout_seconds?: number;
  execution_mode?: "assess_only" | "execute";
  assessment_id?: string;
  scope?: string[];
  forbidden?: string[];
  verification?: string[];
  done_evidence?: string[];
  // v1.0.0 Part B: 是否为该 subgoal task 创建隔离 git worktree（默认 true）。
  // 设为 false 时退化为原行为，使用 input.repo_path，不调用 worktreeManager。
  isolate_worktree?: boolean;
}

export interface CreateSubgoalTaskOutput {
  subgoal_id: string;
  task_id: string;
  subgoal_status: "running";
}

// ── 函数实现 ──────────────────────────────────────────────────────

/**
 * 原子地创建一个 subgoal 并关联到一个新任务。
 *
 * @throws PatchWardenError("goal_not_found") 当 goal_id 不存在
 * @throws PatchWardenError("invalid_dependency") 当 depends_on 引用不存在的 subgoal
 * @throws PatchWardenError("invalid_execution_mode") 当 execution_mode 为 "assess_only"
 */
export function createSubgoalTask(input: CreateSubgoalTaskInput): CreateSubgoalTaskOutput {
  // assess_only 不产生 task，无法关联到 subgoal
  if (input.execution_mode === "assess_only") {
    throw new PatchWardenError(
      "invalid_execution_mode",
      "createSubgoalTask does not support execution_mode \"assess_only\"",
      "Use execution_mode \"execute\" (default) so a task is created and linked to the subgoal.",
      true,
      { goal_id: input.goal_id, execution_mode: input.execution_mode }
    );
  }

  // 1. 读取 goal_status.json，如果不存在抛 goal_not_found
  let goalStatus;
  try {
    goalStatus = readGoalStatus(input.goal_id);
  } catch {
    throw new PatchWardenError(
      "goal_not_found",
      `Goal "${input.goal_id}" not found`,
      "Call list_goals to see available goals.",
      true,
      { goal_id: input.goal_id }
    );
  }

  // 2. addSubgoal（校验 depends_on）
  const { goalStatus: withSubgoal, subgoalId } = addSubgoal(
    goalStatus,
    input.subgoal_title,
    input.depends_on ?? []
  );

  // 2.5 Worktree 隔离（默认开启）：为该 subgoal task 创建独立 git worktree，
  //     用 worktree 路径作为 createTask 的 repo_path，避免并发 task 互相污染。
  //     isolate_worktree === false 时退化为原行为（使用 input.repo_path）。
  const isolate = input.isolate_worktree !== false;
  let repoPathForTask = input.repo_path;
  let worktreeId: string | null = null;
  if (isolate) {
    const workspaceRoot = getConfig().workspaceRoot;
    const wt = createWorktree(input.goal_id, subgoalId, workspaceRoot);
    repoPathForTask = wt.worktreePath;
    worktreeId = wt.worktreeId;
  }

  // 3. 调用 createTask 创建关联任务（强制 execute 模式，确保返回 CreateTaskOutput）
  let taskId: string;
  try {
    const taskResult = createTask({
      plan_id: input.plan_id,
      inline_plan: input.inline_plan,
      plan_title: input.plan_title,
      template: input.template,
      goal: input.goal,
      agent: input.agent,
      repo_path: repoPathForTask,
      test_command: input.test_command,
      verify_commands: input.verify_commands,
      timeout_seconds: input.timeout_seconds,
      execution_mode: "execute",
      assessment_id: input.assessment_id,
      scope: input.scope,
      forbidden: input.forbidden,
      verification: input.verification,
      done_evidence: input.done_evidence,
      goal_id: input.goal_id,
      subgoal_id: subgoalId,
    });
    // execution_mode 为 "execute"，createTask 返回 CreateTaskOutput（含 task_id）
    taskId = (taskResult as { task_id: string }).task_id;
  } catch (createTaskErr) {
    // createTask 失败：清理已创建的隔离 worktree，避免遗留半成品（best effort）
    if (isolate && worktreeId) {
      try {
        discardWorktree(worktreeId, getConfig().workspaceRoot);
      } catch { /* ignore cleanup failure，向上抛出原始 createTask 错误 */ }
    }
    throw createTaskErr;
  }

  // 4. linkTaskToSubgoal + updateSubgoalStatus(running)
  const withTask = linkTaskToSubgoal(withSubgoal, subgoalId, taskId);
  let withRunning = updateSubgoalStatus(withTask, subgoalId, "running");

  // 4.5 隔离模式下，把 worktree_id 记录到 subgoal 对象（写入 goal_status.json）
  if (isolate && worktreeId) {
    const newSubgoals: Subgoal[] = withRunning.subgoals.map((s) =>
      s.id === subgoalId
        ? ({ ...s, worktree_id: worktreeId } as Subgoal)
        : s
    );
    withRunning = { ...withRunning, subgoals: newSubgoals };
  }

  // 5. 写回 goal_status.json
  writeGoalStatus(input.goal_id, withRunning);

  return {
    subgoal_id: subgoalId,
    task_id: taskId,
    subgoal_status: "running",
  };
}
