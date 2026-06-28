/**
 * v0.8.0: Goal Session 交接文档生成 — 将当前 goal 状态渲染为 Markdown 交接报告。
 *
 * generateHandoff 生成 Markdown 字符串；exportHandoff 将其落盘到
 * {workspaceRoot}/.patchwarden/goals/{goalId}/handoff.md。
 * exportHandoff 接受调用方传入的 goalStatus，不自行读取 goal_status.json，
 * 以避免与 goalStore 形成循环依赖。
 */

import type { GoalStatus } from "./goalStatus.js";
import { suggestNextSubgoal } from "./goalGraph.js";
import { getConfig } from "../config.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Markdown 生成 ────────────────────────────────────────────────

/**
 * 生成 Goal Session 交接文档（Markdown 字符串）。
 *
 * 包含章节：当前 Goal、版本目标、已完成/未完成/已拒绝子目标、最近 diff 摘要、
 * 最近测试结果、当前阻塞点、下一步建议、风险提醒、接手说明。
 *
 * @param goalId          Goal 标识（用于接手说明中的引用）
 * @param goalStatus      当前 GoalStatus 快照
 * @param recentDiff      最近一次 git diff 摘要（可选）
 * @param recentTestResult 最近一次测试结果（可选）
 * @returns Markdown 格式的交接文档
 */
export function generateHandoff(
  goalId: string,
  goalStatus: GoalStatus,
  recentDiff?: string,
  recentTestResult?: string
): string {
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push("# Goal Session Handoff");
  lines.push("");
  lines.push("Generated: " + now);
  lines.push("");

  // ── 当前 Goal ───────────────────────────────────────────
  lines.push("## 当前 Goal");
  lines.push("");
  lines.push("- **goal_id**: " + goalStatus.goal_id);
  lines.push("- **title**: " + goalStatus.title);
  lines.push("- **status**: " + goalStatus.status);
  lines.push("- **repo_path**: " + goalStatus.repo_path);
  lines.push("");

  // ── 版本目标 ────────────────────────────────────────────
  lines.push("## 版本目标");
  lines.push("");
  lines.push(goalStatus.title);
  lines.push("");

  // ── 已完成子目标 ────────────────────────────────────────
  lines.push("## 已完成子目标");
  lines.push("");
  const accepted = goalStatus.subgoals.filter((s) => s.status === "accepted");
  if (accepted.length === 0) {
    lines.push("无");
  } else {
    for (const s of accepted) {
      lines.push("- **" + s.id + "**: " + s.title + " (accepted_at: " + (s.accepted_at ?? "N/A") + ")");
    }
  }
  lines.push("");

  // ── 未完成子目标 ────────────────────────────────────────
  lines.push("## 未完成子目标");
  lines.push("");
  const incomplete = goalStatus.subgoals.filter(
    (s) => s.status !== "accepted" && s.status !== "rejected"
  );
  if (incomplete.length === 0) {
    lines.push("无");
  } else {
    for (const s of incomplete) {
      const deps = s.depends_on.length > 0 ? s.depends_on.join(", ") : "无";
      lines.push("- **" + s.id + "**: " + s.title + " (status: " + s.status + ", depends_on: " + deps + ")");
    }
  }
  lines.push("");

  // ── 已拒绝子目标 ────────────────────────────────────────
  lines.push("## 已拒绝子目标");
  lines.push("");
  const rejected = goalStatus.subgoals.filter((s) => s.status === "rejected");
  if (rejected.length === 0) {
    lines.push("无");
  } else {
    for (const s of rejected) {
      lines.push("- **" + s.id + "**: " + s.title + " (rejected_reason: " + (s.rejected_reason ?? "N/A") + ")");
    }
  }
  lines.push("");

  // ── 最近一次 diff 摘要 ──────────────────────────────────
  lines.push("## 最近一次 diff 摘要");
  lines.push("");
  if (recentDiff) {
    lines.push(recentDiff);
  } else {
    lines.push("暂无");
  }
  lines.push("");

  // ── 最近一次测试结果 ────────────────────────────────────
  lines.push("## 最近一次测试结果");
  lines.push("");
  if (recentTestResult) {
    lines.push(recentTestResult);
  } else {
    lines.push("暂无");
  }
  lines.push("");

  // ── 当前阻塞点 ─────────────────────────────────────────
  lines.push("## 当前阻塞点");
  lines.push("");
  const needsFix = goalStatus.subgoals.filter((s) => s.status === "needs_fix");
  if (needsFix.length === 0) {
    lines.push("无");
  } else {
    for (const s of needsFix) {
      lines.push("- **" + s.id + "**: " + s.title);
    }
  }
  lines.push("");

  // ── 下一步建议 ─────────────────────────────────────────
  lines.push("## 下一步建议");
  lines.push("");
  const suggestion = suggestNextSubgoal(goalStatus);
  if (suggestion.subgoal_id) {
    lines.push("建议执行子目标 **" + suggestion.subgoal_id + "**：" + (suggestion.title ?? ""));
  } else if (suggestion.reason === "dependencies_not_met") {
    lines.push("当前存在被阻塞的子目标，建议先处理以下依赖：");
    const blockedList = suggestion.blocked_by ?? [];
    for (const id of blockedList) {
      lines.push("- " + id);
    }
  } else {
    lines.push("当前无可执行的 ready 子目标，建议检查所有子目标状态或等待任务完成。");
  }
  lines.push("");

  // ── 风险提醒 ───────────────────────────────────────────
  lines.push("## 风险提醒");
  lines.push("");
  const risks = goalStatus.subgoals.filter(
    (s) => s.status === "needs_fix" || s.status === "running"
  );
  if (risks.length === 0) {
    lines.push("无");
  } else {
    for (const s of risks) {
      if (s.status === "needs_fix") {
        lines.push("- **" + s.id + "**: " + s.title + " (needs_fix — 需要修复)");
      } else {
        lines.push("- **" + s.id + "**: " + s.title + " (running — 长期运行中)");
      }
    }
  }
  lines.push("");

  // ── 接手说明 ───────────────────────────────────────────
  lines.push("## 接手说明");
  lines.push("");
  lines.push(
    "新会话接手时，请先调用 read_goal 查看 " + goalId + " 的完整状态，然后调用 suggest_next_subgoal 获取下一个可执行子目标。"
  );
  lines.push("");

  return lines.join("\n");
}

// ── 落盘导出 ─────────────────────────────────────────────────────

/**
 * 生成交接文档并写入 {workspaceRoot}/.patchwarden/goals/{goalId}/handoff.md。
 *
 * @param goalId        Goal 标识
 * @param goalStatus    当前 GoalStatus 快照（由调用方读取后传入）
 * @param workspaceRoot 工作区根目录（可选，默认从 getConfig().workspaceRoot 获取）
 * @returns handoff_path（绝对路径）和 content_preview（前 500 字符，超出则追加 "..."）
 */
export function exportHandoff(
  goalId: string,
  goalStatus: GoalStatus,
  workspaceRoot?: string
): { handoff_path: string; content_preview: string } {
  const content = generateHandoff(goalId, goalStatus);

  const root = workspaceRoot ?? getConfig().workspaceRoot;
  const goalDir = resolve(root, ".patchwarden", "goals", goalId);
  mkdirSync(goalDir, { recursive: true });

  const handoffPath = join(goalDir, "handoff.md");
  writeFileSync(handoffPath, content, "utf-8");

  const preview = content.length > 500 ? content.slice(0, 500) + "..." : content;

  return {
    handoff_path: handoffPath,
    content_preview: preview,
  };
}
