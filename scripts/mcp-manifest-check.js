#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CHATGPT_CORE_TOOL_NAMES, CHATGPT_DIRECT_TOOL_NAMES } from "../dist/tools/toolCatalog.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jsonOnly = process.argv.includes("--json");
const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : "chatgpt_core";
if (profile !== "chatgpt_core" && profile !== "chatgpt_direct") {
  throw new Error(`Unsupported manifest profile "${profile}".`);
}
const expectedTools = profile === "chatgpt_direct"
  ? [...CHATGPT_DIRECT_TOOL_NAMES]
  : [...CHATGPT_CORE_TOOL_NAMES];
const defaultConfigPath = resolve(root, "patchwarden.config.json");
const transportEnv = {
  ...process.env,
  PATCHWARDEN_TOOL_PROFILE: profile,
};

// When checking chatgpt_direct profile, ensure enableDirectProfile is true
// by creating a temporary config if needed.
let tempConfigPath = null;
if (profile === "chatgpt_direct") {
  const baseConfig = existsSync(defaultConfigPath)
    ? JSON.parse(readFileSync(defaultConfigPath, "utf-8"))
    : {};
  if (!baseConfig.enableDirectProfile) {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    tempConfigPath = join(mkdtempSync(join(tmpdir(), "pw-direct-")), "config.json");
    writeFileSync(tempConfigPath, JSON.stringify({ ...baseConfig, enableDirectProfile: true }, null, 2), "utf-8");
    transportEnv.PATCHWARDEN_CONFIG = tempConfigPath;
  }
}

if (!transportEnv.PATCHWARDEN_CONFIG) {
  if (process.env.PATCHWARDEN_CONFIG) {
    transportEnv.PATCHWARDEN_CONFIG = process.env.PATCHWARDEN_CONFIG;
  } else if (existsSync(defaultConfigPath)) {
    transportEnv.PATCHWARDEN_CONFIG = defaultConfigPath;
  } else {
    delete transportEnv.PATCHWARDEN_CONFIG;
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, "dist", "index.js")],
  cwd: root,
  env: transportEnv,
  stderr: "pipe",
});

const client = new Client(
  { name: "patchwarden-manifest-check", version: "0.6.0" },
  { capabilities: {} }
);

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  if (JSON.stringify(names) !== JSON.stringify(expectedTools)) {
    throw new Error(`${profile} tool list mismatch. Expected ${expectedTools.join(", ")}; got ${names.join(", ")}`);
  }
  // Layer 2: tools/list must carry _meta with manifest hash for catalog sync
  if (!listed._meta || listed._meta.tool_profile !== profile || listed._meta.tool_count !== expectedTools.length) {
    throw new Error(`tools/list _meta missing or wrong profile/count: ${JSON.stringify(listed._meta || null)}`);
  }
  if (typeof listed._meta.tool_manifest_sha256 !== "string" || listed._meta.tool_manifest_sha256.length !== 64) {
    throw new Error(`tools/list _meta manifest hash invalid: ${JSON.stringify(listed._meta)}`);
  }
  if (typeof listed._meta.schema_epoch !== "string" || typeof listed._meta.server_version !== "string") {
    throw new Error(`tools/list _meta missing schema_epoch/server_version: ${JSON.stringify(listed._meta)}`);
  }
  if (profile === "chatgpt_core") {
    const createTask = listed.tools.find((tool) => tool.name === "create_task");
    const createProperties = Object.keys(createTask?.inputSchema?.properties || {});
    for (const requiredProperty of ["inline_plan", "verify_commands"]) {
      if (!createProperties.includes(requiredProperty)) {
        throw new Error(`create_task schema is missing ${requiredProperty}`);
      }
    }
    const waitTool = listed.tools.find((tool) => tool.name === "wait_for_task");
    const waitProperties = Object.keys(waitTool?.inputSchema?.properties || {});
    if (!waitProperties.includes("timeout_seconds") || !waitProperties.includes("wait_seconds")) {
      throw new Error("wait_for_task schema must expose timeout_seconds and wait_seconds");
    }
    const healthProperties = Object.keys(listed.tools.find((tool) => tool.name === "health_check")?.inputSchema?.properties || {});
    if (!healthProperties.includes("detail")) throw new Error("health_check schema must expose detail");
    const listTaskProperties = Object.keys(listed.tools.find((tool) => tool.name === "list_tasks")?.inputSchema?.properties || {});
    if (!listTaskProperties.includes("repo_path") || !listTaskProperties.includes("active_only")) {
      throw new Error("list_tasks schema must expose repo_path and active_only");
    }
    const summaryProperties = Object.keys(listed.tools.find((tool) => tool.name === "get_task_summary")?.inputSchema?.properties || {});
    if (!summaryProperties.includes("view") || !summaryProperties.includes("max_items")) {
      throw new Error("get_task_summary schema must expose view and max_items");
    }
  } else {
    const directRequirements = {
      create_direct_session: ["repo_path"],
      apply_patch: ["session_id", "path", "expected_sha256", "operations"],
      run_verification: ["session_id", "command"],
      finalize_direct_session: ["session_id"],
      audit_session: ["session_id"],
    };
    for (const [toolName, requiredProperties] of Object.entries(directRequirements)) {
      const tool = listed.tools.find((entry) => entry.name === toolName);
      const properties = Object.keys(tool?.inputSchema?.properties || {});
      for (const property of requiredProperties) {
        if (!properties.includes(property)) {
          throw new Error(`${toolName} schema is missing ${property}`);
        }
      }
    }
  }
  const healthResult = await client.callTool({ name: "health_check", arguments: {} });
  if (healthResult.isError) throw new Error(String(healthResult.content?.[0]?.text || "health_check failed"));
  const health = JSON.parse(String(healthResult.content?.[0]?.text || "{}"));
  if (
    health.tool_profile !== profile ||
    health.tool_count !== expectedTools.length ||
    !health.tool_manifest_sha256 ||
    (profile === "chatgpt_direct" && health.direct_profile_enabled !== true)
  ) {
    throw new Error(`health_check catalog mismatch: ${JSON.stringify(health)}`);
  }
  if (profile === "chatgpt_core") {
    const hiddenResult = await client.callTool({ name: "get_plan", arguments: { plan_id: "stale-client-probe" } });
    const hiddenPayload = JSON.parse(String(hiddenResult.content?.[0]?.text || "{}"));
    if (
      !hiddenResult.isError ||
      hiddenPayload.reason !== "tool_catalog_mismatch" ||
      hiddenPayload.refresh_required !== true ||
      hiddenPayload.tool_manifest_sha256 !== health.tool_manifest_sha256
    ) {
      throw new Error(`hidden tool mismatch guidance is incomplete: ${JSON.stringify(hiddenPayload)}`);
    }
    if (hiddenPayload.next_tool_call?.name !== "health_check" || hiddenPayload.next_tool_call?.arguments?.detail !== "self_diagnostic") {
      throw new Error(`mismatch next_tool_call missing or wrong: ${JSON.stringify(hiddenPayload.next_tool_call || null)}`);
    }
    if (!Array.isArray(hiddenPayload.connector_refresh_steps) || hiddenPayload.connector_refresh_steps.length < 3) {
      throw new Error(`mismatch connector_refresh_steps missing or too short: ${JSON.stringify(hiddenPayload.connector_refresh_steps || null)}`);
    }
  }

  const output = {
    ok: true,
    server_version: health.server_version,
    schema_epoch: health.schema_epoch,
    tool_profile: health.tool_profile,
    tool_count: health.tool_count,
    tool_names: health.tool_names,
    tool_manifest_sha256: health.tool_manifest_sha256,
    required_schema: profile === "chatgpt_core" ? {
      create_task: ["inline_plan", "verify_commands"],
      wait_for_task: ["timeout_seconds", "wait_seconds"],
      health_check: ["detail"],
      list_tasks: ["repo_path", "active_only"],
      get_task_summary: ["view", "max_items"],
    } : {
      create_direct_session: ["repo_path"],
      apply_patch: ["session_id", "path", "expected_sha256", "operations"],
      run_verification: ["session_id", "command"],
      finalize_direct_session: ["session_id"],
      audit_session: ["session_id"],
    },
  };
  console.log(jsonOnly ? JSON.stringify(output) : JSON.stringify(output, null, 2));
} catch (error) {
  const failure = { ok: false, error: error instanceof Error ? error.message : String(error) };
  console.error(jsonOnly ? JSON.stringify(failure) : JSON.stringify(failure, null, 2));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  if (tempConfigPath) {
    try { rmSync(tempConfigPath, { force: true }); } catch {}
  }
}
