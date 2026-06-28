import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateHandoff, exportHandoff } from "../../goal/handoffExport.js";
import type { GoalStatus, Subgoal } from "../../goal/goalStatus.js";

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

describe("handoffExport", () => {

  describe("generateHandoff", () => {

    it("空 subgoals → 文档包含所有章节", () => {
      const goal = makeGoalStatus([]);
      const md = generateHandoff("goal_test_001", goal);
      assert.ok(md.includes("# Goal Session Handoff"));
      assert.ok(md.includes("## 当前 Goal"));
      assert.ok(md.includes("## 版本目标"));
      assert.ok(md.includes("## 已完成子目标"));
      assert.ok(md.includes("## 未完成子目标"));
      assert.ok(md.includes("## 已拒绝子目标"));
      assert.ok(md.includes("## 最近一次 diff 摘要"));
      assert.ok(md.includes("## 最近一次测试结果"));
      assert.ok(md.includes("## 当前阻塞点"));
      assert.ok(md.includes("## 下一步建议"));
      assert.ok(md.includes("## 风险提醒"));
      assert.ok(md.includes("## 接手说明"));
      assert.ok(md.includes("Generated:"));
    });

    it("空 subgoals → 已完成/未完成显示无", () => {
      const goal = makeGoalStatus([]);
      const md = generateHandoff("goal_test_001", goal);
      const completedSection = md.split("## 已完成子目标")[1].split("##")[0];
      assert.ok(completedSection.includes("无"));
      const incompleteSection = md.split("## 未完成子目标")[1].split("##")[0];
      assert.ok(incompleteSection.includes("无"));
    });

    it("有 accepted subgoal → 出现在已完成子目标", () => {
      const goal = makeGoalStatus([
        makeSubgoal({
          id: "subgoal-001",
          title: "Implement feature A",
          status: "accepted",
          accepted_at: "2026-01-01T00:00:00.000Z",
        }),
      ]);
      const md = generateHandoff("goal_test_001", goal);
      const completedSection = md.split("## 已完成子目标")[1].split("##")[0];
      assert.ok(completedSection.includes("subgoal-001"));
      assert.ok(completedSection.includes("Implement feature A"));
      assert.ok(completedSection.includes("2026-01-01T00:00:00.000Z"));
    });

    it("有 running subgoal → 出现在未完成子目标和风险提醒", () => {
      const goal = makeGoalStatus([
        makeSubgoal({
          id: "subgoal-001",
          title: "WIP task",
          status: "running",
        }),
      ]);
      const md = generateHandoff("goal_test_001", goal);
      const incompleteSection = md.split("## 未完成子目标")[1].split("##")[0];
      assert.ok(incompleteSection.includes("subgoal-001"));
      assert.ok(incompleteSection.includes("running"));
      const riskSection = md.split("## 风险提醒")[1].split("##")[0];
      assert.ok(riskSection.includes("subgoal-001"));
      assert.ok(riskSection.includes("running"));
    });

    it("有 rejected subgoal → 出现在已拒绝子目标", () => {
      const goal = makeGoalStatus([
        makeSubgoal({
          id: "subgoal-001",
          title: "Failed task",
          status: "rejected",
          rejected_reason: "Tests failed",
        }),
      ]);
      const md = generateHandoff("goal_test_001", goal);
      const rejectedSection = md.split("## 已拒绝子目标")[1].split("##")[0];
      assert.ok(rejectedSection.includes("subgoal-001"));
      assert.ok(rejectedSection.includes("Failed task"));
      assert.ok(rejectedSection.includes("Tests failed"));
    });

    it("无 rejected subgoal → 已拒绝子目标显示无", () => {
      const goal = makeGoalStatus([]);
      const md = generateHandoff("goal_test_001", goal);
      const rejectedSection = md.split("## 已拒绝子目标")[1].split("##")[0];
      assert.ok(rejectedSection.includes("无"));
    });

    it("有 needs_fix subgoal → 出现在当前阻塞点和风险提醒", () => {
      const goal = makeGoalStatus([
        makeSubgoal({
          id: "subgoal-001",
          title: "Needs fix task",
          status: "needs_fix",
        }),
      ]);
      const md = generateHandoff("goal_test_001", goal);
      const blockerSection = md.split("## 当前阻塞点")[1].split("##")[0];
      assert.ok(blockerSection.includes("subgoal-001"));
      assert.ok(blockerSection.includes("Needs fix task"));
      const riskSection = md.split("## 风险提醒")[1].split("##")[0];
      assert.ok(riskSection.includes("subgoal-001"));
      assert.ok(riskSection.includes("needs_fix"));
    });

    it("有 recentDiff → 出现在最近一次 diff 摘要", () => {
      const goal = makeGoalStatus([]);
      const diff = "diff --git a/src/foo.ts b/src/foo.ts\n+console.log('hello')";
      const md = generateHandoff("goal_test_001", goal, diff);
      const diffSection = md.split("## 最近一次 diff 摘要")[1].split("##")[0];
      assert.ok(diffSection.includes("src/foo.ts"));
      assert.ok(diffSection.includes("console.log"));
    });

    it("无 recentDiff → 显示暂无", () => {
      const goal = makeGoalStatus([]);
      const md = generateHandoff("goal_test_001", goal);
      const diffSection = md.split("## 最近一次 diff 摘要")[1].split("##")[0];
      assert.ok(diffSection.includes("暂无"));
    });

    it("有 recentTestResult → 出现在最近一次测试结果", () => {
      const goal = makeGoalStatus([]);
      const testResult = "PASS: 42 tests passed, 0 failed";
      const md = generateHandoff("goal_test_001", goal, undefined, testResult);
      const testSection = md.split("## 最近一次测试结果")[1].split("##")[0];
      assert.ok(testSection.includes("42 tests passed"));
    });

    it("无 recentTestResult → 显示暂无", () => {
      const goal = makeGoalStatus([]);
      const md = generateHandoff("goal_test_001", goal);
      const testSection = md.split("## 最近一次测试结果")[1].split("##")[0];
      assert.ok(testSection.includes("暂无"));
    });

    it("接手说明包含 goalId", () => {
      const goal = makeGoalStatus([]);
      const md = generateHandoff("goal_handoff_999", goal);
      const handoffSection = md.split("## 接手说明")[1];
      assert.ok(handoffSection.includes("goal_handoff_999"));
      assert.ok(handoffSection.includes("read_goal"));
      assert.ok(handoffSection.includes("suggest_next_subgoal"));
    });

    it("当前 Goal 章节包含 goal_id/title/status/repo_path", () => {
      const goal = makeGoalStatus([], {
        goal_id: "goal_abc",
        title: "My Custom Goal",
        status: "active",
        repo_path: "/custom/repo",
      });
      const md = generateHandoff("goal_abc", goal);
      const goalSection = md.split("## 当前 Goal")[1].split("##")[0];
      assert.ok(goalSection.includes("goal_abc"));
      assert.ok(goalSection.includes("My Custom Goal"));
      assert.ok(goalSection.includes("active"));
      assert.ok(goalSection.includes("/custom/repo"));
    });

    it("有 ready subgoal → 下一步建议包含该 subgoal", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", title: "Ready task", depends_on: [] }),
      ]);
      const md = generateHandoff("goal_test_001", goal);
      const suggestSection = md.split("## 下一步建议")[1].split("##")[0];
      assert.ok(suggestSection.includes("subgoal-001"));
      assert.ok(suggestSection.includes("Ready task"));
    });

    it("未完成子目标显示 depends_on", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "A", status: "accepted", accepted_at: "2026-01-01T00:00:00.000Z" }),
        makeSubgoal({ id: "B", title: "Depends on A", status: "ready", depends_on: ["A"] }),
      ]);
      const md = generateHandoff("goal_test_001", goal);
      const incompleteSection = md.split("## 未完成子目标")[1].split("##")[0];
      assert.ok(incompleteSection.includes("B"));
      assert.ok(incompleteSection.includes("depends_on: A"));
    });
  });

  describe("exportHandoff", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "pw-handoff-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("写入 handoff.md 文件到 .patchwarden/goals/{goalId}/", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", title: "Task A", depends_on: [] }),
      ]);
      const result = exportHandoff("goal_export_001", goal, tempDir);

      const expectedPath = resolve(tempDir, ".patchwarden", "goals", "goal_export_001", "handoff.md");
      assert.equal(result.handoff_path, expectedPath);
      assert.ok(existsSync(expectedPath));

      const fileContent = readFileSync(expectedPath, "utf-8");
      assert.ok(fileContent.includes("# Goal Session Handoff"));
      assert.ok(fileContent.includes("goal_export_001"));
    });

    it("返回的 handoff_path 是绝对路径", () => {
      const goal = makeGoalStatus([]);
      const result = exportHandoff("goal_export_002", goal, tempDir);
      assert.ok(result.handoff_path.includes(tempDir));
      assert.ok(result.handoff_path.endsWith("handoff.md"));
    });

    it("content_preview 不超过 500 字符（加省略号）", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", title: "A".repeat(200), depends_on: [] }),
        makeSubgoal({ id: "subgoal-002", title: "B".repeat(200), depends_on: [] }),
        makeSubgoal({ id: "subgoal-003", title: "C".repeat(200), depends_on: [] }),
      ]);
      const result = exportHandoff("goal_export_003", goal, tempDir);
      assert.ok(result.content_preview.length > 0);
      assert.ok(result.content_preview.endsWith("..."));
      assert.ok(result.content_preview.length <= 503); // 500 + "..."
    });

    it("content_preview 是文档前 500 字符的截取", () => {
      const goal = makeGoalStatus([]);
      const result = exportHandoff("goal_export_004", goal, tempDir);
      const fileContent = readFileSync(result.handoff_path, "utf-8");
      if (fileContent.length > 500) {
        assert.equal(result.content_preview, fileContent.slice(0, 500) + "...");
      } else {
        assert.equal(result.content_preview, fileContent);
      }
    });

    it("文件内容与 generateHandoff 一致", () => {
      const goal = makeGoalStatus([
        makeSubgoal({ id: "subgoal-001", title: "Verify content", depends_on: [] }),
      ]);
      const expected = generateHandoff("goal_export_005", goal);
      const result = exportHandoff("goal_export_005", goal, tempDir);
      const fileContent = readFileSync(result.handoff_path, "utf-8");
      // 排除 Generated 时间戳行（两次调用可能跨越毫秒边界）
      const stripGenerated = (s: string) => s.replace(/^Generated: .*$/m, "Generated: <ts>");
      assert.equal(stripGenerated(fileContent), stripGenerated(expected));
    });

    it("创建多层目录结构", () => {
      const goal = makeGoalStatus([]);
      const result = exportHandoff("goal_deep_001", goal, tempDir);
      const goalDir = resolve(tempDir, ".patchwarden", "goals", "goal_deep_001");
      const stat = statSync(goalDir);
      assert.ok(stat.isDirectory());
      assert.ok(existsSync(result.handoff_path));
    });
  });
});
