/**
 * v0.8.0: Goal Session 目录 CRUD — 在 workspaceRoot 下管理 .patchwarden/goals/ 目录。
 *
 * 目录结构：
 *   {workspaceRoot}/.patchwarden/goals/{goal_id}/
 *     ├── GOAL.md              人类可读的 goal 描述
 *     ├── GOALS.md             子目标列表（人类可读）
 *     ├── goal_status.json     机器可读的状态文件（原子写）
 *     ├── tasks/               任务产物
 *     └── artifacts/           其他产物
 *
 * 所有文件系统函数都接受可选的 workspaceRoot 参数用于测试；
 * 默认从 getConfig().workspaceRoot 读取。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import { PatchWardenError } from "../errors.js";
import {
  type GoalStatus,
  type Subgoal,
  createInitialGoalStatus,
} from "./goalStatus.js";

// ── 辅助：解析 workspaceRoot ──────────────────────────────────────

function resolveWorkspaceRoot(workspaceRoot?: string): string {
  return workspaceRoot ?? getConfig().workspaceRoot;
}

// ── Goal ID 生成 ──────────────────────────────────────────────────

/**
 * 从 title 生成 slug：小写、非字母数字字符替换为 `_`、合并连续 `_`、去除首尾 `_`、截断到 30 字符。
 * 如果 slug 为空（title 全是符号），用 `untitled` 代替。
 */
function titleToSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  return slug === "" ? "untitled" : slug;
}

/**
 * 生成 `goal_{YYYYMMDD}_{slug}` 格式的 goal id。
 * 冲突时追加 `_2`、`_3`... 直到唯一。
 * 日期用本地时区（new Date()）。
 */
export function generateGoalId(title: string, existingIds: string[]): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePart = `${y}${m}${d}`;
  const slug = titleToSlug(title);

  const existing = new Set(existingIds);
  const base = `goal_${datePart}_${slug}`;
  if (!existing.has(base)) {
    return base;
  }

  let counter = 2;
  while (existing.has(`${base}_${counter}`)) {
    counter++;
  }
  return `${base}_${counter}`;
}

// ── 目录路径解析 ──────────────────────────────────────────────────

/**
 * 返回 `.patchwarden/goals/` 目录路径（相对于 workspaceRoot）。
 * 不自动创建目录。
 */
export function getGoalsDir(workspaceRoot?: string): string {
  return join(resolveWorkspaceRoot(workspaceRoot), ".patchwarden", "goals");
}

/**
 * 返回 `{getGoalsDir()}/{goalId}` 路径。
 */
export function getGoalDir(goalId: string, workspaceRoot?: string): string {
  return join(getGoalsDir(workspaceRoot), goalId);
}

// ── CRUD ──────────────────────────────────────────────────────────

/**
 * 创建一个新的 Goal Session。
 * - 用 guardWorkspacePath 校验 repoPath 在 workspaceRoot 内
 * - 扫描现有 goal 目录获取 existingIds，调用 generateGoalId
 * - 创建目录结构：goal_dir/、tasks/、artifacts/
 * - 写入 GOAL.md、GOALS.md、goal_status.json
 * 返回 { goal_id, goal_dir }。
 */
export function createGoal(
  repoPath: string,
  title: string,
  description: string,
  workspaceRoot?: string
): { goal_id: string; goal_dir: string } {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  const guardedRepo = guardWorkspacePath(repoPath, wsRoot);

  const goalsDir = getGoalsDir(workspaceRoot);
  const existingIds: string[] = [];
  if (existsSync(goalsDir)) {
    for (const entry of readdirSync(goalsDir)) {
      const entryPath = join(goalsDir, entry);
      try {
        if (statSync(entryPath).isDirectory()) {
          existingIds.push(entry);
        }
      } catch {
        // 跳过无法 stat 的条目
      }
    }
  }

  const goalId = generateGoalId(title, existingIds);
  const goalDir = join(goalsDir, goalId);

  // 创建目录结构
  mkdirSync(join(goalDir, "tasks"), { recursive: true });
  mkdirSync(join(goalDir, "artifacts"), { recursive: true });

  // 写入 GOAL.md
  const now = new Date().toISOString();
  const goalMd = [
    `# ${title}`,
    "",
    description,
    "",
    `- Created: ${now}`,
    `- Repo: ${guardedRepo}`,
    "- Status: active",
    "",
  ].join("\n");
  writeFileSync(join(goalDir, "GOAL.md"), goalMd, "utf-8");

  // 写入 GOALS.md
  const goalsMd = `# Subgoals: ${title}\n\n_No subgoals yet._\n`;
  writeFileSync(join(goalDir, "GOALS.md"), goalsMd, "utf-8");

  // 写入 goal_status.json
  const status = createInitialGoalStatus(goalId, title, guardedRepo);
  writeFileSync(
    join(goalDir, "goal_status.json"),
    JSON.stringify(status, null, 2) + "\n",
    "utf-8"
  );

  return { goal_id: goalId, goal_dir: goalDir };
}

/**
 * 列出所有 goal 的摘要信息，按 updated_at 降序排列。
 * 无法解析的目录会被跳过。
 */
export function listGoals(
  workspaceRoot?: string
): Array<{
  goal_id: string;
  title: string;
  status: string;
  subgoal_total: number;
  subgoal_accepted: number;
  subgoal_running: number;
  updated_at: string;
}> {
  const goalsDir = getGoalsDir(workspaceRoot);
  if (!existsSync(goalsDir)) {
    return [];
  }

  const results: Array<{
    goal_id: string;
    title: string;
    status: string;
    subgoal_total: number;
    subgoal_accepted: number;
    subgoal_running: number;
    updated_at: string;
  }> = [];

  for (const entry of readdirSync(goalsDir)) {
    const entryPath = join(goalsDir, entry);
    try {
      if (!statSync(entryPath).isDirectory()) {
        continue;
      }
      const status = readGoalStatus(entry, workspaceRoot);
      results.push({
        goal_id: status.goal_id,
        title: status.title,
        status: status.status,
        subgoal_total: status.subgoals.length,
        subgoal_accepted: status.subgoals.filter((s) => s.status === "accepted").length,
        subgoal_running: status.subgoals.filter((s) => s.status === "running").length,
        updated_at: status.updated_at,
      });
    } catch {
      // 跳过无法解析的目录
    }
  }

  results.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return results;
}

/**
 * 读取 goal 的完整详情：goal_status.json + GOAL.md 内容。
 * 如果 goal 目录不存在或 goal_status.json 不存在，抛出 PatchWardenError("goal_not_found")。
 */
export function readGoal(
  goalId: string,
  workspaceRoot?: string
): {
  goal_id: string;
  title: string;
  status: string;
  repo_path: string;
  created_at: string;
  updated_at: string;
  goal_description: string;
  subgoals: Subgoal[];
} {
  const goalDir = getGoalDir(goalId, workspaceRoot);
  if (!existsSync(goalDir)) {
    throw new PatchWardenError(
      "goal_not_found",
      `Goal directory not found: "${goalDir}"`,
      "Ensure the goal id exists before reading.",
      true,
      { goal_id: goalId, goal_dir: goalDir }
    );
  }

  const status = readGoalStatus(goalId, workspaceRoot);

  let goalDescription = "";
  const goalMdPath = join(goalDir, "GOAL.md");
  if (existsSync(goalMdPath)) {
    goalDescription = readFileSync(goalMdPath, "utf-8");
  }

  return {
    goal_id: status.goal_id,
    title: status.title,
    status: status.status,
    repo_path: status.repo_path,
    created_at: status.created_at,
    updated_at: status.updated_at,
    goal_description: goalDescription,
    subgoals: status.subgoals,
  };
}

/**
 * 原子写入 goal_status.json：先写到 .tmp 文件，再 renameSync。
 * JSON 序列化用 JSON.stringify(status, null, 2) + 末尾换行。
 */
export function writeGoalStatus(
  goalId: string,
  status: GoalStatus,
  workspaceRoot?: string
): void {
  const goalDir = getGoalDir(goalId, workspaceRoot);
  const finalPath = join(goalDir, "goal_status.json");
  const tmpPath = join(goalDir, "goal_status.json.tmp");
  writeFileSync(tmpPath, JSON.stringify(status, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, finalPath);
}

/**
 * 读取 goal_status.json 并 JSON.parse。
 * 如果文件不存在，抛出 PatchWardenError("goal_not_found")。
 */
export function readGoalStatus(goalId: string, workspaceRoot?: string): GoalStatus {
  const goalDir = getGoalDir(goalId, workspaceRoot);
  const statusPath = join(goalDir, "goal_status.json");
  if (!existsSync(statusPath)) {
    throw new PatchWardenError(
      "goal_not_found",
      `goal_status.json not found for goal "${goalId}" at "${statusPath}"`,
      "Ensure the goal has been created via createGoal before reading its status.",
      true,
      { goal_id: goalId, status_path: statusPath }
    );
  }
  const raw = readFileSync(statusPath, "utf-8");
  return JSON.parse(raw) as GoalStatus;
}
