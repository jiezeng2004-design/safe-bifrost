/**
 * Shared tool registry for PatchWarden MCP server.
 * Used by both stdio (index.ts) and HTTP (httpServer.ts) transports.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getAllConfiguredTestCommands, getAllConfiguredDirectCommands, getConfig } from "../config.js";
import { savePlan } from "../tools/savePlan.js";
import { getPlan } from "../tools/getPlan.js";
import { createTask } from "../tools/createTask.js";
import { getTaskStatus } from "../tools/getTaskStatus.js";
import { getResult, getResultJson, getDiff, getTestLog, getTaskLogTail } from "../tools/taskOutputs.js";
import { listWorkspace } from "../tools/listWorkspace.js";
import { readWorkspaceFile } from "../tools/readWorkspaceFile.js";
import { listTasks } from "../tools/listTasks.js";
import { cancelTask } from "../tools/cancelTask.js";
import { killTask } from "../tools/killTask.js";
import { retryTask } from "../tools/retryTask.js";
import { getTaskStdoutTail } from "../tools/getTaskStdoutTail.js";
import { getTaskProgress } from "../tools/getTaskProgress.js";
import { listAgents } from "../tools/listAgents.js";
import { healthCheck } from "../tools/healthCheck.js";
import { getTaskSummary } from "../tools/getTaskSummary.js";
import { waitForTask } from "../tools/waitForTask.js";
import { errorPayload, PatchWardenError } from "../errors.js";
import { auditTask } from "../tools/auditTask.js";
import { safeStatus } from "../tools/safeStatus.js";
import {
  safeAudit,
  safeAuditDirectSession,
  safeDiffSummary,
  safeDirectSummary,
  safeFinalizeDirectSession,
  safeResult,
  safeTestSummary,
} from "../tools/safeViews.js";
import { diagnoseTask } from "../tools/diagnoseTask.js";
import { reconcileTasks } from "../tools/reconcileTasks.js";
import { discoverTools } from "../tools/discoverTools.js";
import { explainTool } from "../tools/explainTool.js";
import { invokeDiscoveredTool } from "./invokeDiscoveredTool.js";
import { logger } from "../logging.js";
import { runTask } from "../runner/runTask.js";
import { createDirectSession } from "../tools/createDirectSession.js";
import { searchWorkspace } from "../tools/searchWorkspace.js";
import { applyPatch } from "../tools/applyPatch.js";
import { runVerification } from "../tools/runVerification.js";
import { finalizeDirectSession } from "../tools/finalizeDirectSession.js";
import { auditSession } from "../tools/auditSession.js";
import { syncFile } from "../tools/syncFile.js";
import { createGoal, listGoals, readGoal, readGoalStatus } from "../goal/goalStore.js";
import { suggestNextSubgoal } from "../goal/goalGraph.js";
import { exportHandoff } from "../goal/handoffExport.js";
import { acceptSubgoal, rejectSubgoal, summarizeGoalProgress } from "../goal/goalProgress.js";
import { createSubgoalTask } from "./goalSubgoalTask.js";
import { checkReleaseGate } from "./checkReleaseGate.js";
import { mergeWorktreeTool } from "./mergeWorktree.js";
import { discardWorktreeTool } from "./discardWorktree.js";
import { TASK_TEMPLATE_NAMES } from "./taskTemplates.js";
import {
  buildToolCatalogSnapshot,
  getLastToolCatalogSnapshot,
  resolveToolProfile,
  selectToolsForProfile,
  type ToolCatalogSnapshot,
} from "./toolCatalog.js";

// ── Tool definitions ──────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function getToolDefs(): ToolDef[] {
  const config = getConfig();
  const agentNames = Object.keys(config.agents).sort();
  const agentDescription = agentNames.length > 0
    ? `Configured local agent name. Available agents: ${agentNames.map((name) => JSON.stringify(name)).join(", ")}`
    : "Configured local agent name. No agents are currently configured.";
  const testCommands = getAllConfiguredTestCommands(config).sort();
  const tools: ToolDef[] = [
    {
      name: "save_plan",
      description:
        "Save an execution plan — ChatGPT writes the plan, PatchWarden stores it for local agent execution. Supports plan_ref to load a plan file already placed inside .patchwarden/plans.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Plan title. Defaults to 'Inline plan' or 'Plan from file' when omitted." },
          content: { type: "string", description: "Plan content in Markdown. Required unless plan_ref is provided." },
          plan_ref: { type: "string", description: "Relative path to a plan file already inside .patchwarden/plans. When provided, the file content is loaded and title defaults to 'Plan from file' if title is empty." },
        },
      },
    },
    {
      name: "get_plan",
      description: "Read a saved plan by its plan_id.",
      inputSchema: {
        type: "object",
        properties: {
          plan_id: { type: "string", description: "Plan ID returned by save_plan" },
        },
        required: ["plan_id"],
      },
    },
    {
      name: "health_check",
      description:
        "Check MCP catalog consistency, watcher freshness/supervisor state, workspace readiness, and configured agents. Use detail=self_diagnostic for expanded read-only evidence.",
      inputSchema: {
        type: "object",
        properties: {
          detail: {
            type: "string",
            enum: ["standard", "self_diagnostic"],
            default: "standard",
            description: "Use self_diagnostic for catalog, watcher, agent, allowlist, workspace, and recent failure evidence.",
          },
        },
      },
    },
    {
      name: "list_agents",
      description:
        "List configured local agents and check whether each executable currently exists. This does not start an agent or contact its model provider.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "create_task",
      description:
        "Create a repo-scoped task from exactly one source. For ChatGPT, prefer the guarded inspect_only, feature_small, or fix_tests template when it fits. A stale watcher preserves the task but returns execution_blocked and directs the client to health_check; otherwise call wait_for_task until terminal. Use execution_mode=assess_only to pre-assess risk and get an assessment_id without creating a task; then invoke the returned next_tool_call using only execution_mode=execute and the full assessment_id.",
      inputSchema: {
        type: "object",
        properties: {
          plan_id: { type: "string", description: "Plan ID from save_plan" },
          inline_plan: { type: "string", description: "Inline Markdown plan. It is safety-checked and persisted as an auditable saved plan before task creation." },
          plan_title: { type: "string", description: "Optional title used when inline_plan is supplied." },
          template: {
            type: "string",
            enum: [...TASK_TEMPLATE_NAMES],
            description: "Built-in guarded task template. ChatGPT should prefer inspect_only for diagnosis, feature_small for a scoped change, and fix_tests for known failing verification. Use with goal; rollback_scope_violation also requires source_task_id.",
          },
          goal: { type: "string", description: "Required task goal when template is supplied." },
          source_task_id: { type: "string", description: "Required source task for rollback_scope_violation review." },
          agent: {
            type: "string",
            description: agentDescription,
            ...(agentNames.length > 0 ? { enum: agentNames } : {}),
          },
          repo_path: {
            type: "string",
            description: "Required repository path inside workspaceRoot. No implicit workspace-root fallback is allowed.",
          },
          test_command: {
            type: "string",
            description: testCommands.length
              ? `Optional exact-match verification command. Allowed: ${testCommands.map((command) => JSON.stringify(command)).join(", ")}`
              : "Optional exact-match verification command. No commands are currently allowed.",
            ...(testCommands.length > 0 ? { enum: testCommands } : {}),
          },
          verify_commands: {
            type: "array",
            maxItems: 20,
            items: {
              type: "string",
              ...(testCommands.length > 0 ? { enum: testCommands } : {}),
            },
            description: "Recommended exact-match commands PatchWarden runs independently after the agent exits. Repository-scoped commands are re-authorized after repo_path is resolved.",
          },
          timeout_seconds: {
            type: "integer",
            minimum: 1,
            maximum: config.maxTaskTimeoutSeconds,
            default: config.defaultTaskTimeoutSeconds,
            description: `Total task timeout in seconds (default ${config.defaultTaskTimeoutSeconds}, max ${config.maxTaskTimeoutSeconds})`,
          },
          execution_mode: {
            type: "string",
            enum: ["assess_only", "execute"],
            default: "execute",
            description: "assess_only: run deterministic risk checks and return an assessment_id without creating a task. execute (default): create and queue the task. When combined with assessment_id, the task parameters are loaded from the assessment record and freshness is revalidated.",
          },
          assessment_id: {
            type: "string",
            description: "Assessment ID from a prior assess_only call. When provided with execution_mode=execute, task parameters are loaded from the assessment record and locked to it. The full 128-bit ID (32 hex chars) must be provided; short IDs are display-only.",
          },
        },
        required: [],
      },
    },
    {
      name: "get_task_status",
      description: "Check task status, execution phase, watcher health, pending reason, current command, timeout, and change evidence.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID from create_task" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_result",
      description: "Read result.md, or return structured availability and watcher evidence while the task is not terminal.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_result_json",
      description: "Read the structured result.json for deterministic task acceptance.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_diff",
      description: "Read task diff evidence, or return structured availability and watcher evidence while it is not ready.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_test_log",
      description: "Read test.log, or return structured availability and watcher evidence while it is not ready.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "list_workspace",
      description:
        "List files and directories within the workspace (sensitive files excluded).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional relative path within workspace (default: root)",
          },
        },
      },
    },
    {
      name: "read_workspace_file",
      description:
        "Read a file within the workspace. Sensitive files (secrets, keys, tokens) are blocked. In Direct mode (with session_id), reads are scoped to the session's repo_path and return sha256.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to a file inside the workspace or session repo",
          },
          session_id: {
            type: "string",
            description: "Optional Direct session ID. When provided, read scope is limited to the session's repo_path and sha256 is returned.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "list_tasks",
      description:
        "List recent tasks with status/repo/active filters plus watcher state and computed pending reasons.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by status: pending, running, done, failed, failed_verification, failed_scope_violation, failed_policy_violation, canceled",
          },
          limit: {
            type: "number",
            description: "Max tasks to return (default 20, max 100)",
          },
          repo_path: {
            type: "string",
            description: "Optional exact repo_path or resolved_repo_path filter.",
          },
          active_only: {
            type: "boolean",
            description: "When true, return only pending and running tasks.",
          },
        },
      },
    },
    {
      name: "cancel_task",
      description:
        "Request graceful cancellation. The runner that owns the child process performs termination; the MCP server never kills a PID read from task files.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to cancel" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "kill_task",
      description:
        "Request immediate termination of a pending or running task. The runner validates and kills only the child process it owns.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to terminate" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "retry_task",
      description:
        "Create a new task with the same plan, agent, repo_path, and test_command as an existing task. The original task is unchanged.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to retry" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_task_stdout_tail",
      description:
        "Read the last N lines of agent stdout/stderr. Reads from real-time stdout.log/stderr.log during execution, falls back to result.md after completion. Works on pending, running, and completed tasks. Default 80 lines.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
          lines: { type: "number", description: "Tail line count (default 80, max 200)" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_task_log_tail",
      description:
        "Read the last N lines of a task log file (stdout/stderr/test/verify) with automatic secret redaction. Default 80 lines, max 200. Always returns tail only — never the full file. Use this instead of read_workspace_file to avoid triggering platform content filters on log output.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
          file: {
            type: "string",
            enum: ["stdout", "stderr", "test", "verify"],
            description: "Log file to read: stdout (stdout.log), stderr (stderr.log), test (test.log), verify (verify.log)",
          },
          lines: { type: "number", description: "Tail line count (default 80, max 200)" },
          redact: { type: "boolean", description: "Apply secret redaction (default true)" },
        },
        required: ["task_id", "file"],
      },
    },
    {
      name: "get_task_progress",
      description:
        "Read progress.md for task phases and the most recent heartbeat/current command.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "wait_for_task",
      description:
        "Long-poll a task for up to 30 seconds. If continuation_required=true, call wait_for_task again immediately and do not finish the assistant turn. Terminal responses include get_task_summary acceptance evidence.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID from create_task" },
          wait_seconds: { type: "integer", minimum: 1, maximum: 30, default: 25 },
          timeout_seconds: {
            type: "integer",
            minimum: 1,
            maximum: 30,
            description: "Preferred alias for wait_seconds. Maximum 30 seconds to stay within connector request limits.",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_task_summary",
      description:
        "Return structured acceptance evidence. Use view=compact first for bounded counts and risk excerpts; use standard only when full changed-file and log-tail detail is required.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
          view: { type: "string", enum: ["compact", "standard"], default: "standard", description: "Compact returns bounded acceptance evidence; standard preserves the full legacy summary." },
          max_items: { type: "integer", minimum: 1, maximum: 50, default: 8, description: "Maximum entries per compact evidence group." },
        },
        required: ["task_id"],
      },
    },
    {
      name: "audit_task",
      description:
        "Independently audit a task's outputs. Verifies status, result.md, test.log, git.diff, repo_path consistency, cross-references agent claims with package.json scripts, and flags unverified release/publish claims. Evidence-backed failures, possible heuristic false positives, and manual-verification items are returned separately. Writes independent-review.md to the task directory.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to audit" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "safe_status",
      description:
        "Return minimal task lifecycle status without exposing diff, log content, file contents, or sensitive paths. Use this when only task state is needed and content-bearing tools may be blocked by upper-layer security.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to check" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "safe_result",
      description:
        "Return a low-noise structured task result summary without full logs, markdown, or diff content.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to summarize" },
          max_items: { type: "integer", minimum: 1, maximum: 50, default: 8, description: "Maximum list entries to return per evidence group." },
        },
        required: ["task_id"],
      },
    },
    {
      name: "safe_audit",
      description:
        "Run audit_task and return only bounded structured audit evidence without full review markdown.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to audit" },
          max_items: { type: "integer", minimum: 1, maximum: 50, default: 8, description: "Maximum list entries to return per evidence group." },
        },
        required: ["task_id"],
      },
    },
    {
      name: "safe_test_summary",
      description:
        "Return a compact verification summary for a task without stdout/stderr or test log content.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to summarize" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "safe_diff_summary",
      description:
        "Return changed-file counts and bounded path metadata without returning diff content.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to summarize" },
          max_items: { type: "integer", minimum: 1, maximum: 50, default: 8, description: "Maximum changed files to return." },
        },
        required: ["task_id"],
      },
    },    {
      name: "diagnose_task",
      description:
        "v0.7.0: Diagnose a running or collecting_artifacts task using multi-signal evidence (heartbeat age, log freshness, child PID liveness, watcher ownership, artifact presence). Returns a conservative diagnosis (active_running, stale_running, possibly_stale_running, orphaned_running, artifact_collection_stuck, done_candidate, unknown, terminal) with confidence level and safe_actions. Never relies on a single signal; refuses to call PID-alive tasks 'active' when other signals are stale (PID reuse protection). Read-only — does not modify task state.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to diagnose" },
          include_logs: {
            type: "boolean",
            default: false,
            description: "When true, include redacted stdout/stderr tails in the output. Default false to keep output minimal.",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "reconcile_tasks",
      description:
        "v0.7.0: Scan stale running/collecting_artifacts tasks and either report or safely fix them. report_only (default) returns a diagnosis report without modifying state. safe_fix additionally writes high-confidence status transitions (failed_stale/orphaned/done_by_agent) atomically with backup (status.json.bak), audit fields, and an appended reconcile.log. Never touches tasks still owned by an active watcher; never applies medium/low confidence fixes.",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["report_only", "safe_fix"],
            default: "report_only",
            description: "report_only: read-only diagnosis report. safe_fix: additionally apply high-confidence status transitions with backup + atomic write + reconcile.log.",
          },
          max_age_minutes: {
            type: "number",
            minimum: 1,
            maximum: 1440,
            default: 30,
            description: "Only consider tasks older than this (based on created_at or status.json mtime). Default 30 minutes.",
          },
          include_done_candidates: {
            type: "boolean",
            default: true,
            description: "Include done_by_agent tasks as candidates (useful for auditing acceptance_status). Default true.",
          },
        },
      },
    },
    {
      name: "discover_tools",
      description:
        "v0.7.1: Search candidate tools by natural-language query (Chinese or English). Returns compressed summaries with risk level and schema digest. Filters by profile/mode/riskCeiling. High-risk tools (command/release/credential_sensitive) are hidden by default unless includeHighRisk=true. Read-only — never invokes tools.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language search query. Supports Chinese intent terms (验收/改文件/发布/状态/差异/卡住/旧任务/搜索/工具/诊断 etc.) and English keywords.",
          },
          profile: {
            type: "string",
            enum: ["full", "chatgpt_core", "chatgpt_direct", "chatgpt_search"],
            description: "Filter tools by profile. Default: no filter (all profiles).",
          },
          mode: {
            type: "string",
            enum: ["delegate", "direct", "audit", "release", "diagnostic"],
            description: "Filter tools by mode. Default: no filter.",
          },
          maxResults: {
            type: "number",
            minimum: 1,
            maximum: 50,
            default: 8,
            description: "Maximum number of results. Default 8.",
          },
          riskCeiling: {
            type: "string",
            enum: ["readonly", "workspace_read_sensitive", "workspace_write", "command", "release", "credential_sensitive"],
            description: "Maximum risk level to include. Tools above this level are hidden. Overrides includeHighRisk.",
          },
          includeHighRisk: {
            type: "boolean",
            default: false,
            description: "When true, include high-risk tools (command/release/credential_sensitive) in results. Default false.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "explain_tool",
      description:
        "v0.7.1: Expand a single tool's metadata — title, summary, risk level, tags, aliases, profiles, modes, schema digest, and optionally the full inputSchema. Use after discover_tools to understand a specific tool before calling it. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Tool name or alias to explain. Accepts both the canonical name (e.g. 'create_task') and aliases (e.g. 'new_task').",
          },
          includeSchema: {
            type: "boolean",
            default: false,
            description: "When true, include the full inputSchema in the response. Default false to keep output minimal.",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "invoke_discovered_tool",
      description:
        "v0.8.1: Invoke a previously discovered tool using a discoveryToken. The token must be obtained from discover_tools first. Enforces 10 security checks: token validity, toolName match, profile allowance, risk ceiling, sensitive path guard, assessment requirement, command whitelist, release confirmation, credential block, and invocation logging. Cannot call itself recursively.",
      inputSchema: {
        type: "object",
        properties: {
          toolName: { type: "string", description: "Name of the tool to invoke (must match the discoveryToken's toolName)." },
          arguments: {
            type: "object",
            description: "Arguments to pass to the tool. Must match the tool's inputSchema.",
            additionalProperties: true,
          },
          discoveryToken: { type: "string", description: "Token id from discover_tools. Single-use, expires after 10 minutes." },
          assessmentId: { type: "string", description: "Required for workspace_write/release risk tools. Obtained from the assessment flow." },
        },
        required: ["toolName", "arguments", "discoveryToken"],
      },
    },
    {
      name: "create_goal",
      description:
        "v0.8.0: Create a Goal Session for managing a multi-task objective with subgoal dependencies. Generates a structured directory under .patchwarden/goals/{goal_id}/ with GOAL.md, GOALS.md, and goal_status.json. Use list_goals to enumerate existing goals and read_goal to inspect details.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Goal title (human-readable)." },
          goal_description: { type: "string", description: "Markdown description of the goal, success criteria, and context." },
          repo_path: { type: "string", description: "Repository path inside workspaceRoot. Must be inside the configured workspace." },
        },
        required: ["title", "goal_description", "repo_path"],
      },
    },
    {
      name: "list_goals",
      description:
        "v0.8.0: List all Goal Sessions with completion summaries. Returns goal_id, title, status, subgoal counts, and last update time. Sorted by updated_at descending.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "read_goal",
      description:
        "v0.8.0: Read full Goal Session details including GOAL.md content, goal_status.json, and all subgoals with dependency info. Use after list_goals to inspect a specific goal.",
      inputSchema: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "Goal ID from list_goals or create_goal." },
        },
        required: ["goal_id"],
      },
    },
    {
      name: "create_subgoal_task",
      description:
        "v0.8.0: Create a subgoal within a Goal Session and immediately launch an associated task. Atomically: addSubgoal → create_task → linkTask → mark subgoal running. The subgoal depends_on other subgoals (by id) which must be accepted before suggest_next_subgoal returns it.",
      inputSchema: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "Goal ID to add the subgoal to." },
          subgoal_title: { type: "string", description: "Title of the new subgoal." },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description: "Subgoal IDs this subgoal depends on. Dependencies must be accepted before this subgoal is suggested.",
          },
          plan_id: { type: "string", description: "Plan ID from save_plan. One of plan_id/inline_plan/template+goal is required." },
          inline_plan: { type: "string", description: "Inline Markdown plan." },
          plan_title: { type: "string", description: "Optional title for inline_plan." },
          template: {
            type: "string",
            enum: [...TASK_TEMPLATE_NAMES],
            description: "Built-in task template. Use with goal.",
          },
          goal: { type: "string", description: "Task goal when template is supplied." },
          agent: { type: "string", description: "Agent name." },
          repo_path: { type: "string", description: "Repository path inside workspaceRoot." },
          test_command: { type: "string", description: "Verification command." },
          verify_commands: {
            type: "array",
            maxItems: 20,
            items: { type: "string" },
            description: "Additional verification commands.",
          },
          timeout_seconds: { type: "integer", minimum: 1, description: "Task timeout in seconds." },
          scope: { type: "array", items: { type: "string" }, description: "Allowed file/directory scope." },
          forbidden: { type: "array", items: { type: "string" }, description: "Forbidden file/directory paths." },
          verification: { type: "array", items: { type: "string" }, description: "Acceptance verification commands." },
          done_evidence: { type: "array", items: { type: "string" }, description: "Required done evidence files." },
          isolate_worktree: { type: "boolean", default: true, description: "v1.0.0: If true (default), create the task in an isolated git worktree under _workspacetrees/. Set false to run in the main workspace (v0.8.0 behavior)." },
        },
        required: ["goal_id", "subgoal_title", "repo_path"],
      },
    },
    {
      name: "accept_subgoal",
      description:
        "v0.8.0: Accept a subgoal after all its associated tasks are accepted (via audit_task). Validates every task in subgoal.task_ids has status 'accepted'. Throws subgoal_not_ready if any task is not yet accepted.",
      inputSchema: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "Goal ID." },
          subgoal_id: { type: "string", description: "Subgoal ID to accept." },
        },
        required: ["goal_id", "subgoal_id"],
      },
    },
    {
      name: "reject_subgoal",
      description:
        "v0.8.0: Reject a subgoal with a reason. Allowed from any non-terminal status (ready/running/done_by_agent/needs_fix). Records rejected_reason in goal_status.json.",
      inputSchema: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "Goal ID." },
          subgoal_id: { type: "string", description: "Subgoal ID to reject." },
          reason: { type: "string", description: "Rejection reason (required)." },
        },
        required: ["goal_id", "subgoal_id", "reason"],
      },
    },
    {
      name: "suggest_next_subgoal",
      description:
        "v0.8.0: Suggest the next executable subgoal based on the dependency graph. Returns a ready subgoal whose dependencies are all accepted. If none ready, returns blocked_by list. Use to drive goal-directed task sequencing.",
      inputSchema: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "Goal ID." },
        },
        required: ["goal_id"],
      },
    },
    {
      name: "summarize_goal_progress",
      description:
        "v0.8.0: Summarize goal completion: counts by status (accepted/rejected/running/ready/needs_fix/done_by_agent), completion_rate percentage, blocked_subgoals, and risks (needs_fix or running subgoals).",
      inputSchema: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "Goal ID." },
        },
        required: ["goal_id"],
      },
    },
    {
      name: "export_handoff",
      description:
        "v0.8.0: Export a handoff.md document for transferring a Goal Session to a new conversation. Includes current goal, completed/pending subgoals, recent diff/test results, blockers, next steps, and risks. Writes to .patchwarden/goals/{goal_id}/handoff.md.",
      inputSchema: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "Goal ID." },
        },
        required: ["goal_id"],
      },
    },
    {
      name: "check_release_gate",
      description:
        "v1.0.0: Verify release readiness across five sequential stages: local_ready → packed_ready → published_verified → github_release_verified → ci_verified. Remote stages (published/github/ci) query npm registry and GitHub API via node:https read-only GET; network errors return 'not_checked' (not 'failed'). Never claims release complete before published_verified passes. Does not execute shell commands for remote queries.",
      inputSchema: {
        type: "object",
        properties: {
          repo_path: { type: "string", description: "Repository path inside workspaceRoot." },
          target_stage: {
            type: "string",
            enum: ["local_ready", "packed_ready", "published_verified", "github_release_verified", "ci_verified"],
            description: "Target stage to verify. Stages before target are checked; stages after a failure are 'not_checked'.",
          },
          package_name: { type: "string", description: "npm package name for published_verified (e.g. 'patchwarden'). Required for published_verified stage." },
          version: { type: "string", description: "Version string for published_verified (e.g. '1.0.0'). Required for published_verified stage." },
          github_repo: { type: "string", description: "GitHub repo in 'owner/repo' form for github_release_verified and ci_verified." },
          branch: { type: "string", description: "Git branch for ci_verified (e.g. 'main')." },
        },
        required: ["repo_path", "target_stage"],
      },
    },
    {
      name: "merge_worktree",
      description:
        "v1.0.0: Merge an isolated git worktree's changes back into the main workspace. Use after a subgoal task (created with isolate_worktree=true) is accepted. Updates worktree_status.json to status='merged'. Merge failures do NOT delete the worktree (preserved for manual inspection).",
      inputSchema: {
        type: "object",
        properties: {
          worktree_id: { type: "string", description: "Worktree ID (wt_...) from create_subgoal_task." },
          repo_path: { type: "string", description: "Main workspace repository path inside workspaceRoot." },
        },
        required: ["worktree_id", "repo_path"],
      },
    },
    {
      name: "discard_worktree",
      description:
        "v1.0.0: Discard an isolated git worktree safely. Removes the worktree (git worktree remove --force), deletes its branch, and archives status as 'discarded'. Use when a subgoal is rejected or abandoned. All paths pass guardWorkspacePath + sensitiveGuard.",
      inputSchema: {
        type: "object",
        properties: {
          worktree_id: { type: "string", description: "Worktree ID (wt_...) to discard." },
          repo_path: { type: "string", description: "Main workspace repository path inside workspaceRoot." },
        },
        required: ["worktree_id", "repo_path"],
      },
    },
  ];

  // Direct session tools
  const directCommands = getAllConfiguredDirectCommands(config);
  tools.push({
    name: "create_direct_session",
    description:
      "Create a Direct editing session for ChatGPT to apply patches directly. Requires enableDirectProfile: true in config.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: {
          type: "string",
          description: "Repository path inside workspaceRoot (e.g., 'my-project')",
        },
        title: {
          type: "string",
          description: "Optional title describing the session's purpose",
        },
      },
      required: ["repo_path"],
    },
  });

  tools.push({
    name: "search_workspace",
    description:
      "Search file contents (grep-like) within a Direct session's repo_path. Skips .git, node_modules, dist, release, and sensitive files.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID from create_direct_session" },
        query: { type: "string", description: "Search query string" },
        max_results: { type: "number", description: "Max results (default 20)" },
        case_sensitive: { type: "boolean", description: "Case sensitive search (default false)" },
        max_preview_chars: { type: "number", description: "Max preview chars per match (default 200)" },
        include_globs: {
          type: "array",
          items: { type: "string" },
          description: "Optional file name glob patterns to include (e.g., ['*.ts', '*.js'])",
        },
      },
      required: ["session_id", "query"],
    },
  });

  tools.push({
    name: "apply_patch",
    description:
      "Apply JSON patch operations to a file within a Direct session's repo_path. Validates expected_sha256 before applying. Supports replace_exact, insert_before, insert_after, replace_whole_file.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID" },
        path: { type: "string", description: "Relative file path within the session repo" },
        expected_sha256: { type: "string", description: "Expected SHA-256 hash of the current file content" },
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["replace_exact", "insert_before", "insert_after", "replace_whole_file"] },
              old_text: { type: "string", description: "Text to find (required for replace_exact, insert_before, insert_after)" },
              new_text: { type: "string", description: "Replacement or insertion text" },
              occurrence: { type: "string", enum: ["first", "all", "exactly_once"], description: "Match mode for replace_exact (default first)" },
            },
            required: ["type", "new_text"],
          },
        },
      },
      required: ["session_id", "path", "expected_sha256", "operations"],
    },
  });

  tools.push({
    name: "run_verification",
    description:
      "Run a whitelisted verification command within a Direct session. Command must be in the Direct allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID" },
        command: {
          type: "string",
          description: "Verification command to run",
          ...(directCommands.length > 0 ? { enum: directCommands } : {}),
        },
        timeout_seconds: { type: "number", description: "Timeout in seconds (default 120)" },
      },
      required: ["session_id", "command"],
    },
  });

  tools.push({
    name: "finalize_direct_session",
    description:
      "Finalize a Direct session: capture after snapshot, generate diff/summary/change artifacts, mark session as finalized. Must be called before audit_session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID to finalize" },
      },
      required: ["session_id"],
    },
  });

  tools.push({
    name: "audit_session",
    description:
      "Independently audit a Direct session's changes. Performs 16 deterministic checks and returns pass/warn/fail decision. Requires session to be finalized first.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID to audit" },
      },
      required: ["session_id"],
    },
  });

  tools.push({
    name: "safe_direct_summary",
    description:
      "Return a low-noise Direct session summary without diff content or verification stdout/stderr tails.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Direct session ID" },
        max_items: { type: "integer", minimum: 1, maximum: 50, default: 8, description: "Maximum list entries to return per evidence group." },
      },
      required: ["session_id"],
    },
  });

  tools.push({
    name: "safe_finalize_direct_session",
    description:
      "Finalize a Direct session and return only bounded structured evidence, omitting diff and verification log content.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Direct session ID to finalize" },
        max_items: { type: "integer", minimum: 1, maximum: 50, default: 8, description: "Maximum list entries to return per evidence group." },
      },
      required: ["session_id"],
    },
  });

  tools.push({
    name: "safe_audit_direct_session",
    description:
      "Audit a Direct session and return only bounded structured evidence without verification stdout/stderr tails.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Direct session ID to audit" },
        max_items: { type: "integer", minimum: 1, maximum: 50, default: 8, description: "Maximum list entries to return per evidence group." },
      },
      required: ["session_id"],
    },
  });
  tools.push({
    name: "sync_file",
    description:
      "Copy a file from source to target within the same Direct session repo. Both paths must be inside the session repo_path. Returns before/after sha256 hashes and whether the target changed.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Direct session ID" },
        source_path: { type: "string", description: "Relative path to source file within repo" },
        target_path: { type: "string", description: "Relative path to target file within repo" },
        expected_source_sha256: { type: "string", description: "Optional: expected sha256 of source file" },
        expected_target_sha256: { type: "string", description: "Optional: expected sha256 of target file before copy" },
      },
      required: ["session_id", "source_path", "target_path"],
    },
  });

  // run_task: only available when explicitly enabled
  if ((config as any).enableRunTaskTool === true) {
    tools.push({
      name: "run_task",
      description:
        "Manually trigger execution of a pending task. WARNING: requires enableRunTaskTool=true in config. Prefer using the local watcher instead.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to execute" },
        },
        required: ["task_id"],
      },
    });
  }

  const profile = resolveToolProfile(config.toolProfile);
  const selected = selectToolsForProfile(tools, profile, config.enableDirectProfile);
  buildToolCatalogSnapshot(selected, profile);
  return selected;
}

export function getToolCatalogSnapshot(): ToolCatalogSnapshot {
  const tools = getToolDefs();
  const config = getConfig();
  return buildToolCatalogSnapshot(tools, resolveToolProfile(config.toolProfile));
}

// ── Request handler ───────────────────────────────────────────────

function guardDirectProfileEnabled(): void {
  const config = getConfig();
  if (!config.enableDirectProfile) {
    throw new PatchWardenError(
      "direct_profile_disabled",
      "Direct profile is disabled by local config.",
      "Set enableDirectProfile: true in patchwarden.config.json to use Direct session tools.",
      true,
      { operation: "direct_tool_call" }
    );
  }
}

export async function handleToolCall(name: string, args: Record<string, unknown> | undefined) {
  const startTime = Date.now();
  const taskId = args?.task_id ? String(args.task_id) : args?.session_id ? String(args.session_id) : undefined;
  try {
    const result = await handleToolCallInternal(name, args);
    logger.audit(name, true, Date.now() - startTime, undefined, taskId);
    return result;
  } catch (err) {
    const errorReason = err instanceof Error ? err.message : String(err);
    logger.audit(name, false, Date.now() - startTime, errorReason, taskId);
    throw err;
  }
}

async function handleToolCallInternal(name: string, args: Record<string, unknown> | undefined) {
  switch (name) {
    case "save_plan": {
      return toResult(
        savePlan({
          title: String(args?.title ?? ""),
          content: args?.content !== undefined ? String(args.content) : "",
          plan_ref: args?.plan_ref ? String(args.plan_ref) : undefined,
        })
      );
    }

    case "get_plan": {
      return toResult(
        getPlan({ plan_id: String(args?.plan_id ?? "") })
      );
    }

    case "create_task": {
      return toResult(
        createTask({
          plan_id: args?.plan_id ? String(args.plan_id) : undefined,
          inline_plan: args?.inline_plan ? String(args.inline_plan) : undefined,
          plan_title: args?.plan_title ? String(args.plan_title) : undefined,
          template: args?.template ? String(args.template) as any : undefined,
          goal: args?.goal ? String(args.goal) : undefined,
          source_task_id: args?.source_task_id ? String(args.source_task_id) : undefined,
          agent: String(args?.agent ?? ""),
          repo_path: args?.repo_path ? String(args.repo_path) : undefined,
          test_command: args?.test_command ? String(args.test_command) : undefined,
          verify_commands: Array.isArray(args?.verify_commands)
            ? args.verify_commands.map((command) => String(command))
            : undefined,
          timeout_seconds: args?.timeout_seconds !== undefined
            ? Number(args.timeout_seconds)
            : undefined,
          execution_mode: args?.execution_mode === "assess_only" ? "assess_only" : "execute",
          assessment_id: args?.assessment_id ? String(args.assessment_id) : undefined,
        })
      );
    }

    case "get_task_status": {
      return toResult(getTaskStatus(String(args?.task_id ?? "")));
    }

    case "get_result": {
      return toResult(getResult(String(args?.task_id ?? "")));
    }

    case "get_result_json": {
      return toResult(getResultJson(String(args?.task_id ?? "")));
    }

    case "get_diff": {
      return toResult(getDiff(String(args?.task_id ?? "")));
    }

    case "get_test_log": {
      return toResult(getTestLog(String(args?.task_id ?? "")));
    }

    case "list_workspace": {
      return toResult(
        listWorkspace(args?.path ? String(args.path) : undefined)
      );
    }

    case "read_workspace_file": {
      const sessionId = args?.session_id ? String(args.session_id) : undefined;
      return toResult(readWorkspaceFile({
        path: String(args?.path ?? ""),
        session_id: sessionId,
      }));
    }

    case "list_tasks": {
      return toResult(listTasks({
        status: args?.status ? String(args.status) : undefined,
        repo_path: args?.repo_path ? String(args.repo_path) : undefined,
        active_only: args?.active_only !== undefined ? Boolean(args.active_only) : undefined,
        limit: args?.limit ? Number(args.limit) : undefined,
      }));
    }

    case "list_agents": {
      return toResult(listAgents());
    }

    case "health_check": {
      return toResult(healthCheck(getToolCatalogSnapshot(), {
        detail: args?.detail === "self_diagnostic" ? "self_diagnostic" : "standard",
      }));
    }

    case "cancel_task": {
      return toResult(cancelTask(String(args?.task_id ?? "")));
    }

    case "kill_task": {
      return toResult(killTask(String(args?.task_id ?? "")));
    }

    case "retry_task": {
      return toResult(retryTask(String(args?.task_id ?? "")));
    }

    case "get_task_stdout_tail": {
      return toResult(getTaskStdoutTail(
        String(args?.task_id ?? ""),
        args?.lines ? Number(args.lines) : undefined
      ));
    }

    case "get_task_log_tail": {
      return toResult(getTaskLogTail(
        String(args?.task_id ?? ""),
        (args?.file as "stdout" | "stderr" | "test" | "verify") || "stdout",
        {
          lines: args?.lines ? Number(args.lines) : undefined,
          redact: args?.redact !== undefined ? Boolean(args.redact) : undefined,
        }
      ));
    }

    case "get_task_progress": {
      return toResult(getTaskProgress(String(args?.task_id ?? "")));
    }

    case "wait_for_task": {
      const waitSeconds = normalizeWaitSeconds(args);
      return toResult(await waitForTask(
        String(args?.task_id ?? ""),
        waitSeconds
      ));
    }

    case "get_task_summary": {
      return toResult(getTaskSummary(String(args?.task_id ?? ""), {
        view: normalizeSummaryView(args?.view),
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }));
    }

    case "audit_task": {
      return toResult(auditTask(String(args?.task_id ?? "")));
    }

    case "safe_status": {
      return toResult(safeStatus(String(args?.task_id ?? "")));
    }

    case "safe_result": {
      return toResult(safeResult(String(args?.task_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }));
    }

    case "safe_audit": {
      return toResult(safeAudit(String(args?.task_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }));
    }

    case "safe_test_summary": {
      return toResult(safeTestSummary(String(args?.task_id ?? "")));
    }

    case "safe_diff_summary": {
      return toResult(safeDiffSummary(String(args?.task_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }));
    }
    case "diagnose_task": {
      return toResult(diagnoseTask({
        task_id: String(args?.task_id ?? ""),
        include_logs: args?.include_logs !== undefined ? Boolean(args.include_logs) : undefined,
      }));
    }

    case "reconcile_tasks": {
      return toResult(reconcileTasks({
        mode: args?.mode === "safe_fix" ? "safe_fix" : "report_only",
        max_age_minutes: args?.max_age_minutes !== undefined ? Number(args.max_age_minutes) : undefined,
        include_done_candidates: args?.include_done_candidates !== undefined ? Boolean(args.include_done_candidates) : undefined,
      }));
    }

    case "discover_tools": {
      const profile = args?.profile === "full" || args?.profile === "chatgpt_core" || args?.profile === "chatgpt_direct" || args?.profile === "chatgpt_search"
        ? args.profile : undefined;
      const mode = args?.mode === "delegate" || args?.mode === "direct" || args?.mode === "audit" || args?.mode === "release" || args?.mode === "diagnostic"
        ? args.mode : undefined;
      const riskCeiling = ["readonly", "workspace_read_sensitive", "workspace_write", "command", "release", "credential_sensitive"]
        .includes(String(args?.riskCeiling ?? "")) ? String(args?.riskCeiling) as any : undefined;
      return toResult(discoverTools({
        query: String(args?.query ?? ""),
        profile,
        mode,
        maxResults: args?.maxResults !== undefined ? Number(args.maxResults) : undefined,
        riskCeiling,
        includeHighRisk: args?.includeHighRisk !== undefined ? Boolean(args.includeHighRisk) : undefined,
      }, getToolDefs()));
    }

    case "explain_tool": {
      return toResult(explainTool({
        name: String(args?.name ?? ""),
        includeSchema: args?.includeSchema !== undefined ? Boolean(args.includeSchema) : undefined,
      }, getToolDefs()));
    }

    case "invoke_discovered_tool": {
      const profile = resolveToolProfile(getConfig().toolProfile);
      const result = await invokeDiscoveredTool({
        toolName: String(args?.toolName ?? ""),
        arguments: (args?.arguments && typeof args.arguments === "object" ? args.arguments : {}) as Record<string, unknown>,
        discoveryToken: String(args?.discoveryToken ?? ""),
        assessmentId: args?.assessmentId ? String(args.assessmentId) : undefined,
      }, {
        tools: getToolDefs(),
        profile,
        dispatch: async (name, dispatchArgs) => {
          return handleToolCall(name, dispatchArgs);
        },
      });
      return toResult(result);
    }

    case "run_task": {
      const config = getConfig();
      if ((config as any).enableRunTaskTool !== true) {
        throw new Error(
          "run_task is disabled. Set enableRunTaskTool: true in config to enable. Prefer using the local watcher (npm run watch)."
        );
      }
      const taskId = String(args?.task_id ?? "");
      const result = await runTask(taskId);
      return toResult(result);
    }

    case "create_direct_session": {
      guardDirectProfileEnabled();
      return toResult(createDirectSession({
        repo_path: String(args?.repo_path ?? ""),
        title: args?.title ? String(args.title) : undefined,
      }));
    }

    case "search_workspace": {
      guardDirectProfileEnabled();
      return toResult(searchWorkspace({
        session_id: String(args?.session_id ?? ""),
        query: String(args?.query ?? ""),
        max_results: args?.max_results ? Number(args.max_results) : undefined,
        case_sensitive: args?.case_sensitive !== undefined ? Boolean(args.case_sensitive) : undefined,
        max_preview_chars: args?.max_preview_chars ? Number(args.max_preview_chars) : undefined,
        include_globs: Array.isArray(args?.include_globs) ? args.include_globs.map(String) : undefined,
      }));
    }

    case "apply_patch": {
      guardDirectProfileEnabled();
      return toResult(applyPatch({
        session_id: String(args?.session_id ?? ""),
        path: String(args?.path ?? ""),
        expected_sha256: String(args?.expected_sha256 ?? ""),
        operations: Array.isArray(args?.operations) ? args.operations as any : [],
      }));
    }

    case "run_verification": {
      guardDirectProfileEnabled();
      return toResult(await runVerification({
        session_id: String(args?.session_id ?? ""),
        command: String(args?.command ?? ""),
        timeout_seconds: args?.timeout_seconds ? Number(args.timeout_seconds) : undefined,
      }));
    }

    case "finalize_direct_session": {
      guardDirectProfileEnabled();
      return toResult(finalizeDirectSession({
        session_id: String(args?.session_id ?? ""),
      }));
    }

    case "audit_session": {
      guardDirectProfileEnabled();
      return toResult(auditSession({
        session_id: String(args?.session_id ?? ""),
      }));
    }

    case "safe_direct_summary": {
      guardDirectProfileEnabled();
      return toResult(safeDirectSummary(String(args?.session_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }));
    }

    case "safe_finalize_direct_session": {
      guardDirectProfileEnabled();
      return toResult(safeFinalizeDirectSession(String(args?.session_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }));
    }

    case "safe_audit_direct_session": {
      guardDirectProfileEnabled();
      return toResult(safeAuditDirectSession(String(args?.session_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }));
    }
    case "sync_file": {
      guardDirectProfileEnabled();
      return toResult(syncFile(
        String(args?.session_id ?? ""),
        String(args?.source_path ?? ""),
        String(args?.target_path ?? ""),
        {
          expected_source_sha256: args?.expected_source_sha256 ? String(args.expected_source_sha256) : undefined,
          expected_target_sha256: args?.expected_target_sha256 ? String(args.expected_target_sha256) : undefined,
        }
      ));
    }

    case "create_goal": {
      return toResult(createGoal(
        String(args?.repo_path ?? ""),
        String(args?.title ?? ""),
        String(args?.goal_description ?? "")
      ));
    }

    case "list_goals": {
      return toResult({ goals: listGoals() });
    }

    case "read_goal": {
      return toResult(readGoal(String(args?.goal_id ?? "")));
    }

    case "create_subgoal_task": {
      return toResult(createSubgoalTask({
        goal_id: String(args?.goal_id ?? ""),
        subgoal_title: String(args?.subgoal_title ?? ""),
        depends_on: Array.isArray(args?.depends_on) ? args.depends_on.map(String) : undefined,
        plan_id: args?.plan_id ? String(args.plan_id) : undefined,
        inline_plan: args?.inline_plan ? String(args.inline_plan) : undefined,
        plan_title: args?.plan_title ? String(args.plan_title) : undefined,
        template: args?.template ? String(args.template) as any : undefined,
        goal: args?.goal ? String(args.goal) : undefined,
        agent: args?.agent ? String(args.agent) : undefined,
        repo_path: String(args?.repo_path ?? ""),
        test_command: args?.test_command ? String(args.test_command) : undefined,
        verify_commands: Array.isArray(args?.verify_commands) ? args.verify_commands.map(String) : undefined,
        timeout_seconds: args?.timeout_seconds ? Number(args.timeout_seconds) : undefined,
        scope: Array.isArray(args?.scope) ? args.scope.map(String) : undefined,
        forbidden: Array.isArray(args?.forbidden) ? args.forbidden.map(String) : undefined,
        verification: Array.isArray(args?.verification) ? args.verification.map(String) : undefined,
        done_evidence: Array.isArray(args?.done_evidence) ? args.done_evidence.map(String) : undefined,
        isolate_worktree: args?.isolate_worktree === undefined ? undefined : Boolean(args.isolate_worktree),
      }));
    }

    case "accept_subgoal": {
      return toResult(acceptSubgoal(
        String(args?.goal_id ?? ""),
        String(args?.subgoal_id ?? "")
      ));
    }

    case "reject_subgoal": {
      return toResult(rejectSubgoal(
        String(args?.goal_id ?? ""),
        String(args?.subgoal_id ?? ""),
        String(args?.reason ?? "")
      ));
    }

    case "suggest_next_subgoal": {
      const goalStatus = readGoalStatus(String(args?.goal_id ?? ""));
      return toResult(suggestNextSubgoal(goalStatus));
    }

    case "summarize_goal_progress": {
      return toResult(summarizeGoalProgress(String(args?.goal_id ?? "")));
    }

    case "export_handoff": {
      const goalId = String(args?.goal_id ?? "");
      const goalStatus = readGoalStatus(goalId);
      return toResult(exportHandoff(goalId, goalStatus));
    }

    case "check_release_gate": {
      return toResult(await checkReleaseGate({
        repo_path: String(args?.repo_path ?? ""),
        target_stage: String(args?.target_stage ?? "local_ready") as any,
        package_name: args?.package_name ? String(args.package_name) : undefined,
        version: args?.version ? String(args.version) : undefined,
        github_repo: args?.github_repo ? String(args.github_repo) : undefined,
        branch: args?.branch ? String(args.branch) : undefined,
      }));
    }

    case "merge_worktree": {
      return toResult(mergeWorktreeTool({
        worktree_id: String(args?.worktree_id ?? ""),
        repo_path: String(args?.repo_path ?? ""),
      }));
    }

    case "discard_worktree": {
      return toResult(discardWorktreeTool({
        worktree_id: String(args?.worktree_id ?? ""),
        repo_path: String(args?.repo_path ?? ""),
      }));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function normalizeWaitSeconds(args: Record<string, unknown> | undefined): number | undefined {
  const legacy = args?.wait_seconds;
  const preferred = args?.timeout_seconds;
  if (legacy !== undefined && preferred !== undefined && Number(legacy) !== Number(preferred)) {
    throw new Error("wait_seconds and timeout_seconds must match when both are supplied.");
  }
  const value = preferred ?? legacy;
  return value === undefined ? undefined : Number(value);
}

function normalizeSummaryView(value: unknown): "compact" | "standard" {
  if (value === undefined) return "standard";
  if (value !== "compact" && value !== "standard") {
    throw new Error('view must be "compact" or "standard".');
  }
  return value;
}

function toResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// ── Register on MCP Server ────────────────────────────────────────

export function registerTools(server: Server) {
  // Compute the active tool list ONCE to guarantee list/call consistency.
  // Re-calling getToolDefs() on every request risks divergence between
  // tools/list and tools/call when the profile is reconfigured at runtime.
  const activeTools = getToolDefs();
  const activeNames = new Set(activeTools.map((tool) => tool.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const catalog = getLastToolCatalogSnapshot();
    return {
      tools: activeTools,
      ...(catalog
        ? {
            _meta: {
              server_version: catalog.server_version,
              schema_epoch: catalog.schema_epoch,
              tool_profile: catalog.tool_profile,
              tool_count: catalog.tool_count,
              tool_manifest_sha256: catalog.tool_manifest_sha256,
            },
          }
        : {}),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (!activeNames.has(name)) {
        const catalog = getToolCatalogSnapshot();
        throw new PatchWardenError(
          "tool_catalog_mismatch",
          `Tool "${name}" is not available in the active ${catalog.tool_profile} profile. The client may be using a stale tool catalog.`,
          "Refresh or reconnect the ChatGPT Connector and open a new conversation before retrying.",
          true,
          {
            requested_tool: name,
            refresh_required: true,
            server_version: catalog.server_version,
            schema_epoch: catalog.schema_epoch,
            tool_profile: catalog.tool_profile,
            tool_count: catalog.tool_count,
            tool_names: catalog.tool_names,
            tool_manifest_sha256: catalog.tool_manifest_sha256,
            next_tool_call: {
              name: "health_check",
              arguments: { detail: "self_diagnostic" },
            },
            connector_refresh_steps: [
              "1. Run PatchWarden.cmd health locally to confirm the active profile and manifest hash.",
              "2. In ChatGPT Platform, refresh or reconnect the Connector (do not reuse an old session).",
              "3. Open a NEW ChatGPT conversation; old conversations retain their cached tool catalog.",
              "4. Call health_check in the new conversation and verify tool_manifest_sha256 matches the local report.",
            ],
          }
        );
      }
      return await handleToolCall(name, args);
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(errorPayload(err)) }],
        isError: true,
      };
    }
  });
}
