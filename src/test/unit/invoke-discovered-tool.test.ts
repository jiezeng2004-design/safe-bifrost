import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  invokeDiscoveredTool,
  type InvokeDiscoveredToolContext,
  type InvokeDiscoveredToolInput,
} from "../../tools/invokeDiscoveredTool.js";
import { issueToken, clearAllTokens } from "../../security/discoveryTokenStore.js";
import { computeSchemaDigest, type ToolRisk } from "../../tools/toolRegistry.js";
import type { ToolDef } from "../../tools/registry.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeToolDef(name: string): ToolDef {
  return {
    name,
    description: `Mock ${name} tool`,
    inputSchema: { type: "object", properties: {} },
  };
}

const MOCK_TOOLS: ToolDef[] = [
  "safe_status",
  "get_diff",
  "save_plan",
  "invoke_discovered_tool",
  "__test_credential_tool",
].map(makeToolDef);

function makeContext(overrides: Partial<InvokeDiscoveredToolContext> = {}): InvokeDiscoveredToolContext {
  return {
    tools: MOCK_TOOLS,
    profile: "full",
    dispatch: async () => ({ ok: true }),
    ...overrides,
  };
}

function issueTokenFor(toolName: string, risk: ToolRisk): string {
  return issueToken({
    toolName,
    risk,
    query: "test query",
    schemaDigest: computeSchemaDigest({}),
    profile: "full",
  });
}

function makeInput(overrides: Partial<InvokeDiscoveredToolInput> = {}): InvokeDiscoveredToolInput {
  return {
    toolName: "safe_status",
    arguments: {},
    discoveryToken: "",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("invokeDiscoveredTool", () => {
  beforeEach(() => {
    clearAllTokens();
  });

  describe("合法调用", () => {
    it("readonly 工具 + 有效 token + dispatch 成功 → ok=true", async () => {
      const token = issueTokenFor("safe_status", "readonly");
      const result = await invokeDiscoveredTool(
        makeInput({
          toolName: "safe_status",
          arguments: { task_id: "t-1" },
          discoveryToken: token,
        }),
        makeContext({
          dispatch: async () => ({ status: "pending" }),
        }),
      );
      assert.equal(result.ok, true);
      assert.ok(result.result, "result should be present");
      assert.deepEqual(result.result, { status: "pending" });
      assert.equal(result.invocation_log_written, true);
      assert.equal(result.error, undefined);
    });
  });

  describe("token 校验", () => {
    it("token 不存在 → ok=false, reason=token_not_found", async () => {
      const result = await invokeDiscoveredTool(
        makeInput({
          toolName: "safe_status",
          arguments: {},
          discoveryToken: "tok",
        }),
        makeContext(),
      );
      assert.equal(result.ok, false);
      assert.equal(result.error?.reason, "token_not_found");
      assert.equal(result.invocation_log_written, true);
    });

    it("token toolName 不匹配 → ok=false, reason=token_tool_mismatch", async () => {
      const token = issueTokenFor("safe_status", "readonly");
      const result = await invokeDiscoveredTool(
        makeInput({
          toolName: "get_diff",
          arguments: { task_id: "t-1" },
          discoveryToken: token,
        }),
        makeContext(),
      );
      assert.equal(result.ok, false);
      assert.equal(result.error?.reason, "token_tool_mismatch");
    });
  });

  describe("toolMeta 查找", () => {
    it("工具未注册 → ok=false, reason=tool_not_registered", async () => {
      const token = issueTokenFor("safe_status", "readonly");
      const result = await invokeDiscoveredTool(
        makeInput({
          toolName: "safe_status",
          arguments: {},
          discoveryToken: token,
        }),
        makeContext({
          tools: [makeToolDef("get_diff")],
        }),
      );
      assert.equal(result.ok, false);
      assert.equal(result.error?.reason, "tool_not_registered");
    });
  });

  describe("防递归", () => {
    it("toolName=invoke_discovered_tool → ok=false, reason=recursive_invocation_blocked", async () => {
      const token = issueTokenFor("invoke_discovered_tool", "command");
      const result = await invokeDiscoveredTool(
        makeInput({
          toolName: "invoke_discovered_tool",
          arguments: {},
          discoveryToken: token,
        }),
        makeContext(),
      );
      assert.equal(result.ok, false);
      assert.equal(result.error?.reason, "recursive_invocation_blocked");
    });
  });

  describe("守卫校验", () => {
    it("credential_sensitive 工具 → ok=false, reason=credential_sensitive_blocked", async () => {
      const token = issueTokenFor("__test_credential_tool", "credential_sensitive");
      const result = await invokeDiscoveredTool(
        makeInput({
          toolName: "__test_credential_tool",
          arguments: {},
          discoveryToken: token,
        }),
        makeContext(),
      );
      assert.equal(result.ok, false);
      assert.equal(result.error?.reason, "credential_sensitive_blocked");
    });

    it("workspace_write 缺 assessmentId → ok=false, reason=assessment_required", async () => {
      const token = issueTokenFor("save_plan", "workspace_write");
      const result = await invokeDiscoveredTool(
        makeInput({
          toolName: "save_plan",
          arguments: {},
          discoveryToken: token,
        }),
        makeContext(),
      );
      assert.equal(result.ok, false);
      assert.equal(result.error?.reason, "assessment_required");
    });
  });

  describe("dispatch", () => {
    it("dispatch 抛错 → ok=false, reason=dispatch_error", async () => {
      const token = issueTokenFor("safe_status", "readonly");
      const result = await invokeDiscoveredTool(
        makeInput({
          toolName: "safe_status",
          arguments: {},
          discoveryToken: token,
        }),
        makeContext({
          dispatch: async () => {
            throw new Error("boom");
          },
        }),
      );
      assert.equal(result.ok, false);
      assert.equal(result.error?.reason, "dispatch_error");
      assert.ok(result.error?.message.includes("boom"), `expected message to contain "boom", got "${result.error?.message}"`);
    });

    it("成功调用 → invocation_log_written=true", async () => {
      const token = issueTokenFor("safe_status", "readonly");
      const result = await invokeDiscoveredTool(
        makeInput({
          toolName: "safe_status",
          arguments: { task_id: "t-log" },
          discoveryToken: token,
        }),
        makeContext({
          dispatch: async () => ({ status: "done" }),
        }),
      );
      assert.equal(result.ok, true);
      assert.equal(result.invocation_log_written, true);
    });
  });
});
