/**
 * v0.8.1: toolInvocationGuard — invoke_discovered_tool 调用前强制校验。
 *
 * consumeToken 已完成 token 存在性与过期校验，guard 收到的是已消费的 record。
 * guard 依次执行 8 项校验，任一失败抛出对应错误码：
 *   1. token_tool_mismatch       — toolName 与 record.toolName 一致性
 *   2. profile_not_allowed        — toolMeta.profiles 必须包含当前 profile
 *   3. risk_exceeded              — toolMeta.risk 不能超过 record.risk（schema 漂移拦截）
 *   4. sensitive_path_blocked     — workspace_read_sensitive 路径敏感校验
 *   5. assessment_required        — workspace_write 需要 assessmentId
 *   6. command_not_allowed        — command 工具 args.command 元字符预检
 *   7. release_confirmation_required — release 工具需要 assessmentId
 *   8. credential_sensitive_blocked — credential_sensitive 总是拒绝
 *
 * 加上 consumeToken 内的 token_not_found / token_expired，共 10 项调用前强制校验。
 */

import { PatchWardenError } from "../errors.js";
import { guardSensitivePath } from "./sensitiveGuard.js";
import { TOOL_RISK_RANK, type PatchWardenToolMeta } from "../tools/toolRegistry.js";
import type { ToolProfile } from "../tools/toolCatalog.js";
import type { DiscoveryTokenRecord } from "./discoveryTokenStore.js";

// ── 类型定义 ──────────────────────────────────────────────────────

export interface GuardInput {
  toolName: string;                          // 要调用的工具名
  toolMeta: PatchWardenToolMeta;             // 工具元数据
  args: Record<string, unknown>;             // 调用参数
  discoveryTokenRecord: DiscoveryTokenRecord; // token 记录（已 consume）
  profile: ToolProfile;                      // 当前 profile
  assessmentId?: string;                     // 可选 assessmentId
}

export interface GuardResult {
  allowed: boolean;
}

// 错误码常量
export type InvocationErrorCode =
  | "token_tool_mismatch"
  | "profile_not_allowed"
  | "risk_exceeded"
  | "sensitive_path_blocked"
  | "assessment_required"
  | "command_not_allowed"
  | "release_confirmation_required"
  | "credential_sensitive_blocked";

// ── 内部常量 ──────────────────────────────────────────────────────

/**
 * 常见路径参数字段名，用于 workspace_read_sensitive 校验时扫描 args。
 * 任一字段为字符串路径都会触发 guardSensitivePath。
 */
const PATH_ARG_FIELDS = [
  "path",
  "file",
  "filePath",
  "file_path",
  "filename",
  "repo_path",
  "repoPath",
  "target_path",
  "targetPath",
  "destination",
  "dest",
] as const;

/**
 * shell 元字符黑名单，用于 command 风险工具 args.command 预检。
 * 真正的白名单校验在 handler 内通过 commandGuard 完成，guard 只做元字符预检。
 */
const SHELL_METACHAR_PATTERN = /[|&;`$()<>]/;

// ── 公共 API ──────────────────────────────────────────────────────

/**
 * 调用前强制校验。任一校验失败抛 PatchWardenError，全部通过返回 { allowed: true }。
 */
export function checkInvocation(input: GuardInput): GuardResult {
  const { toolName, toolMeta, args, discoveryTokenRecord, profile, assessmentId } = input;

  // ① toolName 一致性：toolName 必须等于 record.toolName
  if (toolName !== discoveryTokenRecord.toolName) {
    throw new PatchWardenError(
      "token_tool_mismatch",
      `Token tool mismatch: token was issued for "${discoveryTokenRecord.toolName}" but invocation targets "${toolName}".`,
      "Call discover_tools again and use a token issued for the intended tool name.",
      true,
      {
        token: discoveryTokenRecord.token,
        expected_tool: discoveryTokenRecord.toolName,
        actual_tool: toolName,
      }
    );
  }

  // ② profile 允许：toolMeta.profiles 必须包含当前 profile
  if (!toolMeta.profiles.includes(profile)) {
    throw new PatchWardenError(
      "profile_not_allowed",
      `Profile "${profile}" is not allowed for tool "${toolName}". Allowed profiles: ${toolMeta.profiles.join(", ")}.`,
      "Switch to a profile that exposes this tool, or call discover_tools under a supported profile.",
      true,
      {
        tool: toolName,
        current_profile: profile,
        allowed_profiles: toolMeta.profiles,
      }
    );
  }

  // ③ 风险等级校验：toolMeta.risk 不能超过 record.risk
  //    token record 的 risk 是 discover 时记录的工具 risk，应与 toolMeta.risk 一致。
  //    如果工具 schema 漂移导致 risk 变了，这里会拦截。
  const toolRiskRank = TOOL_RISK_RANK[toolMeta.risk];
  const tokenRiskRank = TOOL_RISK_RANK[discoveryTokenRecord.risk];
  if (toolRiskRank > tokenRiskRank) {
    throw new PatchWardenError(
      "risk_exceeded",
      `Risk exceeded: tool "${toolName}" risk is "${toolMeta.risk}" (rank ${toolRiskRank}) but discovery token was issued for risk "${discoveryTokenRecord.risk}" (rank ${tokenRiskRank}). Tool schema may have drifted.`,
      "Call discover_tools again to obtain a fresh token reflecting the current tool risk.",
      true,
      {
        tool: toolName,
        tool_risk: toolMeta.risk,
        token_risk: discoveryTokenRecord.risk,
        tool_risk_rank: toolRiskRank,
        token_risk_rank: tokenRiskRank,
      }
    );
  }

  // ④ workspace_read_sensitive：检查 args 中的路径参数
  checkSensitivePaths(toolMeta, toolName, args);

  // ⑤ workspace_write：要求 assessmentId 非空
  if (toolMeta.risk === "workspace_write") {
    if (!assessmentId || assessmentId.trim() === "") {
      throw new PatchWardenError(
        "assessment_required",
        `Assessment required: tool "${toolName}" has workspace_write risk and requires a non-empty assessmentId.`,
        "Run the assessment flow first and pass the resulting assessmentId to invoke_discovered_tool.",
        true,
        {
          tool: toolName,
          risk: toolMeta.risk,
        }
      );
    }
  }

  // ⑥ command：args.command 元字符预检
  if (toolMeta.risk === "command") {
    checkCommandMetachars(toolMeta, toolName, args);
  }

  // ⑦ release：要求 assessmentId 非空（二次确认语义）
  if (toolMeta.risk === "release") {
    if (!assessmentId || assessmentId.trim() === "") {
      throw new PatchWardenError(
        "release_confirmation_required",
        `Release confirmation required: tool "${toolName}" has release risk and requires a non-empty assessmentId as explicit confirmation.`,
        "Run the release assessment flow first and pass the resulting assessmentId to confirm the release.",
        true,
        {
          tool: toolName,
          risk: toolMeta.risk,
        }
      );
    }
  }

  // ⑧ credential_sensitive：总是拒绝
  if (toolMeta.risk === "credential_sensitive") {
    throw new PatchWardenError(
      "credential_sensitive_blocked",
      `Credential-sensitive tool "${toolName}" cannot be invoked through invoke_discovered_tool.`,
      "Use the dedicated credential-handling tooling outside the dynamic invoke path.",
      true,
      {
        tool: toolName,
        risk: toolMeta.risk,
      }
    );
  }

  return { allowed: true };
}

// ── 内部校验函数 ──────────────────────────────────────────────────

/**
 * workspace_read_sensitive 风险工具：扫描 args 中的路径参数字段，
 * 对每个字符串路径调用 guardSensitivePath（敏感路径会抛 sensitive_path_blocked）。
 * 没有路径参数则跳过。
 */
function checkSensitivePaths(
  toolMeta: PatchWardenToolMeta,
  toolName: string,
  args: Record<string, unknown>
): void {
  if (toolMeta.risk !== "workspace_read_sensitive") {
    return;
  }

  for (const field of PATH_ARG_FIELDS) {
    const value = args[field];
    if (typeof value === "string" && value.length > 0) {
      // guardSensitivePath 内部会在敏感时抛 PatchWardenError("sensitive_path_blocked", ...)
      guardSensitivePath(value);
    }
  }
}

/**
 * command 风险工具：args.command 元字符预检。
 * - args.command 不存在或为空 → 跳过（handler 内部会再校验）
 * - 含 shell 元字符 → 抛 command_not_allowed
 * 真正的白名单校验在 handler 内通过 commandGuard 完成。
 */
function checkCommandMetachars(
  _toolMeta: PatchWardenToolMeta,
  toolName: string,
  args: Record<string, unknown>
): void {
  const command = args.command;
  if (command === undefined || command === null) {
    return;
  }
  if (typeof command !== "string") {
    return;
  }
  if (command.trim() === "") {
    return;
  }

  if (SHELL_METACHAR_PATTERN.test(command)) {
    throw new PatchWardenError(
      "command_not_allowed",
      `Command not allowed: tool "${toolName}" args.command contains shell metacharacters. Detected pattern in "${command}".`,
      "Provide a plain command without shell metacharacters (| & ; ` $ ( ) < >). The handler will validate against the command allowlist.",
      true,
      {
        tool: toolName,
        command,
      }
    );
  }
}
