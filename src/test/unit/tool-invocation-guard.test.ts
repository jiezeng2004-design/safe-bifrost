import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { checkInvocation, type GuardInput } from "../../security/toolInvocationGuard.js";
import { PatchWardenError } from "../../errors.js";
import type { PatchWardenToolMeta, ToolRisk } from "../../tools/toolRegistry.js";
import type { ToolProfile } from "../../tools/toolCatalog.js";
import type { DiscoveryTokenRecord } from "../../security/discoveryTokenStore.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeToolMeta(overrides: Partial<PatchWardenToolMeta> = {}): PatchWardenToolMeta {
  return {
    name: "read_workspace_file",
    title: "Read Workspace File",
    summary: "读取工作区文件内容（自动脱敏敏感路径）",
    description: "Read workspace file content with sensitive path redaction.",
    profiles: ["full", "chatgpt_core", "chatgpt_direct"],
    modes: ["delegate", "direct", "audit"],
    tags: ["read", "file", "workspace"],
    aliases: ["read_file"],
    risk: "workspace_read_sensitive",
    requiresConfirmation: false,
    inputSchemaDigest: "sha256:abc123",
    ...overrides,
  };
}

function makeTokenRecord(overrides: Partial<DiscoveryTokenRecord> = {}): DiscoveryTokenRecord {
  return {
    token: "tok",
    toolName: "read_workspace_file",
    risk: "workspace_read_sensitive",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:10:00.000Z",
    query: "read file",
    schemaDigest: "sha256:abc123",
    profile: "full",
    ...overrides,
  };
}

function makeInput(overrides: Partial<GuardInput> = {}): GuardInput {
  return {
    toolName: "read_workspace_file",
    toolMeta: makeToolMeta(),
    args: {},
    discoveryTokenRecord: makeTokenRecord(),
    profile: "full",
    assessmentId: undefined,
    ...overrides,
  };
}

// 辅助：断言会抛出指定 reason 的 PatchWardenError
function assertPatchWardenError(
  fn: () => void,
  reason: string,
  messageContains?: string
): void {
  assert.throws(
    fn,
    (err: unknown) => {
      assert.ok(err instanceof PatchWardenError, `expected PatchWardenError, got ${err?.constructor?.name}`);
      assert.equal(err.reason, reason, `expected reason "${reason}", got "${err.reason}"`);
      if (messageContains) {
        assert.ok(
          err.message.includes(messageContains),
          `expected message to contain "${messageContains}", got "${err.message}"`
        );
      }
      assert.equal(err.blocked, true, "blocked should default to true");
      return true;
    }
  );
}

// ── Tests ─────────────────────────────────────────────────────────

describe("toolInvocationGuard", () => {
  describe("① token_tool_mismatch", () => {
    it("toolName 与 record.toolName 不一致时抛 token_tool_mismatch", () => {
      const input = makeInput({
        toolName: "save_plan",
        discoveryTokenRecord: makeTokenRecord({ toolName: "read_workspace_file" }),
      });
      assertPatchWardenError(
        () => checkInvocation(input),
        "token_tool_mismatch",
        "save_plan"
      );
    });

    it("toolName 一致时不抛该错误（成功路径在后面统一验证）", () => {
      const input = makeInput({
        toolName: "read_workspace_file",
        discoveryTokenRecord: makeTokenRecord({ toolName: "read_workspace_file" }),
      });
      // 不应抛 token_tool_mismatch；后续校验会通过
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });
  });

  describe("② profile_not_allowed", () => {
    it("toolMeta.profiles 不含当前 profile 时抛 profile_not_allowed", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          profiles: ["full", "chatgpt_core"],
        }),
        profile: "chatgpt_direct",
      });
      assertPatchWardenError(
        () => checkInvocation(input),
        "profile_not_allowed",
        "chatgpt_direct"
      );
    });

    it("profile 在允许列表内时通过（后续校验继续）", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({ profiles: ["full", "chatgpt_direct"] }),
        profile: "chatgpt_direct",
      });
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });
  });

  describe("③ risk_exceeded", () => {
    it("toolMeta.risk 高于 record.risk 时抛 risk_exceeded（schema 漂移）", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "create_task",
          risk: "workspace_write", // rank 2
        }),
        toolName: "create_task",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "create_task",
          risk: "workspace_read_sensitive", // rank 1
        }),
        // workspace_write 需要 assessmentId
        assessmentId: "asm_risk_exceeded_test",
      });
      assertPatchWardenError(
        () => checkInvocation(input),
        "risk_exceeded",
        "workspace_write"
      );
    });

    it("toolMeta.risk 等于 record.risk 时通过（相等不算超过）", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({ risk: "workspace_read_sensitive" }),
        discoveryTokenRecord: makeTokenRecord({ risk: "workspace_read_sensitive" }),
      });
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });

    it("toolMeta.risk 低于 record.risk 时通过（更宽松 token 调更安全工具）", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "health_check",
          risk: "readonly", // rank 0
          profiles: ["full"],
        }),
        toolName: "health_check",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "health_check",
          risk: "workspace_read_sensitive", // rank 1，更高
        }),
      });
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });
  });

  describe("④ sensitive_path_blocked", () => {
    it("workspace_read_sensitive 工具读 .env 路径时抛 sensitive_path_blocked", () => {
      const input = makeInput({
        args: { path: ".env" },
      });
      assertPatchWardenError(
        () => checkInvocation(input),
        "sensitive_path_blocked",
        ".env"
      );
    });

    it("workspace_read_sensitive 工具读非敏感路径时通过", () => {
      const input = makeInput({
        args: { path: "src/main.ts" },
      });
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });

    it("无路径参数时跳过敏感校验", () => {
      const input = makeInput({
        args: { query: "some text" },
      });
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });

    it("支持 file / repo_path / target_path 等多种路径字段", () => {
      // file 字段命中敏感
      assertPatchWardenError(
        () => checkInvocation(makeInput({ args: { file: "id_rsa" } })),
        "sensitive_path_blocked"
      );
      // repo_path 字段命中敏感
      assertPatchWardenError(
        () => checkInvocation(makeInput({ args: { repo_path: ".npmrc" } })),
        "sensitive_path_blocked"
      );
      // target_path 字段命中敏感
      assertPatchWardenError(
        () => checkInvocation(makeInput({ args: { target_path: "config.json" } })),
        "sensitive_path_blocked"
      );
    });
  });

  describe("⑤ assessment_required", () => {
    it("workspace_write 工具无 assessmentId 时抛 assessment_required", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "save_plan",
          risk: "workspace_write",
          profiles: ["full"],
        }),
        toolName: "save_plan",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "save_plan",
          risk: "workspace_write",
        }),
        assessmentId: undefined,
      });
      assertPatchWardenError(
        () => checkInvocation(input),
        "assessment_required",
        "save_plan"
      );
    });

    it("workspace_write 工具 assessmentId 为空字符串时抛 assessment_required", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "save_plan",
          risk: "workspace_write",
          profiles: ["full"],
        }),
        toolName: "save_plan",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "save_plan",
          risk: "workspace_write",
        }),
        assessmentId: "   ",
      });
      assertPatchWardenError(
        () => checkInvocation(input),
        "assessment_required"
      );
    });

    it("workspace_write 工具有 assessmentId 时通过", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "save_plan",
          risk: "workspace_write",
          profiles: ["full"],
        }),
        toolName: "save_plan",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "save_plan",
          risk: "workspace_write",
        }),
        assessmentId: "asm_workspace_write_ok",
      });
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });
  });

  describe("⑥ command_not_allowed", () => {
    function commandInput(command: unknown) {
      return makeInput({
        toolMeta: makeToolMeta({
          name: "run_verification",
          risk: "command",
          profiles: ["full", "chatgpt_direct"],
        }),
        toolName: "run_verification",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "run_verification",
          risk: "command",
        }),
        args: { command },
      });
    }

    it("args.command 含管道 | 时抛 command_not_allowed", () => {
      assertPatchWardenError(
        () => checkInvocation(commandInput("ls | grep secret")),
        "command_not_allowed"
      );
    });

    it("args.command 含 & 时抛 command_not_allowed", () => {
      assertPatchWardenError(
        () => checkInvocation(commandInput("rm -rf & background")),
        "command_not_allowed"
      );
    });

    it("args.command 含 $() 时抛 command_not_allowed", () => {
      assertPatchWardenError(
        () => checkInvocation(commandInput("echo $(cat .env)")),
        "command_not_allowed"
      );
    });

    it("args.command 含反引号时抛 command_not_allowed", () => {
      assertPatchWardenError(
        () => checkInvocation(commandInput("echo `whoami`")),
        "command_not_allowed"
      );
    });

    it("args.command 含分号时抛 command_not_allowed", () => {
      assertPatchWardenError(
        () => checkInvocation(commandInput("ls; rm -rf /")),
        "command_not_allowed"
      );
    });

    it("args.command 不含元字符时通过（白名单由 handler 校验）", () => {
      const result = checkInvocation(commandInput("npm test"));
      assert.deepEqual(result, { allowed: true });
    });

    it("args.command 不存在时跳过（handler 内部再校验）", () => {
      const result = checkInvocation(commandInput(undefined));
      assert.deepEqual(result, { allowed: true });
    });

    it("args.command 为空字符串时跳过", () => {
      const result = checkInvocation(commandInput("   "));
      assert.deepEqual(result, { allowed: true });
    });
  });

  describe("⑦ release_confirmation_required", () => {
    it("release 工具无 assessmentId 时抛 release_confirmation_required", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "publish_release",
          risk: "release",
          profiles: ["full"],
        }),
        toolName: "publish_release",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "publish_release",
          risk: "release",
        }),
        assessmentId: undefined,
      });
      assertPatchWardenError(
        () => checkInvocation(input),
        "release_confirmation_required",
        "publish_release"
      );
    });

    it("release 工具有 assessmentId 时通过", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "publish_release",
          risk: "release",
          profiles: ["full"],
        }),
        toolName: "publish_release",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "publish_release",
          risk: "release",
        }),
        assessmentId: "asm_release_confirm",
      });
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });
  });

  describe("⑧ credential_sensitive_blocked", () => {
    it("credential_sensitive 工具总是被拒绝", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "rotate_secret",
          risk: "credential_sensitive",
          profiles: ["full"],
        }),
        toolName: "rotate_secret",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "rotate_secret",
          risk: "credential_sensitive",
        }),
        assessmentId: "asm_does_not_matter",
      });
      assertPatchWardenError(
        () => checkInvocation(input),
        "credential_sensitive_blocked",
        "rotate_secret"
      );
    });

    it("credential_sensitive 工具即使有 assessmentId 也被拒绝", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "rotate_secret",
          risk: "credential_sensitive",
          profiles: ["full"],
        }),
        toolName: "rotate_secret",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "rotate_secret",
          risk: "credential_sensitive",
        }),
        assessmentId: "asm_credential",
      });
      assertPatchWardenError(
        () => checkInvocation(input),
        "credential_sensitive_blocked"
      );
    });
  });

  describe("成功场景", () => {
    it("成功场景 1: readonly 工具 + 有效 token + profile 允许 → { allowed: true }", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "health_check",
          risk: "readonly",
          profiles: ["full", "chatgpt_core", "chatgpt_direct"],
        }),
        toolName: "health_check",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "health_check",
          risk: "readonly",
        }),
        profile: "chatgpt_core",
        args: {},
      });
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });

    it("成功场景 2: workspace_write 工具 + 有效 token + 有 assessmentId → { allowed: true }", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "create_task",
          risk: "workspace_write",
          profiles: ["full", "chatgpt_core"],
        }),
        toolName: "create_task",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "create_task",
          risk: "workspace_write",
        }),
        profile: "chatgpt_core",
        assessmentId: "asm_success_write",
        args: { prompt: "do something" },
      });
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });

    it("成功场景 3: workspace_read_sensitive 工具 + 有效 token + 非敏感路径 → { allowed: true }", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "read_workspace_file",
          risk: "workspace_read_sensitive",
          profiles: ["full", "chatgpt_core", "chatgpt_direct"],
        }),
        toolName: "read_workspace_file",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "read_workspace_file",
          risk: "workspace_read_sensitive",
        }),
        profile: "chatgpt_direct",
        args: { path: "src/index.ts", file: "README.md" },
      });
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });

    it("成功场景 4: command 工具 + 有效 token + 安全命令 → { allowed: true }", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "run_verification",
          risk: "command",
          profiles: ["full", "chatgpt_direct"],
        }),
        toolName: "run_verification",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "run_verification",
          risk: "command",
        }),
        profile: "chatgpt_direct",
        args: { command: "npm.cmd test" },
      });
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });
  });

  describe("GuardInput 类型守卫与边界", () => {
    it("args.command 为非字符串类型时跳过（handler 内再校验）", () => {
      const input = makeInput({
        toolMeta: makeToolMeta({
          name: "run_verification",
          risk: "command",
          profiles: ["full"],
        }),
        toolName: "run_verification",
        discoveryTokenRecord: makeTokenRecord({
          toolName: "run_verification",
          risk: "command",
        }),
        args: { command: 123 },
      });
      const result = checkInvocation(input);
      assert.deepEqual(result, { allowed: true });
    });

    it("GuardResult.allowed 始终为 true（失败时已抛错）", () => {
      const result = checkInvocation(makeInput());
      assert.equal(result.allowed, true);
      assert.equal(Object.keys(result).length, 1, "GuardResult 只应有 allowed 字段");
    });
  });
});
