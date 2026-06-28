import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getTasksDir, getPlansDir, getConfig } from "../config.js";
import { guardPath, guardWorkspacePath, guardReadPath } from "../security/pathGuard.js";
import { guardTestCommand } from "../security/commandGuard.js";
import { guardRuntimeSelfModification } from "../security/runtimeGuard.js";
import { guardPlanContent } from "../security/planGuard.js";
import { assessRisk } from "../security/riskEngine.js";
import {
  createAssessment,
  readAssessment,
  validateAssessmentFreshness,
  generateAssessmentId,
  createAssessmentDir,
  type AssessmentRecord,
  type AgentAssessmentSummary,
} from "../assessments/assessmentStore.js";
import { runAgentAssessment } from "../assessments/agentAssessor.js";
import { captureRepoSnapshot } from "../runner/changeCapture.js";
import { writeTaskProgress } from "../taskProgress.js";
import { PatchWardenError } from "../errors.js";
import { savePlan } from "./savePlan.js";
import {
  expandTaskTemplate,
  TASK_TEMPLATE_NAMES,
  type ChangePolicy,
  type TaskTemplateName,
} from "./taskTemplates.js";
import { PATCHWARDEN_VERSION } from "../version.js";
import { getLastToolCatalogSnapshot, resolveToolProfile } from "./toolCatalog.js";
import {
  derivePendingReason,
  readWatcherStatus,
  type PendingReason,
  type WatcherStatusSnapshot,
} from "../watcherStatus.js";
import { routeAgent, type AgentRouteResult } from "../agents/agentRouter.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "collecting_artifacts"
  | "done_by_agent"      // v0.7.0: agent self-reported done or status reconciled to done; acceptance_status defaults to "pending"
  | "accepted"           // v0.7.2: audit_task confirmed acceptance
  | "rejected"           // v0.7.2: audit_task confirmed rejection
  | "needs_fix"          // v0.7.2: audit_task requires fixes before acceptance
  | "blocked"            // v0.7.2: audit_task blocked by approval boundary
  | "done"               // legacy terminal status, kept for backward compatibility
  | "failed"
  | "failed_verification"
  | "failed_scope_violation"
  | "failed_policy_violation"
  | "failed_stale"       // v0.7.0: process dead / heartbeat expired
  | "orphaned"           // v0.7.0: watcher no longer owns the task
  | "canceled";

/**
 * v0.7.2 acceptance status — only meaningful for done_by_agent.
 * - "pending": done_by_agent reached but not yet audited/accepted
 * - "accepted": audit_task confirmed all evidence passes
 * - "rejected": audit_task found fail-level issues
 * - "needs_fix": audit_task found warn-level issues requiring fixes
 * - "blocked": audit_task blocked by approval boundary (e.g. release claims)
 * - null: status has no acceptance semantics (running, failed, etc.)
 */
export type AcceptanceStatus = "pending" | "accepted" | "rejected" | "needs_fix" | "blocked" | null;
export type TaskPhase =
  | "queued"
  | "preparing"
  | "executing_agent"
  | "running_tests"
  | "collecting_artifacts"
  | "canceling"
  | "terminating"
  | "completed"
  | "failed"
  | "failed_verification"
  | "failed_scope_violation"
  | "failed_policy_violation"
  | "failed_stale"        // v0.7.0
  | "orphaned"             // v0.7.0
  | "done_by_agent"        // v0.7.0
  | "accepted"             // v0.7.2
  | "rejected"             // v0.7.2
  | "needs_fix"            // v0.7.2
  | "blocked"              // v0.7.2
  | "canceled";

export interface CreateTaskInput {
  plan_id?: string;
  inline_plan?: string;
  plan_title?: string;
  template?: TaskTemplateName;
  goal?: string;
  source_task_id?: string;
  agent?: string;
  repo_path?: string;
  test_command?: string;
  verify_commands?: string[];
  timeout_seconds?: number;
  execution_mode?: "assess_only" | "execute";
  assessment_id?: string;
  // v0.7.2: 验收标准绑定到任务创建
  scope?: string[];           // 允许修改的文件/目录范围（相对于 repo_path）
  forbidden?: string[];       // 禁止修改的文件/目录
  verification?: string[];     // 验收时必须通过的验证命令（独立于 verify_commands）
  done_evidence?: string[];    // 完成证据要求（例如 ["result.md", "test.log", "diff.patch"]）
  // v0.8.0: Goal Session 关联
  goal_id?: string;
  subgoal_id?: string;
}

export interface AssessOnlyOutput {
  assessment_id: string;
  assessment_short_id: string;
  decision: "allow" | "needs_confirm" | "blocked";
  risk_level: "low" | "medium" | "high";
  risk_hints: string[];
  hard_rule_hits: string[];
  reason_codes: string[];
  expires_at: string;
  requires_confirm: boolean;
  workspace_snapshot_summary: {
    head: string | null;
    file_count: number;
    workspace_dirty: boolean;
    snapshot_truncated: boolean;
  };
  next_action: string;
  next_tool_call?: {
    name: "create_task";
    arguments: {
      execution_mode: "execute";
      assessment_id: string;
    };
  };
  local_confirmation: {
    required: boolean;
    command: "patchwarden-confirm" | null;
    arguments: string[];
  };
  suggestion?: string;
  agent_assessment?: {
    status: string;
    merged_risk: string;
    merged_decision: string;
    confidence: number | null;
    notes: string | null;
    read_only_violation: boolean;
    stdout_truncated: boolean;
    stderr_truncated: boolean;
  } | null;
}

export type CreateTaskResult = CreateTaskOutput | AssessOnlyOutput;

export interface CreateTaskOutput {
  task_id: string;
  plan_id: string;
  agent: string;
  status: TaskStatus;
  timeout_seconds: number;
  continuation_required: boolean;
  next_action: string;
  path: string;
  plan_source: "saved" | "inline" | "template";
  template?: TaskTemplateName;
  change_policy: ChangePolicy;
  server_version: string;
  tool_profile: string;
  tool_manifest_sha256: string | null;
  execution_blocked: boolean;
  pending_reason: PendingReason;
  watcher: WatcherStatusSnapshot;
  available_followup_tools: string[];
  next_tool_call: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export function createTask(input: CreateTaskInput & { execution_mode: "assess_only" }): AssessOnlyOutput;
export function createTask(input: CreateTaskInput): CreateTaskOutput;
export function createTask(input: CreateTaskInput): CreateTaskResult {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const plansDir = getPlansDir(config);

  const executionMode = input.execution_mode || "execute";

  // ── assessment_id execute mode: load record and override params ──
  let assessmentRecord: AssessmentRecord | null = null;
  let effectiveInput = input;
  if (executionMode === "execute" && input.assessment_id) {
    assessmentRecord = readAssessment(input.assessment_id);
    // Parameter mismatch check: if ChatGPT passes params that differ from the assessment, reject
    effectiveInput = mergeAssessmentIntoInput(input, assessmentRecord);
  }

  // ── Validate required fields ──
  // agent and repo_path are required unless assessment_id fills them.
  // assess_only always requires them because the risk engine needs to check them.
  // v1.0.0: agent is now optional — if omitted, routeAgent recommends one based on scope/goal/plan.
  let agentSelectionReason: AgentRouteResult | undefined;
  if (!effectiveInput.agent || effectiveInput.agent.trim() === "") {
    const configuredAgents = Object.keys(config.agents);
    const routeResult = routeAgent({
      goal: effectiveInput.goal,
      scope: effectiveInput.scope,
      inline_plan: effectiveInput.inline_plan,
      template: effectiveInput.template,
      configuredAgents,
    });
    effectiveInput.agent = routeResult.recommended_agent;
    agentSelectionReason = {
      recommended_agent: routeResult.recommended_agent,
      reason: routeResult.reason,
      fallback: routeResult.fallback,
    };
  }

  const planSources = [
    effectiveInput.plan_id?.trim() ? "plan_id" : "",
    effectiveInput.inline_plan?.trim() ? "inline_plan" : "",
    effectiveInput.template ? "template" : "",
  ].filter(Boolean);
  if (planSources.length !== 1) {
    throw new PatchWardenError(
      "invalid_plan_source",
      "create_task requires exactly one of plan_id, inline_plan, or template.",
      "Use an existing plan_id, pass inline_plan text, or choose one built-in template."
    );
  }
  if (effectiveInput.template && !TASK_TEMPLATE_NAMES.includes(effectiveInput.template)) {
    throw new PatchWardenError(
      "invalid_task_template",
      `Unknown task template "${effectiveInput.template}".`,
      `Use one of: ${TASK_TEMPLATE_NAMES.join(", ")}.`
    );
  }

  // Resolve repo alias if configured
  let resolvedRepoPath = effectiveInput.repo_path?.trim() || "";
  const aliases = (config as any).repoAliases as Record<string, string> | undefined;
  if (aliases && resolvedRepoPath && aliases[resolvedRepoPath]) {
    resolvedRepoPath = aliases[resolvedRepoPath];
  }

  if (!resolvedRepoPath || resolvedRepoPath === "") {
    throw new PatchWardenError(
      "repo_path_required",
      "create_task requires an explicit repo_path; PatchWarden will not default to workspaceRoot.",
      'Pass a repository path inside workspaceRoot, for example repo_path: "my-project".',
      true,
      { operation: "create_task", safe_alternative: "Pass an existing repository directory under workspaceRoot." }
    );
  }

  // Validate agent
  if (!config.agents[effectiveInput.agent]) {
    throw new PatchWardenError(
      "agent_not_configured",
      `Unknown agent "${effectiveInput.agent}". Available: ${Object.keys(config.agents).join(", ")}`,
      "Call list_agents and use an available configured agent."
    );
  }

  // Validate repo_path is within workspace
  const safeRepoPath = guardWorkspacePath(
    resolvedRepoPath,
    config.workspaceRoot
  );
  if (!existsSync(safeRepoPath)) {
    throw new PatchWardenError(
      "repo_path_not_found",
      `repo_path "${resolvedRepoPath}" resolves to "${safeRepoPath}", but that path does not exist.`,
      "Create the repository directory first or pass an existing path under workspaceRoot.",
      true,
      { operation: "create_task", path: resolvedRepoPath, resolved_repo_path: safeRepoPath, safe_alternative: "Use an existing repository directory under workspaceRoot." }
    );
  }
  if (!statSync(safeRepoPath).isDirectory()) {
    throw new PatchWardenError(
      "repo_path_not_directory",
      `repo_path "${resolvedRepoPath}" resolves to a file, not a directory.`,
      "Pass the repository directory instead of a file path.",
      true,
      { operation: "create_task", path: resolvedRepoPath, resolved_repo_path: safeRepoPath, safe_alternative: "Pass the containing repository directory instead of a file." }
    );
  }

  // Runtime self-modification protection: refuse to modify the active
  // PatchWarden runtime directory or its critical subdirectories.
  guardRuntimeSelfModification(safeRepoPath);

  // Validate test command — must be in allowlist, no swallowing
  let testCmd = "";
  if (effectiveInput.test_command && effectiveInput.test_command.trim() !== "") {
    testCmd = guardTestCommand(effectiveInput.test_command, config, safeRepoPath);
    // guardTestCommand throws if not in allowedTestCommands
  }

  if (effectiveInput.verify_commands !== undefined && !Array.isArray(effectiveInput.verify_commands)) {
    throw new PatchWardenError(
      "invalid_verify_commands",
      "verify_commands must be an array of allow-listed command strings.",
      "Pass an array such as [\"npm test\", \"npm run build\"]."
    );
  }
  if ((effectiveInput.verify_commands?.length || 0) > 20) {
    throw new PatchWardenError(
      "invalid_verify_commands",
      "verify_commands cannot contain more than 20 commands.",
      "Keep verification focused and use no more than 20 allow-listed commands."
    );
  }
  const verifyCommands = [...new Set([
    ...(effectiveInput.verify_commands || []).map((command) => guardTestCommand(command, config, safeRepoPath)),
    ...(testCmd ? [testCmd] : []),
  ])];

  const timeoutSeconds = effectiveInput.timeout_seconds ?? config.defaultTaskTimeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new PatchWardenError(
      "invalid_timeout",
      "timeout_seconds must be a positive integer",
      `Use a whole number from 1 to ${config.maxTaskTimeoutSeconds}.`
    );
  }
  if (timeoutSeconds > config.maxTaskTimeoutSeconds) {
    throw new PatchWardenError(
      "invalid_timeout",
      `timeout_seconds cannot exceed configured maximum ${config.maxTaskTimeoutSeconds}`,
      `Use a value no greater than ${config.maxTaskTimeoutSeconds}.`
    );
  }

  let planId = effectiveInput.plan_id?.trim() || "";
  let planSource: CreateTaskOutput["plan_source"] = "saved";
  let changePolicy: ChangePolicy = "repo_scoped_changes";
  let planContentForHash: string | null = null;

  // ── assess_only: check plan content WITHOUT saving first ──
  // This catches guardPlanContent violations as hard rule hits instead of throwing.
  if (executionMode === "assess_only") {
    let assessPlanContent = "";
    let assessPlanTitle = effectiveInput.plan_title?.trim() || "Assessment plan";
    if (planId) {
      const planFile = join(resolve(plansDir, planId), "plan.md");
      guardReadPath(planFile, config.workspaceRoot, config.plansDir);
      if (!existsSync(planFile)) {
        throw new PatchWardenError(
          "plan_not_found",
          `Plan "${planId}" not found.`,
          "Call save_plan first, or pass inline_plan/template directly to create_task."
        );
      }
      assessPlanContent = readFileSync(planFile, "utf-8");
    } else if (effectiveInput.inline_plan?.trim()) {
      assessPlanContent = effectiveInput.inline_plan.trim();
    } else if (effectiveInput.template) {
      const expanded = expandTaskTemplate({
        template: effectiveInput.template,
        goal: effectiveInput.goal || "",
        source_task_id: effectiveInput.source_task_id,
        verify_commands: verifyCommands,
      });
      assessPlanContent = expanded.content;
      assessPlanTitle = expanded.title;
      changePolicy = expanded.change_policy;
    }

    // Run risk engine WITHOUT saving the plan
    let planBlocked = false;
    let planBlockReason = "";
    try {
      guardPlanContent(assessPlanTitle, assessPlanContent);
    } catch (e) {
      planBlocked = true;
      planBlockReason = e instanceof PatchWardenError ? e.reason : "plan_content_blocked";
    }

    const snapshot = captureRepoSnapshot(safeRepoPath);
    const snapshotTruncated = snapshot.warnings.some((w) => w.includes("snapshot limited"));

    let riskResult;
    if (planBlocked) {
      riskResult = {
        risk_level: "high" as const,
        decision: "blocked" as const,
        reason_codes: [],
        risk_hints: [],
        hard_rule_hits: [planBlockReason],
      };
    } else {
      riskResult = assessRisk({
        repoPath: resolvedRepoPath,
        resolvedRepoPath: safeRepoPath,
        planContent: assessPlanContent,
        planTitle: assessPlanTitle,
        testCommand: testCmd,
        verifyCommands: verifyCommands,
        template: effectiveInput.template,
        goal: effectiveInput.goal,
        agent: effectiveInput.agent,
        config,
        snapshotTruncated,
      });
    }

    // Save the plan now that risk assessment is done (for allow/needs_confirm)
    if (!planBlocked) {
      if (effectiveInput.inline_plan?.trim()) {
        const saved = savePlan({
          title: effectiveInput.plan_title?.trim() || "Inline task plan",
          content: effectiveInput.inline_plan.trim(),
        });
        planId = saved.plan_id;
        planSource = "inline";
        planContentForHash = readFileSync(saved.path, "utf-8");
      } else if (effectiveInput.template) {
        const saved = savePlan({ title: assessPlanTitle, content: assessPlanContent });
        planId = saved.plan_id;
        planSource = "template";
        planContentForHash = readFileSync(saved.path, "utf-8");
      } else {
        planContentForHash = assessPlanContent;
      }
    }

    // ── Agent assessment: only when enabled AND deterministic decision is "allow" ──
    let finalRiskResult = riskResult;
    let agentAssessmentSummary: AgentAssessmentSummary | null = null;
    let preGeneratedAssessmentId: string | undefined;
    let preGeneratedAssessmentDir: string | undefined;

    if (config.enableAgentAssessment === true && riskResult.decision === "allow" && !planBlocked) {
      preGeneratedAssessmentId = generateAssessmentId();
      preGeneratedAssessmentDir = createAssessmentDir(preGeneratedAssessmentId);

      const assessorAgentName = config.agentAssessmentAgentName || effectiveInput.agent;
      agentAssessmentSummary = runAgentAssessment({
        assessmentId: preGeneratedAssessmentId,
        assessmentDir: preGeneratedAssessmentDir,
        agentName: assessorAgentName,
        repoPath: safeRepoPath,
        workspaceRoot: config.workspaceRoot,
        goal: effectiveInput.goal || "",
        planContent: assessPlanContent,
        timeoutSeconds: config.agentAssessmentTimeoutSeconds || 120,
        maxOutputBytes: config.agentAssessmentMaxOutputBytes || 524288,
        config,
      });

      finalRiskResult = {
        risk_level: agentAssessmentSummary.merged_risk,
        decision: agentAssessmentSummary.merged_decision,
        reason_codes: [...riskResult.reason_codes, ...agentAssessmentSummary.merged_reason_codes],
        risk_hints: riskResult.risk_hints,
        hard_rule_hits: riskResult.hard_rule_hits,
      };
    }

    const record = createAssessment({
      decision: finalRiskResult.decision,
      risk_level: finalRiskResult.risk_level,
      risk_hints: finalRiskResult.risk_hints,
      hard_rule_hits: finalRiskResult.hard_rule_hits,
      reason_codes: finalRiskResult.reason_codes,
      repo_path: resolvedRepoPath,
      resolved_repo_path: safeRepoPath,
      plan_id: planId || null,
      plan_content: planContentForHash,
      template: effectiveInput.template || null,
      goal: effectiveInput.goal || null,
      test_command: testCmd || null,
      verify_commands: verifyCommands,
      agent: effectiveInput.agent,
      timeout_seconds: timeoutSeconds,
      change_policy: changePolicy,
      snapshot,
      ...(preGeneratedAssessmentId ? { assessment_id: preGeneratedAssessmentId } : {}),
      ...(preGeneratedAssessmentDir ? { assessment_dir: preGeneratedAssessmentDir } : {}),
      agent_assessment_summary: agentAssessmentSummary,
    });

    const nextAction = record.decision === "allow"
      ? "Call the returned next_tool_call exactly as provided; do not resend goal, plan, repository, agent, or verification arguments."
      : record.decision === "needs_confirm"
        ? `Assessment requires local confirmation. Run patchwarden-confirm ${record.assessment_id} locally, then call the returned next_tool_call exactly as provided.`
        : `Assessment blocked. Fix the reported hard rule hit and re-run assess_only.`;

    const nextToolCall = record.decision === "blocked" ? undefined : {
      name: "create_task" as const,
      arguments: {
        execution_mode: "execute" as const,
        assessment_id: record.assessment_id,
      },
    };

    return {
      assessment_id: record.assessment_id,
      assessment_short_id: record.assessment_short_id,
      decision: record.decision,
      risk_level: record.risk_level,
      risk_hints: record.risk_hints,
      hard_rule_hits: record.hard_rule_hits,
      reason_codes: record.reason_codes,
      expires_at: record.expires_at,
      requires_confirm: record.requires_confirm,
      workspace_snapshot_summary: record.workspace_snapshot_summary,
      next_action: nextAction,
      ...(nextToolCall ? { next_tool_call: nextToolCall } : {}),
      local_confirmation: {
        required: record.requires_confirm,
        command: record.requires_confirm ? "patchwarden-confirm" : null,
        arguments: record.requires_confirm ? [record.assessment_id] : [],
      },
      ...(finalRiskResult.hard_rule_hits.length > 0
        ? { suggestion: `Hard rule hit: ${finalRiskResult.hard_rule_hits.join(", ")}` }
        : {}),
      ...(agentAssessmentSummary ? {
        agent_assessment: {
          status: agentAssessmentSummary.status,
          merged_risk: agentAssessmentSummary.merged_risk,
          merged_decision: agentAssessmentSummary.merged_decision,
          confidence: agentAssessmentSummary.output?.confidence ?? null,
          notes: agentAssessmentSummary.output?.notes ?? null,
          read_only_violation: agentAssessmentSummary.read_only_violation,
          stdout_truncated: agentAssessmentSummary.stdout_truncated,
          stderr_truncated: agentAssessmentSummary.stderr_truncated,
        }
      } : {}),
    };
  }

  // ── execute mode: resolve plan normally ──
  if (planId) {
    const planFile = join(resolve(plansDir, planId), "plan.md");
    guardReadPath(planFile, config.workspaceRoot, config.plansDir);
    if (!existsSync(planFile)) {
      throw new PatchWardenError(
        "plan_not_found",
        `Plan "${planId}" not found.`,
        "Call save_plan first, or pass inline_plan/template directly to create_task."
      );
    }
    planContentForHash = readFileSync(planFile, "utf-8");
  } else if (effectiveInput.inline_plan?.trim()) {
    const saved = savePlan({
      title: effectiveInput.plan_title?.trim() || "Inline task plan",
      content: effectiveInput.inline_plan.trim(),
    });
    planId = saved.plan_id;
    planSource = "inline";
    planContentForHash = readFileSync(saved.path, "utf-8");
  } else {
    const expanded = expandTaskTemplate({
      template: effectiveInput.template!,
      goal: effectiveInput.goal || "",
      source_task_id: effectiveInput.source_task_id,
      verify_commands: verifyCommands,
    });
    const saved = savePlan({ title: expanded.title, content: expanded.content });
    planId = saved.plan_id;
    planSource = "template";
    changePolicy = expanded.change_policy;
    planContentForHash = readFileSync(saved.path, "utf-8");
  }

  // ── execute mode with assessment_id: validate freshness ──
  if (assessmentRecord) {
    const snapshot = captureRepoSnapshot(safeRepoPath);
    const validation = validateAssessmentFreshness(input.assessment_id!, snapshot);
    if (!validation.valid) {
      throw new PatchWardenError(
        validation.failure_reason || "assessment_validation_failed",
        `Assessment "${input.assessment_id}" is no longer valid: ${validation.failure_reason}`,
        "Re-run create_task with execution_mode=assess_only to get a fresh assessment_id.",
        true,
        { assessment_id: input.assessment_id, failure_reason: validation.failure_reason }
      );
    }
  }

  const { taskId, taskDir } = createTaskDirectory(tasksDir, config.workspaceRoot, config.tasksDir);

  const status: TaskStatus = "pending";
  const statusFile = join(taskDir, "status.json");
  const statusData = {
    task_id: taskId,
    plan_id: planId,
    plan_source: planSource,
    template: effectiveInput.template || null,
    change_policy: changePolicy,
    agent: effectiveInput.agent,
    workspace_root: resolve(config.workspaceRoot),
    repo_path: resolvedRepoPath,
    resolved_repo_path: safeRepoPath,
    test_command: testCmd,
    verify_commands: verifyCommands,
    timeout_seconds: timeoutSeconds,
    assessment_id: assessmentRecord?.assessment_id || input.assessment_id || null,
    status,
    phase: "queued" as TaskPhase,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    current_command: null as string | null,
    error: null as string | null,
    // v0.7.2: 验收标准绑定到任务创建
    goal: effectiveInput.goal || null,
    scope: effectiveInput.scope ?? null,
    forbidden: effectiveInput.forbidden ?? null,
    verification: effectiveInput.verification ?? null,
    done_evidence: effectiveInput.done_evidence ?? null,
    acceptance_status: null as AcceptanceStatus,
    // v0.8.0: Goal Session 关联
    goal_id: effectiveInput.goal_id ?? null,
    subgoal_id: effectiveInput.subgoal_id ?? null,
    // v1.0.0: Agent routing decision (only present when agent was auto-routed)
    ...(agentSelectionReason ? { agent_selection_reason: agentSelectionReason } : {}),
  };

  writeFileSync(statusFile, JSON.stringify(statusData, null, 2), "utf-8");
  writeTaskProgress(taskDir, "queued", {
    heartbeatAt: statusData.last_heartbeat_at,
    note: `Waiting for watcher. Timeout: ${timeoutSeconds} seconds.`,
  });

  const catalog = getLastToolCatalogSnapshot();
  const watcher = readWatcherStatus(config);
  const pendingReason = derivePendingReason({ status, phase: statusData.phase }, watcher);
  const hasWaitForTask = catalog?.tool_names?.includes("wait_for_task") ?? true;
  const nextActionWait = `Call wait_for_task with task_id ${taskId}; keep calling it until terminal is true, then review the returned summary.`;
  const nextActionPoll = `Task created. Monitor status with get_task_status(task_id: "${taskId}") and check progress.md. When status reaches done/failed, review get_task_summary or get_result.`;
  const nextActionBlocked = `Task was saved but execution is blocked because the watcher is ${watcher.status}. Call health_check and restart the owned watcher; the queued task will be picked up after recovery.`;
  const followupCandidates = ["health_check", "get_task_status", "list_tasks", "wait_for_task", "cancel_task"];
  const availableFollowupTools = catalog
    ? followupCandidates.filter((name) => catalog.tool_names.includes(name))
    : followupCandidates;

  return {
    task_id: taskId,
    plan_id: planId,
    agent: effectiveInput.agent,
    status,
    timeout_seconds: timeoutSeconds,
    continuation_required: watcher.available && hasWaitForTask,
    next_action: !watcher.available ? nextActionBlocked : hasWaitForTask ? nextActionWait : nextActionPoll,
    path: taskDir,
    plan_source: planSource,
    ...(effectiveInput.template ? { template: effectiveInput.template } : {}),
    change_policy: changePolicy,
    server_version: PATCHWARDEN_VERSION,
    tool_profile: catalog?.tool_profile || resolveToolProfile(config.toolProfile),
    tool_manifest_sha256: catalog?.tool_manifest_sha256 || null,
    execution_blocked: !watcher.available,
    pending_reason: pendingReason,
    watcher,
    available_followup_tools: availableFollowupTools,
    next_tool_call: !watcher.available
      ? { name: "health_check", arguments: { detail: "standard" } }
      : hasWaitForTask
        ? { name: "wait_for_task", arguments: { task_id: taskId, timeout_seconds: 25 } }
        : { name: "get_task_status", arguments: { task_id: taskId } },
  } as CreateTaskOutput;
}

function mergeAssessmentIntoInput(
  input: CreateTaskInput,
  record: AssessmentRecord
): CreateTaskInput {
  // Use plan_id from the assessment record (the plan was already saved during assess_only).
  // Do NOT set template/inline_plan alongside plan_id — createTask requires exactly one plan source.
  const merged: CreateTaskInput = {
    ...input,
    plan_id: record.plan_id || input.plan_id,
    template: undefined,
    inline_plan: undefined,
    goal: record.goal || input.goal,
    agent: record.agent,
    repo_path: record.repo_path,
    test_command: record.test_command || undefined,
    verify_commands: record.verify_commands || input.verify_commands,
    timeout_seconds: record.timeout_seconds || input.timeout_seconds,
  };
  // Parameter mismatch check: if caller passed explicit params that differ from assessment
  if (input.template && record.template && input.template !== record.template) {
    throw new PatchWardenError(
      "assessment_parameter_mismatch",
      `template mismatch: caller passed "${input.template}" but assessment has "${record.template}".`,
      "Do not override assessment-locked parameters. Use the same assessment_id as-is.",
      true,
      { field: "template", assessment_value: record.template, caller_value: input.template }
    );
  }
  if (input.goal && record.goal && input.goal !== record.goal) {
    throw new PatchWardenError(
      "assessment_parameter_mismatch",
      `goal mismatch: caller passed a different goal than the assessment.`,
      "Do not override assessment-locked parameters. Use the same assessment_id as-is.",
      true,
      { field: "goal" }
    );
  }
  if (input.repo_path && record.repo_path && input.repo_path !== record.repo_path) {
    throw new PatchWardenError(
      "assessment_parameter_mismatch",
      `repo_path mismatch: caller passed "${input.repo_path}" but assessment has "${record.repo_path}".`,
      "Do not override assessment-locked parameters. Use the same assessment_id as-is.",
      true,
      { field: "repo_path", assessment_value: record.repo_path, caller_value: input.repo_path }
    );
  }
  return merged;
}

function createTaskDirectory(tasksDir: string, workspaceRoot: string, configuredTasksDir: string): { taskId: string; taskDir: string } {
  guardPath(tasksDir, workspaceRoot, configuredTasksDir);
  mkdirSync(tasksDir, { recursive: true });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const timestamp = new Date().toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "_")
      .slice(0, 15);
    const taskId = `task_${timestamp}_${randomBytes(3).toString("hex")}`;
    const taskDir = resolve(tasksDir, taskId);
    guardPath(taskDir, workspaceRoot, configuredTasksDir);
    try {
      mkdirSync(taskDir, { recursive: false });
      return { taskId, taskDir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new PatchWardenError(
    "task_id_generation_failed",
    "Could not allocate a unique short task ID.",
    "Retry create_task; no task directory was created."
  );
}
