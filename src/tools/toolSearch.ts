/**
 * v0.7.1: SafeToolSearch 搜索引擎 — 只读发现层。
 *
 * 实现 discoverTools（搜索候选工具）和 explainTool（展开工具详情）。
 * 搜索算法：
 *   1. 读取所有 ToolMeta
 *   2. 按 profile / mode / riskCeiling 过滤
 *   3. query 中英文归一化 + INTENT_TERMS 叠加
 *   4. 按 name / title / tags / aliases / summary / description 加权打分
 *   5. 排序返回 topK
 *   6. 对被隐藏的高风险工具返回 hidden_results
 */

import {
  TOOL_RISK_RANK,
  INTENT_TERMS,
  type PatchWardenToolMeta,
  type ToolRisk,
  type ToolMode,
} from "./toolRegistry.js";
import type { ToolProfile } from "./toolCatalog.js";
import type { ToolUsageStats } from "./toolUsageStats.js";

// ── 类型定义 ──────────────────────────────────────────────────────

export interface DiscoverToolsInput {
  query: string;
  profile?: ToolProfile;
  mode?: ToolMode;
  maxResults?: number; // 默认 8
  riskCeiling?: ToolRisk; // 最高允许风险等级
  includeHighRisk?: boolean; // 默认 false（隐藏 command/release/credential_sensitive）
}

export interface DiscoverToolResult {
  name: string;
  title: string;
  summary: string;
  risk: ToolRisk;
  schema_digest: string;
  discoveryToken: string; // v0.8.1: server-side token id，由 tokenIssuer 生成
  why: string;
}

export interface HiddenResultGroup {
  risk: ToolRisk;
  count: number;
  reason: string;
}

// ── v0.9.0: 查询意图分类 ──────────────────────────────────────────

export type QueryIntent = "read" | "write" | "verify" | "release" | "diagnose" | "unknown";

/**
 * 意图优先风险等级映射（roadmap 8.3）。
 * verify 和 diagnose 意图在 ToolRisk 中没有 audit/diagnostic，
 * 用 readonly/workspace_read_sensitive 替代（审计/诊断工具通常是只读的）。
 */
export const INTENT_PRIORITY_RISK: Record<QueryIntent, ToolRisk[]> = {
  read: ["readonly", "workspace_read_sensitive"],
  write: ["workspace_write"],
  verify: ["readonly", "workspace_read_sensitive"],
  release: ["release"],
  diagnose: ["readonly", "workspace_read_sensitive"],
  unknown: [],
};

export interface DiscoverToolsOutput {
  query: string;
  intent: QueryIntent; // v0.9.0: 查询意图分类
  results: DiscoverToolResult[];
  hidden_results: HiddenResultGroup[];
  total_matched: number;
  total_hidden: number;
}

export interface ExplainToolInput {
  name: string;
  includeSchema?: boolean;
}

export interface ExplainToolOutput {
  name: string;
  title: string;
  summary: string;
  description: string;
  risk: ToolRisk;
  risk_rank: number;
  profiles: ToolProfile[];
  modes: ToolMode[];
  tags: string[];
  aliases: string[];
  requires_confirmation: boolean;
  schema_digest: string;
  related_tools: string[];
  input_schema?: unknown;
  schema_drift_warning?: string; // v0.8.1: schema digest 不一致时警告
}

// ── 常量 ──────────────────────────────────────────────────────────

/** 高风险等级：默认隐藏（除非 includeHighRisk=true 或 riskCeiling 明确覆盖） */
const HIGH_RISK_LEVELS: ToolRisk[] = ["command", "release", "credential_sensitive"];

/** 规则匹配权重（ruleScore 分量） */
const RULE_WEIGHTS = {
  name: 10,
  title: 8,
  summary: 4,
  description: 2,
} as const;

/** 标签匹配权重（tagScore 分量） */
const TAG_WEIGHTS = {
  tag: 6,
  alias: 6,
} as const;

const DEFAULT_MAX_RESULTS = 8;

// ── 搜索引擎 ──────────────────────────────────────────────────────

/**
 * 将 query 拆分为搜索 token（小写、去空格）。
 * 同时展开中文意图词（INTENT_TERMS）。
 */
function tokenizeQuery(query: string): string[] {
  const normalized = query.toLowerCase().trim();
  if (!normalized) return [];

  const tokens = new Set<string>();

  // 按空格和标点拆分英文/数字 token
  const rawTokens = normalized.split(/[\s,，;；、|]+/).filter(Boolean);
  for (const token of rawTokens) {
    tokens.add(token);
  }

  // 整体 query 也作为一个 token（用于精确匹配）
  if (normalized.length > 0) {
    tokens.add(normalized);
  }

  // 展开中文意图词
  for (const [intent, terms] of Object.entries(INTENT_TERMS)) {
    if (normalized.includes(intent.toLowerCase())) {
      for (const term of terms) {
        tokens.add(term.toLowerCase());
      }
    }
  }

  return Array.from(tokens);
}

/**
 * 计算单个工具对 token 的匹配得分，分为两个分量：
 * - ruleScore：name/title/summary/description 的匹配得分
 * - tagScore：tags/aliases 的匹配得分
 * matchedFields 保持不变。
 */
function scoreTool(
  tool: PatchWardenToolMeta,
  tokens: string[]
): { ruleScore: number; tagScore: number; matchedFields: string[] } {
  let ruleScore = 0;
  let tagScore = 0;
  const matchedFields: string[] = [];

  if (tokens.length === 0) {
    return { ruleScore: 0, tagScore: 0, matchedFields };
  }

  const nameLower = tool.name.toLowerCase();
  const titleLower = tool.title.toLowerCase();
  const summaryLower = tool.summary.toLowerCase();
  const descLower = tool.description.toLowerCase();
  const tagsLower = tool.tags.map((t) => t.toLowerCase());
  const aliasesLower = tool.aliases.map((a) => a.toLowerCase());

  for (const token of tokens) {
    if (nameLower.includes(token)) {
      ruleScore += RULE_WEIGHTS.name;
      if (!matchedFields.includes("name")) matchedFields.push("name");
    }
    if (titleLower.includes(token)) {
      ruleScore += RULE_WEIGHTS.title;
      if (!matchedFields.includes("title")) matchedFields.push("title");
    }
    if (tagsLower.some((t) => t.includes(token) || token.includes(t))) {
      tagScore += TAG_WEIGHTS.tag;
      if (!matchedFields.includes("tags")) matchedFields.push("tags");
    }
    if (aliasesLower.some((a) => a.includes(token) || token.includes(a))) {
      tagScore += TAG_WEIGHTS.alias;
      if (!matchedFields.includes("aliases")) matchedFields.push("aliases");
    }
    if (summaryLower.includes(token)) {
      ruleScore += RULE_WEIGHTS.summary;
      if (!matchedFields.includes("summary")) matchedFields.push("summary");
    }
    if (descLower.includes(token)) {
      ruleScore += RULE_WEIGHTS.description;
      if (!matchedFields.includes("description")) matchedFields.push("description");
    }
  }

  return { ruleScore, tagScore, matchedFields };
}

/**
 * 判断工具是否应被隐藏（高风险 + includeHighRisk=false）。
 */
function isHiddenByRisk(
  tool: PatchWardenToolMeta,
  riskCeiling: ToolRisk | undefined,
  includeHighRisk: boolean
): boolean {
  // riskCeiling 优先：如果设了 riskCeiling，超过 ceiling 的一律隐藏
  if (riskCeiling !== undefined) {
    return TOOL_RISK_RANK[tool.risk] > TOOL_RISK_RANK[riskCeiling];
  }
  // 没设 riskCeiling 但 includeHighRisk=false：隐藏高风险
  if (!includeHighRisk && HIGH_RISK_LEVELS.includes(tool.risk)) {
    return true;
  }
  return false;
}

// ── v0.9.0: 混合排序公式分量 ──────────────────────────────────────

/**
 * 风险等级对应的 bonus/penalty（roadmap 8.2）。
 * 风险越低加分越高，风险越高扣分越多。
 */
export function riskBonusOrPenalty(risk: ToolRisk): number {
  switch (risk) {
    case "readonly":
      return 1;
    case "workspace_read_sensitive":
      return 0.5;
    case "workspace_write":
      return 0;
    case "command":
      return -0.5;
    case "release":
      return -1;
    case "credential_sensitive":
      return -1;
  }
}

/**
 * 混合排序公式（roadmap 8.2）：
 *   final_score = rule_score * 0.45 + tag_score * 0.25 + profile_match * 0.15
 *               + history_score * 0.10 + risk_bonus_or_penalty * 0.05
 *
 * - ruleScore: name/title/summary/description 匹配得分
 * - tagScore: tags/aliases 匹配得分
 * - profileMatch: 0 或 1，工具是否属于当前 profile
 * - historyScore: successRate * 5，范围 [0, 5]；无历史数据时为 0
 * - riskBonus: 来自 riskBonusOrPenalty
 */
export function computeFinalScore(
  ruleScore: number,
  tagScore: number,
  profileMatch: number,
  historyScore: number,
  riskBonus: number
): number {
  return (
    ruleScore * 0.45 +
    tagScore * 0.25 +
    profileMatch * 0.15 +
    historyScore * 0.10 +
    riskBonus * 0.05
  );
}

/**
 * 查询意图分类（roadmap 8.3）。
 * 不区分大小写，query 包含触发词即命中。
 * 按 read → write → verify → release → diagnose 顺序匹配，第一个命中的意图即返回。
 * 都不命中返回 "unknown"。
 */
export function classifyQueryIntent(query: string): QueryIntent {
  const lower = query.toLowerCase();
  const readTriggers = ["read", "查看", "读取", "看看"];
  const writeTriggers = ["fix", "patch", "修改", "修复"];
  const verifyTriggers = ["test", "check", "验收", "检查"];
  const releaseTriggers = ["release", "publish", "deploy", "发布"];
  const diagnoseTriggers = ["卡住", "running", "stale", "旧任务"];

  if (readTriggers.some((t) => lower.includes(t.toLowerCase()))) return "read";
  if (writeTriggers.some((t) => lower.includes(t.toLowerCase()))) return "write";
  if (verifyTriggers.some((t) => lower.includes(t.toLowerCase()))) return "verify";
  if (releaseTriggers.some((t) => lower.includes(t.toLowerCase()))) return "release";
  if (diagnoseTriggers.some((t) => lower.includes(t.toLowerCase()))) return "diagnose";
  return "unknown";
}

// ── 公开 API ──────────────────────────────────────────────────────

/**
 * discoverTools: 搜索候选工具，返回压缩摘要。
 * v0.9.0: 升级为混合排序公式（5 维加权）+ 查询意图分类。
 */
export function discoverTools(
  input: DiscoverToolsInput,
  registry: PatchWardenToolMeta[],
  tokenIssuer?: (tool: PatchWardenToolMeta) => string,
  usageStatsProvider?: (toolName: string) => ToolUsageStats | null
): DiscoverToolsOutput {
  const {
    query,
    profile,
    mode,
    maxResults = DEFAULT_MAX_RESULTS,
    riskCeiling,
    includeHighRisk = false,
  } = input;

  // v0.9.0: 查询意图分类
  const intent = classifyQueryIntent(query);
  const tokens = tokenizeQuery(query);

  // 1. 按 profile / mode 过滤
  let candidates = registry.filter((tool) => {
    if (profile && !tool.profiles.includes(profile)) return false;
    if (mode && !tool.modes.includes(mode)) return false;
    return true;
  });

  // 2. 分离可见/隐藏工具（风险过滤在打分前执行，historyScore 不影响过滤）
  const visible: Array<{ tool: PatchWardenToolMeta; finalScore: number; matchedFields: string[] }> = [];
  const hidden: PatchWardenToolMeta[] = [];

  for (const tool of candidates) {
    if (isHiddenByRisk(tool, riskCeiling, includeHighRisk)) {
      hidden.push(tool);
    } else {
      const { ruleScore, tagScore, matchedFields } = scoreTool(tool, tokens);

      // profileMatch：工具是否属于当前 profile（input.profile 存在且 tool.profiles 包含）
      const profileMatch = profile && tool.profiles.includes(profile) ? 1 : 0;

      // historyScore：来自 usageStatsProvider，无 provider 或无数据时为 0
      let historyScore = 0;
      if (usageStatsProvider) {
        const stats = usageStatsProvider(tool.name);
        if (stats) {
          historyScore = stats.successRate * 5;
        }
      }

      // riskBonus：来自风险等级；无 usageStatsProvider 时不应用
      // （退化为规则打分+意图微调，向后兼容 v0.7.1，spec SubTask 2.6）
      const riskBonus = usageStatsProvider ? riskBonusOrPenalty(tool.risk) : 0;

      // 混合排序公式
      let finalScore = computeFinalScore(ruleScore, tagScore, profileMatch, historyScore, riskBonus);

      // 意图微调：仅打破平局（+0.01）
      if (intent !== "unknown" && INTENT_PRIORITY_RISK[intent].includes(tool.risk)) {
        finalScore += 0.01;
      }

      visible.push({ tool, finalScore, matchedFields });
    }
  }

  // 3. 排序：finalScore 降序，同分按 name 字母序
  visible.sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    return a.tool.name.localeCompare(b.tool.name);
  });

  // 4. 取 topK
  const topK = visible.slice(0, maxResults);

  // 5. 构造结果
  const results: DiscoverToolResult[] = topK.map(({ tool, matchedFields }) => ({
    name: tool.name,
    title: tool.title,
    summary: tool.summary,
    risk: tool.risk,
    schema_digest: tool.inputSchemaDigest,
    discoveryToken: tokenIssuer ? tokenIssuer(tool) : "",
    why: matchedFields.length > 0
      ? `matched: ${matchedFields.join(", ")}`
      : "no direct match (included for browsing)",
  }));

  // 6. hidden_results 按风险等级分组统计
  const hiddenByRisk = new Map<ToolRisk, number>();
  for (const tool of hidden) {
    hiddenByRisk.set(tool.risk, (hiddenByRisk.get(tool.risk) ?? 0) + 1);
  }
  const hidden_results: HiddenResultGroup[] = Array.from(hiddenByRisk.entries())
    .sort(([a], [b]) => TOOL_RISK_RANK[a] - TOOL_RISK_RANK[b])
    .map(([risk, count]) => ({
      risk,
      count,
      reason: riskCeiling
        ? `exceeds riskCeiling=${riskCeiling}`
        : `includeHighRisk=false`,
    }));

  return {
    query,
    intent,
    results,
    hidden_results,
    total_matched: results.length,
    total_hidden: hidden.length,
  };
}

/**
 * explainTool: 展开单个工具详情。
 */
export function explainTool(
  input: ExplainToolInput,
  registry: PatchWardenToolMeta[],
  toolDefs?: Map<string, { inputSchema: unknown }>,
  tokenPeeker?: (toolName: string) => { schemaDigest: string } | null
): ExplainToolOutput | null {
  const tool = registry.find((t) => t.name === input.name || t.aliases.includes(input.name));
  if (!tool) return null;

  const output: ExplainToolOutput = {
    name: tool.name,
    title: tool.title,
    summary: tool.summary,
    description: tool.description,
    risk: tool.risk,
    risk_rank: TOOL_RISK_RANK[tool.risk],
    profiles: tool.profiles,
    modes: tool.modes,
    tags: tool.tags,
    aliases: tool.aliases,
    requires_confirmation: tool.requiresConfirmation,
    schema_digest: tool.inputSchemaDigest,
    related_tools: tool.relatedTools ?? [],
  };

  if (input.includeSchema && toolDefs) {
    const def = toolDefs.get(tool.name);
    if (def) {
      output.input_schema = def.inputSchema;
    }
  }

  // v0.8.1: schema drift 检测——比较 tokenPeeker 返回的 digest 与 registry 记录的 digest
  if (input.includeSchema && tokenPeeker) {
    const tokenRecord = tokenPeeker(tool.name);
    if (tokenRecord && tokenRecord.schemaDigest !== tool.inputSchemaDigest) {
      output.schema_drift_warning = `Schema digest mismatch: token recorded ${tokenRecord.schemaDigest}, current tool has ${tool.inputSchemaDigest}. Tool schema may have changed since discovery.`;
    }
  }

  return output;
}
