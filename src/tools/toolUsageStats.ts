/**
 * v0.9.0: 工具历史成功率聚合模块。
 *
 * 从 v0.8.1 引入的 invocation.log（JSON Lines 格式）中聚合每个工具的
 * 调用统计，用于搜索排序。聚合维度包括：总调用数、成功率、平均耗时、
 * 最近一次调用时间。
 *
 * 设计原则：
 * - 只读，绝不修改 invocation.log。
 * - 容错：损坏的 JSON 行或缺少必要字段的行被跳过，不抛错、不阻断聚合。
 * - 不引入第三方依赖，仅使用 node:fs / node:path。
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── 类型定义 ──────────────────────────────────────────────────────

/**
 * 单个工具的历史调用统计。
 */
export interface ToolUsageStats {
  /** 总调用次数 */
  totalCalls: number;
  /** 成功率（0~1）：result==="ok" 的调用数 / totalCalls */
  successRate: number;
  /** 平均耗时（毫秒）：所有调用 duration_ms 的平均值 */
  avgDurationMs: number;
  /** 最近一次调用的 timestamp（ISO 字符串）；无调用时为 null */
  lastUsedAt: string | null;
}

// ── 内部聚合累加器 ────────────────────────────────────────────────

interface StatsAccumulator {
  totalCalls: number;
  successCount: number;
  totalDurationMs: number;
  lastUsedAt: string | null;
}

// ── 行级校验 ──────────────────────────────────────────────────────

/**
 * 校验单行解析结果是否包含聚合所需必要字段。
 * 必要字段：toolName（string）、result（string）、duration_ms（number）、timestamp（string）。
 * 缺少任一字段或类型不符的行将被跳过。
 */
function isValidEntry(entry: unknown): entry is {
  toolName: string;
  result: string;
  duration_ms: number;
  timestamp: string;
  [key: string]: unknown;
} {
  if (entry === null || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.toolName !== "string" || e.toolName.length === 0) return false;
  if (typeof e.result !== "string") return false;
  if (typeof e.duration_ms !== "number" || !Number.isFinite(e.duration_ms)) return false;
  if (typeof e.timestamp !== "string" || e.timestamp.length === 0) return false;
  return true;
}

// ── 聚合主函数 ────────────────────────────────────────────────────

/**
 * 从 `<logsDir>/invocation.log`（JSON Lines 格式）聚合每个工具的历史调用统计。
 *
 * 行为约定：
 * - `logsDir` 不存在或 invocation.log 不存在时返回空 Map（不抛错）。
 * - invocation.log 为空文件时返回空 Map（不抛错）。
 * - 损坏的 JSON 行被跳过（不阻断聚合、不抛错）。
 * - 缺少必要字段（toolName/result/duration_ms/timestamp）的行被跳过。
 * - successRate = result==="ok" 的数量 / totalCalls。
 * - avgDurationMs = 所有调用 duration_ms 的算术平均。
 * - lastUsedAt 取所有调用中最大的 timestamp（ISO 字符串按字典序即可比较）。
 *
 * @param logsDir 日志目录，函数会读取其中的 `invocation.log`
 * @returns 按工具名（toolName）索引的统计 Map
 */
export function aggregateUsageStats(logsDir: string): Map<string, ToolUsageStats> {
  const stats = new Map<string, ToolUsageStats>();

  // logsDir 不存在或 invocation.log 不存在时返回空 Map
  const logFilePath = join(logsDir, "invocation.log");
  let raw: string;
  try {
    if (!existsSync(logFilePath)) return stats;
    raw = readFileSync(logFilePath, "utf-8");
  } catch {
    // 读取失败（权限、IO 错误等）按空结果返回，不抛错
    return stats;
  }

  // 空文件直接返回空 Map
  if (raw.length === 0) return stats;

  const lines = raw.split("\n");
  const accumulators = new Map<string, StatsAccumulator>();

  for (const line of lines) {
    const trimmed = line.trim();
    // 跳过空行（包括文件末尾的尾随换行产生的空串）
    if (trimmed.length === 0) continue;

    // 损坏的 JSON 行跳过，不阻断聚合
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // 缺少必要字段的行跳过
    if (!isValidEntry(parsed)) continue;

    const { toolName, result, duration_ms, timestamp } = parsed;

    let acc = accumulators.get(toolName);
    if (!acc) {
      acc = {
        totalCalls: 0,
        successCount: 0,
        totalDurationMs: 0,
        lastUsedAt: null,
      };
      accumulators.set(toolName, acc);
    }

    acc.totalCalls += 1;
    if (result === "ok") acc.successCount += 1;
    acc.totalDurationMs += duration_ms;
    // ISO 8601 字符串按字典序即可正确比较时间先后
    if (acc.lastUsedAt === null || timestamp > acc.lastUsedAt) {
      acc.lastUsedAt = timestamp;
    }
  }

  // 将累加器转换为最终统计结果
  for (const [toolName, acc] of accumulators) {
    stats.set(toolName, {
      totalCalls: acc.totalCalls,
      successRate: acc.totalCalls > 0 ? acc.successCount / acc.totalCalls : 0,
      avgDurationMs: acc.totalCalls > 0 ? acc.totalDurationMs / acc.totalCalls : 0,
      lastUsedAt: acc.lastUsedAt,
    });
  }

  return stats;
}
