import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateGoalId,
  getGoalsDir,
  getGoalDir,
  createGoal,
  listGoals,
  readGoal,
  writeGoalStatus,
  readGoalStatus,
} from "../../goal/goalStore.js";
import { addSubgoal, updateSubgoalStatus } from "../../goal/goalStatus.js";
import { PatchWardenError } from "../../errors.js";

// ── Helpers ───────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pw-goalstore-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function todayDatePart(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("goalStore", () => {

  describe("generateGoalId", () => {
    it("正常 title 生成 goal_{date}_{slug}", () => {
      const id = generateGoalId("Implement Feature X", []);
      assert.equal(id, `goal_${todayDatePart()}_implement_feature_x`);
    });

    it("特殊字符 title 转换为 slug", () => {
      const id = generateGoalId("Fix: Bug #123 & Refactor!", []);
      assert.equal(id, `goal_${todayDatePart()}_fix_bug_123_refactor`);
    });

    it("空 title 用 untitled 代替", () => {
      const id = generateGoalId("", []);
      assert.equal(id, `goal_${todayDatePart()}_untitled`);
    });

    it("纯符号 title 用 untitled 代替", () => {
      const id = generateGoalId("!!!@#$%^&*()", []);
      assert.equal(id, `goal_${todayDatePart()}_untitled`);
    });

    it("title 截断到 30 字符 slug", () => {
      const longTitle = "abcdefghijklmnopqrstuvwxyz0123456789";
      const id = generateGoalId(longTitle, []);
      const slug = id.split("_").slice(2).join("_");
      assert.ok(slug.length <= 30, `slug length should be <= 30, got ${slug.length}`);
    });

    it("冲突时追加 _2", () => {
      const base = `goal_${todayDatePart()}_implement_feature_x`;
      const id = generateGoalId("Implement Feature X", [base]);
      assert.equal(id, `${base}_2`);
    });

    it("多次冲突递增 _3", () => {
      const base = `goal_${todayDatePart()}_implement_feature_x`;
      const id = generateGoalId("Implement Feature X", [base, `${base}_2`]);
      assert.equal(id, `${base}_3`);
    });

    it("不冲突时不追加后缀", () => {
      const base = `goal_${todayDatePart()}_implement_feature_x`;
      const other = `goal_${todayDatePart()}_other_goal`;
      const id = generateGoalId("Implement Feature X", [other]);
      assert.equal(id, base);
    });
  });

  describe("getGoalsDir / getGoalDir", () => {
    it("getGoalsDir 返回 .patchwarden/goals 路径", () => {
      const dir = getGoalsDir(tempDir);
      assert.equal(dir, join(tempDir, ".patchwarden", "goals"));
    });

    it("getGoalDir 返回 {goalsDir}/{goalId}", () => {
      const dir = getGoalDir("goal_001", tempDir);
      assert.equal(dir, join(tempDir, ".patchwarden", "goals", "goal_001"));
    });
  });

  describe("createGoal", () => {
    it("成功创建目录结构和文件", () => {
      const repoRel = "my-repo";
      const { goal_id, goal_dir } = createGoal(repoRel, "Test Goal", "A test description", tempDir);
      assert.ok(goal_id.startsWith(`goal_${todayDatePart()}_test_goal`));
      assert.equal(goal_dir, join(tempDir, ".patchwarden", "goals", goal_id));

      // 验证目录结构
      assert.ok(existsSync(goal_dir), "goal_dir exists");
      assert.ok(existsSync(join(goal_dir, "tasks")), "tasks/ exists");
      assert.ok(existsSync(join(goal_dir, "artifacts")), "artifacts/ exists");

      // 验证 GOAL.md
      const goalMd = readFileSync(join(goal_dir, "GOAL.md"), "utf-8");
      assert.ok(goalMd.includes("# Test Goal"));
      assert.ok(goalMd.includes("A test description"));
      assert.ok(goalMd.includes("- Status: active"));
      assert.ok(goalMd.includes("- Repo:"));

      // 验证 GOALS.md
      const goalsMd = readFileSync(join(goal_dir, "GOALS.md"), "utf-8");
      assert.ok(goalsMd.includes("# Subgoals: Test Goal"));
      assert.ok(goalsMd.includes("_No subgoals yet._"));

      // 验证 goal_status.json
      const statusPath = join(goal_dir, "goal_status.json");
      assert.ok(existsSync(statusPath));
      const status = JSON.parse(readFileSync(statusPath, "utf-8"));
      assert.equal(status.goal_id, goal_id);
      assert.equal(status.title, "Test Goal");
      assert.equal(status.status, "active");
      assert.deepEqual(status.subgoals, []);
    });

    it("repo_path 越界抛出 workspace_path_escape", () => {
      const outside = process.platform === "win32" ? "C:\\Windows\\System32" : "/etc";
      assert.throws(
        () => createGoal(outside, "Bad", "desc", tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "workspace_path_escape");
          return true;
        }
      );
    });

    it("相同 title 创建多个 goal 时 id 不冲突", () => {
      const r1 = createGoal("repo", "Same Title", "d1", tempDir);
      const r2 = createGoal("repo", "Same Title", "d2", tempDir);
      assert.notEqual(r1.goal_id, r2.goal_id);
      assert.ok(r2.goal_id.endsWith("_2"));
    });
  });

  describe("listGoals", () => {
    it("空目录返回空数组", () => {
      const list = listGoals(tempDir);
      assert.deepEqual(list, []);
    });

    it("goals 目录不存在返回空数组", () => {
      // tempDir 中没有 .patchwarden/goals
      const list = listGoals(tempDir);
      assert.deepEqual(list, []);
    });

    it("返回多个 goal 的摘要", () => {
      createGoal("repo", "Goal A", "desc A", tempDir);
      createGoal("repo", "Goal B", "desc B", tempDir);
      const list = listGoals(tempDir);
      assert.equal(list.length, 2);
      const titles = list.map((g) => g.title).sort();
      assert.deepEqual(titles, ["Goal A", "Goal B"]);
    });

    it("按 updated_at 降序排列", async () => {
      const r1 = createGoal("repo", "Older", "desc", tempDir);
      // 等待一小段时间确保 updated_at 不同
      await new Promise((resolve) => setTimeout(resolve, 50));
      const r2 = createGoal("repo", "Newer", "desc", tempDir);

      // 修改 older 的 status，使其 updated_at 更新
      const olderStatus = readGoalStatus(r1.goal_id, tempDir);
      const newerStatus = readGoalStatus(r2.goal_id, tempDir);

      // 让 older 的 updated_at 比 newer 更晚
      const future = new Date(Date.now() + 10000).toISOString();
      writeGoalStatus(r1.goal_id, { ...olderStatus, updated_at: future }, tempDir);

      const list = listGoals(tempDir);
      assert.equal(list.length, 2);
      assert.equal(list[0].goal_id, r1.goal_id);
      assert.equal(list[1].goal_id, r2.goal_id);
      assert.ok(list[0].updated_at >= list[1].updated_at);
    });

    it("subgoal 摘要正确计算", () => {
      const { goal_id } = createGoal("repo", "With Subs", "desc", tempDir);
      let status = readGoalStatus(goal_id, tempDir);
      status = addSubgoal(status, "S1").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-001", "running");
      status = addSubgoal(status, "S2").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-002", "running");
      status = updateSubgoalStatus(status, "subgoal-002", "done_by_agent");
      status = updateSubgoalStatus(status, "subgoal-002", "accepted");
      writeGoalStatus(goal_id, status, tempDir);

      const list = listGoals(tempDir);
      assert.equal(list.length, 1);
      const item = list[0];
      assert.equal(item.subgoal_total, 2);
      assert.equal(item.subgoal_accepted, 1);
      assert.equal(item.subgoal_running, 1);
    });

    it("跳过无法解析的目录", () => {
      // 创建一个有效的 goal
      createGoal("repo", "Valid", "desc", tempDir);
      // 创建一个无效的目录（没有 goal_status.json）
      const goalsDir = getGoalsDir(tempDir);
      const badDir = join(goalsDir, "goal_bad_9999_invalid");
      mkdirSync(badDir, { recursive: true });

      const list = listGoals(tempDir);
      assert.equal(list.length, 1);
      assert.equal(list[0].title, "Valid");
    });
  });

  describe("readGoal", () => {
    it("返回完整详情", () => {
      const { goal_id } = createGoal("repo", "Read Me", "description here", tempDir);
      const detail = readGoal(goal_id, tempDir);
      assert.equal(detail.goal_id, goal_id);
      assert.equal(detail.title, "Read Me");
      assert.equal(detail.status, "active");
      assert.equal(detail.created_at, detail.updated_at);
      assert.ok(detail.goal_description.includes("# Read Me"));
      assert.ok(detail.goal_description.includes("description here"));
      assert.deepEqual(detail.subgoals, []);
    });

    it("goal 不存在抛出 goal_not_found", () => {
      assert.throws(
        () => readGoal("goal_nonexistent", tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });

    it("goal_status.json 不存在抛出 goal_not_found", () => {
      // 手动创建一个 goal 目录但不写 status
      const goalsDir = getGoalsDir(tempDir);
      const emptyGoalDir = join(goalsDir, "goal_empty");
      mkdirSync(emptyGoalDir, { recursive: true });
      assert.throws(
        () => readGoal("goal_empty", tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });
  });

  describe("writeGoalStatus + readGoalStatus", () => {
    it("写入后读取一致", () => {
      const { goal_id } = createGoal("repo", "Round Trip", "desc", tempDir);
      const original = readGoalStatus(goal_id, tempDir);
      const withSub = addSubgoal(original, "New Sub").goalStatus;
      writeGoalStatus(goal_id, withSub, tempDir);

      const read = readGoalStatus(goal_id, tempDir);
      assert.equal(read.subgoals.length, 1);
      assert.equal(read.subgoals[0].id, "subgoal-001");
      assert.equal(read.subgoals[0].title, "New Sub");
      assert.equal(read.subgoals[0].status, "ready");
    });

    it("原子写：tmp 文件不留", () => {
      const { goal_id, goal_dir } = createGoal("repo", "Atomic", "desc", tempDir);
      const status = readGoalStatus(goal_id, tempDir);
      writeGoalStatus(goal_id, status, tempDir);

      const entries = readdirSync(goal_dir);
      assert.ok(!entries.includes("goal_status.json.tmp"), "tmp file should not remain");
      assert.ok(entries.includes("goal_status.json"), "final file should exist");
    });

    it("readGoalStatus 文件不存在抛出 goal_not_found", () => {
      assert.throws(
        () => readGoalStatus("goal_nonexistent", tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });

    it("JSON 格式化（2 空格缩进 + 末尾换行）", () => {
      const { goal_id, goal_dir } = createGoal("repo", "Format", "desc", tempDir);
      const status = readGoalStatus(goal_id, tempDir);
      writeGoalStatus(goal_id, status, tempDir);
      const raw = readFileSync(join(goal_dir, "goal_status.json"), "utf-8");
      // 末尾换行
      assert.ok(raw.endsWith("\n"), "should end with newline");
      // 2 空格缩进
      assert.ok(raw.includes('\n  "goal_id"'), "should use 2-space indent");
    });
  });
});
