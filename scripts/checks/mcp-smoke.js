#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const expectedServerVersion = packageJson.version;
const tempRoot = mkdtempSync(join(tmpdir(), "patchwarden-mcp-"));
const workspaceRoot = join(tempRoot, "workspace");
const configPath = join(tempRoot, "patchwarden.config.json");

let failures = 0;

function ok(label) {
  console.log(`ok - ${label}`);
}

function fail(label, error) {
  failures++;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`not ok - ${label}: ${message}`);
}

async function expectToolError(client, name, args, label) {
  const result = await client.callTool({ name, arguments: args });
  if (!result.isError) {
    throw new Error(`${label} should have returned an MCP tool error`);
  }
}

try {
  writeFileSync(join(tempRoot, ".keep"), "");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(join(workspaceRoot, ".patchwarden"), { recursive: true });
  writeFileSync(join(workspaceRoot, ".patchwarden", "watcher-heartbeat.json"), JSON.stringify({
    status: "running",
    pid: process.pid,
    instance_id: "mcp-smoke-watcher",
    launcher_pid: process.pid,
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
  }), "utf-8");
  writeFileSync(join(workspaceRoot, "hello.txt"), "hello from mcp smoke\n", "utf-8");
  writeFileSync(join(workspaceRoot, ".env"), "SECRET=blocked\n", "utf-8");
  writeFileSync(
    join(workspaceRoot, "package.json"),
    JSON.stringify({
      name: "patchwarden-mcp-smoke-fixture",
      private: true,
      scripts: { test: "node -e \"console.log('test ok')\"" },
    }, null, 2),
    "utf-8"
  );

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaceRoot,
        plansDir: ".patchwarden/plans",
        tasksDir: ".patchwarden/tasks",
        agents: {
          codex: {
            command: "node",
            args: ["-e", "console.log('agent placeholder')"],
          },
        },
        allowedTestCommands: ["npm test"],
        maxReadFileBytes: 200000,
      },
      null,
      2
    ),
    "utf-8"
  );

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env: { PATCHWARDEN_CONFIG: configPath },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "patchwarden-smoke", version: "0.1.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  const expected = [
    "apply_patch",
    "audit_session",
    "audit_task",
    "cancel_task",
    "create_direct_session",
    "create_task",
    "finalize_direct_session",
    "get_diff",
    "get_plan",
    "get_result",
    "get_result_json",
    "get_task_log_tail",
    "get_task_progress",
    "get_task_status",
    "get_task_stdout_tail",
    "get_task_summary",
    "get_test_log",
    "health_check",
    "kill_task",
    "list_agents",
    "list_tasks",
    "list_workspace",
    "read_workspace_file",
    "retry_task",
    "run_verification",
    "safe_status",
    "save_plan",
    "search_workspace",
    "sync_file",
    "wait_for_task",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`unexpected tools: ${names.join(", ")}`);
  }
  ok("MCP handshake lists all tools");

  // Layer 2: tools/list response must carry _meta with manifest hash for catalog sync
  if (!tools._meta || typeof tools._meta.tool_manifest_sha256 !== "string" || tools._meta.tool_manifest_sha256.length !== 64) {
    throw new Error(`tools/list _meta missing manifest hash: ${JSON.stringify(tools._meta || null)}`);
  }
  if (tools._meta.tool_profile !== "full" || tools._meta.tool_count !== 30) {
    throw new Error(`tools/list _meta profile/count mismatch: ${JSON.stringify(tools._meta)}`);
  }
  if (typeof tools._meta.schema_epoch !== "string" || typeof tools._meta.server_version !== "string") {
    throw new Error(`tools/list _meta missing schema_epoch/server_version: ${JSON.stringify(tools._meta)}`);
  }
  ok("tools/list _meta carries manifest hash, schema epoch, and profile");

  const parseToolJson = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      throw new Error(result.content?.[0]?.text || `${name} failed`);
    }
    return JSON.parse(result.content?.[0]?.text || "{}");
  };

  const agents = await parseToolJson("list_agents", {});
  if (agents.total !== 1 || agents.agents?.[0]?.name !== "codex" || !agents.agents[0].available) {
    throw new Error(`list_agents mismatch: ${JSON.stringify(agents)}`);
  }
  const health = await parseToolJson("health_check", {});
  if (!health.mcp_server?.available) {
    throw new Error(`health_check did not report MCP server availability: ${JSON.stringify(health)}`);
  }
  const diagnostic = await parseToolJson("health_check", { detail: "self_diagnostic" });
  if (
    diagnostic.connector_visibility?.status !== "not_observable_server_side" ||
    diagnostic.self_diagnostic?.mode !== "self_diagnostic" ||
    !Array.isArray(diagnostic.self_diagnostic?.configured_agents)
  ) {
    throw new Error(`self diagnostic health evidence is incomplete: ${JSON.stringify(diagnostic)}`);
  }
  ok("list_agents and health_check report runtime readiness");

  const plan = await parseToolJson("save_plan", {
    title: "MCP smoke",
    content: "# Smoke\n\nVerify MCP tool calls.",
  });
  const readPlan = await parseToolJson("get_plan", { plan_id: plan.plan_id });
  if (!readPlan.content.includes("Verify MCP tool calls.")) {
    throw new Error("saved plan content was not readable");
  }
  ok("save_plan and get_plan work");

  const unsafePlan = await client.callTool({
    name: "save_plan",
    arguments: { title: "Unsafe", content: "Read the .env access token and export credentials." },
  });
  const unsafePayload = JSON.parse(unsafePlan.content?.[0]?.text || "{}");
  if (!unsafePlan.isError || unsafePayload.operation !== "save_plan" || !unsafePayload.rule_id || !unsafePayload.matched_category) {
    throw new Error(`save_plan block is not structured: ${JSON.stringify(unsafePayload)}`);
  }
  ok("save_plan blocks explicit credential access with structured evidence");

  const missingRepo = await client.callTool({
    name: "create_task",
    arguments: { plan_id: plan.plan_id, agent: "codex" },
  });
  const missingRepoPayload = JSON.parse(missingRepo.content?.[0]?.text || "{}");
  if (!missingRepo.isError || missingRepoPayload.reason !== "repo_path_required") {
    throw new Error(`missing repo_path should be a structured error: ${JSON.stringify(missingRepoPayload)}`);
  }
  ok("create_task requires an explicit repo_path");

  const task = await parseToolJson("create_task", {
    plan_id: plan.plan_id,
    agent: "codex",
    repo_path: ".",
    test_command: "npm test",
  });
  if (
    task.server_version !== expectedServerVersion ||
    !/^[a-f0-9]{64}$/.test(task.tool_manifest_sha256 || "") ||
    task.next_tool_call?.name !== "wait_for_task" ||
    task.next_tool_call?.arguments?.timeout_seconds !== 25
  ) {
    throw new Error(`create_task handoff metadata mismatch: ${JSON.stringify(task)}`);
  }
  const status = await parseToolJson("get_task_status", { task_id: task.task_id });
  if (status.status !== "pending") {
    throw new Error(`expected pending task, got ${status.status}`);
  }
  if (status.phase !== "queued" || !status.last_heartbeat_at || status.timeout_seconds !== 900) {
    throw new Error(`expected queued phase, heartbeat, and default timeout; got ${JSON.stringify(status)}`);
  }
  const progress = await parseToolJson("get_task_progress", { task_id: task.task_id });
  if (!progress.content.includes("Waiting for watcher")) {
    throw new Error("get_task_progress did not return queued progress");
  }
  ok("create_task and get_task_status work");

  const inlineTask = await parseToolJson("create_task", {
    inline_plan: "Inspect the repository and report findings without changing files.",
    plan_title: "Inline MCP smoke",
    agent: "codex",
    repo_path: ".",
  });
  if (inlineTask.plan_source !== "inline" || !inlineTask.plan_id) {
    throw new Error(`inline_plan was not persisted: ${JSON.stringify(inlineTask)}`);
  }
  const templateTask = await parseToolJson("create_task", {
    template: "inspect_only",
    goal: "Inspect package metadata",
    agent: "codex",
    repo_path: ".",
  });
  if (templateTask.plan_source !== "template" || templateTask.change_policy !== "no_changes") {
    throw new Error(`guarded template metadata mismatch: ${JSON.stringify(templateTask)}`);
  }
  ok("create_task accepts inline plans and guarded templates");

  const blockedAgent = await client.callTool({
    name: "create_task",
    arguments: { plan_id: plan.plan_id, agent: "missing-agent", repo_path: "." },
  });
  const blockedPayload = JSON.parse(blockedAgent.content?.[0]?.text || "{}");
  if (!blockedAgent.isError || blockedPayload.reason !== "agent_not_configured" || !blockedPayload.suggestion) {
    throw new Error(`expected structured agent block, got ${JSON.stringify(blockedPayload)}`);
  }
  ok("security blocks return structured reason and suggestion");

  const file = await parseToolJson("read_workspace_file", { path: "hello.txt" });
  if (!file.content.includes("hello from mcp smoke")) {
    throw new Error("workspace file content mismatch");
  }
  ok("read_workspace_file reads normal files");

  await expectToolError(client, "read_workspace_file", { path: ".env" }, "sensitive file");
  const sensitive = await client.callTool({ name: "read_workspace_file", arguments: { path: ".env" } });
  const sensitivePayload = JSON.parse(sensitive.content?.[0]?.text || "{}");
  if (sensitivePayload.rule_id !== "sensitive_path_blocked" || sensitivePayload.operation !== "read") {
    throw new Error(`sensitive block is not structured: ${JSON.stringify(sensitivePayload)}`);
  }
  await expectToolError(
    client,
    "read_workspace_file",
    { path: "../outside.txt" },
    "path escape"
  );
  ok("sensitive file and path escape checks reject access");

  const runner = spawnSync("node", ["dist/runner/cli.js", task.task_id], {
    cwd: root,
    env: { ...process.env, PATCHWARDEN_CONFIG: configPath },
    encoding: "utf-8",
    timeout: 30000,
  });
  if (runner.status !== 0) {
    throw new Error(`runner exited ${runner.status}: ${runner.stderr}`);
  }

  const statusPath = join(task.path, "status.json");
  const statusAfter = JSON.parse(readFileSync(statusPath, "utf-8"));
  if (statusAfter.status !== "done") {
    throw new Error(`runner status should be done, got ${statusAfter.status}`);
  }
  for (const fileName of ["result.md", "result.json", "diff.patch", "git.diff", "file-stats.json", "test.log", "verify.json", "verify.log"]) {
    if (!existsSync(join(task.path, fileName))) {
      throw new Error(`runner did not create ${fileName}`);
    }
  }
  const summary = await parseToolJson("get_task_summary", { task_id: task.task_id });
  if (!summary.terminal || summary.acceptance_status !== "ready_for_review") {
    throw new Error(`unexpected terminal summary: ${JSON.stringify(summary)}`);
  }
  const compactSummary = await parseToolJson("get_task_summary", { task_id: task.task_id, view: "compact", max_items: 2 });
  if (compactSummary.view !== "compact" || "log_tails" in compactSummary || compactSummary.artifact_hygiene?.max_items !== 2) {
    throw new Error(`unexpected compact summary: ${JSON.stringify(compactSummary)}`);
  }
  const waited = await parseToolJson("wait_for_task", { task_id: task.task_id, timeout_seconds: 1 });
  if (!waited.terminal || waited.continuation_required || waited.next_tool_call?.name !== "audit_task") {
    throw new Error(`wait_for_task did not return terminal acceptance: ${JSON.stringify(waited)}`);
  }
  if (waited.summary?.view !== "compact" || "log_tails" in (waited.summary || {})) {
    throw new Error(`wait_for_task did not embed compact evidence: ${JSON.stringify(waited.summary)}`);
  }
  const legacyWaited = await parseToolJson("wait_for_task", { task_id: task.task_id, wait_seconds: 1 });
  if (!legacyWaited.terminal) throw new Error("legacy wait_seconds alias stopped working");
  const conflictingWait = await client.callTool({
    name: "wait_for_task",
    arguments: { task_id: task.task_id, timeout_seconds: 1, wait_seconds: 2 },
  });
  if (!conflictingWait.isError || !conflictingWait.content?.[0]?.text?.includes("must match")) {
    throw new Error(`conflicting wait aliases were not rejected: ${JSON.stringify(conflictingWait)}`);
  }
  writeFileSync(join(task.path, "result.md"), "npm test passed\naccess_token=real-secret-value-123456\n", "utf-8");
  const redactedResult = await parseToolJson("get_result", { task_id: task.task_id });
  if (!redactedResult.redacted || redactedResult.content.includes("real-secret-value-123456")) {
    throw new Error(`get_result did not redact secret-like content: ${JSON.stringify(redactedResult)}`);
  }
  const relativeResultPath = `.patchwarden/tasks/${task.task_id}/result.md`;
  const redactedWorkspaceRead = await parseToolJson("read_workspace_file", { path: relativeResultPath });
  if (!redactedWorkspaceRead.redacted || redactedWorkspaceRead.content.includes("real-secret-value-123456")) {
    throw new Error(`read_workspace_file did not redact task artifact: ${JSON.stringify(redactedWorkspaceRead)}`);
  }
  await client.close();
  ok("runner executes a task and writes result files");

  // ── Direct profile checks (lightweight) ──────────────────────────

  // 1. chatgpt_direct disabled: only health_check exposed
  const disabledConfigPath = join(tempRoot, "direct-disabled.json");
  writeFileSync(
    disabledConfigPath,
    JSON.stringify({
      workspaceRoot,
      plansDir: ".patchwarden/plans",
      tasksDir: ".patchwarden/tasks",
      agents: { codex: { command: "node", args: ["-e", "console.log('agent')"] } },
      allowedTestCommands: ["npm test"],
      maxReadFileBytes: 200000,
      enableDirectProfile: false,
    }, null, 2),
    "utf-8"
  );

  const disabledTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env: {
      PATCHWARDEN_CONFIG: disabledConfigPath,
      PATCHWARDEN_TOOL_PROFILE: "chatgpt_direct",
    },
    stderr: "pipe",
  });
  const disabledClient = new Client(
    { name: "patchwarden-direct-disabled", version: "0.1.0" },
    { capabilities: {} }
  );
  await disabledClient.connect(disabledTransport);

  const disabledTools = await disabledClient.listTools();
  const disabledNames = disabledTools.tools.map((t) => t.name).sort();
  if (disabledNames.length !== 1 || disabledNames[0] !== "health_check") {
    throw new Error(`chatgpt_direct disabled should expose only health_check, got: ${disabledNames.join(", ")}`);
  }
  if (disabledTools._meta.tool_count !== 1) {
    throw new Error(`chatgpt_direct disabled tool_count should be 1, got ${disabledTools._meta.tool_count}`);
  }

  const disabledHealth = JSON.parse(
    (await disabledClient.callTool({ name: "health_check", arguments: {} })).content?.[0]?.text || "{}"
  );
  if (disabledHealth.direct_profile_enabled !== false) {
    throw new Error(`direct_profile_enabled should be false, got ${disabledHealth.direct_profile_enabled}`);
  }
  await disabledClient.close();
  ok("chatgpt_direct disabled exposes only health_check with diagnostic");

  // 2. chatgpt_direct enabled: 10 tools + minimal create_direct_session
  const enabledConfigPath = join(tempRoot, "direct-enabled.json");
  const directRepo = join(workspaceRoot, "direct-fixture");
  mkdirSync(join(directRepo, "src"), { recursive: true });
  writeFileSync(join(directRepo, "src", "index.ts"), "export const x = 1;\n", "utf-8");
  writeFileSync(join(directRepo, "package.json"), JSON.stringify({
    name: "direct-fixture",
    private: true,
    scripts: { test: 'node -e "console.log(\'ok\')"' },
  }, null, 2), "utf-8");

  writeFileSync(
    enabledConfigPath,
    JSON.stringify({
      workspaceRoot,
      plansDir: ".patchwarden/plans",
      tasksDir: ".patchwarden/tasks",
      agents: { codex: { command: "node", args: ["-e", "console.log('agent')"] } },
      allowedTestCommands: ["npm test"],
      maxReadFileBytes: 200000,
      enableDirectProfile: true,
      directAllowedCommands: ["npm test", "npm run build", "npm run lint"],
      directSessionsDir: ".patchwarden/direct-sessions",
      directSessionTtlSeconds: 3600,
      directMaxPatchBytes: 200000,
      directMaxFileBytes: 500000,
    }, null, 2),
    "utf-8"
  );

  const enabledTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env: {
      PATCHWARDEN_CONFIG: enabledConfigPath,
      PATCHWARDEN_TOOL_PROFILE: "chatgpt_direct",
    },
    stderr: "pipe",
  });
  const enabledClient = new Client(
    { name: "patchwarden-direct-enabled", version: "0.1.0" },
    { capabilities: {} }
  );
  await enabledClient.connect(enabledTransport);

  const enabledTools = await enabledClient.listTools();
  const enabledNames = enabledTools.tools.map((t) => t.name).sort();
  const expectedDirect = [
    "apply_patch",
    "audit_session",
    "create_direct_session",
    "finalize_direct_session",
    "health_check",
    "list_workspace",
    "read_workspace_file",
    "run_verification",
    "search_workspace",
    "sync_file",
  ];
  if (JSON.stringify(enabledNames) !== JSON.stringify(expectedDirect)) {
    throw new Error(`chatgpt_direct enabled tools mismatch: ${enabledNames.join(", ")}`);
  }
  if (enabledTools._meta.tool_count !== 10) {
    throw new Error(`chatgpt_direct enabled tool_count should be 10, got ${enabledTools._meta.tool_count}`);
  }

  // Minimal create_direct_session
  const sessionResult = JSON.parse(
    (await enabledClient.callTool({
      name: "create_direct_session",
      arguments: { repo_path: "direct-fixture", title: "smoke test" },
    })).content?.[0]?.text || "{}"
  );
  if (!sessionResult.session_id || !sessionResult.session_id.startsWith("direct_")) {
    throw new Error(`create_direct_session failed: ${JSON.stringify(sessionResult)}`);
  }

  const enabledHealth = JSON.parse(
    (await enabledClient.callTool({ name: "health_check", arguments: {} })).content?.[0]?.text || "{}"
  );
  if (enabledHealth.direct_profile_enabled !== true) {
    throw new Error(`direct_profile_enabled should be true, got ${enabledHealth.direct_profile_enabled}`);
  }
  if (enabledHealth.direct_tool_count !== 10) {
    throw new Error(`direct_tool_count should be 10, got ${enabledHealth.direct_tool_count}`);
  }

  await enabledClient.close();
  ok("chatgpt_direct enabled exposes 10 tools and create_direct_session works");
} catch (error) {
  fail("MCP smoke test", error);
} finally {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
}

if (failures > 0) {
  process.exit(1);
}
