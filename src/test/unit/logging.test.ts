import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { Logger, logUnhandledError, installGlobalHandlers } from "../../logging.js";

// ── Test helpers ──────────────────────────────────────────────────

/**
 * Capture everything written to stderr during `fn` and return it as an
 * array of raw chunks (one per `process.stderr.write` call).
 */
function captureStderr(fn: () => void): string[] {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks;
}

/**
 * Capture stderr and return the parsed JSON objects (one per log line).
 */
function captureJson(fn: () => void): Record<string, unknown>[] {
  const chunks = captureStderr(fn);
  return chunks
    .flatMap((chunk) => chunk.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

// ── Logger: stderr output ─────────────────────────────────────────

describe("Logger — stderr output", () => {
  it("writes JSON log entries to stderr (never stdout)", () => {
    const log = new Logger();
    const entries = captureJson(() => {
      log.info("hello from test", { component: "unit-test" });
    });

    assert.equal(entries.length, 1);
    const entry = entries[0];

    assert.equal(entry.level, "info");
    assert.equal(entry.message, "hello from test");
    assert.equal(entry.component, "unit-test");
    assert.equal(typeof entry.timestamp, "string");
    // timestamp must be a valid ISO date
    assert.ok(!Number.isNaN(Date.parse(entry.timestamp as string)));
  });

  it("supports warn and error levels", () => {
    const log = new Logger();
    const entries = captureJson(() => {
      log.warn("careful");
      log.error("broken");
    });

    assert.equal(entries.length, 2);
    assert.equal(entries[0].level, "warn");
    assert.equal(entries[0].message, "careful");
    assert.equal(entries[1].level, "error");
    assert.equal(entries[1].message, "broken");
  });

  it("does not write anything to stdout", () => {
    const originalStdout = process.stdout.write;
    let stdoutWritten = false;
    process.stdout.write = (() => {
      stdoutWritten = true;
      return true;
    }) as typeof process.stdout.write;

    try {
      const log = new Logger();
      log.info("should not touch stdout");
      log.warn("nor this");
      log.error("nor this");
    } finally {
      process.stdout.write = originalStdout;
    }

    assert.equal(stdoutWritten, false, "Logger must never write to stdout");
  });
});

// ── Logger: audit ─────────────────────────────────────────────────

describe("Logger.audit — format", () => {
  it("produces an audit log entry with all required fields", () => {
    const log = new Logger();
    const entries = captureJson(() => {
      log.audit("createTask", true, 150, undefined, "task-001");
    });

    assert.equal(entries.length, 1);
    const entry = entries[0];

    // Required core fields
    assert.equal(entry.level, "audit");
    assert.equal(typeof entry.timestamp, "string");
    assert.ok(!Number.isNaN(Date.parse(entry.timestamp as string)));
    assert.equal(typeof entry.message, "string");

    // Audit-specific fields
    assert.equal(entry.tool, "createTask");
    assert.equal(entry.ok, true);
    assert.equal(entry.duration_ms, 150);
    assert.equal(entry.task_id, "task-001");

    // error_reason should be absent when not provided
    assert.equal(entry.error_reason, undefined);
  });

  it("includes error_reason when the tool call failed", () => {
    const log = new Logger();
    const entries = captureJson(() => {
      log.audit("applyPatch", false, 3000, "command_blocked", "task-002");
    });

    assert.equal(entries.length, 1);
    const entry = entries[0];

    assert.equal(entry.ok, false);
    assert.equal(entry.error_reason, "command_blocked");
    assert.equal(entry.task_id, "task-002");
  });

  it("omits task_id when not provided", () => {
    const log = new Logger();
    const entries = captureJson(() => {
      log.audit("healthCheck", true, 5);
    });

    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.task_id, undefined);
    assert.equal(entry.error_reason, undefined);
  });
});

// ── Logger: verbose mode ──────────────────────────────────────────

describe("Logger — verbose mode (PATCHWARDEN_VERBOSE_LOG)", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.PATCHWARDEN_VERBOSE_LOG;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.PATCHWARDEN_VERBOSE_LOG;
    } else {
      process.env.PATCHWARDEN_VERBOSE_LOG = savedEnv;
    }
  });

  it("does not log args by default (verbose mode off)", () => {
    delete process.env.PATCHWARDEN_VERBOSE_LOG;

    const log = new Logger();
    const sensitiveArgs = {
      prompt: "fix the bug",
      token: "ghp_" + "a".repeat(20),
    };

    const entries = captureJson(() => {
      log.audit("createTask", true, 100, undefined, "task-003", sensitiveArgs);
    });

    assert.equal(entries.length, 1);
    const entry = entries[0];

    // args must NOT be present when verbose mode is off
    assert.equal(entry.args, undefined);
    // The raw token must not appear anywhere in the serialized entry
    const raw = JSON.stringify(entry);
    assert.ok(!raw.includes("ghp_"), "raw token must not leak into log output");
  });

  it("logs sanitized args when PATCHWARDEN_VERBOSE_LOG=true", () => {
    process.env.PATCHWARDEN_VERBOSE_LOG = "true";

    const log = new Logger();
    const sensitiveArgs = {
      prompt: "fix the bug",
      token: "ghp_" + "a".repeat(20),
    };

    const entries = captureJson(() => {
      log.audit("createTask", true, 100, undefined, "task-004", sensitiveArgs);
    });

    assert.equal(entries.length, 1);
    const entry = entries[0];

    // args must be present and redacted
    assert.ok(entry.args !== undefined, "args should be logged in verbose mode");
    const argsStr = String(entry.args);
    assert.ok(argsStr.includes("[REDACTED TOKEN]"), "sensitive token must be redacted");
    assert.ok(!argsStr.includes("ghp_"), "raw token must not appear in args");
    // non-sensitive content is preserved
    assert.ok(argsStr.includes("fix the bug"), "non-sensitive args content is preserved");
  });

  it("does not log args when PATCHWARDEN_VERBOSE_LOG is set but not 'true'", () => {
    process.env.PATCHWARDEN_VERBOSE_LOG = "false";

    const log = new Logger();
    const entries = captureJson(() => {
      log.audit("createTask", true, 100, undefined, "task-005", { prompt: "hello" });
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].args, undefined);
  });
});

// ── logUnhandledError ─────────────────────────────────────────────

describe("logUnhandledError", () => {
  it("produces structured JSON output for Error instances", () => {
    const error = new Error("something went wrong");
    error.name = "CustomError";

    const entries = captureJson(() => {
      logUnhandledError(error);
    });

    assert.equal(entries.length, 1);
    const entry = entries[0];

    assert.equal(entry.level, "error");
    assert.equal(entry.message, "unhandled_error");
    assert.equal(entry.error, "something went wrong");
    assert.equal(entry.error_name, "CustomError");
    assert.equal(typeof entry.timestamp, "string");
    assert.ok(!Number.isNaN(Date.parse(entry.timestamp as string)));
    assert.equal(typeof entry.stack, "string");
    assert.ok((entry.stack as string).includes("something went wrong"));
  });

  it("handles non-Error values (string)", () => {
    const entries = captureJson(() => {
      logUnhandledError("a plain string rejection");
    });

    assert.equal(entries.length, 1);
    const entry = entries[0];

    assert.equal(entry.level, "error");
    assert.equal(entry.error, "a plain string rejection");
    assert.equal(entry.error_name, "string");
    assert.equal(entry.stack, undefined);
  });

  it("handles non-Error values (object)", () => {
    const entries = captureJson(() => {
      logUnhandledError({ code: 42, detail: "weird" });
    });

    assert.equal(entries.length, 1);
    const entry = entries[0];

    assert.equal(entry.level, "error");
    assert.ok(String(entry.error).includes("42"));
    assert.equal(entry.error_name, "object");
  });
});

// ── installGlobalHandlers ─────────────────────────────────────────

describe("installGlobalHandlers", () => {
  it("does not throw when called", () => {
    // Save existing listeners so we can restore them afterwards and avoid
    // the fatal `uncaughtException` handler interfering with the test
    // runner.
    const origUnhandled = process.listeners("unhandledRejection");
    const origUncaught = process.listeners("uncaughtException");

    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");

    try {
      assert.doesNotThrow(() => installGlobalHandlers());

      // Verify the handlers were actually registered
      assert.ok(process.listenerCount("unhandledRejection") >= 1);
      assert.ok(process.listenerCount("uncaughtException") >= 1);
    } finally {
      // Restore original listeners
      process.removeAllListeners("unhandledRejection");
      process.removeAllListeners("uncaughtException");
      for (const fn of origUnhandled) process.on("unhandledRejection", fn);
      for (const fn of origUncaught) process.on("uncaughtException", fn);
    }
  });

  it("can be called multiple times without throwing", () => {
    const origUnhandled = process.listeners("unhandledRejection");
    const origUncaught = process.listeners("uncaughtException");

    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");

    try {
      assert.doesNotThrow(() => {
        installGlobalHandlers();
        installGlobalHandlers();
      });
    } finally {
      process.removeAllListeners("unhandledRejection");
      process.removeAllListeners("uncaughtException");
      for (const fn of origUnhandled) process.on("unhandledRejection", fn);
      for (const fn of origUncaught) process.on("uncaughtException", fn);
    }
  });
});
