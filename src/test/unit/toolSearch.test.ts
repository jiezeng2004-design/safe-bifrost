import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildToolRegistry,
  computeSchemaDigest,
  TOOL_RISK_RANK,
  type PatchWardenToolMeta,
  type ToolRisk,
} from "../../tools/toolRegistry.js";
import {
  discoverTools,
  explainTool,
  computeFinalScore,
  riskBonusOrPenalty,
  classifyQueryIntent,
  INTENT_PRIORITY_RISK,
  type QueryIntent,
} from "../../tools/toolSearch.js";
import {
  selectToolsForProfile,
  resolveToolProfile,
  CHATGPT_SEARCH_TOOL_NAMES,
} from "../../tools/toolCatalog.js";
import type { ToolDef } from "../../tools/registry.js";
import type { ToolUsageStats } from "../../tools/toolUsageStats.js";

// ── Mock tool definitions ─────────────────────────────────────────

function makeTool(name: string, inputSchema: Record<string, unknown> = {}): ToolDef {
  return {
    name,
    description: `Description for ${name}`,
    inputSchema: {
      type: "object" as const,
      properties: inputSchema,
    },
  };
}

const MOCK_TOOLS: ToolDef[] = [
  makeTool("health_check", { detail: { type: "string" } }),
  makeTool("list_agents"),
  makeTool("list_workspace"),
  makeTool("list_tasks", { repo_path: { type: "string" }, active_only: { type: "boolean" } }),
  makeTool("get_task_status", { task_id: { type: "string" } }),
  makeTool("get_diff", { task_id: { type: "string" } }),
  makeTool("get_result", { task_id: { type: "string" } }),
  makeTool("get_result_json", { task_id: { type: "string" } }),
  makeTool("get_test_log", { task_id: { type: "string" } }),
  makeTool("get_task_log_tail", { task_id: { type: "string" } }),
  makeTool("get_task_progress", { task_id: { type: "string" } }),
  makeTool("get_task_summary", { task_id: { type: "string" } }),
  makeTool("safe_status", { task_id: { type: "string" } }),
  makeTool("diagnose_task", { task_id: { type: "string" }, include_logs: { type: "boolean" } }),
  makeTool("reconcile_tasks", { mode: { type: "string" }, max_age_minutes: { type: "number" } }),
  makeTool("wait_for_task", { task_id: { type: "string" }, timeout_seconds: { type: "number" } }),
  makeTool("get_plan", { plan_id: { type: "string" } }),
  makeTool("get_task_stdout_tail", { task_id: { type: "string" } }),
  makeTool("discover_tools", { query: { type: "string" } }),
  makeTool("explain_tool", { name: { type: "string" } }),
  makeTool("read_workspace_file", { path: { type: "string" } }),
  makeTool("search_workspace", { session_id: { type: "string" }, query: { type: "string" } }),
  makeTool("save_plan", { title: { type: "string" }, content: { type: "string" } }),
  makeTool("create_task", { plan_id: { type: "string" }, agent: { type: "string" } }),
  makeTool("sync_file", { session_id: { type: "string" }, source: { type: "string" } }),
  makeTool("apply_patch", { session_id: { type: "string" }, path: { type: "string" } }),
  makeTool("create_direct_session", { repo_path: { type: "string" } }),
  makeTool("finalize_direct_session", { session_id: { type: "string" } }),
  makeTool("audit_session", { session_id: { type: "string" } }),
  makeTool("audit_task", { task_id: { type: "string" } }),
  makeTool("cancel_task", { task_id: { type: "string" } }),
  makeTool("kill_task", { task_id: { type: "string" } }),
  makeTool("retry_task", { task_id: { type: "string" } }),
  makeTool("run_verification", { session_id: { type: "string" }, command: { type: "string" } }),
  // v0.8.0 goal 工具
  makeTool("create_goal", { title: { type: "string" }, goal_description: { type: "string" }, repo_path: { type: "string" } }),
  makeTool("list_goals"),
  makeTool("read_goal", { goal_id: { type: "string" } }),
  makeTool("create_subgoal_task", { goal_id: { type: "string" }, subgoal_title: { type: "string" }, depends_on: { type: "array", items: { type: "string" } }, repo_path: { type: "string" } }),
  makeTool("accept_subgoal", { goal_id: { type: "string" }, subgoal_id: { type: "string" } }),
  makeTool("reject_subgoal", { goal_id: { type: "string" }, subgoal_id: { type: "string" }, reason: { type: "string" } }),
  makeTool("suggest_next_subgoal", { goal_id: { type: "string" } }),
  makeTool("summarize_goal_progress", { goal_id: { type: "string" } }),
  makeTool("export_handoff", { goal_id: { type: "string" } }),
  // v0.8.1 invoke_discovered_tool
  makeTool("invoke_discovered_tool", { tool_name: { type: "string" }, token: { type: "string" }, input: { type: "object" } }),
];

const REGISTRY: PatchWardenToolMeta[] = buildToolRegistry(MOCK_TOOLS);
const TOOL_DEFS_MAP = new Map(MOCK_TOOLS.map((t) => [t.name, t]));

// ── Tests ─────────────────────────────────────────────────────────

describe("toolSearch", () => {

  describe("discoverTools — 中文意图搜索", () => {
    it("「验收」应命中 safe_status / get_diff / get_result / get_test_log / audit_task", () => {
      const result = discoverTools({ query: "验收" }, REGISTRY);
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("safe_status"), `expected safe_status in results, got: ${names.join(", ")}`);
      assert.ok(names.includes("get_diff"), `expected get_diff in results, got: ${names.join(", ")}`);
      assert.ok(names.includes("get_result"), `expected get_result in results, got: ${names.join(", ")}`);
      assert.ok(names.includes("get_test_log"), `expected get_test_log in results, got: ${names.join(", ")}`);
      assert.ok(names.includes("audit_task"), `expected audit_task in results, got: ${names.join(", ")}`);
    });

    it("「改文件」应命中 apply_patch / sync_file", () => {
      const result = discoverTools({ query: "改文件" }, REGISTRY);
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("apply_patch"), `expected apply_patch, got: ${names.join(", ")}`);
      assert.ok(names.includes("sync_file"), `expected sync_file, got: ${names.join(", ")}`);
    });

    it("「卡住/旧任务」应命中 diagnose_task / reconcile_tasks", () => {
      const result = discoverTools({ query: "卡住 旧任务" }, REGISTRY);
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("diagnose_task"), `expected diagnose_task, got: ${names.join(", ")}`);
      assert.ok(names.includes("reconcile_tasks"), `expected reconcile_tasks, got: ${names.join(", ")}`);
    });

    it("「状态」应命中 safe_status / list_tasks / health_check", () => {
      const result = discoverTools({ query: "状态" }, REGISTRY);
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("safe_status"), `expected safe_status, got: ${names.join(", ")}`);
      assert.ok(names.includes("list_tasks"), `expected list_tasks, got: ${names.join(", ")}`);
      assert.ok(names.includes("health_check"), `expected health_check, got: ${names.join(", ")}`);
    });

    it("「差异」应命中 get_diff", () => {
      const result = discoverTools({ query: "差异" }, REGISTRY);
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("get_diff"), `expected get_diff, got: ${names.join(", ")}`);
    });

    it("「工具」应命中 discover_tools / explain_tool", () => {
      const result = discoverTools({ query: "工具" }, REGISTRY);
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("discover_tools"), `expected discover_tools, got: ${names.join(", ")}`);
      assert.ok(names.includes("explain_tool"), `expected explain_tool, got: ${names.join(", ")}`);
    });
  });

  describe("discoverTools — 英文搜索", () => {
    it("'diff' should match get_diff", () => {
      const result = discoverTools({ query: "diff" }, REGISTRY);
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("get_diff"), `expected get_diff, got: ${names.join(", ")}`);
    });

    it("'cancel task' should match cancel_task and kill_task", () => {
      const result = discoverTools({ query: "cancel task" }, REGISTRY);
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("cancel_task"), `expected cancel_task, got: ${names.join(", ")}`);
      assert.ok(names.includes("kill_task"), `expected kill_task, got: ${names.join(", ")}`);
    });

    it("'patch' should match apply_patch", () => {
      const result = discoverTools({ query: "patch" }, REGISTRY);
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("apply_patch"), `expected apply_patch, got: ${names.join(", ")}`);
    });

    it("'status' should match safe_status and get_task_status", () => {
      const result = discoverTools({ query: "status" }, REGISTRY);
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("safe_status"), `expected safe_status, got: ${names.join(", ")}`);
      assert.ok(names.includes("get_task_status"), `expected get_task_status, got: ${names.join(", ")}`);
    });
  });

  describe("discoverTools — riskCeiling 过滤", () => {
    it("riskCeiling=readonly 时不能返回 workspace_read_sensitive 及以上工具", () => {
      const result = discoverTools({ query: "", riskCeiling: "readonly" }, REGISTRY);
      for (const r of result.results) {
        assert.ok(
          TOOL_RISK_RANK[r.risk] <= TOOL_RISK_RANK.readonly,
          `tool ${r.name} has risk ${r.risk} which exceeds readonly`
        );
      }
    });

    it("riskCeiling=workspace_read_sensitive 时可返回读取类工具但不能返回写入工具", () => {
      const result = discoverTools({ query: "", riskCeiling: "workspace_read_sensitive" }, REGISTRY);
      for (const r of result.results) {
        assert.ok(
          TOOL_RISK_RANK[r.risk] <= TOOL_RISK_RANK.workspace_read_sensitive,
          `tool ${r.name} has risk ${r.risk} which exceeds workspace_read_sensitive`
        );
      }
    });

    it("riskCeiling=workspace_write 时可返回写入工具但不能返回 command 工具", () => {
      const result = discoverTools({ query: "", riskCeiling: "workspace_write" }, REGISTRY);
      for (const r of result.results) {
        assert.ok(
          TOOL_RISK_RANK[r.risk] <= TOOL_RISK_RANK.workspace_write,
          `tool ${r.name} has risk ${r.risk} which exceeds workspace_write`
        );
      }
    });
  });

  describe("discoverTools — hidden_results", () => {
    it("默认 includeHighRisk=false 时 command 工具被隐藏", () => {
      const result = discoverTools({ query: "verify test run" }, REGISTRY);
      const visibleNames = result.results.map((r) => r.name);
      assert.ok(!visibleNames.includes("run_verification"), "run_verification should be hidden by default");
      const hiddenRisks = result.hidden_results.map((h) => h.risk);
      assert.ok(hiddenRisks.includes("command"), "command risk should be in hidden_results");
    });

    it("includeHighRisk=true 时 command 工具出现在结果中", () => {
      const result = discoverTools({ query: "verify test run", includeHighRisk: true }, REGISTRY);
      const visibleNames = result.results.map((r) => r.name);
      assert.ok(visibleNames.includes("run_verification"), "run_verification should be visible when includeHighRisk=true");
    });

    it("hidden_results 包含 count 和 reason", () => {
      const result = discoverTools({ query: "verify" }, REGISTRY);
      assert.ok(result.hidden_results.length > 0, "should have hidden results");
      for (const h of result.hidden_results) {
        assert.ok(typeof h.count === "number" && h.count > 0, `count should be positive, got ${h.count}`);
        assert.ok(h.reason.length > 0, `reason should be non-empty, got "${h.reason}"`);
      }
    });

    it("riskCeiling=readonly 时 hidden_results reason 包含 'riskCeiling'", () => {
      const result = discoverTools({ query: "", riskCeiling: "readonly" }, REGISTRY);
      assert.ok(result.hidden_results.length > 0, "should have hidden results");
      for (const h of result.hidden_results) {
        assert.ok(h.reason.includes("riskCeiling"), `reason should mention riskCeiling, got "${h.reason}"`);
      }
    });
  });

  describe("discoverTools — maxResults", () => {
    it("maxResults 限制返回数量", () => {
      const result = discoverTools({ query: "", maxResults: 3 }, REGISTRY);
      assert.ok(result.results.length <= 3, `expected at most 3 results, got ${result.results.length}`);
    });

    it("maxResults=1 只返回一个结果", () => {
      const result = discoverTools({ query: "task", maxResults: 1 }, REGISTRY);
      assert.equal(result.results.length, 1);
    });
  });

  describe("discoverTools — profile 过滤", () => {
    it("profile=chatgpt_core 只返回 core 工具", () => {
      const result = discoverTools({ query: "", profile: "chatgpt_core" }, REGISTRY);
      for (const r of result.results) {
        const meta = REGISTRY.find((m) => m.name === r.name);
        assert.ok(meta, `tool ${r.name} not in registry`);
        assert.ok(
          meta!.profiles.includes("chatgpt_core"),
          `tool ${r.name} should be in chatgpt_core profile`
        );
      }
    });

    it("profile=chatgpt_direct 只返回 direct 工具", () => {
      const result = discoverTools({ query: "", profile: "chatgpt_direct" }, REGISTRY);
      for (const r of result.results) {
        const meta = REGISTRY.find((m) => m.name === r.name);
        assert.ok(meta, `tool ${r.name} not in registry`);
        assert.ok(
          meta!.profiles.includes("chatgpt_direct"),
          `tool ${r.name} should be in chatgpt_direct profile`
        );
      }
    });
  });

  describe("discoverTools — goal 工具可发现性（v0.8.0 补齐 + v0.8.1）", () => {
    it("「目标 goal 子目标」应命中 create_goal / list_goals / read_goal / create_subgoal_task", () => {
      const result = discoverTools({ query: "目标 goal 子目标" }, REGISTRY);
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("create_goal"), `expected create_goal, got: ${names.join(", ")}`);
      assert.ok(names.includes("list_goals"), `expected list_goals, got: ${names.join(", ")}`);
      assert.ok(names.includes("read_goal"), `expected read_goal, got: ${names.join(", ")}`);
      assert.ok(names.includes("create_subgoal_task"), `expected create_subgoal_task, got: ${names.join(", ")}`);
    });

    it("「交接 handoff」应命中 export_handoff", () => {
      const result = discoverTools({ query: "交接 handoff" }, REGISTRY);
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("export_handoff"), `expected export_handoff, got: ${names.join(", ")}`);
    });

    it("explain_tool({ name: 'create_goal' }) 返回非 null 且 risk === 'workspace_write'", () => {
      const result = explainTool({ name: "create_goal" }, REGISTRY, TOOL_DEFS_MAP);
      assert.ok(result, "create_goal should be explainable");
      assert.equal(result!.risk, "workspace_write");
    });

    it("explain_tool({ name: 'invoke_discovered_tool' }) 返回非 null 且 risk === 'command'", () => {
      const result = explainTool({ name: "invoke_discovered_tool" }, REGISTRY, TOOL_DEFS_MAP);
      assert.ok(result, "invoke_discovered_tool should be explainable");
      assert.equal(result!.risk, "command");
      assert.ok(
        result!.profiles.includes("chatgpt_search"),
        `profiles should include 'chatgpt_search' (v0.8.1), got: ${result!.profiles.join(", ")}`
      );
      assert.equal(result!.requires_confirmation, true, "invoke_discovered_tool should require confirmation");
    });
  });

  describe("discoverTools — discoveryToken (v0.8.1)", () => {
    it("不传 tokenIssuer 时每个 result 的 discoveryToken 为空字符串", () => {
      const result = discoverTools({ query: "task" }, REGISTRY);
      assert.ok(result.results.length > 0, "should have results");
      for (const r of result.results) {
        assert.equal(r.discoveryToken, "", `tool ${r.name} should have empty discoveryToken`);
      }
    });

    it("传 tokenIssuer 时 discoveryToken 等于 issuer 返回值", () => {
      const issuer = (tool: PatchWardenToolMeta) => `token_for_${tool.name}`;
      const result = discoverTools({ query: "task" }, REGISTRY, issuer);
      assert.ok(result.results.length > 0, "should have results");
      for (const r of result.results) {
        assert.equal(
          r.discoveryToken,
          `token_for_${r.name}`,
          `tool ${r.name} should have token from issuer`
        );
      }
    });

    it("每个 result 都包含 discoveryToken 字段（类型为 string）", () => {
      const result = discoverTools({ query: "diff" }, REGISTRY);
      for (const r of result.results) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(r, "discoveryToken"),
          `tool ${r.name} should have discoveryToken field`
        );
        assert.equal(typeof r.discoveryToken, "string");
      }
    });
  });

  describe("explainTool", () => {
    it("返回工具的完整元数据", () => {
      const result = explainTool({ name: "create_task" }, REGISTRY, TOOL_DEFS_MAP);
      assert.ok(result, "should return a result");
      assert.equal(result!.name, "create_task");
      assert.equal(result!.title, "Create Task");
      assert.equal(result!.risk, "workspace_write");
      assert.ok(result!.tags.length > 0, "should have tags");
      assert.ok(result!.aliases.length > 0, "should have aliases");
      assert.ok(result!.schema_digest.startsWith("sha256:"), "schema_digest should be sha256 prefixed");
      assert.ok(result!.related_tools.length > 0, "should have related tools");
    });

    it("includeSchema=true 时返回 inputSchema", () => {
      const result = explainTool({ name: "create_task", includeSchema: true }, REGISTRY, TOOL_DEFS_MAP);
      assert.ok(result, "should return a result");
      assert.ok(result!.input_schema, "should include inputSchema");
      assert.equal((result!.input_schema as any).type, "object");
    });

    it("includeSchema=false (default) 时不返回 inputSchema", () => {
      const result = explainTool({ name: "create_task" }, REGISTRY, TOOL_DEFS_MAP);
      assert.ok(result, "should return a result");
      assert.equal(result!.input_schema, undefined, "should not include inputSchema");
    });

    it("通过别名查找工具", () => {
      const result = explainTool({ name: "new_task" }, REGISTRY, TOOL_DEFS_MAP);
      assert.ok(result, "should find tool by alias");
      assert.equal(result!.name, "create_task");
    });

    it("不存在的工具返回 null", () => {
      const result = explainTool({ name: "nonexistent_tool" }, REGISTRY, TOOL_DEFS_MAP);
      assert.equal(result, null);
    });

    it("risk_rank 与 TOOL_RISK_RANK 一致", () => {
      const result = explainTool({ name: "run_verification" }, REGISTRY, TOOL_DEFS_MAP);
      assert.ok(result, "should return a result");
      assert.equal(result!.risk, "command");
      assert.equal(result!.risk_rank, TOOL_RISK_RANK.command);
    });
  });

  describe("explainTool — schema_drift_warning (v0.8.1)", () => {
    it("schema 一致时不设 schema_drift_warning", () => {
      // tokenPeeker 返回 toolDef 实际计算的 digest，与 registry 一致
      const peeker = (toolName: string) => {
        const toolDef = TOOL_DEFS_MAP.get(toolName);
        if (!toolDef) return null;
        return { schemaDigest: computeSchemaDigest(toolDef.inputSchema) };
      };
      const result = explainTool(
        { name: "create_task", includeSchema: true },
        REGISTRY,
        TOOL_DEFS_MAP,
        peeker
      );
      assert.ok(result, "should return a result");
      assert.equal(
        result!.schema_drift_warning,
        undefined,
        "should not set drift warning when digests match"
      );
    });

    it("schema 不一致时设 schema_drift_warning（registry digest 与 toolDef 实际 digest 不同）", () => {
      // 构造 registry 副本，将 create_task 的 digest 改为错误的值（模拟过期 registry）
      const driftedRegistry: PatchWardenToolMeta[] = REGISTRY.map((m) =>
        m.name === "create_task"
          ? { ...m, inputSchemaDigest: "sha256:fake_drifted_digest_value" }
          : m
      );
      // tokenPeeker 返回 toolDef 实际计算的 digest（正确值）
      const peeker = (toolName: string) => {
        const toolDef = TOOL_DEFS_MAP.get(toolName);
        if (!toolDef) return null;
        return { schemaDigest: computeSchemaDigest(toolDef.inputSchema) };
      };
      const result = explainTool(
        { name: "create_task", includeSchema: true },
        driftedRegistry,
        TOOL_DEFS_MAP,
        peeker
      );
      assert.ok(result, "should return a result");
      assert.ok(result!.schema_drift_warning, "should set drift warning when digests differ");
      assert.ok(
        result!.schema_drift_warning!.includes("mismatch"),
        `warning should mention mismatch, got: ${result!.schema_drift_warning}`
      );
    });

    it("不传 tokenPeeker 时不设 schema_drift_warning", () => {
      const result = explainTool(
        { name: "create_task", includeSchema: true },
        REGISTRY,
        TOOL_DEFS_MAP
      );
      assert.ok(result, "should return a result");
      assert.equal(
        result!.schema_drift_warning,
        undefined,
        "should not set drift warning without tokenPeeker"
      );
    });

    it("includeSchema=false 时即使有 tokenPeeker 也不设 schema_drift_warning", () => {
      const peeker = (_toolName: string) => ({ schemaDigest: "sha256:different" });
      const result = explainTool(
        { name: "create_task", includeSchema: false },
        REGISTRY,
        TOOL_DEFS_MAP,
        peeker
      );
      assert.ok(result, "should return a result");
      assert.equal(
        result!.schema_drift_warning,
        undefined,
        "should not set drift warning when includeSchema=false"
      );
    });
  });

  describe("schema_digest 稳定性", () => {
    it("相同 inputSchema 产生相同 digest", () => {
      const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } };
      const d1 = computeSchemaDigest(schema);
      const d2 = computeSchemaDigest(schema);
      assert.equal(d1, d2);
    });

    it("不同 key 顺序产生相同 digest（字段排序稳定性）", () => {
      const schema1 = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } };
      const schema2 = { type: "object", properties: { b: { type: "number" }, a: { type: "string" } } };
      const d1 = computeSchemaDigest(schema1);
      const d2 = computeSchemaDigest(schema2);
      assert.equal(d1, d2, "digest should be stable regardless of key order");
    });

    it("不同 inputSchema 产生不同 digest", () => {
      const schema1 = { type: "object", properties: { a: { type: "string" } } };
      const schema2 = { type: "object", properties: { a: { type: "number" } } };
      const d1 = computeSchemaDigest(schema1);
      const d2 = computeSchemaDigest(schema2);
      assert.notEqual(d1, d2);
    });

    it("registry 中每个工具的 schema_digest 格式正确", () => {
      for (const meta of REGISTRY) {
        assert.ok(
          meta.inputSchemaDigest.startsWith("sha256:"),
          `tool ${meta.name} has invalid digest format: ${meta.inputSchemaDigest}`
        );
        assert.equal(
          meta.inputSchemaDigest.length,
          "sha256:".length + 64,
          `tool ${meta.name} has invalid digest length`
        );
      }
    });
  });

  describe("buildToolRegistry", () => {
    it("所有 mock 工具都被注册", () => {
      const registeredNames = REGISTRY.map((m) => m.name);
      for (const tool of MOCK_TOOLS) {
        assert.ok(
          registeredNames.includes(tool.name),
          `tool ${tool.name} should be in registry`
        );
      }
    });

    it("每个工具有完整元数据", () => {
      for (const meta of REGISTRY) {
        assert.ok(meta.title.length > 0, `tool ${meta.name} missing title`);
        assert.ok(meta.summary.length > 0, `tool ${meta.name} missing summary`);
        assert.ok(meta.profiles.length > 0, `tool ${meta.name} missing profiles`);
        assert.ok(meta.modes.length > 0, `tool ${meta.name} missing modes`);
        assert.ok(meta.tags.length > 0, `tool ${meta.name} missing tags`);
        assert.ok(meta.aliases.length > 0, `tool ${meta.name} missing aliases`);
        assert.ok(typeof meta.risk === "string", `tool ${meta.name} missing risk`);
        assert.ok(typeof meta.requiresConfirmation === "boolean", `tool ${meta.name} missing requiresConfirmation`);
      }
    });
  });

  describe("chatgpt_search profile 选择（v0.8.1）", () => {
    const SEARCH_TOOLS = CHATGPT_SEARCH_TOOL_NAMES.map((name) => makeTool(name));

    it("selectToolsForProfile 对 chatgpt_search 返回恰好 5 个工具，顺序与 CHATGPT_SEARCH_TOOL_NAMES 一致", () => {
      const selected = selectToolsForProfile(SEARCH_TOOLS, "chatgpt_search");
      assert.equal(selected.length, 5);
      assert.deepEqual(
        selected.map((t) => t.name),
        [...CHATGPT_SEARCH_TOOL_NAMES]
      );
    });

    it("selectToolsForProfile 缺失任一工具时抛错", () => {
      const partial = SEARCH_TOOLS.slice(0, 4); // 丢弃 safe_status
      assert.throws(
        () => selectToolsForProfile(partial, "chatgpt_search"),
        /chatgpt_search tool profile requires missing tool/
      );
    });

    it("resolveToolProfile 接受 \"chatgpt_search\"", () => {
      const saved = process.env.PATCHWARDEN_TOOL_PROFILE;
      delete process.env.PATCHWARDEN_TOOL_PROFILE;
      try {
        assert.equal(resolveToolProfile("chatgpt_search"), "chatgpt_search");
      } finally {
        if (saved !== undefined) process.env.PATCHWARDEN_TOOL_PROFILE = saved;
      }
    });

    it("resolveToolProfile 拒绝非法值并消息含 4 个合法值", () => {
      const saved = process.env.PATCHWARDEN_TOOL_PROFILE;
      delete process.env.PATCHWARDEN_TOOL_PROFILE;
      try {
        assert.throws(
          () => resolveToolProfile("invalid_profile"),
          (err: Error) => {
            assert.ok(err.message.includes('"full"'), `message should mention "full": ${err.message}`);
            assert.ok(err.message.includes('"chatgpt_core"'), `message should mention "chatgpt_core": ${err.message}`);
            assert.ok(err.message.includes('"chatgpt_direct"'), `message should mention "chatgpt_direct": ${err.message}`);
            assert.ok(err.message.includes('"chatgpt_search"'), `message should mention "chatgpt_search": ${err.message}`);
            return true;
          }
        );
      } finally {
        if (saved !== undefined) process.env.PATCHWARDEN_TOOL_PROFILE = saved;
      }
    });
  });

  // ── v0.9.0: 混合排序公式测试 ─────────────────────────────────────

  // 构造自定义 PatchWardenToolMeta 的辅助函数（用于隔离测试混合排序公式）
  function makeCustomMeta(name: string, risk: ToolRisk): PatchWardenToolMeta {
    return {
      name,
      title: name,
      summary: name,
      description: name,
      profiles: ["full"],
      modes: ["delegate"],
      tags: [],
      aliases: [],
      risk,
      requiresConfirmation: false,
      inputSchemaDigest: "sha256:fake",
    };
  }

  describe("混合排序公式 (v0.9.0)", () => {
    it("computeFinalScore 按 0.45/0.25/0.15/0.10/0.05 权重正确加权", () => {
      // ruleScore=10, tagScore=20, profileMatch=1, historyScore=5, riskBonus=-1
      // 10*0.45 + 20*0.25 + 1*0.15 + 5*0.10 + (-1)*0.05 = 4.5 + 5 + 0.15 + 0.5 - 0.05 = 10.1
      const result = computeFinalScore(10, 20, 1, 5, -1);
      assert.ok(
        Math.abs(result - 10.1) < 1e-9,
        `expected ~10.1, got ${result}`
      );
    });

    it("computeFinalScore 各分量独立贡献正确", () => {
      // 只 ruleScore 有值
      assert.ok(Math.abs(computeFinalScore(10, 0, 0, 0, 0) - 4.5) < 1e-9);
      // 只 tagScore 有值
      assert.ok(Math.abs(computeFinalScore(0, 10, 0, 0, 0) - 2.5) < 1e-9);
      // 只 profileMatch 有值
      assert.ok(Math.abs(computeFinalScore(0, 0, 1, 0, 0) - 0.15) < 1e-9);
      // 只 historyScore 有值
      assert.ok(Math.abs(computeFinalScore(0, 0, 0, 5, 0) - 0.5) < 1e-9);
      // 只 riskBonus 有值
      assert.ok(Math.abs(computeFinalScore(0, 0, 0, 0, 1) - 0.05) < 1e-9);
    });

    it("riskBonusOrPenalty 6 种 ToolRisk 的 bonus/penalty 值正确", () => {
      assert.equal(riskBonusOrPenalty("readonly"), 1);
      assert.equal(riskBonusOrPenalty("workspace_read_sensitive"), 0.5);
      assert.equal(riskBonusOrPenalty("workspace_write"), 0);
      assert.equal(riskBonusOrPenalty("command"), -0.5);
      assert.equal(riskBonusOrPenalty("release"), -1);
      assert.equal(riskBonusOrPenalty("credential_sensitive"), -1);
    });

    it("无 usageStatsProvider 时 historyScore=0，结果与 v0.7.1 基本一致（向后兼容）", () => {
      // "diff" 不命中任何意图触发词，intent=unknown
      const result = discoverTools({ query: "diff" }, REGISTRY);
      assert.equal(result.intent, "unknown");
      const names = result.results.map((r) => r.name);
      assert.ok(names.includes("get_diff"), `expected get_diff, got: ${names.join(", ")}`);
      // get_diff 强匹配，应为首个结果
      assert.equal(result.results[0].name, "get_diff");
    });

    it("有 usageStatsProvider 且 successRate=0.9 时，目标工具排名比无历史数据时高", () => {
      // 构造两个 ruleScore/tagScore 完全相同的 readonly 工具
      const customRegistry: PatchWardenToolMeta[] = [
        makeCustomMeta("zz_one", "readonly"),
        makeCustomMeta("zz_two", "readonly"),
      ];
      const query = "zz";
      // 无 provider：同分按字母序，zz_one 在前
      const noProvider = discoverTools({ query }, customRegistry);
      assert.equal(noProvider.results[0].name, "zz_one");
      assert.equal(noProvider.results[1].name, "zz_two");
      // 有 provider：zz_two 有 successRate=0.9，historyScore=4.5，应排在 zz_one 前面
      const provider = (toolName: string): ToolUsageStats | null =>
        toolName === "zz_two"
          ? { totalCalls: 10, successRate: 0.9, avgDurationMs: 100, lastUsedAt: "2026-06-27T00:00:00.000Z" }
          : null;
      const withProvider = discoverTools({ query }, customRegistry, undefined, provider);
      assert.equal(withProvider.results[0].name, "zz_two", "有历史数据时 zz_two 应排第一");
      assert.equal(withProvider.results[1].name, "zz_one");
    });

    it("高风险工具（command）即使 successRate=1.0，includeHighRisk=false 时仍进 hidden_results", () => {
      const provider = (toolName: string): ToolUsageStats | null =>
        toolName === "run_verification"
          ? { totalCalls: 100, successRate: 1.0, avgDurationMs: 50, lastUsedAt: "2026-06-27T00:00:00.000Z" }
          : null;
      const result = discoverTools({ query: "verify test run" }, REGISTRY, undefined, provider);
      const visibleNames = result.results.map((r) => r.name);
      assert.ok(
        !visibleNames.includes("run_verification"),
        "run_verification 应被隐藏（风险过滤不受 historyScore 影响）"
      );
      const hiddenRisks = result.hidden_results.map((h) => h.risk);
      assert.ok(hiddenRisks.includes("command"), "command 应在 hidden_results 中");
    });
  });

  // ── v0.9.0: 查询意图分类测试 ─────────────────────────────────────

  describe("查询意图分类 (v0.9.0)", () => {
    it("classifyQueryIntent('查看任务状态') 返回 'read'", () => {
      assert.equal(classifyQueryIntent("查看任务状态"), "read");
    });

    it("classifyQueryIntent('修复 bug') 返回 'write'", () => {
      assert.equal(classifyQueryIntent("修复 bug"), "write");
    });

    it("classifyQueryIntent('验收测试') 返回 'verify'", () => {
      assert.equal(classifyQueryIntent("验收测试"), "verify");
    });

    it("classifyQueryIntent('发布版本') 返回 'release'", () => {
      assert.equal(classifyQueryIntent("发布版本"), "release");
    });

    it("classifyQueryIntent('旧任务卡住') 返回 'diagnose'", () => {
      assert.equal(classifyQueryIntent("旧任务卡住"), "diagnose");
    });

    it("classifyQueryIntent('random text') 返回 'unknown'", () => {
      assert.equal(classifyQueryIntent("random text"), "unknown");
    });

    it("意图触发词大小写不敏感（'CHECK' 命中 verify）", () => {
      assert.equal(classifyQueryIntent("CHECK status"), "verify");
    });

    it("按 read → write → verify 顺序匹配（'fix test' 命中 write 而非 verify）", () => {
      // "fix" 是 write 触发词，"test" 是 verify 触发词；write 优先
      assert.equal(classifyQueryIntent("fix test"), "write");
    });

    it("INTENT_PRIORITY_RISK 映射完整", () => {
      assert.deepEqual(INTENT_PRIORITY_RISK.read, ["readonly", "workspace_read_sensitive"]);
      assert.deepEqual(INTENT_PRIORITY_RISK.write, ["workspace_write"]);
      assert.deepEqual(INTENT_PRIORITY_RISK.verify, ["readonly", "workspace_read_sensitive"]);
      assert.deepEqual(INTENT_PRIORITY_RISK.release, ["release"]);
      assert.deepEqual(INTENT_PRIORITY_RISK.diagnose, ["readonly", "workspace_read_sensitive"]);
      assert.deepEqual(INTENT_PRIORITY_RISK.unknown, []);
    });
  });

  // ── v0.9.0: discoverTools intent 集成测试 ────────────────────────

  describe("discoverTools — intent 集成 (v0.9.0)", () => {
    it("discoverTools 输出包含 intent 字段", () => {
      const result = discoverTools({ query: "查看任务" }, REGISTRY);
      assert.ok(
        Object.prototype.hasOwnProperty.call(result, "intent"),
        "应有 intent 字段"
      );
      assert.equal(result.intent, "read"); // "查看" → read
    });

    it("同分工具按意图优先风险等级微调排序（intent=read 时 readonly 排在 workspace_write 前面）", () => {
      // 构造两个 ruleScore/tagScore 相同的工具，仅风险等级不同
      // 名字避开意图触发词子串（如 "read"/"write"），确保基础分真正相同
      const customRegistry: PatchWardenToolMeta[] = [
        makeCustomMeta("aa_beta", "workspace_write"),
        makeCustomMeta("aa_alpha", "readonly"),
      ];
      // "查看" 触发 read 意图；"aa" 匹配两个工具的 name/title/summary/description
      const result = discoverTools({ query: "查看 aa" }, customRegistry);
      assert.equal(result.intent, "read");
      assert.equal(
        result.results[0].name,
        "aa_alpha",
        "readonly 工具应排在 workspace_write 前面（intent=read 优先只读）"
      );
      assert.equal(result.results[1].name, "aa_beta");
    });
  });
});
