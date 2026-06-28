/**
 * v0.7.2: 验收引擎 — 基于证据推导 4 级验收结论。
 *
 * 输入：status.json、task_meta（goal/scope/forbidden/verification/done_evidence）、
 *       audit checks（pass/warn/fail）、release claims、artifact 信息
 * 输出：ACCEPTED / NEEDS_FIX / REJECTED / BLOCKED_BY_APPROVAL
 *       + reasons + required_evidence + next_suggested_task
 *
 * 决策规则：
 *   1. 存在 fail 级检查项 → REJECTED
 *   2. 存在 release claims 但无法验证远端 → BLOCKED_BY_APPROVAL
 *   3. 存在 warn 级检查项或文档不同步 → NEEDS_FIX
 *   4. 所有检查通过 → ACCEPTED
 */

import type { AcceptanceStatus } from "../tools/createTask.js";

// ── 类型定义 ──────────────────────────────────────────────────────

export type AcceptanceVerdict = "ACCEPTED" | "NEEDS_FIX" | "REJECTED" | "BLOCKED_BY_APPROVAL";

export interface AcceptanceCheck {
  name: string;
  result: "pass" | "warn" | "fail";
  detail: string;
}

export interface AcceptanceEvidence {
  task_id: string;
  task_status: string;
  // 证据文件是否存在
  result_md_exists: boolean;
  result_json_exists: boolean;
  verify_json_exists: boolean;
  test_log_exists: boolean;
  git_diff_exists: boolean;
  // 验证状态
  verify_status: "passed" | "failed" | "skipped" | null;
  // 范围违规
  new_out_of_scope_changes: Array<{ path: string; change: string }>;
  // 任务元数据（来自 create_task 的结构化验收标准）
  goal: string | null;
  scope: string[] | null;
  forbidden: string[] | null;
  verification: string[] | null;
  done_evidence: string[] | null;
  // artifact 信息
  artifact_status: string | null;
  // release claims（auditTask 扫描到的发布声明）
  release_claims_unverified: boolean;
  // audit checks（来自 auditTask 的完整检查列表）
  checks: AcceptanceCheck[];
}

export interface AcceptanceResult {
  verdict: AcceptanceVerdict;
  acceptance_status: AcceptanceStatus;
  reason: string;
  reasons: string[];
  required_evidence: string[];
  next_suggested_task: string;
  fail_checks: AcceptanceCheck[];
  warn_checks: AcceptanceCheck[];
}

// ── 验收决策 ──────────────────────────────────────────────────────

/**
 * 核心验收决策函数。
 * 输入所有证据，输出 4 级验收结论。
 */
export function evaluateAcceptance(evidence: AcceptanceEvidence): AcceptanceResult {
  const reasons: string[] = [];
  const requiredEvidence: string[] = [];
  const failChecks: AcceptanceCheck[] = [];
  const warnChecks: AcceptanceCheck[] = [];

  // 收集 fail 和 warn 检查项
  for (const check of evidence.checks) {
    if (check.result === "fail") {
      failChecks.push(check);
    } else if (check.result === "warn") {
      warnChecks.push(check);
    }
  }

  // ── Rule 1: fail 级检查项 → REJECTED ──────────────────────
  if (failChecks.length > 0) {
    for (const check of failChecks) {
      reasons.push(`[FAIL] ${check.name}: ${check.detail}`);
    }
    return {
      verdict: "REJECTED",
      acceptance_status: "rejected",
      reason: `${failChecks.length} fail-level check(s): ${failChecks.map((c) => c.name).join(", ")}`,
      reasons,
      required_evidence: requiredEvidence.length > 0 ? requiredEvidence : ["Fix all fail-level issues and re-run audit_task"],
      next_suggested_task: `Fix fail-level issues: ${failChecks.map((c) => c.name).join(", ")}`,
      fail_checks: failChecks,
      warn_checks: warnChecks,
    };
  }

  // ── Rule 2: release claims 无法验证 → BLOCKED_BY_APPROVAL ──
  if (evidence.release_claims_unverified) {
    reasons.push("[BLOCKED] Release claims detected but remote state cannot be verified");
    requiredEvidence.push("Verify remote release state (npm publish, GitHub release, git tag)");
    return {
      verdict: "BLOCKED_BY_APPROVAL",
      acceptance_status: "blocked",
      reason: "Release claims require manual verification of remote state",
      reasons,
      required_evidence: requiredEvidence,
      next_suggested_task: "Manually verify remote release state, then re-run audit_task",
      fail_checks: failChecks,
      warn_checks: warnChecks,
    };
  }

  // ── Rule 3: warn 级检查项 → NEEDS_FIX ──────────────────────
  if (warnChecks.length > 0) {
    for (const check of warnChecks) {
      reasons.push(`[WARN] ${check.name}: ${check.detail}`);
    }
    return {
      verdict: "NEEDS_FIX",
      acceptance_status: "needs_fix",
      reason: `${warnChecks.length} warn-level check(s) require fixes: ${warnChecks.map((c) => c.name).join(", ")}`,
      reasons,
      required_evidence: requiredEvidence.length > 0 ? requiredEvidence : ["Resolve all warn-level issues"],
      next_suggested_task: `Fix warn-level issues: ${warnChecks.map((c) => c.name).join(", ")}`,
      fail_checks: failChecks,
      warn_checks: warnChecks,
    };
  }

  // ── Rule 4: 所有检查通过 → ACCEPTED ───────────────────────
  return {
    verdict: "ACCEPTED",
    acceptance_status: "accepted",
    reason: "All acceptance checks passed",
    reasons: ["All checks passed, no warnings or failures"],
    required_evidence: [],
    next_suggested_task: "Task accepted. Proceed to next goal or task.",
    fail_checks: failChecks,
    warn_checks: warnChecks,
  };
}

/**
 * 将 AcceptanceVerdict 映射到 AcceptanceStatus（用于回写 status.json）。
 */
export function verdictToStatus(verdict: AcceptanceVerdict): AcceptanceStatus {
  switch (verdict) {
    case "ACCEPTED": return "accepted";
    case "REJECTED": return "rejected";
    case "NEEDS_FIX": return "needs_fix";
    case "BLOCKED_BY_APPROVAL": return "blocked";
  }
}
