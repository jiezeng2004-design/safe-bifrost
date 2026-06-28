/**
 * v0.8.1: invoke_discovered_tool MCP 工具封装层。
 *
 * 受控动态调用链：agent 必须先 discover_tools 获取 discoveryToken，
 * 再凭 token 调用工具。本模块串联 consumeToken → toolMeta 查找 →
 * 防递归 → checkInvocation → dispatch → logToolInvocation，
 * 任一环节失败都记审计日志并返回错误结果，不向上层抛错。
 */

import { consumeToken, type DiscoveryTokenRecord } from "../security/discoveryTokenStore.js";
import { checkInvocation } from "../security/toolInvocationGuard.js";
import { logToolInvocation, computeArgumentsDigest } from "../logging.js";
import { buildToolRegistry, type PatchWardenToolMeta } from "./toolRegistry.js";
import type { ToolProfile } from "./toolCatalog.js";
import type { ToolDef } from "./registry.js";
import { PatchWardenError } from "../errors.js";

// ── 类型定义 ──────────────────────────────────────────────────────

export interface InvokeDiscoveredToolInput {
  toolName: string;
  arguments: Record<string, unknown>;
  discoveryToken: string;
  assessmentId?: string;
}

export type ToolDispatch = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface InvokeDiscoveredToolContext {
  tools: ToolDef[];
  profile: ToolProfile;
  dispatch: ToolDispatch;
}

export interface InvokeDiscoveredToolResult {
  ok: boolean;
  result?: unknown;
  error?: { reason: string; message: string };
  invocation_log_written: boolean;
}

// ── 内部错误码常量 ────────────────────────────────────────────────

const RECURSIVE_INVOCATION_BLOCKED = "recursive_invocation_blocked";
const TOOL_NOT_REGISTERED = "tool_not_registered";
const DISPATCH_ERROR = "dispatch_error";

// ── 公共 API ──────────────────────────────────────────────────────

/**
 * 受控动态调用入口。串联 token 消费、toolMeta 查找、防递归、
 * 8 项守卫校验、工具分发和审计日志。任何环节失败都记日志并返回
 * 错误结果，不向上层抛错。
 */
export async function invokeDiscoveredTool(
  input: InvokeDiscoveredToolInput,
  context: InvokeDiscoveredToolContext,
): Promise<InvokeDiscoveredToolResult> {
  const startTime = Date.now();
  const argumentsDigest = computeArgumentsDigest(input.arguments);

  let tokenRecord: DiscoveryTokenRecord | null = null;
  let toolMeta: PatchWardenToolMeta | null = null;

  const writeLog = (result: "ok" | "error", errorCode?: string): void => {
    const durationMs = Date.now() - startTime;
    logToolInvocation({
      timestamp: new Date().toISOString(),
      toolName: input.toolName,
      discoveryToken: input.discoveryToken,
      risk: toolMeta?.risk ?? "unknown",
      profile: context.profile,
      arguments_digest: argumentsDigest,
      ...(tokenRecord?.allowedScope ? { allowedScope: tokenRecord.allowedScope } : {}),
      result,
      ...(errorCode ? { error_code: errorCode } : {}),
      duration_ms: durationMs,
    });
  };

  const fail = (reason: string, message: string): InvokeDiscoveredToolResult => {
    writeLog("error", reason);
    return {
      ok: false,
      error: { reason, message },
      invocation_log_written: true,
    };
  };

  try {
    // 1. consumeToken（单次使用语义，token_not_found / token_expired 在此抛出）
    try {
      tokenRecord = consumeToken(input.discoveryToken);
    } catch (err) {
      if (err instanceof PatchWardenError) {
        return fail(err.reason, err.message);
      }
      return fail("token_error", err instanceof Error ? err.message : String(err));
    }

    // 2. 查 toolMeta（防止调用未注册工具）
    const registry = buildToolRegistry(context.tools);
    toolMeta = registry.find((meta) => meta.name === input.toolName) ?? null;
    if (!toolMeta) {
      return fail(
        TOOL_NOT_REGISTERED,
        `Tool "${input.toolName}" is not registered in the tool registry.`,
      );
    }

    // 3. 防递归：禁止调用 invoke_discovered_tool 自身（防止绕过守卫）
    if (input.toolName === "invoke_discovered_tool") {
      return fail(
        RECURSIVE_INVOCATION_BLOCKED,
        "Recursive invocation of invoke_discovered_tool is blocked. invoke_discovered_tool cannot call itself.",
      );
    }

    // 4. checkInvocation（8 项调用前强制校验）
    try {
      checkInvocation({
        toolName: input.toolName,
        toolMeta,
        args: input.arguments,
        discoveryTokenRecord: tokenRecord,
        profile: context.profile,
        assessmentId: input.assessmentId,
      });
    } catch (err) {
      if (err instanceof PatchWardenError) {
        return fail(err.reason, err.message);
      }
      return fail("guard_error", err instanceof Error ? err.message : String(err));
    }

    // 5. dispatch（调用实际工具 handler）
    let dispatchResult: unknown;
    try {
      dispatchResult = await context.dispatch(input.toolName, input.arguments);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(
        DISPATCH_ERROR,
        `Dispatch failed for tool "${input.toolName}": ${message}`,
      );
    }

    // 6. 成功 → 记审计日志 → 返回成功结果
    writeLog("ok");
    return {
      ok: true,
      result: dispatchResult,
      invocation_log_written: true,
    };
  } catch (err) {
    // 兜底：任何意外错误都记日志并返回错误结果（不抛给上层）
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      "unexpected_error",
      `Unexpected error during invoke_discovered_tool: ${message}`,
    );
  }
}
