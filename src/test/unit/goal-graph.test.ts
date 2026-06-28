import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  getReadySubgoals,
  getBlockedSubgoals,
  suggestNextSubgoal,
  detectCycle,
  topologicalSort,
} from "../../goal/goalGraph.js";
import type { GoalStatus, Subgoal, SubgoalStatus } from "../../goal/goalStatus.js";
import { PatchWardenError } from "../../errors.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeSubgoal(overrides: Partial<Subgoal> & { id: string }): Subgoal {
  return {
    title: "Subgoal " + overrides.id,
    status: "ready",
    depends_on: [],
    task_ids: [],
    ...overrides,
  };
}

function makeGoalStatus(subgoals: Subgoal[], overrides: Partial<GoalStatus> = {}): GoalStatus {
  const now = new Date().toISOString();
  return {
    goal_id: "goal_test_001",
    title: "Test Goal",
    status: "active",
    repo_path: "/repo/test",
    created_at: now,
    updated_at: now,
    subgoals,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("goalGraph", () => {

  describe("getReadySubgoals", () => {

    it("无 subgoal 返回空数组", () => {
      const goal = makeGoalStatus([]);
      assert.deepEqual(getReadySubgoals(goal), []);
    });

    it("ready 且无依赖 → 返回", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", depends_on: [] }),
      ]);
      const ready = getReadySubgoals(goal);
      assert.equal(ready.length, 1);
      assert.equal(ready[0].id, "subgoal-001");
    });

    it("ready 但依赖未 accepted → 不返回", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", status: "running" }),
        makeSubgoal({ id: "subgoal-002", depends_on: ["subgoal-001"] }),
      ]);
      const ready = getReadySubgoals(goal);
      assert.equal(ready.length, 0);
    });

    it("ready 且依赖已 accepted → 返回", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", status: "accepted", accepted_at: "2026-01-01T00:00:00.000Z" }),
        makeSubgoal({ id: "subgoal-002", depends_on: ["subgoal-001"] }),
      ]);
      const ready = getReadySubgoals(goal);
      assert.equal(ready.length, 1);
      assert.equal(ready[0].id, "subgoal-002");
    });

    it("非 ready 状态（running 等）→ 不返回", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", status: "running" }),
        makeSubgoal({ id: "subgoal-002", status: "done_by_agent" }),
        makeSubgoal({ id: "subgoal-003", status: "accepted" }),
      ]);
      const ready = getReadySubgoals(goal);
      assert.equal(ready.length, 0);
    });

    it("依赖引用不存在的 subgoal → 不返回", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", depends_on: ["subgoal-999"] }),
      ]);
      const ready = getReadySubgoals(goal);
      assert.equal(ready.length, 0);
    });

    it("不修改传入的 goalStatus（不可变）", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", depends_on: [] }),
      ]);
      const snapshot = JSON.stringify(goal);
      getReadySubgoals(goal);
      assert.equal(JSON.stringify(goal), snapshot);
    });
  });

  describe("getBlockedSubgoals", () => {

    it("无 blocked 返回空数组", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", depends_on: [] }),
        makeSubgoal({ id: "subgoal-002", status: "running" }),
      ]);
      assert.deepEqual(getBlockedSubgoals(goal), []);
    });

    it("ready 但依赖 running → 返回，blocked_by 包含该 id", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", status: "running" }),
        makeSubgoal({ id: "subgoal-002", depends_on: ["subgoal-001"] }),
      ]);
      const blocked = getBlockedSubgoals(goal);
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0].subgoal.id, "subgoal-002");
      assert.deepEqual(blocked[0].blocked_by, ["subgoal-001"]);
    });

    it("依赖引用不存在 → blocked_by 包含该不存在的 id", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", depends_on: ["subgoal-999"] }),
      ]);
      const blocked = getBlockedSubgoals(goal);
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0].subgoal.id, "subgoal-001");
      assert.deepEqual(blocked[0].blocked_by, ["subgoal-999"]);
    });

    it("依赖部分 accepted 部分 running → blocked_by 只含未 accepted 的", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", status: "accepted", accepted_at: "2026-01-01T00:00:00.000Z" }),
        makeSubgoal({ id: "subgoal-002", status: "running" }),
        makeSubgoal({ id: "subgoal-003", depends_on: ["subgoal-001", "subgoal-002"] }),
      ]);
      const blocked = getBlockedSubgoals(goal);
      assert.equal(blocked.length, 1);
      assert.deepEqual(blocked[0].blocked_by, ["subgoal-002"]);
    });

    it("非 ready 状态的 subgoal 不计入 blocked", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", status: "running", depends_on: ["subgoal-999"] }),
      ]);
      const blocked = getBlockedSubgoals(goal);
      assert.equal(blocked.length, 0);
    });
  });

  describe("suggestNextSubgoal", () => {

    it("有 ready → 返回第一个 ready", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", depends_on: [] }),
      ]);
      const suggestion = suggestNextSubgoal(goal);
      assert.equal(suggestion.subgoal_id, "subgoal-001");
      assert.equal(suggestion.title, "Subgoal subgoal-001");
      assert.deepEqual(suggestion.depends_on, []);
      assert.equal(suggestion.reason, undefined);
    });

    it("无 ready 有 blocked → 返回 null + blocked_by", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", status: "running" }),
        makeSubgoal({ id: "subgoal-002", depends_on: ["subgoal-001"] }),
      ]);
      const suggestion = suggestNextSubgoal(goal);
      assert.equal(suggestion.subgoal_id, null);
      assert.equal(suggestion.reason, "dependencies_not_met");
      assert.deepEqual(suggestion.blocked_by, ["subgoal-002"]);
    });

    it("无 ready 无 blocked → 返回 null + no_ready_subgoal", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", status: "accepted", accepted_at: "2026-01-01T00:00:00.000Z" }),
        makeSubgoal({ id: "subgoal-002", status: "running" }),
      ]);
      const suggestion = suggestNextSubgoal(goal);
      assert.equal(suggestion.subgoal_id, null);
      assert.equal(suggestion.reason, "no_ready_subgoal");
      assert.equal(suggestion.blocked_by, undefined);
    });

    it("多个 ready → 返回数组顺序第一个", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", depends_on: [] }),
        makeSubgoal({ id: "subgoal-002", depends_on: [] }),
        makeSubgoal({ id: "subgoal-003", depends_on: [] }),
      ]);
      const suggestion = suggestNextSubgoal(goal);
      assert.equal(suggestion.subgoal_id, "subgoal-001");
    });

    it("空 subgoals → no_ready_subgoal", () => {
      const goal = makeGoalStatus([]);
      const suggestion = suggestNextSubgoal(goal);
      assert.equal(suggestion.subgoal_id, null);
      assert.equal(suggestion.reason, "no_ready_subgoal");
    });
  });

  describe("detectCycle", () => {

    it("无依赖无环", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", depends_on: [] }),
        makeSubgoal({ id: "subgoal-002", depends_on: [] }),
      ]);
      assert.equal(detectCycle(goal), null);
    });

    it("线性依赖 A→B 无环（B depends_on A）", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "A", depends_on: [] }),
        makeSubgoal({ id: "B", depends_on: ["A"] }),
      ]);
      assert.equal(detectCycle(goal), null);
    });

    it("A→B→A 有环，返回环路径", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "A", depends_on: ["B"] }),
        makeSubgoal({ id: "B", depends_on: ["A"] }),
      ]);
      const cycle = detectCycle(goal);
      assert.ok(cycle !== null);
      assert.ok(cycle.length >= 2);
      assert.ok(cycle.includes("A"));
      assert.ok(cycle.includes("B"));
    });

    it("自环 A→A 有环", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "A", depends_on: ["A"] }),
      ]);
      const cycle = detectCycle(goal);
      assert.ok(cycle !== null);
      assert.ok(cycle.includes("A"));
    });

    it("引用不存在的 subgoal 不算环", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "A", depends_on: ["nonexistent"] }),
      ]);
      assert.equal(detectCycle(goal), null);
    });

    it("三节点环 A→B→C→A", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "A", depends_on: ["C"] }),
        makeSubgoal({ id: "B", depends_on: ["A"] }),
        makeSubgoal({ id: "C", depends_on: ["B"] }),
      ]);
      const cycle = detectCycle(goal);
      assert.ok(cycle !== null);
      assert.ok(cycle.includes("A"));
      assert.ok(cycle.includes("B"));
      assert.ok(cycle.includes("C"));
    });

    it("无环的复杂依赖图", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "A", depends_on: [] }),
        makeSubgoal({ id: "B", depends_on: ["A"] }),
        makeSubgoal({ id: "C", depends_on: ["A"] }),
        makeSubgoal({ id: "D", depends_on: ["B", "C"] }),
      ]);
      assert.equal(detectCycle(goal), null);
    });
  });

  describe("topologicalSort", () => {

    it("线性 A→B（B 依赖 A）→ 返回 [A, B]", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "A", depends_on: [] }),
        makeSubgoal({ id: "B", depends_on: ["A"] }),
      ]);
      const sorted = topologicalSort(goal);
      assert.equal(sorted.length, 2);
      const aIndex = sorted.indexOf("A");
      const bIndex = sorted.indexOf("B");
      assert.ok(aIndex < bIndex, "A should come before B");
    });

    it("有环抛错", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "A", depends_on: ["B"] }),
        makeSubgoal({ id: "B", depends_on: ["A"] }),
      ]);
      assert.throws(
        () => topologicalSort(goal),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "dependency_cycle");
          return true;
        }
      );
    });

    it("单节点无依赖", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "A", depends_on: [] }),
      ]);
      assert.deepEqual(topologicalSort(goal), ["A"]);
    });

    it("菱形依赖：D 依赖 B、C，B/C 依赖 A → A 最前，D 最后", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "A", depends_on: [] }),
        makeSubgoal({ id: "B", depends_on: ["A"] }),
        makeSubgoal({ id: "C", depends_on: ["A"] }),
        makeSubgoal({ id: "D", depends_on: ["B", "C"] }),
      ]);
      const sorted = topologicalSort(goal);
      assert.equal(sorted.length, 4);
      const aIndex = sorted.indexOf("A");
      const bIndex = sorted.indexOf("B");
      const cIndex = sorted.indexOf("C");
      const dIndex = sorted.indexOf("D");
      assert.ok(aIndex < bIndex, "A before B");
      assert.ok(aIndex < cIndex, "A before C");
      assert.ok(bIndex < dIndex, "B before D");
      assert.ok(cIndex < dIndex, "C before D");
    });

    it("引用不存在的 subgoal 不影响排序", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "A", depends_on: ["nonexistent"] }),
        makeSubgoal({ id: "B", depends_on: ["A"] }),
      ]);
      const sorted = topologicalSort(goal);
      assert.equal(sorted.length, 2);
      const aIndex = sorted.indexOf("A");
      const bIndex = sorted.indexOf("B");
      assert.ok(aIndex < bIndex, "A before B");
    });
  });
});
