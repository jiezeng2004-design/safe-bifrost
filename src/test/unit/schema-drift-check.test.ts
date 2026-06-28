import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { computeSchemaDigest } from "../../tools/toolRegistry.js";
import type {
  PatchWardenToolMeta,
  ToolMode,
  ToolRisk,
} from "../../tools/toolRegistry.js";
import type { ToolProfile } from "../../tools/toolCatalog.js";
import { CHATGPT_CORE_TOOL_NAMES } from "../../tools/toolCatalog.js";
import {
  checkRegistrySchemaDigest,
  checkChatgptCoreManifestStable,
  checkNewToolsProfileAppend,
  runAllSchemaDriftChecks,
  type ToolDefLike,
} from "../../tools/schemaDriftCheck.js";

// ── 测试夹具构造工具 ─────────────────────────────────────────────

const SAMPLE_SCHEMA = {
  type: "object" as const,
  properties: {
    task_id: { type: "string", description: "Task ID" },
  },
  required: ["task_id"],
};

const OTHER_SCHEMA = {
  type: "object" as const,
  properties: {
    plan_id: { type: "string", description: "Plan ID" },
  },
  required: ["plan_id"],
};

interface MakeMetaOpts {
  name: string;
  inputSchema?: unknown;
  inputSchemaDigest?: string;
  profiles?: ToolProfile[];
}

/** 构造一个满足 PatchWardenToolMeta 接口的元数据对象。 */
function makeMeta(opts: MakeMetaOpts): PatchWardenToolMeta {
  const schema = opts.inputSchema ?? SAMPLE_SCHEMA;
  return {
    name: opts.name,
    title: `Tool ${opts.name}`,
    summary: `summary for ${opts.name}`,
    description: `description for ${opts.name}`,
    profiles: opts.profiles ?? ["full"],
    modes: ["diagnostic"] as ToolMode[],
    tags: [],
    aliases: [],
    risk: "readonly" as ToolRisk,
    requiresConfirmation: false,
    inputSchemaDigest: opts.inputSchemaDigest ?? computeSchemaDigest(schema),
  };
}

/** 构造 toolDefs Map。 */
function makeToolDefs(
  entries: Array<{ name: string; inputSchema?: unknown }>,
): Map<string, ToolDefLike> {
  const map = new Map<string, ToolDefLike>();
  for (const e of entries) {
    map.set(e.name, {
      inputSchema: e.inputSchema ?? SAMPLE_SCHEMA,
    });
  }
  return map;
}

/** 构造包含全部 21 个 chatgpt_core 工具（顺序一致）的 toolDefs Map。 */
function makeCoreToolDefs(): Map<string, ToolDefLike> {
  return makeToolDefs(
    [...CHATGPT_CORE_TOOL_NAMES].map((name) => ({ name })),
  );
}

/** 构造一个 registry：所有工具都属于 chatgpt_core profile。 */
function makeCoreRegistry(count: number): PatchWardenToolMeta[] {
  const names = [...CHATGPT_CORE_TOOL_NAMES].slice(0, count);
  return names.map((name) => makeMeta({ name, profiles: ["chatgpt_core"] }));
}

// ── 1. checkRegistrySchemaDigest ─────────────────────────────────

describe("checkRegistrySchemaDigest", () => {
  it("digest 一致时 ok=true，warnings 为空", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const registry = [makeMeta({ name: "tool_a", inputSchema: schema })];
    const toolDefs = makeToolDefs([{ name: "tool_a", inputSchema: schema }]);

    const result = checkRegistrySchemaDigest(registry, toolDefs);

    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });

  it("digest 不一致时 ok=false，warnings 包含工具名和两个 digest", () => {
    const registrySchema = SAMPLE_SCHEMA;
    const actualSchema = OTHER_SCHEMA;
    // registry 记录的是 registrySchema 的 digest，但实际 toolDef 用的是 actualSchema
    const registry = [
      makeMeta({ name: "tool_drift", inputSchema: registrySchema }),
    ];
    const toolDefs = makeToolDefs([{ name: "tool_drift", inputSchema: actualSchema }]);

    const result = checkRegistrySchemaDigest(registry, toolDefs);

    assert.equal(result.ok, false);
    assert.equal(result.warnings.length, 1);
    const warning = result.warnings[0];
    const expectedRegistryDigest = computeSchemaDigest(registrySchema);
    const expectedActualDigest = computeSchemaDigest(actualSchema);
    assert.ok(warning.includes("tool_drift"), "warning 应包含工具名");
    assert.ok(
      warning.includes(expectedRegistryDigest),
      "warning 应包含 registry digest",
    );
    assert.ok(
      warning.includes(expectedActualDigest),
      "warning 应包含 actual digest",
    );
  });

  it("toolDefs 中找不到工具时跳过（不报 drift）", () => {
    const registry = [makeMeta({ name: "missing_tool" })];
    const toolDefs = makeToolDefs([]); // 空映射

    const result = checkRegistrySchemaDigest(registry, toolDefs);

    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });
});

// ── 2. checkChatgptCoreManifestStable ────────────────────────────

describe("checkChatgptCoreManifestStable", () => {
  it("21 工具全部存在时 ok=true", () => {
    const toolDefs = makeCoreToolDefs();

    const result = checkChatgptCoreManifestStable(toolDefs);

    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });

  it("缺少工具时 ok=false", () => {
    // 移除最后一个工具，使 chatgpt_core 工具数为 20
    const names = [...CHATGPT_CORE_TOOL_NAMES].slice(0, 20);
    const toolDefs = makeToolDefs(names.map((name) => ({ name })));

    const result = checkChatgptCoreManifestStable(toolDefs);

    assert.equal(result.ok, false);
    assert.equal(result.warnings.length, 1);
    assert.ok(
      result.warnings[0].includes("missing tools"),
      "warning 应包含 missing tools",
    );
    assert.ok(
      result.warnings[0].includes(CHATGPT_CORE_TOOL_NAMES[20]),
      "warning 应包含缺失的工具名",
    );
  });
});

// ── 3. checkNewToolsProfileAppend ────────────────────────────────

describe("checkNewToolsProfileAppend", () => {
  it("chatgpt_core 21 工具时 ok=true", () => {
    const registry = makeCoreRegistry(21);

    const result = checkNewToolsProfileAppend(registry);

    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });

  it("chatgpt_core 工具数不为 21 时 ok=false", () => {
    // 22 个 chatgpt_core 工具：21 个标准工具 + 1 个重复名（模拟新工具追加）
    const registry = makeCoreRegistry(21);
    registry.push(makeMeta({ name: "extra_tool", profiles: ["chatgpt_core"] }));

    const result = checkNewToolsProfileAppend(registry);

    assert.equal(result.ok, false);
    assert.equal(result.warnings.length, 1);
    assert.ok(
      result.warnings[0].includes("expected 21"),
      "warning 应包含预期数量 21",
    );
    assert.ok(
      result.warnings[0].includes("got 22"),
      "warning 应包含实际数量 22",
    );
  });
});

// ── 4. runAllSchemaDriftChecks ───────────────────────────────────

describe("runAllSchemaDriftChecks", () => {
  it("无 drift 时 ok=true", () => {
    // registry 与 toolDefs 完全一致，且 chatgpt_core 工具数为 21
    const registry = makeCoreRegistry(21);
    const toolDefs = makeCoreToolDefs();

    const result = runAllSchemaDriftChecks(registry, toolDefs);

    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });

  it("有 drift 时 ok=false，warnings 合并正确", () => {
    // 构造同时触发三个检查的 drift：
    // - check 1: 一个工具 digest 不一致
    // - check 2: toolDefs 缺少一个 chatgpt_core 工具（数量 16）
    // - check 3: registry 有 22 个 chatgpt_core 工具
    const driftedSchema = OTHER_SCHEMA;
    const registry = makeCoreRegistry(21);
    // 第一个工具的 digest 指向 SAMPLE_SCHEMA，但 toolDefs 中该工具用 driftedSchema
    registry[0] = makeMeta({
      name: CHATGPT_CORE_TOOL_NAMES[0],
      inputSchema: SAMPLE_SCHEMA,
      profiles: ["chatgpt_core"],
    });
    // 追加一个额外的 chatgpt_core 工具，使 profile 工具数变为 22
    registry.push(makeMeta({ name: "extra_tool", profiles: ["chatgpt_core"] }));

    // toolDefs：第一个工具用 driftedSchema（触发 check 1），且移除最后一个核心工具（触发 check 2）
    const coreNames = [...CHATGPT_CORE_TOOL_NAMES];
    const toolDefEntries = coreNames.slice(0, 20).map((name) => ({
      name,
      inputSchema: name === CHATGPT_CORE_TOOL_NAMES[0] ? driftedSchema : SAMPLE_SCHEMA,
    }));
    const toolDefs = makeToolDefs(toolDefEntries);

    const result = runAllSchemaDriftChecks(registry, toolDefs);

    assert.equal(result.ok, false);
    // 至少包含来自三个检查的警告
    assert.ok(
      result.warnings.length >= 3,
      `应有至少 3 条警告，实际 ${result.warnings.length}`,
    );
    // 验证三类警告都存在
    const hasDigestDrift = result.warnings.some((w) => w.startsWith("Schema drift for tool"));
    const hasManifestMissing = result.warnings.some((w) => w.includes("missing tools"));
    const hasProfileCount = result.warnings.some((w) => w.includes("profile tool count changed"));
    assert.ok(hasDigestDrift, "应包含 registry digest drift 警告");
    assert.ok(hasManifestMissing, "应包含 manifest 缺失工具警告");
    assert.ok(hasProfileCount, "应包含 profile 数量变化警告");
  });
});
