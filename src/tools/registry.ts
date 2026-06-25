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
import { logger } from "../logging.js";
import { runTask } from "../runner/runTask.js";
import { createDirectSession } from "../tools/createDirectSession.js";
import { searchWorkspace } from "../tools/searchWorkspace.js";
import { applyPatch } from "../tools/applyPatch.js";
import { runVerification } from "../tools/runVerification.js";
import { finalizeDirectSession } from "../tools/finalizeDirectSession.js";
import { auditSession } from "../tools/auditSession.js";
import { syncFile } from "../tools/syncFile.js";
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
