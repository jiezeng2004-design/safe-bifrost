/**
 * v0.7.1: explain_tool MCP 工具封装。
 *
 * 展开单个工具详情，可选包含完整 inputSchema。
 * 不加入 chatgpt_core，仅 full profile。
 * v0.8.1: includeSchema=true 时通过 tokenPeeker 二次确认 schema digest，
 *         检测 registry 与实际 toolDef 之间的 schema drift。
 */

import type { ToolDef } from "./registry.js";
import { buildToolRegistry, computeSchemaDigest, type PatchWardenToolMeta } from "./toolRegistry.js";
import { explainTool as searchExplain, type ExplainToolInput } from "./toolSearch.js";

export function explainTool(
  input: ExplainToolInput,
  tools: ToolDef[]
): ReturnType<typeof searchExplain> {
  const registry: PatchWardenToolMeta[] = buildToolRegistry(tools);
  const toolDefsMap = new Map(tools.map((t) => [t.name, t]));
  return searchExplain(input, registry, toolDefsMap, (toolName) => {
    const toolDef = toolDefsMap.get(toolName);
    if (!toolDef) return null;
    const currentDigest = computeSchemaDigest(toolDef.inputSchema);
    return { schemaDigest: currentDigest };
  });
}
