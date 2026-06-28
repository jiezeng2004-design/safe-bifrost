/**
 * v0.7.1: discover_tools MCP 工具封装。
 *
 * 搜索候选工具，返回压缩摘要和风险等级。
 * 不加入 chatgpt_core，仅 full profile。
 * v0.8.1: 为每个搜索结果生成 discoveryToken（server-side 保存）。
 * v0.9.0: 传入 usageStatsProvider，从 invocation.log 聚合历史成功率用于混合排序。
 */

import { join } from "node:path";
import type { ToolDef } from "./registry.js";
import { buildToolRegistry, type PatchWardenToolMeta } from "./toolRegistry.js";
import { discoverTools as searchDiscover, type DiscoverToolsInput } from "./toolSearch.js";
import { issueToken } from "../security/discoveryTokenStore.js";
import { aggregateUsageStats, type ToolUsageStats } from "./toolUsageStats.js";
import { getConfig } from "../config.js";

export function discoverTools(
  input: DiscoverToolsInput,
  tools: ToolDef[]
): ReturnType<typeof searchDiscover> {
  const registry: PatchWardenToolMeta[] = buildToolRegistry(tools);

  // v0.9.0: 从 invocation.log 聚合历史成功率，用于混合排序公式
  let usageMap: Map<string, ToolUsageStats> | null = null;
  try {
    const workspaceRoot = getConfig().workspaceRoot;
    const logsDir = join(workspaceRoot, ".patchwarden", "logs");
    usageMap = aggregateUsageStats(logsDir);
  } catch {
    // 配置读取失败或日志目录不存在时，无历史数据（不阻断搜索）
    usageMap = null;
  }

  return searchDiscover(
    input,
    registry,
    (tool) => {
      return issueToken({
        toolName: tool.name,
        risk: tool.risk,
        query: input.query,
        schemaDigest: tool.inputSchemaDigest,
        profile: input.profile ?? "full",
      });
    },
    usageMap
      ? (toolName: string) => usageMap!.get(toolName) ?? null
      : undefined,
  );
}
