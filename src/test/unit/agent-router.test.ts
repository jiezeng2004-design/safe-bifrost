import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  routeAgent,
  AGENT_ROUTING_RULES,
  type AgentRouteInput,
} from "../../agents/agentRouter.js";
import { PatchWardenError } from "../../errors.js";

// ── Helpers ───────────────────────────────────────────────────────

const ALL_AGENTS = ["codex", "opencode", "claude", "patchwarden-direct", "patchwarden-audit"];

function scopeFiles(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `file_${i}.ts`);
}

// ── Tests ─────────────────────────────────────────────────────────

describe("routeAgent", () => {
  // ── 1. 大规模代码修改 → opencode ────────────────────────────────

  it("scope 15 个文件 → opencode, fallback=false, reason 含 'large scope'", () => {
    const result = routeAgent({
      goal: "大规模修改",
      scope: scopeFiles(15),
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "opencode");
    assert.equal(result.fallback, false);
    assert.ok(result.reason.includes("large scope"), `reason should contain 'large scope', got: ${result.reason}`);
    assert.ok(result.reason.includes("15"), `reason should contain file count '15', got: ${result.reason}`);
    assert.ok(ALL_AGENTS.includes(result.recommended_agent));
  });

  // ── 2. 单文件修改 → patchwarden-direct ──────────────────────────

  it("scope 1 个文件 → patchwarden-direct, fallback=false", () => {
    const result = routeAgent({
      goal: "修复一个 bug",
      scope: ["src/index.ts"],
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "patchwarden-direct");
    assert.equal(result.fallback, false);
    assert.ok(ALL_AGENTS.includes(result.recommended_agent));
  });

  // ── 3. 文档整理 → claude ────────────────────────────────────────

  it("goal 含 '更新 README 文档' → claude（若 configured）", () => {
    const result = routeAgent({
      goal: "更新 README 文档",
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "claude");
    assert.equal(result.fallback, false);
    assert.ok(result.reason.includes("documentation"), `reason should contain 'documentation', got: ${result.reason}`);
    assert.ok(ALL_AGENTS.includes(result.recommended_agent));
  });

  it("goal 含文档关键词但 claude 未配置 → fallback 到 opencode", () => {
    const configured = ["codex", "opencode"];
    const result = routeAgent({
      goal: "更新 README 文档",
      configuredAgents: configured,
    });
    assert.equal(result.recommended_agent, "opencode");
    assert.equal(result.fallback, true);
    assert.ok(configured.includes(result.recommended_agent));
  });

  it("goal 含文档关键词但 claude 和 opencode 都未配置 → fallback 到第一个", () => {
    const configured = ["codex"];
    const result = routeAgent({
      goal: "更新 README 文档",
      configuredAgents: configured,
    });
    assert.equal(result.recommended_agent, "codex");
    assert.equal(result.fallback, true);
    assert.ok(configured.includes(result.recommended_agent));
  });

  // ── 4. 复杂推理和重构 → codex ───────────────────────────────────

  it("goal 含 '跨模块重构' → codex", () => {
    const result = routeAgent({
      goal: "跨模块重构认证模块",
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "codex");
    assert.equal(result.fallback, false);
    assert.ok(result.reason.includes("refactor"), `reason should contain 'refactor', got: ${result.reason}`);
    assert.ok(ALL_AGENTS.includes(result.recommended_agent));
  });

  it("goal 含 'redesign' → codex", () => {
    const result = routeAgent({
      goal: "Redesign the data layer",
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "codex");
    assert.equal(result.fallback, false);
    assert.ok(ALL_AGENTS.includes(result.recommended_agent));
  });

  // ── 5. 验收审计 → patchwarden-audit ─────────────────────────────

  it("goal 含 '审计任务' → patchwarden-audit", () => {
    const result = routeAgent({
      goal: "执行验收审计任务",
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "patchwarden-audit");
    assert.equal(result.fallback, false);
    assert.ok(result.reason.includes("audit"), `reason should contain 'audit', got: ${result.reason}`);
    assert.ok(ALL_AGENTS.includes(result.recommended_agent));
  });

  it("goal 含 'verify' → patchwarden-audit", () => {
    const result = routeAgent({
      goal: "verify the release artifacts",
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "patchwarden-audit");
    assert.equal(result.fallback, false);
    assert.ok(ALL_AGENTS.includes(result.recommended_agent));
  });

  // ── 6. 无匹配 → fallback 到 configuredAgents[0] ────────────────

  it("无匹配（goal='普通任务', scope=['a.ts','b.ts']）→ fallback=true, recommended_agent=configuredAgents[0]", () => {
    const configured = ["codex", "opencode"];
    const result = routeAgent({
      goal: "普通任务",
      scope: ["a.ts", "b.ts"],
      configuredAgents: configured,
    });
    assert.equal(result.recommended_agent, configured[0]);
    assert.equal(result.fallback, true);
    assert.ok(configured.includes(result.recommended_agent));
  });

  // ── 7. 白名单约束：推荐结果必须在 configuredAgents 中 ──────────

  it("所有场景断言 result.recommended_agent 在 configuredAgents 中", () => {
    const configured = ["codex", "opencode"];
    const inputs: AgentRouteInput[] = [
      { goal: "大规模修改", scope: scopeFiles(15), configuredAgents: configured },
      { goal: "单文件", scope: ["a.ts"], configuredAgents: configured },
      { goal: "审计任务", configuredAgents: configured },
      { goal: "重构模块", configuredAgents: configured },
      { goal: "更新文档", configuredAgents: configured },
      { goal: "普通任务", scope: ["a.ts", "b.ts"], configuredAgents: configured },
    ];
    for (const input of inputs) {
      const result = routeAgent(input);
      assert.ok(
        configured.includes(result.recommended_agent),
        `recommended_agent "${result.recommended_agent}" not in configuredAgents [${configured.join(", ")}] for goal "${input.goal}"`
      );
    }
  });

  it("白名单约束：opencode 未配置时大规模 scope 回退到第一个 agent", () => {
    const configured = ["codex"];
    const result = routeAgent({
      goal: "大规模修改",
      scope: scopeFiles(15),
      configuredAgents: configured,
    });
    assert.equal(result.recommended_agent, "codex");
    assert.equal(result.fallback, true);
    assert.ok(result.reason.includes("fallback"), `reason should contain 'fallback', got: ${result.reason}`);
    assert.ok(configured.includes(result.recommended_agent));
  });

  it("白名单约束：patchwarden-direct 未配置时单文件 scope 回退", () => {
    const configured = ["codex", "opencode"];
    const result = routeAgent({
      goal: "修复 bug",
      scope: ["a.ts"],
      configuredAgents: configured,
    });
    assert.equal(result.recommended_agent, "codex");
    assert.equal(result.fallback, true);
    assert.ok(configured.includes(result.recommended_agent));
  });

  it("白名单约束：patchwarden-audit 未配置时审计任务回退", () => {
    const configured = ["codex", "opencode"];
    const result = routeAgent({
      goal: "审计任务",
      configuredAgents: configured,
    });
    assert.equal(result.recommended_agent, "codex");
    assert.equal(result.fallback, true);
    assert.ok(configured.includes(result.recommended_agent));
  });

  it("白名单约束：codex 未配置时重构任务回退", () => {
    const configured = ["opencode"];
    const result = routeAgent({
      goal: "跨模块重构",
      configuredAgents: configured,
    });
    assert.equal(result.recommended_agent, "opencode");
    assert.equal(result.fallback, true);
    assert.ok(configured.includes(result.recommended_agent));
  });

  // ── 8. configuredAgents 为空 → 抛错 ────────────────────────────

  it("configuredAgents 为空 → 抛 PatchWardenError(no_agent_configured)", () => {
    assert.throws(
      () => routeAgent({ goal: "任意任务", configuredAgents: [] }),
      (err: unknown) => {
        assert.ok(err instanceof PatchWardenError, "err should be PatchWardenError");
        assert.equal((err as PatchWardenError).reason, "no_agent_configured");
        return true;
      }
    );
  });

  // ── 9. 路由规则优先级验证 ───────────────────────────────────────

  it("优先级：scope > 10 优先于文档关键词", () => {
    // scope 15 个文件 + goal 含文档关键词 → opencode（规则1 优先于规则5）
    const result = routeAgent({
      goal: "更新文档",
      scope: scopeFiles(15),
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "opencode");
    assert.equal(result.fallback, false);
  });

  it("优先级：scope === 1 优先于审计关键词", () => {
    // scope 1 个文件 + goal 含审计关键词 → patchwarden-direct（规则2 优先于规则3）
    const result = routeAgent({
      goal: "审计任务",
      scope: ["a.ts"],
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "patchwarden-direct");
    assert.equal(result.fallback, false);
  });

  it("优先级：审计关键词优先于重构关键词", () => {
    // goal 同时含审计和重构关键词 → patchwarden-audit（规则3 优先于规则4）
    const result = routeAgent({
      goal: "审计重构模块",
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "patchwarden-audit");
    assert.equal(result.fallback, false);
  });

  it("优先级：重构关键词优先于文档关键词", () => {
    // goal 同时含重构和文档关键词 → codex（规则4 优先于规则5）
    const result = routeAgent({
      goal: "重构文档模块",
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "codex");
    assert.equal(result.fallback, false);
  });

  // ── 10. inline_plan 文本特征匹配 ────────────────────────────────

  it("inline_plan 含重构关键词 → codex", () => {
    const result = routeAgent({
      goal: "改进代码",
      inline_plan: "需要 refactor 数据访问层",
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "codex");
    assert.equal(result.fallback, false);
  });

  it("inline_plan 含审计关键词 → patchwarden-audit", () => {
    const result = routeAgent({
      goal: "检查工作",
      inline_plan: "执行 audit 验收流程",
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "patchwarden-audit");
    assert.equal(result.fallback, false);
  });

  // ── 11. AGENT_ROUTING_RULES 常量结构断言 ────────────────────────

  it("AGENT_ROUTING_RULES 导出完整路由规则结构", () => {
    assert.equal(AGENT_ROUTING_RULES.largeScope.agent, "opencode");
    assert.equal(AGENT_ROUTING_RULES.largeScope.threshold, 10);

    assert.equal(AGENT_ROUTING_RULES.singleFile.agent, "patchwarden-direct");

    assert.equal(AGENT_ROUTING_RULES.audit.agent, "patchwarden-audit");
    assert.ok(AGENT_ROUTING_RULES.audit.keywords.includes("审计"));
    assert.ok(AGENT_ROUTING_RULES.audit.keywords.includes("audit"));
    assert.ok(AGENT_ROUTING_RULES.audit.keywords.includes("验收"));
    assert.ok(AGENT_ROUTING_RULES.audit.keywords.includes("verify"));

    assert.equal(AGENT_ROUTING_RULES.refactor.agent, "codex");
    assert.ok(AGENT_ROUTING_RULES.refactor.keywords.includes("重构"));
    assert.ok(AGENT_ROUTING_RULES.refactor.keywords.includes("refactor"));
    assert.ok(AGENT_ROUTING_RULES.refactor.keywords.includes("跨模块"));
    assert.ok(AGENT_ROUTING_RULES.refactor.keywords.includes("redesign"));

    assert.equal(AGENT_ROUTING_RULES.documentation.agent, "claude");
    assert.equal(AGENT_ROUTING_RULES.documentation.fallbackAgent, "opencode");
    assert.ok(AGENT_ROUTING_RULES.documentation.keywords.includes("文档"));
    assert.ok(AGENT_ROUTING_RULES.documentation.keywords.includes("readme"));
    assert.ok(AGENT_ROUTING_RULES.documentation.keywords.includes("changelog"));
    assert.ok(AGENT_ROUTING_RULES.documentation.keywords.includes("doc"));
  });

  // ── 12. scope 边界值测试 ────────────────────────────────────────

  it("scope 正好 10 个文件（threshold 边界）→ 不触发 large scope 规则", () => {
    // threshold 是 10，> 10 才触发，所以 10 个文件不触发规则1
    const result = routeAgent({
      goal: "普通任务",
      scope: scopeFiles(10),
      configuredAgents: ALL_AGENTS,
    });
    // 10 个文件不触发规则1，也不触发规则2（不是1个），无关键词 → fallback
    assert.equal(result.fallback, true);
    assert.equal(result.recommended_agent, ALL_AGENTS[0]);
  });

  it("scope 正好 11 个文件 → 触发 large scope 规则", () => {
    const result = routeAgent({
      goal: "普通任务",
      scope: scopeFiles(11),
      configuredAgents: ALL_AGENTS,
    });
    assert.equal(result.recommended_agent, "opencode");
    assert.equal(result.fallback, false);
  });
});
