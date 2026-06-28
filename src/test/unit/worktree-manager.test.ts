import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  createWorktree,
  mergeWorktree,
  discardWorktree,
  readWorktreeStatus,
  getWorktreesDir,
  type WorktreeStatus,
} from "../../goal/worktreeManager.js";
import { PatchWardenError } from "../../errors.js";

// ── Test fixtures ─────────────────────────────────────────────────

/**
 * 在 dir 创建一个真实的 git 仓库：git init + 配置 user + 初始 commit。
 * createWorktree 要求 workspaceRoot 是一个至少有一个 commit 的 git 仓库。
 */
function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@patchwarden.local"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "PatchWarden Test"', { cwd: dir, stdio: "ignore" });
  execSync('git config commit.gpgsign false', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "init\n", "utf-8");
  execSync("git add README.md", { cwd: dir, stdio: "ignore" });
  execSync("git commit -m init", { cwd: dir, stdio: "ignore" });
}

function gitBranchList(cwd: string): string {
  return execSync("git branch --list", { cwd, stdio: ["pipe", "pipe", "ignore"] }).toString("utf-8");
}

function assertPatchWardenError(fn: () => void, reason: string): void {
  try {
    fn();
    assert.fail(`expected PatchWardenError("${reason}") to be thrown`);
  } catch (err) {
    assert.ok(err instanceof PatchWardenError, `expected PatchWardenError, got: ${err}`);
    assert.equal((err as PatchWardenError).reason, reason);
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe("worktreeManager", () => {
  let workspaceRoot: string;

  before(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "pw-wt-"));
    initGitRepo(workspaceRoot);
  });

  after(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // ── 1. createWorktree 成功 ──
  it("createWorktree creates an active worktree with valid status.json", () => {
    const result = createWorktree("goal_20260101_demo", "subgoal-001", workspaceRoot);

    assert.ok(result.worktreeId.startsWith("wt_"), `worktreeId should start with "wt_", got: ${result.worktreeId}`);
    assert.ok(result.branch.startsWith("pw-goal_20260101_demo-subgoal-001"), `branch should be pw-<goal>-<subgoal>, got: ${result.branch}`);
    assert.ok(existsSync(result.worktreePath), "worktreePath should exist");

    const statusFile = join(result.worktreePath, "worktree_status.json");
    assert.ok(existsSync(statusFile), "worktree_status.json should exist");

    // 原子写：不应残留 .tmp 文件
    assert.ok(!existsSync(statusFile + ".tmp"), "status.json.tmp should not remain after atomic write");

    // JSON 合法且字段正确
    const status = JSON.parse(readFileSync(statusFile, "utf-8")) as WorktreeStatus;
    assert.equal(status.worktree_id, result.worktreeId);
    assert.equal(status.goal_id, "goal_20260101_demo");
    assert.equal(status.subgoal_id, "subgoal-001");
    assert.equal(status.status, "active");
    assert.equal(status.branch, result.branch);
    assert.equal(status.path, result.worktreePath);
    assert.ok(typeof status.created_at === "string" && status.created_at.length > 0);

    // worktree 内应检出主仓库的文件（README.md）
    assert.ok(existsSync(join(result.worktreePath, "README.md")), "worktree should check out README.md");

    // branch 应在 git 中存在
    assert.ok(gitBranchList(workspaceRoot).includes(result.branch), "branch should exist in git");

    // readWorktreeStatus 应返回一致的状态
    const readBack = readWorktreeStatus(result.worktreeId, workspaceRoot);
    assert.ok(readBack !== null);
    assert.equal(readBack.status, "active");
  });

  // ── 2. createWorktree git 命令失败清理 ──
  it("createWorktree cleans up and throws when git fails (non-git workspaceRoot)", () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "pw-wt-nogit-"));
    try {
      // 非 git 目录 → git worktree add 失败
      assertPatchWardenError(
        () => createWorktree("goal_x", "subgoal-001", nonGitDir),
        "worktree_create_failed"
      );

      // 不应残留任何 worktree 目录
      const worktreesDir = getWorktreesDir(nonGitDir);
      if (existsSync(worktreesDir)) {
        // 若 _workspacetrees 被创建，应为空（无半成品 worktree）
        const entries = readdirSync(worktreesDir);
        assert.equal(entries.length, 0, "no leftover worktree directories should remain after failure");
      }
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  // ── 3. mergeWorktree 成功 ──
  it("mergeWorktree merges the branch back and marks status merged", () => {
    const created = createWorktree("goal_merge", "subgoal-001", workspaceRoot);

    // 在 worktree 中产生一个新 commit，使 merge 有实际内容
    writeFileSync(join(created.worktreePath, "feature.txt"), "merged feature\n", "utf-8");
    execSync("git add feature.txt", { cwd: created.worktreePath, stdio: "ignore" });
    execSync("git commit -m feature", { cwd: created.worktreePath, stdio: "ignore" });

    const result = mergeWorktree(created.worktreeId, workspaceRoot);
    assert.equal(result.status, "merged");

    // 主工作区应出现 feature.txt（fast-forward 合并）
    assert.ok(existsSync(join(workspaceRoot, "feature.txt")), "feature.txt should appear in main workspace after merge");

    // status 应更新为 merged，merged_at 非空
    const status = readWorktreeStatus(created.worktreeId, workspaceRoot);
    assert.ok(status !== null);
    assert.equal(status.status, "merged");
    assert.ok(typeof status.merged_at === "string" && status.merged_at.length > 0, "merged_at should be set");
  });

  // ── 4. discardWorktree 成功 ──
  it("discardWorktree removes worktree, deletes branch, and archives status", () => {
    const created = createWorktree("goal_discard", "subgoal-001", workspaceRoot);
    const branch = created.branch;
    const worktreePath = created.worktreePath;

    const result = discardWorktree(created.worktreeId, workspaceRoot);
    assert.equal(result.status, "discarded");

    // worktree 目录应被移除
    assert.ok(!existsSync(worktreePath), "worktree directory should be removed after discard");

    // 临时 branch 应被删除
    assert.ok(!gitBranchList(workspaceRoot).includes(branch), "temporary branch should be deleted after discard");

    // 归档文件应存在且 status="discarded"
    const archiveFile = join(workspaceRoot, ".patchwarden", "worktree-archive", `${created.worktreeId}.json`);
    assert.ok(existsSync(archiveFile), "archived status file should exist");
    const archived = JSON.parse(readFileSync(archiveFile, "utf-8")) as WorktreeStatus;
    assert.equal(archived.status, "discarded");
    assert.ok(typeof archived.discarded_at === "string" && archived.discarded_at.length > 0, "discarded_at should be set");
    assert.equal(archived.worktree_id, created.worktreeId);
  });

  // ── 5. 路径逃逸拦截 ──
  it("blocks path escape via worktreeId containing ..", () => {
    // worktreeId 在 read/merge/discard 中由调用方提供，构造逃逸路径
    assertPatchWardenError(
      () => readWorktreeStatus("../../../outside", workspaceRoot),
      "workspace_path_escape"
    );
    assertPatchWardenError(
      () => mergeWorktree("../../../outside", workspaceRoot),
      "workspace_path_escape"
    );
    assertPatchWardenError(
      () => discardWorktree("../../../outside", workspaceRoot),
      "workspace_path_escape"
    );
  });

  // ── 6. 敏感路径拦截 ──
  it("blocks sensitive worktreeId via guardSensitivePath", () => {
    // "credentials" 命中 sensitiveGuard 的敏感模式
    assertPatchWardenError(
      () => readWorktreeStatus("credentials", workspaceRoot),
      "sensitive_path_blocked"
    );
    assertPatchWardenError(
      () => mergeWorktree("credentials", workspaceRoot),
      "sensitive_path_blocked"
    );
    assertPatchWardenError(
      () => discardWorktree("credentials", workspaceRoot),
      "sensitive_path_blocked"
    );
  });

  // ── 7. readWorktreeStatus 返回 null 当 status 不存在 ──
  it("readWorktreeStatus returns null when status file does not exist", () => {
    // 创建一个 worktree 目录但不含 status 文件
    const created = createWorktree("goal_missing", "subgoal-001", workspaceRoot);
    // 手动删除 status 文件模拟缺失
    unlinkSync(join(created.worktreePath, "worktree_status.json"));
    assert.equal(readWorktreeStatus(created.worktreeId, workspaceRoot), null);
    // 清理：删除该 worktree（避免污染后续测试）
    try {
      execSync(`git worktree remove --force "${created.worktreePath}"`, { cwd: workspaceRoot, stdio: "ignore" });
    } catch { /* ignore */ }
    try {
      execSync(`git branch -D ${created.branch}`, { cwd: workspaceRoot, stdio: "ignore" });
    } catch { /* ignore */ }
  });

  // ── 8. 非法状态转换：merge/discard 已 merged 的 worktree 抛错 ──
  it("rejects merge/discard on non-active worktree", () => {
    // 复用 #3 已 merged 的 worktree（goal_merge/subgoal-001）
    // 先找到它的 worktreeId：扫描 _workspacetrees 目录
    const worktreesDir = getWorktreesDir(workspaceRoot);
    let mergedId: string | null = null;
    for (const entry of readdirSync(worktreesDir)) {
      const s = readWorktreeStatus(entry, workspaceRoot);
      if (s && s.status === "merged" && s.goal_id === "goal_merge") {
        mergedId = entry;
        break;
      }
    }
    assert.ok(mergedId !== null, "should find the merged worktree from the merge test");

    assertPatchWardenError(
      () => mergeWorktree(mergedId as string, workspaceRoot),
      "invalid_worktree_state"
    );
    assertPatchWardenError(
      () => discardWorktree(mergedId as string, workspaceRoot),
      "invalid_worktree_state"
    );
  });
});
