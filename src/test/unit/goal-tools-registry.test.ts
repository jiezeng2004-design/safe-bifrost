import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getToolDefs, handleToolCall } from "../../tools/registry.js";
import { reloadConfig } from "../../config.js";
import { PatchWardenError } from "../../errors.js";

// ── 9 个 Goal Session MCP 工具名 ──────────────────────────────────

const GOAL_TOOL_NAMES = [
  "create_goal",
  "list_goals",
  "read_goal",
  "create_subgoal_task",
  "accept_subgoal",
  "reject_subgoal",
  "suggest_next_subgoal",
  "summarize_goal_progress",
  "export_handoff",
] as const;

// ── 测试环境隔离：使用临时 workspaceRoot + full profile ───────────

let tempDir: string;
let prevConfigEnv: string | undefined;
let prevProfileEnv: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pw-goal-registry-"));
  const configPath = join(tempDir, "patchwarden.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaceRoot: tempDir,
      toolProfile: "full",
      agents: {},
      allowedTestCommands: [],
    }),
    "utf-8"
  );
  prevConfigEnv = process.env.PATCHWARDEN_CONFIG;
  prevProfileEnv = process.env.PATCHWARDEN_TOOL_PROFILE;
  process.env.PATCHWARDEN_CONFIG = configPath;
  process.env.PATCHWARDEN_TOOL_PROFILE = "full";
  reloadConfig();
});

afterEach(() => {
  if (prevConfigEnv === undefined) {
    delete process.env.PATCHWARDEN_CONFIG;
  } else {
    process.env.PATCHWARDEN_CONFIG = prevConfigEnv;
  }
  if (prevProfileEnv === undefined) {
    delete process.env.PATCHWARDEN_TOOL_PROFILE;
  } else {
    process.env.PATCHWARDEN_TOOL_PROFILE = prevProfileEnv;
  }
  reloadConfig();
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────

describe("goal tools registry", () => {

  describe("getToolDefs — 工具定义", () => {
    it("包含全部 9 个 goal 工具", () => {
      const tools = getToolDefs();
      const names = new Set(tools.map((t) => t.name));
      for (const name of GOAL_TOOL_NAMES) {
        assert.ok(names.has(name), `Missing tool definition: ${name}`);
      }
    });

    it("每个 goal 工具描述以 v0.8.0 开头且 inputSchema.type 为 object", () => {
      const tools = getToolDefs();
      const byName = new Map(tools.map((t) => [t.name, t]));
      for (const name of GOAL_TOOL_NAMES) {
        const tool = byName.get(name);
        assert.ok(tool, `Tool not found: ${name}`);
        assert.equal(tool.inputSchema.type, "object", `${name} schema type should be object`);
        assert.ok(
          tool.description.startsWith("v0.8.0:"),
          `${name} description should start with v0.8.0:`
        );
      }
    });

    it("create_goal required 字段为 title/goal_description/repo_path", () => {
      const tools = getToolDefs();
      const tool = tools.find((t) => t.name === "create_goal");
      assert.ok(tool);
      assert.deepEqual(tool.inputSchema.required, ["title", "goal_description", "repo_path"]);
    });

    it("create_subgoal_task required 字段为 goal_id/subgoal_title/repo_path", () => {
      const tools = getToolDefs();
      const tool = tools.find((t) => t.name === "create_subgoal_task");
      assert.ok(tool);
      assert.deepEqual(tool.inputSchema.required, ["goal_id", "subgoal_title", "repo_path"]);
    });

    it("create_subgoal_task template enum 复用 TASK_TEMPLATE_NAMES", () => {
      const tools = getToolDefs();
      const tool = tools.find((t) => t.name === "create_subgoal_task");
      assert.ok(tool);
      const props = tool.inputSchema.properties as Record<string, any>;
      assert.ok(Array.isArray(props.template.enum));
      assert.ok(props.template.enum.length > 0);
    });

    it("accept_subgoal required 字段为 goal_id/subgoal_id", () => {
      const tools = getToolDefs();
      const tool = tools.find((t) => t.name === "accept_subgoal");
      assert.ok(tool);
      assert.deepEqual(tool.inputSchema.required, ["goal_id", "subgoal_id"]);
    });

    it("reject_subgoal required 字段为 goal_id/subgoal_id/reason", () => {
      const tools = getToolDefs();
      const tool = tools.find((t) => t.name === "reject_subgoal");
      assert.ok(tool);
      assert.deepEqual(tool.inputSchema.required, ["goal_id", "subgoal_id", "reason"]);
    });
  });

  describe("handleToolCall — handler 分发", () => {
    it("list_goals 返回 { goals: [] } 格式（空工作区）", async () => {
      const result = await handleToolCall("list_goals", {});
      assert.ok(Array.isArray(result.content));
      assert.equal(result.content[0].type, "text");
      const data = JSON.parse(result.content[0].text);
      assert.ok(Array.isArray(data.goals));
      assert.equal(data.goals.length, 0);
    });

    it("read_goal 不存在时抛出 goal_not_found", async () => {
      await assert.rejects(
        () => handleToolCall("read_goal", { goal_id: "goal_nonexistent_xyz_99999" }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError, "should be PatchWardenError");
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });

    it("create_goal 路径越界抛出 workspace_path_escape", async () => {
      await assert.rejects(
        () => handleToolCall("create_goal", {
          title: "Test Goal",
          goal_description: "desc",
          repo_path: "../../../../..",
        }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError, "should be PatchWardenError");
          assert.equal(err.reason, "workspace_path_escape");
          return true;
        }
      );
    });

    it("suggest_next_subgoal 不存在时抛出 goal_not_found", async () => {
      await assert.rejects(
        () => handleToolCall("suggest_next_subgoal", { goal_id: "goal_nonexistent_xyz_99999" }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError, "should be PatchWardenError");
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });

    it("summarize_goal_progress 不存在时抛出 goal_not_found", async () => {
      await assert.rejects(
        () => handleToolCall("summarize_goal_progress", { goal_id: "goal_nonexistent_xyz_99999" }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError, "should be PatchWardenError");
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });

    it("export_handoff 不存在时抛出 goal_not_found", async () => {
      await assert.rejects(
        () => handleToolCall("export_handoff", { goal_id: "goal_nonexistent_xyz_99999" }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError, "should be PatchWardenError");
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });

    it("accept_subgoal 不存在时抛出 goal_not_found", async () => {
      await assert.rejects(
        () => handleToolCall("accept_subgoal", {
          goal_id: "goal_nonexistent_xyz_99999",
          subgoal_id: "sg_1",
        }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError, "should be PatchWardenError");
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });

    it("reject_subgoal 不存在时抛出 goal_not_found", async () => {
      await assert.rejects(
        () => handleToolCall("reject_subgoal", {
          goal_id: "goal_nonexistent_xyz_99999",
          subgoal_id: "sg_1",
          reason: "test reason",
        }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError, "should be PatchWardenError");
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });

    it("create_subgoal_task 不存在时抛出 goal_not_found", async () => {
      await assert.rejects(
        () => handleToolCall("create_subgoal_task", {
          goal_id: "goal_nonexistent_xyz_99999",
          subgoal_title: "Sub A",
          repo_path: "repo",
        }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError, "should be PatchWardenError");
          assert.equal(err.reason, "goal_not_found");
          return true;
        }
      );
    });
  });
});
