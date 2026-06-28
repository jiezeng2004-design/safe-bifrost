import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getConfig, getTasksDir, getDirectSessionsDir, resolveWorkspaceRoot } from "../config.js";
import { listAgents } from "./listAgents.js";
import { redactSensitiveContent, redactSensitiveValue } from "../security/contentRedaction.js";
import { PATCHWARDEN_VERSION, TOOL_SCHEMA_EPOCH } from "../version.js";
import type { ToolCatalogSnapshot } from "./toolCatalog.js";
import { CHATGPT_CORE_TOOL_NAMES, CHATGPT_DIRECT_TOOL_NAMES, CHATGPT_SEARCH_TOOL_NAMES, resolveToolProfile } from "./toolCatalog.js";
import { readWatcherStatus } from "../watcherStatus.js";
import { listTasks } from "./listTasks.js";

const SERVER_STARTED_AT = Date.now();

export interface HealthCheckInput {
  detail?: "standard" | "self_diagnostic";
}

export function healthCheck(catalog?: ToolCatalogSnapshot, input: HealthCheckInput = {}) {
  const config = getConfig();
  const workspaceRoot = resolveWorkspaceRoot(config);
  const tasksDir = getTasksDir(config);
  const watcher = {
    ...readWatcherStatus(config),
    supervisor: readWatcherSupervisorStatus(),
  };

  const agents = listAgents();
  const workspace = directoryStatus(workspaceRoot, false);
  const tasks = directoryStatus(tasksDir, true, workspaceRoot);
  const tunnel = readTunnelStatus();

  // Profile consistency: verify catalog matches the active profile
  const profileErrors: string[] = [];
  let profileConsistent = true;
  if (catalog) {
    const activeProfile = resolveToolProfile(config.toolProfile);
    let expectedNames: string[] | null = null;
    if (activeProfile === "chatgpt_core") {
      expectedNames = [...CHATGPT_CORE_TOOL_NAMES];
    } else if (activeProfile === "chatgpt_direct" && config.enableDirectProfile) {
      expectedNames = [...CHATGPT_DIRECT_TOOL_NAMES];
    } else if (activeProfile === "chatgpt_direct" && !config.enableDirectProfile) {
      // Degraded mode: only health_check should be exposed
      expectedNames = ["health_check"];
      profileErrors.push("Direct profile is disabled (enableDirectProfile=false). Only health_check is available. Set enableDirectProfile: true to enable Direct session tools.");
      profileConsistent = false;
    } else if (activeProfile === "chatgpt_search") {
      expectedNames = [...CHATGPT_SEARCH_TOOL_NAMES];
    }
    if (expectedNames) {
      const catalogNames = new Set(catalog.tool_names);
      for (const name of expectedNames) {
        if (!catalogNames.has(name)) {
          profileErrors.push(`Expected tool "${name}" is missing from the active ${activeProfile} profile catalog.`);
          profileConsistent = false;
        }
      }
      if (catalog.tool_count !== expectedNames.length) {
        profileErrors.push(
          `Profile ${activeProfile} expects ${expectedNames.length} tools but catalog reports ${catalog.tool_count}. This can cause tools to appear in the list but fail when called.`
        );
        profileConsistent = false;
      }
    }
  } else {
    profileErrors.push("No tool catalog snapshot available; profile consistency cannot be verified.");
    profileConsistent = false;
  }

  const mismatchReport = [...profileErrors];
  let tunnelCatalogComparison = "unavailable";
  if (catalog && typeof tunnel.tool_profile === "string" && tunnel.tool_profile) {
    if (tunnel.tool_profile !== catalog.tool_profile) {
      tunnelCatalogComparison = "different_profile";
    } else if (typeof tunnel.tool_manifest_sha256 === "string" && tunnel.tool_manifest_sha256) {
      tunnelCatalogComparison = tunnel.tool_manifest_sha256 === catalog.tool_manifest_sha256 ? "match" : "mismatch";
      if (tunnelCatalogComparison === "mismatch") {
        mismatchReport.push("The active MCP catalog hash differs from the tunnel startup manifest. Restart the owned tunnel process.");
      }
    }
  }

  const agentReady = agents.agents.every((agent) => agent.available);
  const catalogConsistent = profileConsistent && mismatchReport.length === 0;
  const status = watcher.available && workspace.available && tasks.available && agentReady && catalogConsistent
    ? "healthy"
    : "degraded";

  const directSessionsDir = getDirectSessionsDir(config);
  const directSessions = directoryStatus(directSessionsDir, true, workspaceRoot);
  const activeProfile = resolveToolProfile(config.toolProfile);

  return {
    status,
    server_version: catalog?.server_version || PATCHWARDEN_VERSION,
    schema_epoch: catalog?.schema_epoch || TOOL_SCHEMA_EPOCH,
    tool_profile: catalog?.tool_profile || "unknown",
    tool_count: catalog?.tool_count ?? null,
    tool_names: catalog?.tool_names || [],
    tool_manifest_sha256: catalog?.tool_manifest_sha256 || null,
    profile_consistent: profileConsistent,
    profile_errors: profileErrors,
    catalog_consistent: catalogConsistent,
    mismatch_report: mismatchReport,
    tunnel_catalog_comparison: tunnelCatalogComparison,
    direct_profile_enabled: config.enableDirectProfile ?? false,
    direct_sessions_dir: directSessions,
    direct_session_ttl_seconds: config.directSessionTtlSeconds,
    ...(activeProfile === "chatgpt_direct" ? { direct_tool_count: config.enableDirectProfile ? CHATGPT_DIRECT_TOOL_NAMES.length : 1 } : {}),
    ...(activeProfile === "chatgpt_search" ? { search_tool_count: CHATGPT_SEARCH_TOOL_NAMES.length } : {}),
    connector_visibility: {
      status: "not_observable_server_side",
      verification: "Refresh or reconnect the Connector and verify tools/list from a new ChatGPT conversation.",
      refresh_steps: [
        "1. Run PatchWarden.cmd health to confirm the active profile, tool count, and catalog consistency.",
        "2. In ChatGPT Platform, refresh or reconnect the Connector (do not reuse an old session).",
        "3. Open a NEW ChatGPT conversation (old conversations retain their cached tool catalog).",
        "4. Call health_check in the new conversation; verify tool_manifest_sha256 matches the local report.",
      ],
    },
    mcp_server: {
      available: true,
      pid: process.pid,
      uptime_seconds: Math.round((Date.now() - SERVER_STARTED_AT) / 1000),
      checked_at: new Date().toISOString(),
    },
    path_encoding: checkPathEncoding(),
    watcher,
    workspace_root: workspace,
    tasks_dir: tasks,
    tunnel,
    agents: agents.agents,
    agent_status: Object.fromEntries(agents.agents.map((agent) => [agent.name, agent.available ? "ok" : "missing"])),
    ...(input.detail === "self_diagnostic" ? { self_diagnostic: buildSelfDiagnostic(config) } : {}),
    last_error: tunnel.last_error || (!watcher.available ? watcher.reason : null) || mismatchReport[0] || null,
  };
}

function buildSelfDiagnostic(config: ReturnType<typeof getConfig>) {
  const recent = listTasks({ limit: 20 });
  const failures = recent.tasks
    .filter((task) => task.status.startsWith("failed") || task.status === "canceled")
    .slice(0, 10)
    .map((task) => ({
      task_id: task.task_id,
      status: task.status,
      phase: task.phase,
      pending_reason: task.pending_reason,
      error: task.error,
    }));
  const diagnostic = {
    mode: "self_diagnostic",
    allowed_test_commands_count: config.allowedTestCommands.length,
    allowed_test_commands: [...config.allowedTestCommands],
    configured_agents: Object.keys(config.agents),
    recent_tasks_returned: recent.tasks.length,
    recent_failures: failures,
  };
  const safe = redactSensitiveValue(diagnostic);
  return {
    ...safe.value,
    redacted: safe.redacted,
    redaction_categories: safe.redaction_categories,
  };
}

function readWatcherSupervisorStatus(): Record<string, unknown> {
  const runtimeRoot = process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "patchwarden", "runtime")
    : join(homedir(), ".patchwarden", "runtime");
  const path = join(runtimeRoot, "watcher-status.json");
  if (!existsSync(path)) return { observed: false, managed: false };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
    return {
      observed: true,
      managed: Boolean(raw.managed),
      status: safeText(raw.status, 40) || "unknown",
      pid: Number.isInteger(Number(raw.pid)) ? Number(raw.pid) : null,
      instance_id: safeText(raw.instance_id, 100) || null,
      restart_attempts: Number.isInteger(Number(raw.restart_attempts)) ? Number(raw.restart_attempts) : 0,
      last_error: safeText(raw.last_error, 500) || null,
      checked_at: safeText(raw.checked_at, 80) || null,
    };
  } catch {
    return { observed: true, managed: false, status: "invalid_status_file" };
  }
}

function directoryStatus(path: string, allowCreatable: boolean, createRoot?: string) {
  if (!existsSync(path)) {
    if (allowCreatable) {
      const parent = createRoot || dirname(path);
      try {
        accessSync(parent, constants.R_OK | constants.W_OK);
        return { available: true, path, readable: false, writable: true, reason: "Directory will be created on first use." };
      } catch {}
    }
    return { available: false, path, readable: false, writable: false, reason: "Directory does not exist." };
  }
  let readable = false;
  let writable = false;
  try { accessSync(path, constants.R_OK); readable = true; } catch {}
  try { accessSync(path, constants.W_OK); writable = true; } catch {}
  return {
    available: readable && writable,
    path,
    readable,
    writable,
    reason: readable && writable ? null : "Directory is not readable and writable by the current process.",
  };
}

function readTunnelStatus(): Record<string, unknown> & { last_error: string | null } {
  const runtimeRoot = process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "patchwarden", "runtime")
    : join(homedir(), ".patchwarden", "runtime");
  const statusFile = join(runtimeRoot, "tunnel-status.json");
  if (!existsSync(statusFile)) {
    return { observed: false, status: "not_observed", last_error: null };
  }
  try {
    const text = readFileSync(statusFile, "utf-8");
    const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    const allowed = {
      observed: true,
      status: safeText(raw.status, 40) || "unknown",
      reason_code: safeText(raw.reason_code, 80) || null,
      ready: Boolean(raw.ready),
      attempt: Number.isFinite(Number(raw.attempt)) ? Number(raw.attempt) : null,
      pid: Number.isInteger(Number(raw.pid)) ? Number(raw.pid) : null,
      checked_at: safeText(raw.checked_at, 80) || null,
      next_retry_at: safeText(raw.next_retry_at, 80) || null,
      last_error: safeText(raw.last_error, 500) || null,
      server_version: safeText(raw.server_version, 40) || null,
      schema_epoch: safeText(raw.schema_epoch, 80) || null,
      tool_profile: safeText(raw.tool_profile, 40) || null,
      tool_count: Number.isInteger(Number(raw.tool_count)) ? Number(raw.tool_count) : null,
      tool_names: Array.isArray(raw.tool_names)
        ? raw.tool_names.filter((name: unknown) => typeof name === "string").slice(0, 100)
        : [],
      tool_manifest_sha256: safeText(raw.tool_manifest_sha256, 80) || null,
      core_tools_ready: Boolean(raw.core_tools_ready),
    };
    const redacted = redactSensitiveContent(JSON.stringify(allowed));
    return JSON.parse(redacted.content);
  } catch {
    return { observed: true, status: "invalid_status_file", last_error: "Tunnel status file is unreadable." };
  }
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").slice(0, maxLength) : "";
}

function checkPathEncoding(): { encoding: string; warnings: string[] } {
  const warnings: string[] = [];
  // Node.js always uses UTF-8 for fs operations, but on Windows the console
  // codepage can cause display issues. We check if the environment is likely
  // to cause problems with non-ASCII paths.
  if (process.platform === "win32") {
    // Check if the system locale uses a codepage that might not support UTF-8
    const lang = process.env.LANG || process.env.LC_ALL || "";
    const chcp = process.env.PATCHWARDEN_CHCP || "";
    if (chcp && !chcp.includes("65001") && !chcp.includes("utf")) {
      warnings.push(`Windows codepage "${chcp}" may cause display issues with non-ASCII paths. Consider setting codepage to 65001 (UTF-8).`);
    }
  }
  // Verify that Node.js fs operations use UTF-8 by default
  // This is always true in Node.js >= 18
  return {
    encoding: "utf-8",
    warnings,
  };
}
