import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createSubgoalTask } from "../../tools/goalSubgoalTask.js";
import { PatchWardenError } from "../../errors.js";

// ── Tests ─────────────────────────────────────────────────────────
//
// 说明：createSubgoalTask 内部调用 createTask，后者使用 getConfig()（无 workspaceRoot
// 覆盖），因此 happy-path 依赖真实配置的工作区，留待集成测试覆盖。
// 此处仅测试不触及 createTask 完整流程的错误路径：
//   - invalid_execution_mode：在读取 goal 之前即抛错
//   - goal_not_found：readGoalStatus 在默认工作区找不到 goal 即抛错

describe("createSubgoalTask", () => {

  describe("错误路径", () => {
    it("execution_mode=assess_only 抛 invalid_execution_mode", () => {
      assert.throws(
        () =>
          createSubgoalTask({
            goal_id: "goal_nonexistent_test",
            subgoal_title: "Sub A",
            repo_path: "repo",
            execution_mode: "assess_only",
          }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_execution_mode");
          assert.equal(err.blocked, true);
          return true;
        }
      );
    });

    it("goal_id 不存在抛 goal_not_found", () => {
      assert.throws(
        () =>
          createSubgoalTask({
            goal_id: "goal_definitely_does_not_exist_99999",
            subgoal_title: "Sub A",
            repo_path: "repo",
          }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "goal_not_found");
          assert.equal(err.blocked, true);
          assert.ok(err.details.goal_id === "goal_definitely_does_not_exist_99999");
          return true;
        }
      );
    });

    it("assess_only 优先于 goal_not_found（在读取 goal 前校验）", () => {
      // execution_mode=assess_only 应先抛 invalid_execution_mode，
      // 而不是去读不存在的 goal
      assert.throws(
        () =>
          createSubgoalTask({
            goal_id: "goal_definitely_does_not_exist_99999",
            subgoal_title: "Sub A",
            repo_path: "repo",
            execution_mode: "assess_only",
          }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_execution_mode");
          return true;
        }
      );
    });
  });
});
