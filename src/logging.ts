import { redactSensitiveContent } from "./security/contentRedaction.js";

// ── Types ─────────────────────────────────────────────────────────

export type LogLevel = "info" | "warn" | "error" | "audit";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
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
