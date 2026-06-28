/**
 * v0.9.0: Schema 漂移检测模块。
 *
 * 检测 registry 元数据与实际工具 schema 是否漂移，
 * 并聚合为可被 doctor 自检消费的 SchemaDriftResult。
 *
 * 本模块只做检测和报告，不做运行时阻断。
 */

import { computeSchemaDigest } from "./toolRegistry.js";
import type { PatchWardenToolMeta } from "./toolRegistry.js";
import { CHATGPT_CORE_TOOL_NAMES } from "./toolCatalog.js";

// ── 结果类型 ──────────────────────────────────────────────────────

export interface SchemaDriftResult {
  /** true 表示无 drift，false 表示有 drift */
  ok: boolean;
  /** drift 描述列表（每个 drift 一条警告消息） */
  warnings: string[];
}

/** toolDefs Map 的值类型：至少包含 inputSchema。 */
export interface ToolDefLike {
  inputSchema: unknown;
}

/** chatgpt_core profile 的预期工具数（17）。 */
const EXPECTED_CORE_COUNT = CHATGPT_CORE_TOOL_NAMES.length;

// ── 检查 1: registry schema digest 一致性 ─────────────────────────

/**
 * 检查 registry 中记录的 inputSchemaDigest 与实际 toolDef 的 inputSchema digest 是否一致。
 * toolDefs 中找不到的工具会被跳过（不报 drift）。
 */
export function checkRegistrySchemaDigest(
  registry: PatchWardenToolMeta[],
  toolDefs: Map<string, ToolDefLike>,
): SchemaDriftResult {
  const warnings: string[] = [];
  for (const meta of registry) {
    const toolDef = toolDefs.get(meta.name);
    if (!toolDef) continue; // toolDefs 中找不到该工具时跳过（不报 drift）
    const actualDigest = computeSchemaDigest(toolDef.inputSchema);
    if (actualDigest !== meta.inputSchemaDigest) {
      warnings.push(
        `Schema drift for tool '${meta.name}': registry digest ${meta.inputSchemaDigest} != actual digest ${actualDigest}`,
      );
    }
  }
  return { ok: warnings.length === 0, warnings };
}

// ── 检查 2: chatgpt_core manifest 稳定性 ──────────────────────────

/**
 * 校验 chatgpt_core profile 的 17 工具 manifest 是否稳定。
 *
 * toolCatalog.ts 未导出独立的 manifest hash 计算函数（stableJson 为私有），
 * 因此采用 fallback 方案：校验 CHATGPT_CORE_TOOL_NAMES 中的 17 个工具名
 * 全部存在于 toolDefs 中（集合比较，不比较顺序——Map 迭代顺序取决于构造
 * 方式，不一定与 chatgpt_core profile 顺序一致）。
 *
 * 真正的顺序稳定性由 CHATGPT_CORE_TOOL_NAMES 常量本身保证（顺序固定），
 * 如果常量被修改，这里的名称集合比较也会检测到变化。
 */
export function checkChatgptCoreManifestStable(
  toolDefs: Map<string, ToolDefLike>,
): SchemaDriftResult {
  const warnings: string[] = [];
  const expected = [...CHATGPT_CORE_TOOL_NAMES];
  // 检查 CHATGPT_CORE_TOOL_NAMES 中的每个工具是否都存在于 toolDefs
  const missing = expected.filter((name) => !toolDefs.has(name));
  if (missing.length > 0) {
    warnings.push(
      `chatgpt_core manifest has missing tools: ${missing.join(", ")} (expected ${EXPECTED_CORE_COUNT}, got ${EXPECTED_CORE_COUNT - missing.length})`,
    );
  }
  return { ok: warnings.length === 0, warnings };
}

// ── 检查 3: chatgpt_core profile 工具数未变 ───────────────────────

/**
 * 校验 chatgpt_core profile 的工具数仍然是 17。
 * 用于检测是否有新工具被意外追加到 chatgpt_core profile。
 */
export function checkNewToolsProfileAppend(
  registry: PatchWardenToolMeta[],
): SchemaDriftResult {
  const warnings: string[] = [];
  const coreCount = registry.filter((t) => t.profiles.includes("chatgpt_core")).length;
  if (coreCount !== EXPECTED_CORE_COUNT) {
    warnings.push(
      `chatgpt_core profile tool count changed: expected ${EXPECTED_CORE_COUNT}, got ${coreCount}`,
    );
  }
  return { ok: warnings.length === 0, warnings };
}

// ── 聚合检查 ──────────────────────────────────────────────────────

/**
 * 聚合执行所有 schema drift 检查，合并 warnings。
 * ok = warnings.length === 0
 */
export function runAllSchemaDriftChecks(
  registry: PatchWardenToolMeta[],
  toolDefs: Map<string, ToolDefLike>,
): SchemaDriftResult {
  const warnings: string[] = [];
  const r1 = checkRegistrySchemaDigest(registry, toolDefs);
  warnings.push(...r1.warnings);
  const r2 = checkChatgptCoreManifestStable(toolDefs);
  warnings.push(...r2.warnings);
  const r3 = checkNewToolsProfileAppend(registry);
  warnings.push(...r3.warnings);
  return { ok: warnings.length === 0, warnings };
}
