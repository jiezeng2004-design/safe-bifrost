import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig, getTasksDir } from "../config.js";
import { auditSession } from "./auditSession.js";
import { auditTask, type AuditTaskOutput } from "./auditTask.js";
import { finalizeDirectSession } from "./finalizeDirectSession.js";
import { getTaskSummary } from "./getTaskSummary.js";
import { guardReadPath } from "../security/pathGuard.js";
import { redactSensitiveValue } from "../security/contentRedaction.js";
import { readDirectSession, type DirectSessionRecord, type DirectSessionVerificationRun } from "../direct/directSessionStore.js";
import type { ChangeArtifacts, ChangedFile, ClassifiedChange } from "../runner/changeCapture.js";

export interface SafeViewOptions {
  max_items?: number;
}

export function safeResult(taskId: string, options: SafeViewOptions = {}) {
  const maxItems = normalizeMaxItems(options.max_items);
  const summary = getTaskSummary(taskId, { view: "compact", max_items: maxItems });
  return redact({
    task_id: summary.task_id,
    status: summary.status,
    terminal: summary.terminal,
    acceptance_status: summary.acceptance_status,
    phase: summary.phase,
    repo_path: summary.repo_path,
    changed_files_total: summary.changed_files_total,
    out_of_scope_changes_total: summary.out_of_scope_changes_total,
    artifact_hygiene_counts: summary.artifact_hygiene.counts,
    release_artifacts_count: summary.release_artifacts_count,
    artifact_status: summary.artifact_status,
    verification: summary.verification_summary,
    warnings: limitStrings(summary.warnings, maxItems),
    errors: limitStrings(summary.errors, maxItems),
    failure_reason: summary.failure_reason,
    failed_command: summary.failed_command,
    next_action: summary.suggested_next_action,
    execution_blocked: summary.execution_blocked,
    pending_reason: summary.pending_reason,
    redacted: summary.redacted,
    redaction_categories: summary.redaction_categories,
  });
}

export function safeTestSummary(taskId: string) {
  const { taskDir, config } = getTaskDir(taskId);
  const verify = readJson(join(taskDir, "verify.json"), config);
  const summary = getTaskSummary(taskId, { view: "compact", max_items: 8 });
  const commands = asArray(verify.commands).map((entry: any) => ({
    command: String(entry.command || ""),
    status: String(entry.status || "unknown"),
    exit_code: entry.exit_code ?? null,
    duration_ms: Number(entry.duration_ms || 0),
  }));
  return redact({
    task_id: taskId,
    status: String(verify.status || summary.verification_summary.status || "not_available"),
    command_count: commands.length,
    passed_commands: commands.filter((entry) => entry.status === "passed").length,
    failed_commands: commands.filter((entry) => ["failed", "timed_out", "canceled"].includes(entry.status)).length,
    skipped_commands: commands.filter((entry) => entry.status === "skipped").length,
    commands,
    headline: summary.verification_summary.headline,
  });
}

export function safeDiffSummary(taskId: string, options: SafeViewOptions = {}) {
  const maxItems = normalizeMaxItems(options.max_items);
  const { taskDir, config } = getTaskDir(taskId);
  const changes = readJson(join(taskDir, "changed-files.json"), config);
  const changedFiles = asArray(changes.changed_files) as ChangedFile[];
  const hygiene = asRecord(changes.artifact_hygiene);
  return redact({
    task_id: taskId,
    changed_files_total: changedFiles.length,
    additions: Number(changes.additions || 0),
    deletions: Number(changes.deletions || 0),
    diff_available: Boolean(changes.diff_available),
    diff_truncated: Boolean(changes.diff_truncated),
    patch_mode: changes.patch_mode || null,
    files: changedFiles.slice(0, maxItems).map((file) => ({
      path: file.path,
      old_path: file.old_path || null,
      change: file.change,
      kind: file.kind,
      tracked: Boolean(file.tracked),
      ignored: Boolean(file.ignored),
    })),
    artifact_hygiene_counts: asRecord(hygiene.counts),
    large_diff_omitted: true,
    truncated: changedFiles.length > maxItems,
  });
}

export function safeAudit(taskId: string, options: SafeViewOptions = {}) {
  const maxItems = normalizeMaxItems(options.max_items);
  return auditToSafe(auditTask(taskId) as AuditTaskOutput, maxItems);
}

export function safeDirectSummary(sessionId: string, options: SafeViewOptions = {}) {
  const maxItems = normalizeMaxItems(options.max_items);
  const session = readDirectSession(sessionId);
  return directSessionToSafe(session, maxItems, "summary");
}

export function safeFinalizeDirectSession(sessionId: string, options: SafeViewOptions = {}) {
  const maxItems = normalizeMaxItems(options.max_items);
  const finalized = finalizeDirectSession({ session_id: sessionId });
  const session = readDirectSession(sessionId);
  return redact({
    ...directSessionToSafe(session, maxItems, "finalize"),
    finalized: finalized.finalized,
    next_action: finalized.next_action,
  });
}

export function safeAuditDirectSession(sessionId: string, options: SafeViewOptions = {}) {
  const maxItems = normalizeMaxItems(options.max_items);
  const audit = auditSession({ session_id: sessionId });
  return redact({
    session_id: audit.session_id,
    decision: audit.decision,
    reason_codes: audit.reason_codes.slice(0, maxItems),
    blocking_findings: limitStrings(audit.blocking_findings, maxItems),
    warnings: limitStrings(audit.warnings, maxItems),
    evidence: {
      changed_files_total: audit.evidence.changed_files_total,
      verification_runs: summarizeVerificationRuns(audit.evidence.verification_runs),
      diff_available: Boolean(audit.evidence.diff_path),
      summary_available: Boolean(audit.evidence.summary_path),
      audit_available: Boolean(audit.evidence.audit_path),
    },
    next_action: audit.next_action,
  });
}

function auditToSafe(audit: AuditTaskOutput, maxItems: number) {
  const checks = audit.checks.map((check) => ({
    name: check.name,
    result: check.result,
    detail: truncate(check.detail, 240),
  }));
  return redact({
    task_id: audit.task_id,
    verdict: audit.verdict,
    acceptance: {
      verdict: audit.acceptance.verdict,
      status: audit.acceptance.status,
      reason: truncate(audit.acceptance.reason, 240),
      fail_checks: audit.acceptance.fail_checks.slice(0, maxItems).map((check) => check.name),
      warn_checks: audit.acceptance.warn_checks.slice(0, maxItems).map((check) => check.name),
      next_suggested_task: truncate(audit.acceptance.next_suggested_task, 240),
    },
    check_counts: {
      pass: checks.filter((check) => check.result === "pass").length,
      warn: checks.filter((check) => check.result === "warn").length,
      fail: checks.filter((check) => check.result === "fail").length,
    },
    checks: checks.slice(0, maxItems),
    fail_checks: checks.filter((check) => check.result === "fail").slice(0, maxItems),
    warn_checks: checks.filter((check) => check.result === "warn").slice(0, maxItems),
    possible_false_positives: audit.possible_false_positives.slice(0, maxItems).map((item) => ({
      check: item.check,
      reason: truncate(item.reason, 240),
    })),
    manual_verification_required: audit.manual_verification_required,
    manual_verification_items: limitStrings(audit.manual_verification_items, maxItems),
    recommended_next_actions: limitStrings(audit.recommended_next_actions, maxItems),
  });
}

function directSessionToSafe(session: DirectSessionRecord, maxItems: number, view: "summary" | "finalize") {
  const artifacts = session.change_artifacts;
  const changedFiles = artifacts?.changed_files || [];
  return redact({
    view,
    session_id: session.session_id,
    title: session.title || "",
    repo_path: session.repo_path,
    created_at: session.created_at,
    expires_at: session.expires_at,
    finalized: session.finalized,
    finalized_at: session.finalized_at,
    audited: session.audited,
    changed_files_total: changedFiles.length,
    files: changedFiles.slice(0, maxItems).map((file) => ({
      path: file.path,
      old_path: file.old_path || null,
      change: file.change,
      kind: file.kind,
      tracked: Boolean(file.tracked),
      ignored: Boolean(file.ignored),
    })),
    artifact_hygiene_counts: artifacts?.artifact_hygiene.counts || {},
    source_changes: limitClassified(artifacts?.artifact_hygiene.source_changes, maxItems),
    tracked_build_artifacts: limitClassified(artifacts?.artifact_hygiene.tracked_build_artifacts, maxItems),
    runtime_generated_files: limitClassified(artifacts?.artifact_hygiene.runtime_generated_files, maxItems),
    suspicious_changes: limitClassified(artifacts?.artifact_hygiene.suspicious_changes, maxItems),
    verification: summarizeVerificationRuns(session.verification_runs),
    large_diff_omitted: true,
    truncated: changedFiles.length > maxItems,
  });
}

function summarizeVerificationRuns(runs: DirectSessionVerificationRun[]) {
  return runs.map((run) => ({
    command: run.command,
    exit_code: run.exit_code,
    passed: run.passed,
    timed_out: run.timed_out,
    started_at: run.started_at,
    finished_at: run.finished_at,
  }));
}

function limitClassified(value: ClassifiedChange[] | undefined, maxItems: number) {
  return (value || []).slice(0, maxItems).map((entry) => ({
    path: entry.path,
    change: entry.change,
    kind: entry.kind,
    tracked: entry.tracked,
    ignored: entry.ignored,
    reason: truncate(entry.reason, 160),
  }));
}

function getTaskDir(taskId: string) {
  const config = getConfig();
  const taskDir = resolve(getTasksDir(config), taskId);
  guardReadPath(join(taskDir, "status.json"), config.workspaceRoot, config.tasksDir);
  return { config, taskDir };
}

function readJson(path: string, config: ReturnType<typeof getConfig>): Record<string, any> {
  guardReadPath(path, config.workspaceRoot, config.tasksDir);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

function normalizeMaxItems(value: number | undefined): number {
  if (value === undefined) return 8;
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("max_items must be an integer from 1 to 50.");
  }
  return value;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function limitStrings(values: string[], maxItems: number): string[] {
  return values.slice(0, maxItems).map((value) => truncate(value, 240));
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function redact<T>(value: T): T {
  return redactSensitiveValue(value).value as T;
}
