/**
 * v0.7.1: 统一工具注册表 — SafeToolSearch 只读发现层的基础。
 *
 * 为每个 MCP 工具补全元数据：风险等级、模式、标签、别名、中文意图词。
 * schema digest 使用稳定字段顺序的 canonical JSON → sha256 计算，
 * 用于检测工具 schema 漂移、release check 校验、discover_tools 返回。
 */

import { createHash } from "node:crypto";
import type { ToolProfile } from "./toolCatalog.js";
import type { ToolDef } from "./registry.js";

// ── 风险分级 ──────────────────────────────────────────────────────

export type ToolRisk =
  | "readonly"
  | "workspace_read_sensitive"
  | "workspace_write"
  | "command"
  | "release"
  | "credential_sensitive";

export const TOOL_RISK_RANK: Record<ToolRisk, number> = {
  readonly: 0,
  workspace_read_sensitive: 1,
  workspace_write: 2,
  command: 3,
  release: 4,
  credential_sensitive: 5,
};

export type ToolMode = "delegate" | "direct" | "audit" | "release" | "diagnostic";

// ── 工具元数据 ────────────────────────────────────────────────────

export interface PatchWardenToolMeta {
  name: string;
  title: string;
  summary: string;
  description: string;
  profiles: ToolProfile[];
  modes: ToolMode[];
  tags: string[];
  aliases: string[];
  risk: ToolRisk;
  requiresConfirmation: boolean;
  /** sha256 of canonical-JSON(inputSchema)，用于检测 schema 漂移 */
  inputSchemaDigest: string;
  relatedTools?: string[];
  examples?: string[];
}

// ── 中文意图映射 ──────────────────────────────────────────────────

export const INTENT_TERMS: Record<string, string[]> = {
  "验收": ["status", "result", "diff", "test", "artifact", "audit", "verify", "verification"],
  "改文件": ["read_file", "sync_file", "apply_patch", "workspace_write", "patch", "write"],
  "发布": ["release", "manifest", "pack", "changelog", "tag", "publish"],
  "安卓": ["android", "gradle", "sdk", "diagnostic"],
  "状态": ["safe_status", "list_tasks", "task", "status", "health"],
  "差异": ["diff", "git", "changes", "patch"],
  "卡住": ["diagnose_task", "reconcile_tasks", "stale", "running", "heartbeat", "stuck"],
  "旧任务": ["diagnose_task", "reconcile_tasks", "orphaned", "stale", "old"],
  "搜索": ["search", "discover", "find", "list", "workspace"],
  "计划": ["plan", "save_plan", "create_task", "goal"],
  "等待": ["wait", "wait_for_task", "progress"],
  "取消": ["cancel", "kill", "stop", "terminate"],
  "重试": ["retry", "restart", "rerun"],
  "工具": ["tool", "discover", "explain", "registry", "search"],
  "诊断": ["diagnose", "health", "doctor", "diagnostic", "status"],
  "会话": ["session", "direct", "create_direct_session", "finalize"],
  "审计": ["audit", "audit_task", "audit_session", "verify"],
  "读取": ["read", "read_workspace_file", "get", "list"],
  "创建": ["create", "create_task", "create_direct_session", "save"],
  "查看": ["list", "get", "read", "status", "summary"],
  "清理": ["reconcile", "kill", "cancel", "cleanup"],
};

// ── 静态工具元数据（不含 schema digest，digest 动态计算） ─────────

interface StaticToolMeta {
  title: string;
  summary: string;
  profiles: ToolProfile[];
  modes: ToolMode[];
  tags: string[];
  aliases: string[];
  risk: ToolRisk;
  requiresConfirmation: boolean;
  relatedTools?: string[];
  examples?: string[];
}

const STATIC_TOOL_META: Record<string, StaticToolMeta> = {
  // ── readonly ──────────────────────────────────────────────────
  health_check: {
    title: "Health Check",
    summary: "检查 PatchWarden 服务健康状态、watcher、MCP 就绪情况",
    profiles: ["full", "chatgpt_core", "chatgpt_direct"],
    modes: ["diagnostic"],
    tags: ["health", "status", "diagnostic", "ready", "watcher"],
    aliases: ["health", "status", "ready", "ping"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["safe_status", "list_agents"],
  },
  list_agents: {
    title: "List Agents",
    summary: "列出已配置的本地 agent 及其可用性",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "diagnostic"],
    tags: ["agent", "list", "config", "codex", "opencode"],
    aliases: ["agents", "list_agent"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["health_check", "create_task"],
  },
  list_workspace: {
    title: "List Workspace",
    summary: "列出工作区内的文件和目录",
    profiles: ["full", "chatgpt_core", "chatgpt_direct"],
    modes: ["delegate", "direct"],
    tags: ["workspace", "list", "files", "directory"],
    aliases: ["ls", "files", "list_files"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["read_workspace_file", "search_workspace"],
  },
  list_tasks: {
    title: "List Tasks",
    summary: "列出任务列表，可按仓库过滤、只看活跃任务",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "diagnostic"],
    tags: ["task", "list", "status", "running", "pending"],
    aliases: ["tasks", "list_task"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_task_status", "safe_status", "get_task_summary"],
  },
  get_task_status: {
    title: "Get Task Status",
    summary: "获取任务当前状态（pending/running/done/failed 等）",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "diagnostic"],
    tags: ["task", "status", "state"],
    aliases: ["task_status", "status"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["safe_status", "list_tasks", "get_task_summary"],
  },
  get_diff: {
    title: "Get Diff",
    summary: "获取任务的 git diff 内容",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "audit"],
    tags: ["diff", "git", "changes", "patch"],
    aliases: ["diff", "git_diff"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_result", "get_test_log", "get_task_summary"],
  },
  get_result: {
    title: "Get Result",
    summary: "获取任务的 result.md 内容（自动脱敏）",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "audit"],
    tags: ["result", "output", "summary", "markdown"],
    aliases: ["result", "result_md"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_result_json", "get_diff", "get_test_log"],
  },
  get_result_json: {
    title: "Get Result JSON",
    summary: "获取任务的结构化 result.json 结果",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "audit"],
    tags: ["result", "json", "structured", "output"],
    aliases: ["result_json", "json_result"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_result", "get_diff"],
  },
  get_test_log: {
    title: "Get Test Log",
    summary: "获取任务的测试日志 test.log",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "audit"],
    tags: ["test", "log", "verify", "verification"],
    aliases: ["test_log", "log"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_result", "get_diff"],
  },
  get_task_log_tail: {
    title: "Get Task Log Tail",
    summary: "获取任务日志尾部内容",
    profiles: ["full"],
    modes: ["delegate", "diagnostic"],
    tags: ["log", "tail", "task", "output"],
    aliases: ["log_tail", "tail"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_task_stdout_tail", "get_test_log"],
  },
  get_task_progress: {
    title: "Get Task Progress",
    summary: "获取任务执行进度和阶段信息",
    profiles: ["full"],
    modes: ["delegate", "diagnostic"],
    tags: ["progress", "task", "phase", "status"],
    aliases: ["progress", "task_progress"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["wait_for_task", "get_task_status"],
  },
  get_task_summary: {
    title: "Get Task Summary",
    summary: "获取任务综合摘要（状态、差异、文件统计、日志尾部）",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "audit"],
    tags: ["summary", "task", "overview", "compact"],
    aliases: ["summary", "task_summary"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_result", "get_diff", "safe_status"],
  },
  safe_status: {
    title: "Safe Status",
    summary: "安全状态查询（不含 diff/log 内容，仅任务状态）",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "diagnostic"],
    tags: ["status", "safe", "task", "minimal", "health"],
    aliases: ["safe", "safe_status"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_task_status", "diagnose_task", "list_tasks"],
  },
  safe_result: {
    title: "Safe Result",
    summary: "安全任务结果摘要（不含完整日志、完整 diff 或长 markdown）",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "audit"],
    tags: ["safe", "result", "summary", "task", "redacted"],
    aliases: ["safe_result", "result_summary"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_result", "get_task_summary", "safe_status"],
  },
  safe_audit: {
    title: "Safe Audit",
    summary: "安全审计摘要（仅返回检查状态、计数和下一步建议）",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "audit"],
    tags: ["safe", "audit", "checks", "acceptance", "task"],
    aliases: ["safe_audit", "audit_summary"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["audit_task", "safe_result"],
  },
  safe_test_summary: {
    title: "Safe Test Summary",
    summary: "安全验证摘要（仅返回验证命令状态和计数）",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "audit"],
    tags: ["safe", "test", "verification", "summary"],
    aliases: ["safe_tests", "test_summary"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_test_log", "safe_result"],
  },
  safe_diff_summary: {
    title: "Safe Diff Summary",
    summary: "安全差异摘要（仅返回文件列表和统计，不返回完整 diff）",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "audit"],
    tags: ["safe", "diff", "summary", "files", "changes"],
    aliases: ["safe_diff", "diff_summary"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_diff", "safe_result"],
  },
  diagnose_task: {
    title: "Diagnose Task",
    summary: "v0.7.0: 多信号诊断 running/collecting_artifacts 任务真实状态",
    profiles: ["full"],
    modes: ["diagnostic"],
    tags: ["diagnose", "stale", "running", "heartbeat", "pid", "watcher", "stuck"],
    aliases: ["diagnose", "diagnostic"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["reconcile_tasks", "safe_status", "get_task_status"],
  },
  reconcile_tasks: {
    title: "Reconcile Tasks",
    summary: "v0.7.0: 扫描旧 running 任务并报告或安全修复",
    profiles: ["full"],
    modes: ["diagnostic"],
    tags: ["reconcile", "stale", "cleanup", "failed_stale", "orphaned"],
    aliases: ["reconcile", "cleanup", "fix_stale"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["diagnose_task", "safe_status"],
  },
  wait_for_task: {
    title: "Wait For Task",
    summary: "等待任务完成并返回下一步工具调用建议",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate"],
    tags: ["wait", "task", "complete", "terminal", "block"],
    aliases: ["wait", "wait_task"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_task_progress", "get_task_summary", "audit_task"],
  },
  get_plan: {
    title: "Get Plan",
    summary: "读取已保存的执行计划",
    profiles: ["full"],
    modes: ["delegate"],
    tags: ["plan", "read", "get", "save_plan"],
    aliases: ["plan", "read_plan"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["save_plan", "create_task"],
  },
  get_task_stdout_tail: {
    title: "Get Task Stdout Tail",
    summary: "获取任务标准输出尾部内容",
    profiles: ["full"],
    modes: ["delegate", "diagnostic"],
    tags: ["stdout", "tail", "log", "output", "task"],
    aliases: ["stdout_tail", "stdout"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["get_task_log_tail", "get_test_log"],
  },
  discover_tools: {
    title: "Discover Tools",
    summary: "v0.7.1: 搜索候选工具，返回压缩摘要和风险等级",
    profiles: ["full"],
    modes: ["diagnostic"],
    tags: ["discover", "search", "tool", "registry", "find"],
    aliases: ["discover", "tool_search", "find_tool"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["explain_tool"],
  },
  explain_tool: {
    title: "Explain Tool",
    summary: "v0.7.1: 展开单个工具详情，可选包含完整 inputSchema",
    profiles: ["full"],
    modes: ["diagnostic"],
    tags: ["explain", "tool", "detail", "schema", "describe"],
    aliases: ["explain", "tool_info", "describe_tool"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["discover_tools"],
  },

  // ── workspace_read_sensitive ──────────────────────────────────
  read_workspace_file: {
    title: "Read Workspace File",
    summary: "读取工作区文件内容（自动脱敏敏感路径）",
    profiles: ["full", "chatgpt_core", "chatgpt_direct"],
    modes: ["delegate", "direct", "audit"],
    tags: ["read", "file", "workspace", "content", "sensitive"],
    aliases: ["read_file", "cat", "file"],
    risk: "workspace_read_sensitive",
    requiresConfirmation: false,
    relatedTools: ["list_workspace", "search_workspace"],
  },
  search_workspace: {
    title: "Search Workspace",
    summary: "在 Direct 会话仓库中搜索文件内容（grep-like）",
    profiles: ["full", "chatgpt_direct"],
    modes: ["direct"],
    tags: ["search", "grep", "workspace", "content", "find"],
    aliases: ["search", "grep", "find_in_files"],
    risk: "workspace_read_sensitive",
    requiresConfirmation: false,
    relatedTools: ["read_workspace_file", "list_workspace"],
  },

  // ── workspace_write ────────────────────────────────────────────
  save_plan: {
    title: "Save Plan",
    summary: "保存执行计划到工作区",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate"],
    tags: ["plan", "save", "create", "write"],
    aliases: ["save_plan", "create_plan"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["get_plan", "create_task"],
  },
  create_task: {
    title: "Create Task",
    summary: "创建任务并返回 watcher 交接指令",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate"],
    tags: ["task", "create", "run", "plan", "agent"],
    aliases: ["create_task", "new_task", "start_task"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["save_plan", "wait_for_task", "get_task_status"],
  },
  sync_file: {
    title: "Sync File",
    summary: "在 Direct 会话中同步文件（带 sha256 校验）",
    profiles: ["full", "chatgpt_direct"],
    modes: ["direct"],
    tags: ["sync", "file", "copy", "write"],
    aliases: ["sync", "copy_file"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["apply_patch", "create_direct_session"],
  },
  apply_patch: {
    title: "Apply Patch",
    summary: "在 Direct 会话中应用补丁修改文件",
    profiles: ["full", "chatgpt_direct"],
    modes: ["direct"],
    tags: ["patch", "apply", "write", "edit", "modify"],
    aliases: ["patch", "edit", "apply_patch"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["sync_file", "finalize_direct_session", "search_workspace"],
  },
  create_direct_session: {
    title: "Create Direct Session",
    summary: "创建 Direct 编辑会话",
    profiles: ["full", "chatgpt_direct"],
    modes: ["direct"],
    tags: ["direct", "session", "create", "start"],
    aliases: ["new_session", "start_session"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["apply_patch", "search_workspace", "finalize_direct_session"],
  },
  finalize_direct_session: {
    title: "Finalize Direct Session",
    summary: "完成 Direct 会话并生成摘要和 diff",
    profiles: ["full", "chatgpt_direct"],
    modes: ["direct", "audit"],
    tags: ["direct", "session", "finalize", "complete", "summary"],
    aliases: ["finalize", "end_session"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["create_direct_session", "audit_session", "apply_patch"],
  },
  audit_session: {
    title: "Audit Session",
    summary: "审计 Direct 会话的变更和验证结果",
    profiles: ["full", "chatgpt_direct"],
    modes: ["direct", "audit"],
    tags: ["audit", "session", "direct", "verify", "review"],
    aliases: ["audit_direct", "review_session"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["finalize_direct_session", "audit_task"],
  },
  audit_task: {
    title: "Audit Task",
    summary: "审计任务执行结果和验证证据",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate", "audit"],
    tags: ["audit", "task", "verify", "review", "evidence"],
    aliases: ["audit", "review_task"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["get_task_summary", "get_result", "wait_for_task"],
  },
  cancel_task: {
    title: "Cancel Task",
    summary: "安全取消运行中的任务",
    profiles: ["full", "chatgpt_core"],
    modes: ["delegate"],
    tags: ["cancel", "task", "stop", "terminate"],
    aliases: ["cancel", "stop_task"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["kill_task", "retry_task", "get_task_status"],
  },
  kill_task: {
    title: "Kill Task",
    summary: "立即终止任务进程",
    profiles: ["full"],
    modes: ["delegate"],
    tags: ["kill", "task", "terminate", "force", "stop", "cancel"],
    aliases: ["kill", "force_kill"],
    risk: "workspace_write",
    requiresConfirmation: true,
    relatedTools: ["cancel_task", "retry_task"],
  },
  retry_task: {
    title: "Retry Task",
    summary: "重试失败或取消的任务",
    profiles: ["full"],
    modes: ["delegate"],
    tags: ["retry", "task", "restart", "rerun", "failed"],
    aliases: ["retry", "restart_task"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["cancel_task", "create_task", "get_task_status"],
  },

  // ── command ───────────────────────────────────────────────────
  run_verification: {
    title: "Run Verification",
    summary: "在 Direct 会话中运行白名单验证命令",
    profiles: ["full", "chatgpt_direct"],
    modes: ["direct", "audit"],
    tags: ["verify", "verification", "command", "test", "run"],
    aliases: ["verify", "run_test", "test"],
    risk: "command",
    requiresConfirmation: false,
    relatedTools: ["finalize_direct_session", "audit_session"],
  },
  safe_direct_summary: {
    title: "Safe Direct Summary",
    summary: "Direct 会话安全摘要（不含完整 diff 或验证 stdout/stderr）",
    profiles: ["full", "chatgpt_direct"],
    modes: ["direct", "audit"],
    tags: ["safe", "direct", "summary", "session"],
    aliases: ["safe_direct", "direct_summary"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["finalize_direct_session", "audit_session"],
  },
  safe_finalize_direct_session: {
    title: "Safe Finalize Direct Session",
    summary: "完成 Direct 会话并返回低噪摘要",
    profiles: ["full", "chatgpt_direct"],
    modes: ["direct", "audit"],
    tags: ["safe", "direct", "finalize", "summary"],
    aliases: ["safe_finalize", "finalize_summary"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["finalize_direct_session", "safe_direct_summary"],
  },
  safe_audit_direct_session: {
    title: "Safe Audit Direct Session",
    summary: "Direct 会话安全审计摘要（不含验证尾部或完整 diff）",
    profiles: ["full", "chatgpt_direct"],
    modes: ["direct", "audit"],
    tags: ["safe", "direct", "audit", "session"],
    aliases: ["safe_direct_audit", "audit_direct_summary"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["audit_session", "safe_finalize_direct_session"],
  },
  run_task: {
    title: "Run Task",
    summary: "手动触发任务执行（需 enableRunTaskTool=true）",
    profiles: ["full"],
    modes: ["delegate"],
    tags: ["run", "task", "execute", "manual", "agent"],
    aliases: ["run", "execute_task"],
    risk: "command",
    requiresConfirmation: true,
    relatedTools: ["create_task", "wait_for_task"],
  },

  // ── v0.8.0 goal 工具 + v0.8.1 invoke_discovered_tool ───────────
  create_goal: {
    title: "Create Goal",
    summary: "v0.8.0: 创建目标会话，管理多任务目标和子目标依赖",
    profiles: ["full"],
    modes: ["delegate"],
    tags: ["goal", "create", "session", "objective", "plan"],
    aliases: ["new_goal", "create_goal"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["list_goals", "read_goal", "create_subgoal_task"],
  },
  list_goals: {
    title: "List Goals",
    summary: "v0.8.0: 列出所有目标会话及完成进度",
    profiles: ["full"],
    modes: ["delegate", "diagnostic"],
    tags: ["goal", "list", "session", "enumerate"],
    aliases: ["goals", "list_goal"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["create_goal", "read_goal"],
  },
  read_goal: {
    title: "Read Goal",
    summary: "v0.8.0: 读取目标会话详情，含子目标和依赖信息",
    profiles: ["full"],
    modes: ["delegate", "diagnostic"],
    tags: ["goal", "read", "detail", "session"],
    aliases: ["get_goal", "goal_detail"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["list_goals", "create_goal", "suggest_next_subgoal"],
  },
  create_subgoal_task: {
    title: "Create Subgoal Task",
    summary: "v0.8.0: 在目标会话中创建子目标并启动关联任务",
    profiles: ["full"],
    modes: ["delegate"],
    tags: ["goal", "subgoal", "create", "task", "dependency"],
    aliases: ["new_subgoal", "add_subgoal"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["create_goal", "accept_subgoal", "suggest_next_subgoal"],
  },
  accept_subgoal: {
    title: "Accept Subgoal",
    summary: "v0.8.0: 验收子目标，确认所有关联任务已通过",
    profiles: ["full"],
    modes: ["delegate", "audit"],
    tags: ["goal", "subgoal", "accept", "verify", "approve"],
    aliases: ["accept", "approve_subgoal"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["reject_subgoal", "audit_task", "create_subgoal_task"],
  },
  reject_subgoal: {
    title: "Reject Subgoal",
    summary: "v0.8.0: 拒绝子目标并记录原因",
    profiles: ["full"],
    modes: ["delegate", "audit"],
    tags: ["goal", "subgoal", "reject", "deny"],
    aliases: ["reject", "deny_subgoal"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["accept_subgoal", "create_subgoal_task"],
  },
  suggest_next_subgoal: {
    title: "Suggest Next Subgoal",
    summary: "v0.8.0: 基于依赖图建议下一个可执行的子目标",
    profiles: ["full"],
    modes: ["delegate", "diagnostic"],
    tags: ["goal", "subgoal", "suggest", "next", "ready", "dependency"],
    aliases: ["next_subgoal", "suggest"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["read_goal", "create_subgoal_task", "summarize_goal_progress"],
  },
  summarize_goal_progress: {
    title: "Summarize Goal Progress",
    summary: "v0.8.0: 汇总目标完成度、各状态子目标统计和风险",
    profiles: ["full"],
    modes: ["delegate", "diagnostic"],
    tags: ["goal", "progress", "summary", "completion", "status"],
    aliases: ["goal_progress", "progress"],
    risk: "readonly",
    requiresConfirmation: false,
    relatedTools: ["suggest_next_subgoal", "read_goal", "export_handoff"],
  },
  export_handoff: {
    title: "Export Handoff",
    summary: "v0.8.0: 导出目标会话交接文档，用于新会话续作",
    profiles: ["full"],
    modes: ["delegate", "audit"],
    tags: ["goal", "handoff", "export", "transfer", "session"],
    aliases: ["handoff", "export_handoff"],
    risk: "workspace_write",
    requiresConfirmation: false,
    relatedTools: ["summarize_goal_progress", "read_goal"],
  },
  invoke_discovered_tool: {
    title: "Invoke Discovered Tool",
    summary: "v0.8.1: 通过 token 调用 discover_tools 发现的动态工具",
    profiles: ["full", "chatgpt_search"],
    modes: ["delegate", "direct"],
    tags: ["invoke", "call", "tool", "dynamic", "discovered", "token"],
    aliases: ["invoke", "call_tool", "invoke_tool"],
    risk: "command",
    requiresConfirmation: true,
    relatedTools: ["discover_tools", "explain_tool"],
  },
  // ── 测试 fixture（不暴露在 getToolDefs，仅供 invokeDiscoveredTool 单测） ──
  __test_credential_tool: {
    title: "Test Credential Tool",
    summary: "Test fixture: credential_sensitive risk tool (never exposed in getToolDefs)",
    profiles: ["full"],
    modes: ["delegate"],
    tags: ["test", "credential", "fixture"],
    aliases: [],
    risk: "credential_sensitive",
    requiresConfirmation: true,
  },
  // ── v1.0.0 release / worktree 工具 ──────────────────────────────
  check_release_gate: {
    title: "Check Release Gate",
    summary: "v1.0.0: 五阶段发布门禁检查（local/packed/published/github/ci）",
    profiles: ["full"],
    modes: ["release", "diagnostic"],
    tags: ["release", "gate", "verify", "publish", "npm", "github", "ci"],
    aliases: ["release_gate", "check_release", "verify_release"],
    risk: "release",
    requiresConfirmation: true,
    relatedTools: ["audit_task", "safe_status"],
  },
  merge_worktree: {
    title: "Merge Worktree",
    summary: "v1.0.0: 合并隔离 worktree 变更回主工作区",
    profiles: ["full"],
    modes: ["delegate"],
    tags: ["worktree", "merge", "goal", "subgoal", "isolate"],
    aliases: ["merge_worktree", "worktree_merge"],
    risk: "workspace_write",
    requiresConfirmation: true,
    relatedTools: ["discard_worktree", "create_subgoal_task", "accept_subgoal"],
  },
  discard_worktree: {
    title: "Discard Worktree",
    summary: "v1.0.0: 安全丢弃隔离 worktree 并归档状态",
    profiles: ["full"],
    modes: ["delegate"],
    tags: ["worktree", "discard", "cleanup", "goal", "subgoal"],
    aliases: ["discard_worktree", "worktree_discard", "remove_worktree"],
    risk: "workspace_write",
    requiresConfirmation: true,
    relatedTools: ["merge_worktree", "create_subgoal_task", "reject_subgoal"],
  },
};

// ── schema digest 计算 ───────────────────────────────────────────

/**
 * 稳定 JSON 序列化：按字段名排序，避免 key 顺序导致 digest 漂移。
 */
export function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 计算 inputSchema 的 sha256 digest。
 * 返回格式："sha256:<hex>"
 */
export function computeSchemaDigest(inputSchema: unknown): string {
  const canonical = stableJsonStringify(inputSchema);
  const hash = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hash}`;
}

// ── 构建完整工具注册表 ────────────────────────────────────────────

/**
 * 从 ToolDef[] 构建带元数据的完整工具注册表。
 * 静态元数据来自 STATIC_TOOL_META，schema digest 动态计算。
 * 未在 STATIC_TOOL_META 中注册的工具会被跳过（不报错，保持前向兼容）。
 */
export function buildToolRegistry(tools: ToolDef[]): PatchWardenToolMeta[] {
  const registry: PatchWardenToolMeta[] = [];
  for (const tool of tools) {
    const meta = STATIC_TOOL_META[tool.name];
    if (!meta) continue;
    registry.push({
      name: tool.name,
      title: meta.title,
      summary: meta.summary,
      description: tool.description,
      profiles: meta.profiles,
      modes: meta.modes,
      tags: meta.tags,
      aliases: meta.aliases,
      risk: meta.risk,
      requiresConfirmation: meta.requiresConfirmation,
      inputSchemaDigest: computeSchemaDigest(tool.inputSchema),
      relatedTools: meta.relatedTools,
      examples: meta.examples,
    });
  }
  return registry;
}

/**
 * 获取单个工具的元数据（不含 schema digest，digest 需从 registry 获取）。
 */
export function getStaticToolMeta(name: string): StaticToolMeta | undefined {
  return STATIC_TOOL_META[name];
}
