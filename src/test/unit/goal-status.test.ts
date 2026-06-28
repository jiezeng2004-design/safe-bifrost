import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  createInitialGoalStatus,
  addSubgoal,
  updateSubgoalStatus,
  linkTaskToSubgoal,
  type GoalStatus,
} from "../../goal/goalStatus.js";
import { PatchWardenError } from "../../errors.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeInitialStatus(): GoalStatus {
  return createInitialGoalStatus("goal_test_001", "Test Goal", "/repo/test");
}

// ── Tests ─────────────────────────────────────────────────────────

describe("goalStatus", () => {

  describe("createInitialGoalStatus", () => {
    it("返回正确的初始字段", () => {
      const status = createInitialGoalStatus("goal_20260101_my_goal", "My Goal", "/repo/path");
      assert.equal(status.goal_id, "goal_20260101_my_goal");
      assert.equal(status.title, "My Goal");
      assert.equal(status.status, "active");
      assert.equal(status.repo_path, "/repo/path");
      assert.ok(status.created_at.length > 0);
      assert.equal(status.created_at, status.updated_at);
      assert.deepEqual(status.subgoals, []);
    });
  });

  describe("addSubgoal", () => {
    it("成功生成 subgoal-001", () => {
      const initial = makeInitialStatus();
      const { goalStatus, subgoalId } = addSubgoal(initial, "First subgoal");
      assert.equal(subgoalId, "subgoal-001");
      assert.equal(goalStatus.subgoals.length, 1);
      const sub = goalStatus.subgoals[0];
      assert.equal(sub.id, "subgoal-001");
      assert.equal(sub.title, "First subgoal");
      assert.equal(sub.status, "ready");
      assert.deepEqual(sub.depends_on, []);
      assert.deepEqual(sub.task_ids, []);
    });

    it("多个 subgoal 编号递增", () => {
      const initial = makeInitialStatus();
      const r1 = addSubgoal(initial, "A");
      const r2 = addSubgoal(r1.goalStatus, "B");
      const r3 = addSubgoal(r2.goalStatus, "C");
      assert.equal(r1.subgoalId, "subgoal-001");
      assert.equal(r2.subgoalId, "subgoal-002");
      assert.equal(r3.subgoalId, "subgoal-003");
      assert.equal(r3.goalStatus.subgoals.length, 3);
    });

    it("三位补零到 010", () => {
      let status = makeInitialStatus();
      for (let i = 1; i <= 10; i++) {
        const r = addSubgoal(status, `Sub ${i}`);
        status = r.goalStatus;
        if (i === 10) {
          assert.equal(r.subgoalId, "subgoal-010");
        }
      }
    });

    it("无效依赖抛出 invalid_dependency", () => {
      const initial = makeInitialStatus();
      assert.throws(
        () => addSubgoal(initial, "Bad dep", ["subgoal-999"]),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_dependency");
          return true;
        }
      );
    });

    it("有效依赖成功添加", () => {
      const initial = makeInitialStatus();
      const r1 = addSubgoal(initial, "Parent");
      const r2 = addSubgoal(r1.goalStatus, "Child", ["subgoal-001"]);
      assert.equal(r2.subgoalId, "subgoal-002");
      assert.deepEqual(r2.goalStatus.subgoals[1].depends_on, ["subgoal-001"]);
    });

    it("不修改原 goalStatus（不可变）", () => {
      const initial = makeInitialStatus();
      const originalLen = initial.subgoals.length;
      addSubgoal(initial, "New");
      assert.equal(initial.subgoals.length, originalLen);
    });

    it("更新 updated_at", () => {
      const initial = makeInitialStatus();
      const originalUpdatedAt = initial.updated_at;
      const { goalStatus } = addSubgoal(initial, "New");
      // updated_at 应该是新的 ISO 时间字符串
      assert.ok(goalStatus.updated_at >= originalUpdatedAt);
    });
  });

  describe("updateSubgoalStatus", () => {
    it("合法转换 ready → running", () => {
      let status = makeInitialStatus();
      const r = addSubgoal(status, "Sub");
      status = r.goalStatus;
      const updated = updateSubgoalStatus(status, "subgoal-001", "running");
      assert.equal(updated.subgoals[0].status, "running");
    });

    it("合法完整链路 ready → running → done_by_agent → accepted", () => {
      let status = makeInitialStatus();
      status = addSubgoal(status, "Sub").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-001", "running");
      status = updateSubgoalStatus(status, "subgoal-001", "done_by_agent");
      status = updateSubgoalStatus(status, "subgoal-001", "accepted");
      assert.equal(status.subgoals[0].status, "accepted");
      assert.ok(status.subgoals[0].accepted_at !== undefined);
      assert.ok(status.subgoals[0].accepted_at!.length > 0);
    });

    it("done_by_agent → rejected 需要 reason", () => {
      let status = makeInitialStatus();
      status = addSubgoal(status, "Sub").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-001", "running");
      status = updateSubgoalStatus(status, "subgoal-001", "done_by_agent");

      // 缺少 reason 抛错
      assert.throws(
        () => updateSubgoalStatus(status, "subgoal-001", "rejected"),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_status_transition");
          return true;
        }
      );

      // 提供 reason 成功
      const updated = updateSubgoalStatus(status, "subgoal-001", "rejected", {
        rejected_reason: "Tests failed",
      });
      assert.equal(updated.subgoals[0].status, "rejected");
      assert.equal(updated.subgoals[0].rejected_reason, "Tests failed");
    });

    it("合法分支 done_by_agent → needs_fix → running", () => {
      let status = makeInitialStatus();
      status = addSubgoal(status, "Sub").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-001", "running");
      status = updateSubgoalStatus(status, "subgoal-001", "done_by_agent");
      status = updateSubgoalStatus(status, "subgoal-001", "needs_fix");
      assert.equal(status.subgoals[0].status, "needs_fix");
      status = updateSubgoalStatus(status, "subgoal-001", "running");
      assert.equal(status.subgoals[0].status, "running");
    });

    it("非法转换 ready → accepted 抛错", () => {
      const initial = makeInitialStatus();
      const status = addSubgoal(initial, "Sub").goalStatus;
      assert.throws(
        () => updateSubgoalStatus(status, "subgoal-001", "accepted"),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_status_transition");
          return true;
        }
      );
    });

    it("非法转换 running → ready 抛错", () => {
      let status = makeInitialStatus();
      status = addSubgoal(status, "Sub").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-001", "running");
      assert.throws(
        () => updateSubgoalStatus(status, "subgoal-001", "ready"),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_status_transition");
          return true;
        }
      );
    });

    it("终态 accepted → running 抛错", () => {
      let status = makeInitialStatus();
      status = addSubgoal(status, "Sub").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-001", "running");
      status = updateSubgoalStatus(status, "subgoal-001", "done_by_agent");
      status = updateSubgoalStatus(status, "subgoal-001", "accepted");
      assert.throws(
        () => updateSubgoalStatus(status, "subgoal-001", "running"),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_status_transition");
          return true;
        }
      );
    });

    it("subgoal 不存在抛出 subgoal_not_found", () => {
      const initial = makeInitialStatus();
      assert.throws(
        () => updateSubgoalStatus(initial, "subgoal-999", "running"),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "subgoal_not_found");
          return true;
        }
      );
    });

    it("不修改原 goalStatus（不可变）", () => {
      let status = makeInitialStatus();
      status = addSubgoal(status, "Sub").goalStatus;
      const originalStatus = status.subgoals[0].status;
      updateSubgoalStatus(status, "subgoal-001", "running");
      assert.equal(status.subgoals[0].status, originalStatus);
    });
  });

  describe("linkTaskToSubgoal", () => {
    it("成功追加 taskId", () => {
      let status = makeInitialStatus();
      status = addSubgoal(status, "Sub").goalStatus;
      const updated = linkTaskToSubgoal(status, "subgoal-001", "task_abc");
      assert.deepEqual(updated.subgoals[0].task_ids, ["task_abc"]);
    });

    it("追加多个 taskId", () => {
      let status = makeInitialStatus();
      status = addSubgoal(status, "Sub").goalStatus;
      status = linkTaskToSubgoal(status, "subgoal-001", "task_a");
      status = linkTaskToSubgoal(status, "subgoal-001", "task_b");
      assert.deepEqual(status.subgoals[0].task_ids, ["task_a", "task_b"]);
    });

    it("去重：相同 taskId 不重复添加", () => {
      let status = makeInitialStatus();
      status = addSubgoal(status, "Sub").goalStatus;
      status = linkTaskToSubgoal(status, "subgoal-001", "task_a");
      status = linkTaskToSubgoal(status, "subgoal-001", "task_a");
      assert.deepEqual(status.subgoals[0].task_ids, ["task_a"]);
    });

    it("subgoal 不存在抛出 subgoal_not_found", () => {
      const initial = makeInitialStatus();
      assert.throws(
        () => linkTaskToSubgoal(initial, "subgoal-999", "task_a"),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "subgoal_not_found");
          return true;
        }
      );
    });

    it("不修改原 goalStatus（不可变）", () => {
      let status = makeInitialStatus();
      status = addSubgoal(status, "Sub").goalStatus;
      const originalLen = status.subgoals[0].task_ids.length;
      linkTaskToSubgoal(status, "subgoal-001", "task_a");
      assert.equal(status.subgoals[0].task_ids.length, originalLen);
    });
  });
});
