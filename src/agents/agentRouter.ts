import { PatchWardenError } from "../errors.js";

// ── Types ─────────────────────────────────────────────────────────

export interface AgentRouteInput {
  goal?: string;
  scope?: string[];
  inline_plan?: string;
  template?: string;
  configuredAgents: string[];
}

export interface AgentRouteResult {
  recommended_agent: string;
  reason: string;
  fallback: boolean;
}

// ── Routing rules (roadmap 9.3) ───────────────────────────────────

export const AGENT_ROUTING_RULES = {
  /** 大规模代码修改 → opencode */
  largeScope: {
    agent: "opencode",
    threshold: 10, // scope.length > threshold
  },
  /** 单文件修改 → patchwarden-direct */
  singleFile: {
    agent: "patchwarden-direct",
  },
  /** 验收审计 → patchwarden-audit */
  audit: {
    agent: "patchwarden-audit",
    keywords: ["审计", "audit", "验收", "verify"],
  },
  /** 复杂推理和重构 → codex */
  refactor: {
    agent: "codex",
    keywords: ["重构", "refactor", "跨模块", "redesign"],
  },
  /** 文档整理 → claude（fallback 到 opencode） */
  documentation: {
    agent: "claude",
    fallbackAgent: "opencode",
    keywords: ["文档", "readme", "changelog", "doc"],
  },
} as const;

// ── Helpers ───────────────────────────────────────────────────────

function containsAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function resolveRoute(
  preferred: string,
  reason: string,
  configuredAgents: string[]
): AgentRouteResult {
  if (configuredAgents.includes(preferred)) {
    return { recommended_agent: preferred, reason, fallback: false };
  }
  const fallback = configuredAgents[0];
  return {
    recommended_agent: fallback,
    reason: `fallback: ${preferred} not configured, using ${fallback}`,
    fallback: true,
  };
}

// ── Route agent ───────────────────────────────────────────────────

export function routeAgent(input: AgentRouteInput): AgentRouteResult {
  if (!input.configuredAgents || input.configuredAgents.length === 0) {
    throw new PatchWardenError(
      "no_agent_configured",
      "No agent is configured for routing.",
      "Configure at least one agent in patchwarden.config.json under the agents field."
    );
  }

  const scopeCount = input.scope?.length ?? 0;
  const text = `${input.goal || ""} ${input.inline_plan || ""}`.toLowerCase();

  // Rule 1: 大规模代码修改 → opencode (scope files > 10)
  if (scopeCount > AGENT_ROUTING_RULES.largeScope.threshold) {
    return resolveRoute(
      AGENT_ROUTING_RULES.largeScope.agent,
      `large scope (${scopeCount} files)`,
      input.configuredAgents
    );
  }

  // Rule 2: 单文件修改 → patchwarden-direct (scope files === 1)
  if (scopeCount === 1) {
    return resolveRoute(
      AGENT_ROUTING_RULES.singleFile.agent,
      "single file scope",
      input.configuredAgents
    );
  }

  // Rule 3: 验收审计 → patchwarden-audit
  if (containsAny(text, AGENT_ROUTING_RULES.audit.keywords)) {
    return resolveRoute(
      AGENT_ROUTING_RULES.audit.agent,
      "audit keywords",
      input.configuredAgents
    );
  }

  // Rule 4: 复杂推理和重构 → codex
  if (containsAny(text, AGENT_ROUTING_RULES.refactor.keywords)) {
    return resolveRoute(
      AGENT_ROUTING_RULES.refactor.agent,
      "refactor keywords",
      input.configuredAgents
    );
  }

  // Rule 5: 文档整理 → claude（fallback 到 opencode）
  if (containsAny(text, AGENT_ROUTING_RULES.documentation.keywords)) {
    const preferred = AGENT_ROUTING_RULES.documentation.agent;
    const fallbackAgent = AGENT_ROUTING_RULES.documentation.fallbackAgent;
    if (input.configuredAgents.includes(preferred)) {
      return { recommended_agent: preferred, reason: "documentation keywords", fallback: false };
    }
    if (input.configuredAgents.includes(fallbackAgent)) {
      return {
        recommended_agent: fallbackAgent,
        reason: `fallback: ${preferred} not configured, using ${fallbackAgent}`,
        fallback: true,
      };
    }
    const firstAgent = input.configuredAgents[0];
    return {
      recommended_agent: firstAgent,
      reason: `fallback: ${preferred} not configured, using ${firstAgent}`,
      fallback: true,
    };
  }

  // Rule 6: 无匹配 → fallback 到 configuredAgents[0]
  return {
    recommended_agent: input.configuredAgents[0],
    reason: `no specific routing rule matched, using default agent ${input.configuredAgents[0]}`,
    fallback: true,
  };
}
