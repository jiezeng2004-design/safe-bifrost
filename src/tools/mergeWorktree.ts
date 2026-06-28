/**
 * v1.0.0 Part B: merge_worktree MCP 工具 handler — 把隔离 worktree 的 branch
 * 合并回主工作区，并将 worktree 状态置为 "merged"。
 *
 * 参考 src/tools/auditTask.ts 的导出/返回风格。
 */

import { getConfig } from "../config.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import { mergeWorktree } from "../goal/worktreeManager.js";

export interface MergeWorktreeInput {
  worktree_id: string;
  repo_path: string;
}

export interface MergeWorktreeOutput {
  worktree_id: string;
  status: "merged";
  merged_at: string;
}

/**
 * 合并指定 worktree 的 branch 回 repo_path（主工作区）。
 *
 * @throws PatchWardenError("workspace_path_escape") 当 repo_path 逃逸出 workspaceRoot
 * @throws PatchWardenError("worktree_not_found") 当 worktree 不存在
 * @throws PatchWardenError("invalid_worktree_state") 当 worktree 非 active
 * @throws PatchWardenError("worktree_merge_failed") 当 git merge 失败
 */
export function mergeWorktreeTool(input: MergeWorktreeInput): MergeWorktreeOutput {
  const config = getConfig();
  const repoPathSafe = guardWorkspacePath(input.repo_path, config.workspaceRoot);

  mergeWorktree(input.worktree_id, repoPathSafe);

  return {
    worktree_id: input.worktree_id,
    status: "merged",
    merged_at: new Date().toISOString(),
  };
}
