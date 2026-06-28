import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createGoal,
  readGoalStatus,
  writeGoalStatus,
} from "../../goal/goalStore.js";
import {
  addSubgoal,
  updateSubgoalStatus,
  linkTaskToSubgoal,
  type SubgoalStatus,
} from "../../goal/goalStatus.js";
import {
  acceptSubgoal,
  rejectSubgoal,
  summarizeGoalProgress,
} from "../../goal/goalProgress.js";
import { PatchWardenError } from "../../errors.js";

// ── Helpers ───────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pw-goalprogress-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * 在 {workspaceRoot}/.patchwarden/tasks/{taskId}/status.json 创建任务状态文件。
 */
function createTestTask(workspaceRoot: string, taskId: string, status: string): void {
  const taskDir = join(workspaceRoot, ".patchwarden", "tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "status.json"),
    JSON.stringify({ task_id: taskId, status }),
    "utf-8"
  );
}

/**
 * 创建 goal 并添加一个 subgoal，可选地设置状态和关联 task。
 */
function setupGoalWithSubgoal(
  workspaceRoot: string,
  options: {
    title?: string;
    subgoalTitle?: string;
    subgoalStatus?: SubgoalStatus;
    taskIds?: string[];
    dependsOn?: string[];
  } = {}
): { goal_id: string; subgoal_id: string } {
  const { goal_id } = createGoal(
    "repo",
    options.title ?? "Test Goal",
    "description",
    workspaceRoot
  );

  let status = readGoalStatus(goal_id, workspaceRoot);
  const addResult = addSubgoal(status, options.subgoalTitle ?? "Subgoal 1", options.dependsOn ?? []);
  status = addResult.goalStatus;
  const subgoalId = addResult.subgoalId;

  // 关联 task
  for (const taskId of options.taskIds ?? []) {
    status = linkTaskToSubgoal(status, subgoalId, taskId);
  }

  // 推进到目标状态
  const targetStatus = options.subgoalStatus ?? "ready";
  if (targetStatus !== "ready") {
    if (targetStatus === "running" || targetStatus === "done_by_agent" ||
        targetStatus === "accepted" || targetStatus === "rejected" || targetStatus === "needs_fix") {
      status = updateSubgoalStatus(status, subgoalId, "running");
      if (targetStatus === "done_by_agent" || targetStatus === "accepted" ||
          targetStatus === "rejected" || targetStatus === "needs_fix") {
        status = updateSubgoalStatus(status, subgoalId, "done_by_agent");
        if (targetStatus === "accepted") {
          status = updateSubgoalStatus(status, subgoalId, "accepted");
        } else if (targetStatus === "rejected") {
          status = updateSubgoalStatus(status, subgoalId, "rejected", {
            rejected_reason: "pre-set rejected",
          });
        } else if (targetStatus === "needs_fix") {
          status = updateSubgoalStatus(status, subgoalId, "needs_fix");
        }
      }
    }
  }

  writeGoalStatus(goal_id, status, workspaceRoot);
  return { goal_id, subgoal_id: subgoalId };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("goalProgress", () => {

  describe("acceptSubgoal", () => {

    it("所有关联 task 为 accepted → 成功，subgoal.status 变为 accepted", () => {
      const { goal_id, subgoal_id } = setupGoalWithSubgoal(tempDir, {
        subgoalStatus: "done_by_agent",
        taskIds: ["task-001", "task-002"],
      });
      createTestTask(tempDir, "task-001", "accepted");
      createTestTask(tempDir, "task-002", "accepted");

      const result = acceptSubgoal(goal_id, subgoal_id, tempDir);

      assert.equal(result.subgoal_id, subgoal_id);
      assert.equal(result.status, "accepted");
      assert.ok(result.accepted_at.length > 0);

      // 验证已持久化
      const status = readGoalStatus(goal_id, tempDir);
      const sub = status.subgoals.find((s) => s.id === subgoal_id)!;
      assert.equal(sub.status, "accepted");
      assert.equal(sub.accepted_at, result.accepted_at);
    });

    it("有未 accepted 的 task（done_by_agent）→ 抛 subgoal_not_ready，detail 含 unaccepted_tasks", () => {
      const { goal_id, subgoal_id } = setupGoalWithSubgoal(tempDir, {
        subgoalStatus: "done_by_agent",
        taskIds: ["task-001", "task-002"],
      });
      createTestTask(tempDir, "task-001", "accepted");
      createTestTask(tempDir, "task-002", "done_by_agent");

      assert.throws(
        () => acceptSubgoal(goal_id, subgoal_id, tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "subgoal_not_ready");
          const details = err.details as { unaccepted_tasks: Array<{ task_id: string; current_status: string }> };
          assert.ok(Array.isArray(details.unaccepted_tasks));
          assert.equal(details.unaccepted_tasks.length, 1);
          assert.equal(details.unaccepted_tasks[0].task_id, "task-002");
          assert.equal(details.unaccepted_tasks[0].current_status, "done_by_agent");
          return true;
        }
      );

      // 验证状态未改变
      const status = readGoalStatus(goal_id, tempDir);
      const sub = status.subgoals.find((s) => s.id === subgoal_id)!;
      assert.equal(sub.status, "done_by_agent");
    });

    it("无关联 task（task_ids 为空）→ 抛 subgoal_not_ready", () => {
      const { goal_id, subgoal_id } = setupGoalWithSubgoal(tempDir, {
        subgoalStatus: "done_by_agent",
        taskIds: [],
      });

      assert.throws(
        () => acceptSubgoal(goal_id, subgoal_id, tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "subgoal_not_ready");
          return true;
        }
      );
    });

    it("subgoal 不存在 → 抛 subgoal_not_found", () => {
      const { goal_id } = setupGoalWithSubgoal(tempDir, {
        subgoalStatus: "done_by_agent",
        taskIds: ["task-001"],
      });
      createTestTask(tempDir, "task-001", "accepted");

      assert.throws(
        () => acceptSubgoal(goal_id, "subgoal-999", tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "subgoal_not_found");
          return true;
        }
      );
    });

    it("goal 不存在 → 抛 goal_not_found", () => {
      assert.throws(
        () => acceptSubgoal("goal_nonexistent", "subgoal-001", tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });

    it("task status.json 不存在 → 视为未 accepted，抛 subgoal_not_ready", () => {
      const { goal_id, subgoal_id } = setupGoalWithSubgoal(tempDir, {
        subgoalStatus: "done_by_agent",
        taskIds: ["task-missing"],
      });
      // 不创建 task 文件

      assert.throws(
        () => acceptSubgoal(goal_id, subgoal_id, tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "subgoal_not_ready");
          const details = err.details as { unaccepted_tasks: Array<{ task_id: string; current_status: string }> };
          assert.equal(details.unaccepted_tasks[0].current_status, "missing");
          return true;
        }
      );
    });
  });

  describe("rejectSubgoal", () => {

    it("从 running 状态 reject → 成功，status 变为 rejected，rejected_reason 记录", () => {
      const { goal_id, subgoal_id } = setupGoalWithSubgoal(tempDir, {
        subgoalStatus: "running",
      });

      const result = rejectSubgoal(goal_id, subgoal_id, "Tests failed", tempDir);

      assert.equal(result.subgoal_id, subgoal_id);
      assert.equal(result.status, "rejected");
      assert.equal(result.rejected_reason, "Tests failed");

      // 验证已持久化
      const status = readGoalStatus(goal_id, tempDir);
      const sub = status.subgoals.find((s) => s.id === subgoal_id)!;
      assert.equal(sub.status, "rejected");
      assert.equal(sub.rejected_reason, "Tests failed");
    });

    it("从 ready 状态 reject → 成功", () => {
      const { goal_id, subgoal_id } = setupGoalWithSubgoal(tempDir, {
        subgoalStatus: "ready",
      });

      const result = rejectSubgoal(goal_id, subgoal_id, "Not needed", tempDir);

      assert.equal(result.status, "rejected");
      assert.equal(result.rejected_reason, "Not needed");

      const status = readGoalStatus(goal_id, tempDir);
      const sub = status.subgoals.find((s) => s.id === subgoal_id)!;
      assert.equal(sub.status, "rejected");
    });

    it("从 done_by_agent 状态 reject → 成功", () => {
      const { goal_id, subgoal_id } = setupGoalWithSubgoal(tempDir, {
        subgoalStatus: "done_by_agent",
      });

      const result = rejectSubgoal(goal_id, subgoal_id, "Quality issues", tempDir);

      assert.equal(result.status, "rejected");
      assert.equal(result.rejected_reason, "Quality issues");

      const status = readGoalStatus(goal_id, tempDir);
      const sub = status.subgoals.find((s) => s.id === subgoal_id)!;
      assert.equal(sub.status, "rejected");
    });

    it("从 needs_fix 状态 reject → 成功", () => {
      const { goal_id, subgoal_id } = setupGoalWithSubgoal(tempDir, {
        subgoalStatus: "needs_fix",
      });

      const result = rejectSubgoal(goal_id, subgoal_id, "Abandoning fix", tempDir);

      assert.equal(result.status, "rejected");
      assert.equal(result.rejected_reason, "Abandoning fix");
    });

    it("从 accepted 状态 reject → 抛 invalid_status_transition", () => {
      const { goal_id, subgoal_id } = setupGoalWithSubgoal(tempDir, {
        subgoalStatus: "accepted",
      });

      assert.throws(
        () => rejectSubgoal(goal_id, subgoal_id, "Try to reject", tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_status_transition");
          const details = err.details as { from_status: string; to_status: string };
          assert.equal(details.from_status, "accepted");
          assert.equal(details.to_status, "rejected");
          return true;
        }
      );

      // 验证状态未改变
      const status = readGoalStatus(goal_id, tempDir);
      const sub = status.subgoals.find((s) => s.id === subgoal_id)!;
      assert.equal(sub.status, "accepted");
    });

    it("从 rejected 状态 reject → 抛 invalid_status_transition", () => {
      const { goal_id, subgoal_id } = setupGoalWithSubgoal(tempDir, {
        subgoalStatus: "rejected",
      });

      assert.throws(
        () => rejectSubgoal(goal_id, subgoal_id, "Reject again", tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_status_transition");
          const details = err.details as { from_status: string };
          assert.equal(details.from_status, "rejected");
          return true;
        }
      );
    });

    it("subgoal 不存在 → 抛 subgoal_not_found", () => {
      const { goal_id } = setupGoalWithSubgoal(tempDir);

      assert.throws(
        () => rejectSubgoal(goal_id, "subgoal-999", "reason", tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "subgoal_not_found");
          return true;
        }
      );
    });

    it("goal 不存在 → 抛 goal_not_found", () => {
      assert.throws(
        () => rejectSubgoal("goal_nonexistent", "subgoal-001", "reason", tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });
  });

  describe("summarizeGoalProgress", () => {

    it("空 subgoals → total=0, completion_rate=0%", () => {
      const { goal_id } = createGoal("repo", "Empty Goal", "desc", tempDir);

      const summary = summarizeGoalProgress(goal_id, tempDir);

      assert.equal(summary.goal_id, goal_id);
      assert.equal(summary.title, "Empty Goal");
      assert.equal(summary.total, 0);
      assert.equal(summary.accepted, 0);
      assert.equal(summary.rejected, 0);
      assert.equal(summary.running, 0);
      assert.equal(summary.ready, 0);
      assert.equal(summary.needs_fix, 0);
      assert.equal(summary.done_by_agent, 0);
      assert.equal(summary.completion_rate, "0%");
      assert.deepEqual(summary.blocked_subgoals, []);
      assert.deepEqual(summary.risks, []);
    });

    it("混合状态 → 正确计数", () => {
      const { goal_id } = createGoal("repo", "Mixed Goal", "desc", tempDir);
      let status = readGoalStatus(goal_id, tempDir);

      // subgoal-001: accepted
      status = addSubgoal(status, "S1").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-001", "running");
      status = updateSubgoalStatus(status, "subgoal-001", "done_by_agent");
      status = updateSubgoalStatus(status, "subgoal-001", "accepted");

      // subgoal-002: running
      status = addSubgoal(status, "S2").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-002", "running");

      // subgoal-003: ready
      status = addSubgoal(status, "S3").goalStatus;

      // subgoal-004: rejected
      status = addSubgoal(status, "S4").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-004", "running");
      status = updateSubgoalStatus(status, "subgoal-004", "done_by_agent");
      status = updateSubgoalStatus(status, "subgoal-004", "rejected", { rejected_reason: "bad" });

      // subgoal-005: needs_fix
      status = addSubgoal(status, "S5").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-005", "running");
      status = updateSubgoalStatus(status, "subgoal-005", "done_by_agent");
      status = updateSubgoalStatus(status, "subgoal-005", "needs_fix");

      // subgoal-006: done_by_agent
      status = addSubgoal(status, "S6").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-006", "running");
      status = updateSubgoalStatus(status, "subgoal-006", "done_by_agent");

      writeGoalStatus(goal_id, status, tempDir);

      const summary = summarizeGoalProgress(goal_id, tempDir);

      assert.equal(summary.total, 6);
      assert.equal(summary.accepted, 1);
      assert.equal(summary.rejected, 1);
      assert.equal(summary.running, 1);
      assert.equal(summary.ready, 1);
      assert.equal(summary.needs_fix, 1);
      assert.equal(summary.done_by_agent, 1);
      // 1/6 = 16.67% → round to 17%
      assert.equal(summary.completion_rate, "17%");
    });

    it("有 blocked subgoal → blocked_subgoals 非空", () => {
      const { goal_id } = createGoal("repo", "Blocked Goal", "desc", tempDir);
      let status = readGoalStatus(goal_id, tempDir);

      // subgoal-001: running（未 accepted，作为阻塞源）
      status = addSubgoal(status, "Blocker").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-001", "running");

      // subgoal-002: ready 但依赖 subgoal-001（未 accepted）→ blocked
      status = addSubgoal(status, "Blocked", ["subgoal-001"]).goalStatus;

      writeGoalStatus(goal_id, status, tempDir);

      const summary = summarizeGoalProgress(goal_id, tempDir);

      assert.equal(summary.blocked_subgoals.length, 1);
      assert.equal(summary.blocked_subgoals[0].subgoal_id, "subgoal-002");
      assert.equal(summary.blocked_subgoals[0].title, "Blocked");
      assert.deepEqual(summary.blocked_subgoals[0].blocked_by, ["subgoal-001"]);
    });

    it("有 needs_fix → risks 非空", () => {
      const { goal_id } = createGoal("repo", "Risk Goal", "desc", tempDir);
      let status = readGoalStatus(goal_id, tempDir);

      status = addSubgoal(status, "NeedsFix").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-001", "running");
      status = updateSubgoalStatus(status, "subgoal-001", "done_by_agent");
      status = updateSubgoalStatus(status, "subgoal-001", "needs_fix");

      writeGoalStatus(goal_id, status, tempDir);

      const summary = summarizeGoalProgress(goal_id, tempDir);

      assert.equal(summary.risks.length, 1);
      assert.equal(summary.risks[0].subgoal_id, "subgoal-001");
      assert.equal(summary.risks[0].title, "NeedsFix");
      assert.equal(summary.risks[0].status, "needs_fix");
      assert.equal(summary.risks[0].reason, "needs_fix");
    });

    it("有 running → risks 非空", () => {
      const { goal_id } = createGoal("repo", "Running Goal", "desc", tempDir);
      let status = readGoalStatus(goal_id, tempDir);

      status = addSubgoal(status, "Running").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-001", "running");

      writeGoalStatus(goal_id, status, tempDir);

      const summary = summarizeGoalProgress(goal_id, tempDir);

      assert.equal(summary.risks.length, 1);
      assert.equal(summary.risks[0].subgoal_id, "subgoal-001");
      assert.equal(summary.risks[0].status, "running");
      assert.equal(summary.risks[0].reason, "running");
    });

    it("全部 accepted → completion_rate=100%", () => {
      const { goal_id } = createGoal("repo", "All Accepted", "desc", tempDir);
      let status = readGoalStatus(goal_id, tempDir);

      status = addSubgoal(status, "S1").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-001", "running");
      status = updateSubgoalStatus(status, "subgoal-001", "done_by_agent");
      status = updateSubgoalStatus(status, "subgoal-001", "accepted");

      status = addSubgoal(status, "S2").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-002", "running");
      status = updateSubgoalStatus(status, "subgoal-002", "done_by_agent");
      status = updateSubgoalStatus(status, "subgoal-002", "accepted");

      writeGoalStatus(goal_id, status, tempDir);

      const summary = summarizeGoalProgress(goal_id, tempDir);

      assert.equal(summary.total, 2);
      assert.equal(summary.accepted, 2);
      assert.equal(summary.completion_rate, "100%");
      assert.equal(summary.risks.length, 0);
      assert.equal(summary.blocked_subgoals.length, 0);
    });

    it("goal 不存在 → 抛 goal_not_found", () => {
      assert.throws(
        () => summarizeGoalProgress("goal_nonexistent", tempDir),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });

    it("completion_rate 取整正确（1/3 → 33%）", () => {
      const { goal_id } = createGoal("repo", "Third Goal", "desc", tempDir);
      let status = readGoalStatus(goal_id, tempDir);

      // 1 accepted, 2 ready
      status = addSubgoal(status, "S1").goalStatus;
      status = updateSubgoalStatus(status, "subgoal-001", "running");
      status = updateSubgoalStatus(status, "subgoal-001", "done_by_agent");
      status = updateSubgoalStatus(status, "subgoal-001", "accepted");

      status = addSubgoal(status, "S2").goalStatus;
      status = addSubgoal(status, "S3").goalStatus;

      writeGoalStatus(goal_id, status, tempDir);

      const summary = summarizeGoalProgress(goal_id, tempDir);
      assert.equal(summary.completion_rate, "33%");
    });
  });
});
