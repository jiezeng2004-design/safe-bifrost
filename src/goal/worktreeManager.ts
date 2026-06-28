/**
 * v1.0.0 Part B: Worktree 隔离管理器 — 在 workspaceRoot 下管理 git worktree，
 * 为每个 subgoal task 提供独立的代码副本，避免并发任务互相污染工作区。
 *
 * 目录结构：
 *   {workspaceRoot}/_workspacetrees/{worktree_id}/
 *     └── worktree_status.json   机器可读的状态文件（原子写）
 *   {workspaceRoot}/.patchwarden/worktree-archive/{worktree_id}.json
 *     归档的已 discard 状态（worktree 目录被删除后保留审计记录）
 *
 * 安全约束：
 *   - 所有路径经 guardWorkspacePath + guardSensitivePath 校验
 *   - git 命令只用 child_process.execFileSync（不使用 shell），白名单仅
 *     git worktree add/remove/prune + git merge + git branch
 *   - createWorktree 失败时清理半成品 worktree 目录与临时 branch
 *   - 不暴露通用 shell，不 blanket-kill watcher（worktree 与 watcher 无关）
 *
 * 所有文件系统函数都接受可选的 workspaceRoot 参数用于测试；
 * 默认从 getConfig().workspaceRoot 读取。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getConfig } from "../config.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import { guardSensitivePath } from "../security/sensitiveGuard.js";
import { PatchWardenError } from "../errors.js";

// ── 类型定义 ──────────────────────────────────────────────────────

export interface WorktreeStatus {
  worktree_id: string;
  goal_id: string;
  subgoal_id: string;
  path: string;
  created_at: string;
  status: "active" | "merged" | "discarded";
  branch: string;
  merged_at?: string;
  discarded_at?: string;
}

// ── 常量 ──────────────────────────────────────────────────────────

/** worktree 根目录名，放在 workspaceRoot 下。 */
export const WorktreeDir = "_workspacetrees";

/** 归档目录名（discard 后保留状态），位于 .patchwarden 下，始终为安全路径。 */
const WORKTREE_ARCHIVE_DIR = ".patchwarden/worktree-archive";

const GIT_TIMEOUT_MS = 30000;
const GIT_BRANCH_TIMEOUT_MS = 15000;

// ── 辅助：解析 workspaceRoot ──────────────────────────────────────

function resolveWorkspaceRoot(workspaceRoot?: string): string {
  return workspaceRoot ?? getConfig().workspaceRoot;
}

// ── 目录路径解析 ──────────────────────────────────────────────────

/**
 * 返回 `<workspaceRoot>/_workspacetrees` 目录路径。不自动创建目录。
 */
export function getWorktreesDir(workspaceRoot?: string): string {
  return join(resolveWorkspaceRoot(workspaceRoot), WorktreeDir);
}

/**
 * 返回 `<getWorktreesDir()>/<worktreeId>` 路径。
 */
export function getWorktreeDir(worktreeId: string, workspaceRoot?: string): string {
  return join(getWorktreesDir(workspaceRoot), worktreeId);
}

// ── ID 与 branch 生成 ─────────────────────────────────────────────

/**
 * 生成 `wt_<timestamp_base36>_<randomHex>` 格式的 worktree id。
 * 内部生成，不接受调用方输入，避免路径注入。
 */
function generateWorktreeId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(6).toString("hex");
  return `wt_${ts}_${rand}`;
}

/**
 * 将字符串清洗为合法 git branch 段：只保留 [a-zA-Z0-9_-]，其余替换为 `_`。
 * 注意 `.` 与 `/` 会被替换：`..` 路径穿越片段无法进入 branch 名；`/` 被排除
 * 是因为 `git worktree add -b <name> <path>` 在 Windows 的 git 上对含 `/` 的
 * 新分支名会报 `fatal: invalid reference`（即便分支名本身合法）。
 */
function sanitizeBranchSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned === "" ? "x" : cleaned;
}

// ── 原子写 ────────────────────────────────────────────────────────

/**
 * 原子写入 status 文件：先写到 `.tmp` 文件，再 renameSync。
 * 参考 goalStore.ts writeGoalStatus 的模式。
 */
function writeStatusAtomic(statusFilePath: string, status: WorktreeStatus): void {
  const tmpPath = statusFilePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(status, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, statusFilePath);
}

function runGit(args: string[], cwd: string, timeoutMs: number): void {
  execFileSync("git", args, {
    cwd,
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function gitErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    if (stderr) {
      const text = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr);
      if (text.trim()) return text.trim();
    }
  }
  return err instanceof Error ? err.message : String(err);
}

// ── 公共 API ──────────────────────────────────────────────────────

/**
 * 为指定 goal/subgoal 创建一个隔离的 git worktree。
 *
 * 流程：
 *   1. 生成 worktreeId（内部随机），拼出 worktreePath 与 branch
 *   2. guardWorkspacePath + guardSensitivePath 校验路径
 *   3. `git worktree add -b <branch> <worktreePath>` 创建 worktree
 *   4. 原子写入 worktree_status.json（status="active"）
 *
 * 失败时清理：若 git worktree add 或写 status 失败，移除已创建的 worktree
 * 目录与临时 branch，抛出 PatchWardenError("worktree_create_failed")。
 *
 * @returns { worktreeId, worktreePath, branch }
 */
export function createWorktree(
  goalId: string,
  subgoalId: string,
  workspaceRoot: string
): { worktreeId: string; worktreePath: string; branch: string } {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);

  const worktreeId = generateWorktreeId();
  const worktreePath = getWorktreeDir(worktreeId, workspaceRoot);
  const branch = `pw-${sanitizeBranchSegment(goalId)}-${sanitizeBranchSegment(subgoalId)}`;

  // 安全：校验 worktreePath 在 workspaceRoot 内且非敏感路径
  guardWorkspacePath(worktreePath, wsRoot);
  guardSensitivePath(worktreePath);

  let worktreeCreated = false;
  let branchCreated = false;

  try {
    runGit(["worktree", "add", "-b", branch, worktreePath], wsRoot, GIT_TIMEOUT_MS);
    worktreeCreated = true;
    branchCreated = true;

    // 原子写入 worktree_status.json（worktreePath 是新目录，无旧 status，直接 tmp + rename）
    const statusFilePath = join(worktreePath, "worktree_status.json");
    const now = new Date().toISOString();
    const status: WorktreeStatus = {
      worktree_id: worktreeId,
      goal_id: goalId,
      subgoal_id: subgoalId,
      path: worktreePath,
      created_at: now,
      status: "active",
      branch,
    };
    writeStatusAtomic(statusFilePath, status);

    return { worktreeId, worktreePath, branch };
  } catch (err) {
    // 清理半成品
    if (worktreeCreated) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch { /* ignore */ }
      // rmSync 可能无法清除 git 的 worktree 元数据，再尝试 git worktree remove
      try {
        runGit(["worktree", "remove", "--force", worktreePath], wsRoot, GIT_BRANCH_TIMEOUT_MS);
      } catch { /* ignore */ }
    }
    if (branchCreated) {
      try {
        runGit(["branch", "-D", branch], wsRoot, GIT_BRANCH_TIMEOUT_MS);
      } catch { /* ignore — branch 可能未创建或已随 worktree remove 清理 */ }
    }

    if (err instanceof PatchWardenError) throw err;

    throw new PatchWardenError(
      "worktree_create_failed",
      `Failed to create worktree for goal "${goalId}" / subgoal "${subgoalId}": ${gitErrorMessage(err)}`,
      "Ensure workspaceRoot is a git repository with at least one commit, and the worktree path is writable.",
      true,
      {
        goal_id: goalId,
        subgoal_id: subgoalId,
        branch,
        worktree_path: worktreePath,
      }
    );
  }
}

/**
 * 读取 worktree_status.json。不存在返回 null。
 * 路径逃逸或敏感路径会抛 PatchWardenError（不静默吞掉安全违规）。
 */
export function readWorktreeStatus(
  worktreeId: string,
  workspaceRoot?: string
): WorktreeStatus | null {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  const worktreePath = getWorktreeDir(worktreeId, workspaceRoot);

  guardWorkspacePath(worktreePath, wsRoot);
  guardSensitivePath(worktreePath);

  const statusFilePath = join(worktreePath, "worktree_status.json");
  if (!existsSync(statusFilePath)) return null;

  try {
    const raw = readFileSync(statusFilePath, "utf-8");
    return JSON.parse(raw) as WorktreeStatus;
  } catch {
    return null;
  }
}

/**
 * 将 worktree 的 branch 合并回主工作区（workspaceRoot）。
 *
 * 流程：
 *   1. 读取 worktree_status.json，校验 status === "active"
 *   2. `git merge <branch>`（在 workspaceRoot 执行）
 *   3. 原子更新 worktree_status.json：status="merged"，merged_at=ISO timestamp
 *
 * 合并失败时抛 PatchWardenError("worktree_merge_failed")，不删除 worktree
 * （保留供人工排查冲突）。
 */
export function mergeWorktree(
  worktreeId: string,
  workspaceRoot: string
): { status: "merged" } {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  const worktreePath = getWorktreeDir(worktreeId, workspaceRoot);

  guardWorkspacePath(worktreePath, wsRoot);
  guardSensitivePath(worktreePath);

  const status = readWorktreeStatus(worktreeId, workspaceRoot);
  if (!status) {
    throw new PatchWardenError(
      "worktree_not_found",
      `Worktree "${worktreeId}" not found or has no worktree_status.json`,
      "Ensure the worktree id was created via createWorktree before merging.",
      true,
      { worktree_id: worktreeId }
    );
  }

  if (status.status !== "active") {
    throw new PatchWardenError(
      "invalid_worktree_state",
      `Worktree "${worktreeId}" is not active (current status: "${status.status}")`,
      "Only active worktrees can be merged.",
      true,
      { worktree_id: worktreeId, current_status: status.status }
    );
  }

  try {
    runGit(["merge", status.branch], wsRoot, GIT_TIMEOUT_MS);
  } catch (err) {
    // 合并失败：不删 worktree，保留供人工排查
    throw new PatchWardenError(
      "worktree_merge_failed",
      `Failed to merge worktree branch "${status.branch}" into workspace: ${gitErrorMessage(err)}`,
      "Resolve merge conflicts manually in the main workspace, then retry or discard the worktree.",
      true,
      { worktree_id: worktreeId, branch: status.branch }
    );
  }

  const updatedStatus: WorktreeStatus = {
    ...status,
    status: "merged",
    merged_at: new Date().toISOString(),
  };
  const statusFilePath = join(worktreePath, "worktree_status.json");
  writeStatusAtomic(statusFilePath, updatedStatus);

  return { status: "merged" };
}

/**
 * 丢弃 worktree：移除 worktree 目录与临时 branch，归档最终状态。
 *
 * 流程：
 *   1. 读取 worktree_status.json（在 remove 之前读取，因为 status 文件位于
 *      worktree 目录内），校验 status === "active"
 *   2. `git worktree remove --force <worktreePath>`
 *   3. `git branch -D <branch>` 删除临时 branch
 *   4. 把更新后的 status（discarded）写到归档目录
 *      `<workspaceRoot>/.patchwarden/worktree-archive/<worktreeId>.json`
 *      （.patchwarden 始终为安全路径，用 guardWorkspacePath 校验）
 *
 * 移除失败抛 PatchWardenError("worktree_discard_failed")。
 */
export function discardWorktree(
  worktreeId: string,
  workspaceRoot: string
): { status: "discarded" } {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  const worktreePath = getWorktreeDir(worktreeId, workspaceRoot);

  guardWorkspacePath(worktreePath, wsRoot);
  guardSensitivePath(worktreePath);

  // 在 remove 之前读取 status（status 文件位于 worktree 目录内）
  const status = readWorktreeStatus(worktreeId, workspaceRoot);
  if (!status) {
    throw new PatchWardenError(
      "worktree_not_found",
      `Worktree "${worktreeId}" not found or has no worktree_status.json`,
      "Ensure the worktree id was created via createWorktree before discarding.",
      true,
      { worktree_id: worktreeId }
    );
  }

  if (status.status !== "active") {
    throw new PatchWardenError(
      "invalid_worktree_state",
      `Worktree "${worktreeId}" is not active (current status: "${status.status}")`,
      "Only active worktrees can be discarded.",
      true,
      { worktree_id: worktreeId, current_status: status.status }
    );
  }

  try {
    runGit(["worktree", "remove", "--force", worktreePath], wsRoot, GIT_TIMEOUT_MS);
  } catch (err) {
    // git remove 失败时再尝试直接删目录（best effort），然后抛错
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch { /* ignore */ }
    throw new PatchWardenError(
      "worktree_discard_failed",
      `Failed to remove worktree "${worktreeId}": ${gitErrorMessage(err)}`,
      "Remove the worktree directory manually and run `git worktree prune`.",
      true,
      { worktree_id: worktreeId, worktree_path: worktreePath }
    );
  }

  // 删除临时 branch（best effort — 可能已随 worktree remove 清理）
  try {
    runGit(["branch", "-D", status.branch], wsRoot, GIT_BRANCH_TIMEOUT_MS);
  } catch { /* ignore */ }

  // 归档最终状态到 .patchwarden/worktree-archive/（worktree 目录可能已消失）
  const archivedStatus: WorktreeStatus = {
    ...status,
    status: "discarded",
    discarded_at: new Date().toISOString(),
  };

  const archiveDir = join(wsRoot, WORKTREE_ARCHIVE_DIR);
  guardWorkspacePath(archiveDir, wsRoot);
  // .patchwarden 路径在 sensitiveGuard 中始终视为安全（SAFE_PREFIX），无需额外校验

  try {
    mkdirSync(archiveDir, { recursive: true });
  } catch { /* ignore */ }

  const archiveFilePath = join(archiveDir, `${worktreeId}.json`);
  writeStatusAtomic(archiveFilePath, archivedStatus);

  return { status: "discarded" };
}
