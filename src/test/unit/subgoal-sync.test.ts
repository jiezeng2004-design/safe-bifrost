import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoal, readGoalStatus, writeGoalStatus } from "../../goal/goalStore.js";
import { addSubgoal, updateSubgoalStatus } from "../../goal/goalStatus.js";
import { syncSubgoalOnTaskDone, readTaskGoalMeta } from "../../goal/subgoalSync.js";

// ── Helpers ───────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pw-subgoalsync-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * 在 tempDir 下创建 goal，添加一个 subgoal 并置为 running，写回 goal_status.json。
 * 返回 goal_id 和 subgoalId。
 */
function setupGoalWithRunningSubgoal(
  title = "Test Goal"
): { goalId: string; subgoalId: string } {
  const { goal_id } = createGoal("repo", title, "desc", tempDir);
  let status = readGoalStatus(goal_id, tempDir);
  const { goalStatus: withSub, subgoalId } = addSubgoal(status, "First subgoal");
  const withRunning = updateSubgoalStatus(withSub, subgoalId, "running");
  writeGoalStatus(goal_id, withRunning, tempDir);
  return { goalId: goal_id, subgoalId };
}

/** 创建一个假的 task 目录，写入 status.json（可包含 goal_id/subgoal_id）。 */
function writeTaskStatus(
  taskId: string,
  fields: Record<string, unknown>
): string {
  const taskDir = join(tempDir, ".patchwarden", "tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "status.json"),
    JSON.stringify({ task_id: taskId, ...fields }, null, 2),
    "utf-8"
  );
  return taskDir;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("subgoalSync", () => {

  describe("syncSubgoalOnTaskDone", () => {
    it("无 goal_id/subgoal_id 直接返回（向后兼容）", () => {
      const { goalId, subgoalId } = setupGoalWithRunningSubgoal();
      // 不传 goal_id / subgoal_id
      syncSubgoalOnTaskDone("task_001", { goal_id: null, subgoal_id: null }, tempDir);

      // subgoal 状态不变
      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals[0].status, "running");
    });

    it("仅 goal_id 缺失直接返回", () => {
      const { subgoalId } = setupGoalWithRunningSubgoal();
      syncSubgoalOnTaskDone("task_001", { goal_id: null, subgoal_id: subgoalId }, tempDir);
      // 不应抛错
    });

    it("仅 subgoal_id 缺失直接返回", () => {
      const { goalId } = setupGoalWithRunningSubgoal();
      syncSubgoalOnTaskDone("task_001", { goal_id: goalId, subgoal_id: null }, tempDir);
      // 不应抛错
    });

    it("subgoal 状态为 running → 更新为 done_by_agent", () => {
      const { goalId, subgoalId } = setupGoalWithRunningSubgoal();
      syncSubgoalOnTaskDone("task_001", { goal_id: goalId, subgoal_id: subgoalId }, tempDir);

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals[0].status, "done_by_agent");
    });

    it("subgoal 状态非 running（如 ready）→ 不更新", () => {
      const { goal_id } = createGoal("repo", "Ready Goal", "desc", tempDir);
      let status = readGoalStatus(goal_id, tempDir);
      const { goalStatus: withSub, subgoalId } = addSubgoal(status, "Ready subgoal");
      // 不做 running 转换，保持 ready
      writeGoalStatus(goal_id, withSub, tempDir);

      syncSubgoalOnTaskDone("task_001", { goal_id: goal_id, subgoal_id: subgoalId }, tempDir);

      const after = readGoalStatus(goal_id, tempDir);
      assert.equal(after.subgoals[0].status, "ready");
    });

    it("subgoal 状态为 done_by_agent → 不重复更新", () => {
      const { goalId, subgoalId } = setupGoalWithRunningSubgoal();
      // 第一次同步：running → done_by_agent
      syncSubgoalOnTaskDone("task_001", { goal_id: goalId, subgoal_id: subgoalId }, tempDir);
      // 第二次同步：done_by_agent 不应再变（running → done_by_agent 已完成，且 done_by_agent → done_by_agent 非法）
      syncSubgoalOnTaskDone("task_001", { goal_id: goalId, subgoal_id: subgoalId }, tempDir);

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals[0].status, "done_by_agent");
    });

    it("goal 不存在 → 不抛错（try/catch 隔离）", () => {
      // 不抛错即通过
      assert.doesNotThrow(() => {
        syncSubgoalOnTaskDone(
          "task_001",
          { goal_id: "goal_nonexistent", subgoal_id: "subgoal-001" },
          tempDir
        );
      });
    });

    it("subgoal 不存在 → 不抛错", () => {
      const { goalId } = setupGoalWithRunningSubgoal();
      assert.doesNotThrow(() => {
        syncSubgoalOnTaskDone(
          "task_001",
          { goal_id: goalId, subgoal_id: "subgoal-999" },
          tempDir
        );
      });
      // 原 subgoal 不受影响
      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals[0].status, "running");
    });

    it("不传 workspaceRoot 时不抛错（使用默认 getConfig）", () => {
      // 此测试验证向后兼容签名；默认 getConfig().workspaceRoot 指向 cwd，
      // goal 不存在于那里，应被 try/catch 吞掉，不抛错。
      const { goalId, subgoalId } = setupGoalWithRunningSubgoal();
      assert.doesNotThrow(() => {
        syncSubgoalOnTaskDone("task_001", { goal_id: goalId, subgoal_id: subgoalId });
      });
    });
  });

  describe("readTaskGoalMeta", () => {
    it("正常读取 status.json 中的 goal_id/subgoal_id", () => {
      const taskDir = writeTaskStatus("task_001", {
        goal_id: "goal_20260101_test",
        subgoal_id: "subgoal-001",
      });
      const meta = readTaskGoalMeta(taskDir);
      assert.equal(meta.goal_id, "goal_20260101_test");
      assert.equal(meta.subgoal_id, "subgoal-001");
    });

    it("status.json 不存在 → 返回 { null, null }", () => {
      const taskDir = join(tempDir, ".patchwarden", "tasks", "nonexistent");
      const meta = readTaskGoalMeta(taskDir);
      assert.equal(meta.goal_id, null);
      assert.equal(meta.subgoal_id, null);
    });

    it("status.json 无 goal_id/subgoal_id 字段 → 返回 { null, null }", () => {
      const taskDir = writeTaskStatus("task_002", { status: "pending" });
      const meta = readTaskGoalMeta(taskDir);
      assert.equal(meta.goal_id, null);
      assert.equal(meta.subgoal_id, null);
    });

    it("status.json 字段为非字符串 → 返回 { null, null }", () => {
      const taskDir = writeTaskStatus("task_003", {
        goal_id: 123,
        subgoal_id: null,
      });
      const meta = readTaskGoalMeta(taskDir);
      assert.equal(meta.goal_id, null);
      assert.equal(meta.subgoal_id, null);
    });

    it("status.json 为损坏 JSON → 返回 { null, null }", () => {
      const taskDir = join(tempDir, ".patchwarden", "tasks", "task_004");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.json"), "{ not valid json", "utf-8");
      const meta = readTaskGoalMeta(taskDir);
      assert.equal(meta.goal_id, null);
      assert.equal(meta.subgoal_id, null);
    });

    it("仅 goal_id 字段存在 → subgoal_id 为 null", () => {
      const taskDir = writeTaskStatus("task_005", { goal_id: "goal_x" });
      const meta = readTaskGoalMeta(taskDir);
      assert.equal(meta.goal_id, "goal_x");
      assert.equal(meta.subgoal_id, null);
    });
  });

  describe("end-to-end: task 完成 → subgoal 同步", () => {
    it("模拟 reconcileTasks done_by_agent 流程：task status.json 写入后同步 subgoal", () => {
      const { goalId, subgoalId } = setupGoalWithRunningSubgoal();
      const taskId = "task_20260101_abc123";

      // 模拟 createTask 写入 task status.json（含 goal_id/subgoal_id）
      const taskDir = writeTaskStatus(taskId, {
        status: "pending",
        goal_id: goalId,
        subgoal_id: subgoalId,
      });

      // 模拟 reconcileTasks 将状态置为 done_by_agent 后调用同步
      const meta = readTaskGoalMeta(taskDir);
      assert.equal(meta.subgoal_id, subgoalId);
      syncSubgoalOnTaskDone(taskId, meta, tempDir);

      // 验证 subgoal 状态已同步为 done_by_agent
      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals[0].status, "done_by_agent");
    });

    it("无关联的 task 完成 → subgoal 状态不变", () => {
      const { goalId, subgoalId } = setupGoalWithRunningSubgoal();
      const taskId = "task_20260101_nogoal";

      // task 没有 goal_id/subgoal_id 关联
      const taskDir = writeTaskStatus(taskId, { status: "pending" });
      const meta = readTaskGoalMeta(taskDir);
      assert.equal(meta.subgoal_id, null);

      // 即便误调用同步，也不会影响 subgoal
      syncSubgoalOnTaskDone(taskId, meta, tempDir);

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals[0].status, "running");
    });
  });
});
