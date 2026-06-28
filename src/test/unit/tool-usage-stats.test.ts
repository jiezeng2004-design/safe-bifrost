import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  aggregateUsageStats,
  type ToolUsageStats,
} from "../../tools/toolUsageStats.js";
import type { InvocationLogEntry } from "../../logging.js";

// ── Helpers ───────────────────────────────────────────────────────

/**
 * 构造一条合法的 InvocationLogEntry（用于测试）。
 * 通过 overrides 覆盖字段，方便生成不同工具/结果/耗时的记录。
 */
function sampleEntry(overrides: Partial<InvocationLogEntry> = {}): InvocationLogEntry {
  return {
    timestamp: "2026-06-27T00:00:00.000Z",
    toolName: "read_workspace_file",
    discoveryToken: "tok",
    risk: "workspace_read_sensitive",
    profile: "full",
    arguments_digest: "sha256:" + "0".repeat(64),
    result: "ok",
    duration_ms: 100,
    ...overrides,
  };
}

/**
 * 将多条 entry 序列化为 JSON Lines 字符串（每行一个 JSON 对象 + "\n"）。
 */
function toJsonLines(entries: InvocationLogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/**
 * 将任意字符串数组序列化为 JSON Lines（用于写入损坏/畸形行）。
 */
function toRawLines(lines: string[]): string {
  return lines.join("\n") + "\n";
}

// ── Tests ─────────────────────────────────────────────────────────

describe("aggregateUsageStats", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-usage-stats-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 1. logsDir 不存在 ──────────────────────────────────────────

  it("logsDir 不存在时返回空 Map（不抛错）", () => {
    const missingDir = join(tempDir, "does-not-exist");
    assert.ok(!existsSync(missingDir));

    const stats = aggregateUsageStats(missingDir);
    assert.equal(stats.size, 0);
  });

  // ── 2. invocation.log 不存在 ───────────────────────────────────

  it("invocation.log 不存在时返回空 Map（不抛错）", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    assert.ok(!existsSync(join(logsDir, "invocation.log")));

    const stats = aggregateUsageStats(logsDir);
    assert.equal(stats.size, 0);
  });

  // ── 3. invocation.log 为空文件 ─────────────────────────────────

  it("invocation.log 为空文件时返回空 Map（不抛错）", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, "invocation.log"), "", "utf-8");

    const stats = aggregateUsageStats(logsDir);
    assert.equal(stats.size, 0);
  });

  // ── 4. 正常聚合：多个工具 ──────────────────────────────────────

  it("正常聚合：多个工具各自的 totalCalls/successRate/avgDurationMs/lastUsedAt 正确", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "invocation.log"),
      toJsonLines([
        sampleEntry({
          toolName: "read_workspace_file",
          result: "ok",
          duration_ms: 100,
          timestamp: "2026-06-27T10:00:00.000Z",
        }),
        sampleEntry({
          toolName: "read_workspace_file",
          result: "error",
          duration_ms: 200,
          timestamp: "2026-06-27T11:00:00.000Z",
        }),
        sampleEntry({
          toolName: "save_plan",
          result: "ok",
          duration_ms: 50,
          timestamp: "2026-06-27T09:00:00.000Z",
        }),
      ]),
      "utf-8",
    );

    const stats = aggregateUsageStats(logsDir);
    assert.equal(stats.size, 2);

    const readStats = stats.get("read_workspace_file");
    assert.ok(readStats, "read_workspace_file stats should exist");
    assert.equal(readStats!.totalCalls, 2);
    assert.equal(readStats!.successRate, 0.5);
    assert.equal(readStats!.avgDurationMs, 150);
    assert.equal(readStats!.lastUsedAt, "2026-06-27T11:00:00.000Z");

    const planStats = stats.get("save_plan");
    assert.ok(planStats, "save_plan stats should exist");
    assert.equal(planStats!.totalCalls, 1);
    assert.equal(planStats!.successRate, 1);
    assert.equal(planStats!.avgDurationMs, 50);
    assert.equal(planStats!.lastUsedAt, "2026-06-27T09:00:00.000Z");
  });

  // ── 5. 损坏的 JSON 行被跳过 ───────────────────────────────────

  it("损坏的 JSON 行被跳过，不阻断聚合", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    // 合法行 + 损坏行 + 合法行
    const raw = toRawLines([
      JSON.stringify(sampleEntry({ toolName: "tool_a", duration_ms: 100 })),
      "{ this is not valid json",
      JSON.stringify(sampleEntry({
        toolName: "tool_a",
        duration_ms: 300,
        timestamp: "2026-06-27T12:00:00.000Z",
      })),
      "",
      "another-corrupted-line",
    ]);
    writeFileSync(join(logsDir, "invocation.log"), raw, "utf-8");

    const stats = aggregateUsageStats(logsDir);
    assert.equal(stats.size, 1);

    const a = stats.get("tool_a");
    assert.ok(a, "tool_a stats should exist");
    assert.equal(a!.totalCalls, 2, "损坏行应被跳过，仅统计 2 条合法记录");
    assert.equal(a!.avgDurationMs, 200);
    assert.equal(a!.lastUsedAt, "2026-06-27T12:00:00.000Z");
  });

  // ── 6. 缺少 toolName 字段的行被跳过 ───────────────────────────

  it("缺少 toolName 字段的行被跳过", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    // 构造一个缺少 toolName 的对象（直接写 JSON 以便删字段）
    const noToolName = JSON.stringify({
      timestamp: "2026-06-27T10:00:00.000Z",
      discoveryToken: "tok",
      risk: "readonly",
      profile: "full",
      arguments_digest: "sha256:" + "0".repeat(64),
      result: "ok",
      duration_ms: 100,
    });
    writeFileSync(
      join(logsDir, "invocation.log"),
      toRawLines([
        noToolName,
        JSON.stringify(sampleEntry({ toolName: "valid_tool", duration_ms: 200 })),
      ]),
      "utf-8",
    );

    const stats = aggregateUsageStats(logsDir);
    assert.equal(stats.size, 1);
    assert.ok(stats.has("valid_tool"), "仅 valid_tool 应被聚合");
    assert.ok(!stats.has(undefined as unknown as string));
    assert.equal(stats.get("valid_tool")!.totalCalls, 1);
  });

  // ── 7. successRate 计算：3 次调用 2 次 ok ─────────────────────

  it("successRate 计算：3 次调用 2 次 ok → 约 0.666...", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "invocation.log"),
      toJsonLines([
        sampleEntry({ toolName: "rate_tool", result: "ok", duration_ms: 10 }),
        sampleEntry({ toolName: "rate_tool", result: "ok", duration_ms: 10 }),
        sampleEntry({ toolName: "rate_tool", result: "error", duration_ms: 10 }),
      ]),
      "utf-8",
    );

    const stats = aggregateUsageStats(logsDir);
    const s = stats.get("rate_tool");
    assert.ok(s);
    assert.equal(s!.totalCalls, 3);
    // 使用 toFixed 近似比较：2/3 ≈ 0.6667
    assert.equal(s!.successRate.toFixed(4), (2 / 3).toFixed(4));
  });

  // ── 8. avgDurationMs 计算：[100, 200, 300] → 200 ──────────────

  it("avgDurationMs 计算：[100, 200, 300] → 200", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "invocation.log"),
      toJsonLines([
        sampleEntry({ toolName: "dur_tool", duration_ms: 100 }),
        sampleEntry({ toolName: "dur_tool", duration_ms: 200 }),
        sampleEntry({ toolName: "dur_tool", duration_ms: 300 }),
      ]),
      "utf-8",
    );

    const stats = aggregateUsageStats(logsDir);
    const s = stats.get("dur_tool");
    assert.ok(s);
    assert.equal(s!.avgDurationMs, 200);
  });

  // ── 9. lastUsedAt：取最新的 timestamp ─────────────────────────

  it("lastUsedAt：取最新的 timestamp（顺序无关）", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    // 故意打乱时间顺序，验证取最大值而非最后一行
    writeFileSync(
      join(logsDir, "invocation.log"),
      toJsonLines([
        sampleEntry({
          toolName: "ts_tool",
          timestamp: "2026-06-27T10:00:00.000Z",
        }),
        sampleEntry({
          toolName: "ts_tool",
          timestamp: "2026-06-28T08:00:00.000Z",
        }),
        sampleEntry({
          toolName: "ts_tool",
          timestamp: "2026-06-27T23:00:00.000Z",
        }),
      ]),
      "utf-8",
    );

    const stats = aggregateUsageStats(logsDir);
    const s = stats.get("ts_tool");
    assert.ok(s);
    assert.equal(s!.lastUsedAt, "2026-06-28T08:00:00.000Z");
  });

  // ── 10. 单个工具多次调用聚合正确 ──────────────────────────────

  it("单个工具多次调用聚合正确", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "invocation.log"),
      toJsonLines([
        sampleEntry({
          toolName: "single_tool",
          result: "ok",
          duration_ms: 100,
          timestamp: "2026-06-25T00:00:00.000Z",
        }),
        sampleEntry({
          toolName: "single_tool",
          result: "ok",
          duration_ms: 200,
          timestamp: "2026-06-26T00:00:00.000Z",
        }),
        sampleEntry({
          toolName: "single_tool",
          result: "error",
          duration_ms: 300,
          timestamp: "2026-06-27T00:00:00.000Z",
        }),
        sampleEntry({
          toolName: "single_tool",
          result: "ok",
          duration_ms: 400,
          timestamp: "2026-06-28T00:00:00.000Z",
        }),
      ]),
      "utf-8",
    );

    const stats = aggregateUsageStats(logsDir);
    assert.equal(stats.size, 1);

    const s = stats.get("single_tool");
    assert.ok(s);
    assert.equal(s!.totalCalls, 4);
    assert.equal(s!.successRate, 0.75);
    assert.equal(s!.avgDurationMs, 250);
    assert.equal(s!.lastUsedAt, "2026-06-28T00:00:00.000Z");
  });

  // ── 额外：缺少其他必要字段（duration_ms / result / timestamp）的行被跳过 ──

  it("缺少 duration_ms / result / timestamp 字段的行被跳过", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const missingDuration = JSON.stringify({
      timestamp: "2026-06-27T10:00:00.000Z",
      toolName: "no_duration",
      result: "ok",
    });
    const missingResult = JSON.stringify({
      timestamp: "2026-06-27T10:00:00.000Z",
      toolName: "no_result",
      duration_ms: 100,
    });
    const missingTimestamp = JSON.stringify({
      toolName: "no_timestamp",
      result: "ok",
      duration_ms: 100,
    });
    writeFileSync(
      join(logsDir, "invocation.log"),
      toRawLines([
        missingDuration,
        missingResult,
        missingTimestamp,
        JSON.stringify(sampleEntry({ toolName: "valid_tool", duration_ms: 200 })),
      ]),
      "utf-8",
    );

    const stats = aggregateUsageStats(logsDir);
    assert.equal(stats.size, 1, "仅 valid_tool 应被聚合");
    assert.ok(stats.has("valid_tool"));
    assert.ok(!stats.has("no_duration"));
    assert.ok(!stats.has("no_result"));
    assert.ok(!stats.has("no_timestamp"));
  });

  // ── 额外：返回的 ToolUsageStats 结构完整性 ────────────────────

  it("返回的 ToolUsageStats 包含全部字段且类型正确", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "invocation.log"),
      toJsonLines([
        sampleEntry({ toolName: "shape_tool", result: "ok", duration_ms: 42 }),
      ]),
      "utf-8",
    );

    const stats = aggregateUsageStats(logsDir);
    const s: ToolUsageStats | undefined = stats.get("shape_tool");
    assert.ok(s);
    assert.equal(typeof s!.totalCalls, "number");
    assert.equal(typeof s!.successRate, "number");
    assert.equal(typeof s!.avgDurationMs, "number");
    assert.equal(typeof s!.lastUsedAt, "string");
    assert.equal(s!.totalCalls, 1);
    assert.equal(s!.successRate, 1);
    assert.equal(s!.avgDurationMs, 42);
  });
});
