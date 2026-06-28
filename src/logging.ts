import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactSensitiveContent } from "./security/contentRedaction.js";
import { stableJsonStringify } from "./tools/toolRegistry.js";
import { getConfig } from "./config.js";

// ── Types ─────────────────────────────────────────────────────────

export type LogLevel = "info" | "warn" | "error" | "audit";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

/**
 * v0.8.1: 单次 invoke_discovered_tool 调用的结构化审计记录。
 *
 * 注意：出于安全考虑，只记录参数的 sha256 digest
 * (`arguments_digest`)，绝不记录原始参数。日志以 JSON Lines 形式
 * 追加写入 `.patchwarden/logs/invocation.log`。
 */
export interface InvocationLogEntry {
  timestamp: string;          // ISO 时间戳
  toolName: string;           // 被调用的工具名
  discoveryToken: string;     // discover_tools 颁发的 token id
  risk: string;               // ToolRisk 值
  profile: string;            // ToolProfile 值
  arguments_digest: string;   // sha256 of stableJsonStringify(arguments)，格式 "sha256:<hex>"
  allowedScope?: string[];    // 允许的 scope（可选）
  result: "ok" | "error";     // 调用结果
  error_code?: string;        // 失败时的错误码
  duration_ms: number;        // 调用耗时（毫秒）
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Returns true when PATCHWARDEN_VERBOSE_LOG is set to "true".
 * Verbose mode enables logging of sanitized tool-call arguments.
 */
export function isVerboseLogging(): boolean {
  return process.env.PATCHWARDEN_VERBOSE_LOG === "true";
}

/**
 * Serialize a value to a JSON string, falling back to String() on failure
 * (e.g. circular references, functions, symbols).
 */
function safeStringify(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? String(value) : result;
  } catch {
    return String(value);
  }
}

/**
 * Write a single JSON log line to stderr.
 *
 * All log output goes to stderr — NEVER stdout — so that MCP JSON-RPC
 * traffic on stdout is never polluted by log messages.
 */
function emit(entry: LogEntry): void {
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// ── Logger ────────────────────────────────────────────────────────

/**
 * Structured logger that emits JSON lines to stderr.
 *
 * Each entry contains `timestamp`, `level`, `message`, plus any optional
 * context fields supplied by the caller.
 */
export class Logger {
  info(message: string, context?: Record<string, unknown>): void {
    emit({ timestamp: new Date().toISOString(), level: "info", message, ...context });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    emit({ timestamp: new Date().toISOString(), level: "warn", message, ...context });
  }

  error(message: string, context?: Record<string, unknown>): void {
    emit({ timestamp: new Date().toISOString(), level: "error", message, ...context });
  }

  /**
   * Emit a tool-call audit log entry.
   *
   * Required fields: `tool`, `ok`, `duration_ms`.
   * Optional fields: `error_reason`, `task_id`.
   *
   * By default raw arguments are NOT logged. When verbose mode is enabled
   * (PATCHWARDEN_VERBOSE_LOG=true) and `args` is provided, the arguments
   * are serialized and sanitized via `redactSensitiveContent` before being
   * included in the `args` field.
   */
  audit(
    tool: string,
    ok: boolean,
    durationMs: number,
    errorReason?: string,
    taskId?: string,
    args?: unknown,
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "audit",
      message: "tool_call_audit",
      tool,
      ok,
      duration_ms: durationMs,
    };
    if (errorReason !== undefined) entry.error_reason = errorReason;
    if (taskId !== undefined) entry.task_id = taskId;
    if (args !== undefined && isVerboseLogging()) {
      const redacted = redactSensitiveContent(safeStringify(args));
      entry.args = redacted.content;
    }
    emit(entry);
  }
}

/** Default singleton logger instance. */
export const logger = new Logger();

// ── Unhandled error helpers ───────────────────────────────────────

/**
 * Produce a structured error log entry for an unhandled rejection or
 * uncaught exception. Writes JSON to stderr.
 */
export function logUnhandledError(error: unknown): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level: "error",
    message: "unhandled_error",
    error: error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : safeStringify(error),
    error_name: error instanceof Error ? error.name : typeof error,
  };
  if (error instanceof Error && error.stack) {
    entry.stack = error.stack;
  }
  emit(entry);
}

/**
 * Register process-level handlers for `unhandledRejection` and
 * `uncaughtException`.
 *
 * Both handlers log structured error output to stderr. The
 * `uncaughtException` handler does NOT swallow the fatal error — after
 * logging it exits with a non-zero status code to preserve the default
 * crash behaviour required for truly fatal failures.
 */
export function installGlobalHandlers(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    logUnhandledError(reason);
  });

  process.on("uncaughtException", (error: Error) => {
    logUnhandledError(error);
    // Do not swallow: exit with failure so the process does not continue
    // in an undefined state.
    process.exit(1);
  });
}

// ── v0.8.1: Invocation log ───────────────────────────────────────

/**
 * 计算工具调用参数的 sha256 digest。
 *
 * 使用 `stableJsonStringify`（按字段名排序的 canonical JSON）计算，
 * 这样相同语义的参数（仅 key 顺序不同）会得到相同的 digest。
 * 返回格式："sha256:<hex>"。
 *
 * 安全说明：digest 是单向哈希，无法还原出原始参数内容。
 */
export function computeArgumentsDigest(args: unknown): string {
  const canonical = stableJsonStringify(args);
  const hash = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hash}`;
}

/**
 * 将一次 invoke_discovered_tool 调用记录追加到 invocation.log。
 *
 * 日志位置：`<workspaceRoot>/.patchwarden/logs/invocation.log`，以
 * JSON Lines 形式追加写入。`entry` 中只含参数 digest，不含原始参数。
 *
 * 该函数不会抛错——日志写入失败不应阻断主调用流程。失败时仅向
 * stderr 记录一条 error 日志。
 *
 * @param entry   调用记录（调用方需先计算好 `arguments_digest`）
 * @param options 可选，`logsDir` 用于覆盖日志目录（主要用于测试）
 */
export function logToolInvocation(
  entry: InvocationLogEntry,
  options?: { logsDir?: string },
): void {
  try {
    let logsDir: string;
    if (options?.logsDir) {
      logsDir = options.logsDir;
    } else {
      let workspaceRoot: string;
      try {
        workspaceRoot = getConfig().workspaceRoot;
      } catch {
        workspaceRoot = process.cwd();
      }
      logsDir = join(workspaceRoot, ".patchwarden", "logs");
    }

    mkdirSync(logsDir, { recursive: true });
    const logFilePath = join(logsDir, "invocation.log");
    appendFileSync(logFilePath, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    // 日志失败不应阻断主流程，仅向 stderr 记录错误
    try {
      const message = err instanceof Error ? err.message : String(err);
      emit({
        timestamp: new Date().toISOString(),
        level: "error",
        message: "invocation_log_write_failed",
        error: message,
      });
    } catch {
      // 连 stderr 写入都失败，彻底吞掉以避免影响主流程
    }
  }
}
