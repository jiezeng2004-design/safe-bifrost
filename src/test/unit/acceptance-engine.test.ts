import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  evaluateAcceptance,
  verdictToStatus,
  type AcceptanceEvidence,
} from "../../goal/acceptanceEngine.js";
import { renderAcceptanceMarkdown } from "../../goal/acceptanceTemplate.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeEvidence(overrides: Partial<AcceptanceEvidence> = {}): AcceptanceEvidence {
  return {
    task_id: "task_test_001",
    task_status: "done_by_agent",
    result_md_exists: true,
    result_json_exists: true,
    verify_json_exists: true,
    test_log_exists: true,
    git_diff_exists: true,
    verify_status: "passed",
    new_out_of_scope_changes: [],
    goal: null,
    scope: null,
    forbidden: null,
    verification: null,
    done_evidence: null,
    artifact_status: "collected",
    release_claims_unverified: false,
    checks: [
      { name: "task_status", result: "pass", detail: "Task status is done_by_agent." },
      { name: "result_md_exists", result: "pass", detail: "result.md found." },
      { name: "verify_status", result: "pass", detail: "Verification passed." },
    ],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("acceptanceEngine", () => {

  describe("evaluateAcceptance — 基础场景", () => {

    it("所有检查通过 → ACCEPTED", () => {
      const evidence = makeEvidence();
      const result = evaluateAcceptance(evidence);
      assert.equal(result.verdict, "ACCEPTED");
      assert.equal(result.acceptance_status, "accepted");
      assert.equal(result.fail_checks.length, 0);
      assert.equal(result.warn_checks.length, 0);
      assert.ok(result.reason.includes("All acceptance checks passed"));
    });

    it("存在 fail 级检查项 → REJECTED", () => {
      const evidence = makeEvidence({
        checks: [
          { name: "task_status", result: "pass", detail: "ok" },
          { name: "result_md_exists", result: "fail", detail: "result.md is missing." },
          { name: "verify_status", result: "pass", detail: "ok" },
        ],
      });
      const result = evaluateAcceptance(evidence);
      assert.equal(result.verdict, "REJECTED");
      assert.equal(result.acceptance_status, "rejected");
      assert.equal(result.fail_checks.length, 1);
      assert.equal(result.fail_checks[0].name, "result_md_exists");
      assert.ok(result.reason.includes("fail-level"));
    });

    it("存在 warn 级检查项（无 fail）→ NEEDS_FIX", () => {
      const evidence = makeEvidence({
        checks: [
          { name: "task_status", result: "pass", detail: "ok" },
          { name: "git_diff_exists", result: "warn", detail: "git.diff is missing." },
          { name: "test_log_exists", result: "warn", detail: "test.log is missing." },
        ],
      });
      const result = evaluateAcceptance(evidence);
      assert.equal(result.verdict, "NEEDS_FIX");
      assert.equal(result.acceptance_status, "needs_fix");
      assert.equal(result.warn_checks.length, 2);
      assert.ok(result.reason.includes("warn-level"));
    });

    it("存在 release claims 但无法验证 → BLOCKED_BY_APPROVAL（即使有 warn）", () => {
      const evidence = makeEvidence({
        release_claims_unverified: true,
        checks: [
          { name: "task_status", result: "pass", detail: "ok" },
          { name: "release_claims_unverified", result: "warn", detail: "Found release claims." },
        ],
      });
      const result = evaluateAcceptance(evidence);
      assert.equal(result.verdict, "BLOCKED_BY_APPROVAL");
      assert.equal(result.acceptance_status, "blocked");
      assert.ok(result.reason.includes("Release claims"));
      assert.ok(result.required_evidence.some((e) => e.includes("Verify remote")));
    });

    it("fail 级检查项优先于 release claims", () => {
      const evidence = makeEvidence({
        release_claims_unverified: true,
        checks: [
          { name: "task_status", result: "fail", detail: "Task failed." },
          { name: "release_claims_unverified", result: "warn", detail: "Found release claims." },
        ],
      });
      const result = evaluateAcceptance(evidence);
      assert.equal(result.verdict, "REJECTED");
      assert.equal(result.acceptance_status, "rejected");
    });

    it("多个 fail 级检查项全部收集", () => {
      const evidence = makeEvidence({
        checks: [
          { name: "result_md_exists", result: "fail", detail: "missing" },
          { name: "verify_status", result: "fail", detail: "failed" },
          { name: "scope_changes", result: "fail", detail: "out of scope" },
        ],
      });
      const result = evaluateAcceptance(evidence);
      assert.equal(result.verdict, "REJECTED");
      assert.equal(result.fail_checks.length, 3);
    });
  });

  describe("verdictToStatus", () => {
    it("ACCEPTED → accepted", () => {
      assert.equal(verdictToStatus("ACCEPTED"), "accepted");
    });

    it("REJECTED → rejected", () => {
      assert.equal(verdictToStatus("REJECTED"), "rejected");
    });

    it("NEEDS_FIX → needs_fix", () => {
      assert.equal(verdictToStatus("NEEDS_FIX"), "needs_fix");
    });

    it("BLOCKED_BY_APPROVAL → blocked", () => {
      assert.equal(verdictToStatus("BLOCKED_BY_APPROVAL"), "blocked");
    });
  });

  describe("evaluateAcceptance — next_suggested_task", () => {
    it("ACCEPTED 的 next_suggested_task 包含 'accepted'", () => {
      const result = evaluateAcceptance(makeEvidence());
      assert.ok(result.next_suggested_task.includes("accepted"));
    });

    it("REJECTED 的 next_suggested_task 包含 fail 检查名", () => {
      const result = evaluateAcceptance(makeEvidence({
        checks: [{ name: "result_md_exists", result: "fail", detail: "missing" }],
      }));
      assert.ok(result.next_suggested_task.includes("result_md_exists"));
    });

    it("NEEDS_FIX 的 next_suggested_task 包含 warn 检查名", () => {
      const result = evaluateAcceptance(makeEvidence({
        checks: [{ name: "git_diff_exists", result: "warn", detail: "missing" }],
      }));
      assert.ok(result.next_suggested_task.includes("git_diff_exists"));
    });

    it("BLOCKED_BY_APPROVAL 的 next_suggested_task 包含 'verify'", () => {
      const result = evaluateAcceptance(makeEvidence({ release_claims_unverified: true }));
      assert.ok(result.next_suggested_task.toLowerCase().includes("verify"));
    });
  });

  describe("evaluateAcceptance — reasons 可追溯", () => {
    it("REJECTED 的 reasons 包含 [FAIL] 前缀", () => {
      const result = evaluateAcceptance(makeEvidence({
        checks: [{ name: "result_md_exists", result: "fail", detail: "missing" }],
      }));
      assert.ok(result.reasons.some((r) => r.includes("[FAIL]")));
    });

    it("NEEDS_FIX 的 reasons 包含 [WARN] 前缀", () => {
      const result = evaluateAcceptance(makeEvidence({
        checks: [{ name: "git_diff_exists", result: "warn", detail: "missing" }],
      }));
      assert.ok(result.reasons.some((r) => r.includes("[WARN]")));
    });

    it("BLOCKED_BY_APPROVAL 的 reasons 包含 [BLOCKED] 前缀", () => {
      const result = evaluateAcceptance(makeEvidence({ release_claims_unverified: true }));
      assert.ok(result.reasons.some((r) => r.includes("[BLOCKED]")));
    });

    it("ACCEPTED 的 reasons 非空", () => {
      const result = evaluateAcceptance(makeEvidence());
      assert.ok(result.reasons.length > 0);
    });
  });

  describe("renderAcceptanceMarkdown", () => {
    it("生成包含 verdict 的 ACCEPTANCE.md 内容", () => {
      const evidence = makeEvidence();
      const result = evaluateAcceptance(evidence);
      const md = renderAcceptanceMarkdown("task_test_001", result, evidence);
      assert.ok(md.includes("# Acceptance Report — task_test_001"));
      assert.ok(md.includes("**ACCEPTED**"));
      assert.ok(md.includes("## Evidence Summary"));
      assert.ok(md.includes("## Verdict"));
    });

    it("REJECTED 的 Markdown 包含 fail 检查", () => {
      const evidence = makeEvidence({
        checks: [{ name: "result_md_exists", result: "fail", detail: "missing" }],
      });
      const result = evaluateAcceptance(evidence);
      const md = renderAcceptanceMarkdown("task_test_002", result, evidence);
      assert.ok(md.includes("**REJECTED**"));
      assert.ok(md.includes("## Fail-Level Checks"));
      assert.ok(md.includes("result_md_exists"));
    });

    it("NEEDS_FIX 的 Markdown 包含 warn 检查", () => {
      const evidence = makeEvidence({
        checks: [{ name: "git_diff_exists", result: "warn", detail: "missing" }],
      });
      const result = evaluateAcceptance(evidence);
      const md = renderAcceptanceMarkdown("task_test_003", result, evidence);
      assert.ok(md.includes("**NEEDS_FIX**"));
      assert.ok(md.includes("## Warn-Level Checks"));
    });

    it("BLOCKED 的 Markdown 包含 required_evidence", () => {
      const evidence = makeEvidence({ release_claims_unverified: true });
      const result = evaluateAcceptance(evidence);
      const md = renderAcceptanceMarkdown("task_test_004", result, evidence);
      assert.ok(md.includes("**BLOCKED_BY_APPROVAL**"));
      assert.ok(md.includes("## Required Evidence"));
    });

    it("有 goal/scope 时显示 Task Acceptance Criteria", () => {
      const evidence = makeEvidence({
        goal: "Implement feature X",
        scope: ["src/feature.ts"],
        forbidden: [".env"],
        verification: ["npm test"],
        done_evidence: ["result.md", "test.log"],
      });
      const result = evaluateAcceptance(evidence);
      const md = renderAcceptanceMarkdown("task_test_005", result, evidence);
      assert.ok(md.includes("## Task Acceptance Criteria"));
      assert.ok(md.includes("Implement feature X"));
      assert.ok(md.includes("src/feature.ts"));
      assert.ok(md.includes(".env"));
    });

    it("无 goal/scope 时不显示 Task Acceptance Criteria section", () => {
      const evidence = makeEvidence();
      const result = evaluateAcceptance(evidence);
      const md = renderAcceptanceMarkdown("task_test_006", result, evidence);
      assert.ok(!md.includes("## Task Acceptance Criteria"));
    });
  });
});
