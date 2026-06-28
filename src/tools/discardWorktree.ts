/**
 * v1.0.0 Part B: discard_worktree MCP 工具 handler — 移除隔离 worktree 与临时
 * branch，并将最终状态归档到 .patchwarden/worktree-archive/。
 *
 * 参考 src/tools/auditTask.ts 的导出/返回风格。
 */

import { getConfig } from "../config.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import { discardWorktree } from "../goal/worktreeManager.js";

export interface DiscardWorktreeInput {
  worktree_id: string;
  repo_path: string;
}

export interface DiscardWorktreeOutput {
  worktree_id: string;
  status: "discarded";
  discarded_at: string;
}

/**
 * 丢弃指定 worktree：移除 worktree 目录、删除临时 branch、归档状态。
 *
 * @throws PatchWardenError("workspace_path_escape") 当 repo_path 逃逸出 workspaceRoot
 * @throws PatchWardenError("worktree_not_found") 当 worktree 不存在
 * @throws PatchWardenError("invalid_worktree_state") 当 worktree 非 active
 * @throws PatchWardenError("worktree_discard_failed") 当 git worktree remove 失败
 */
export function discardWorktreeTool(input: DiscardWorktreeInput): DiscardWorktreeOutput {
  const config = getConfig();
  const repoPathSafe = guardWorkspacePath(input.repo_path, config.workspaceRoot);

  discardWorktree(input.worktree_id, repoPathSafe);

  return {
    worktree_id: input.worktree_id,
    status: "discarded",
    discarded_at: new Date().toISOString(),
  };
}
