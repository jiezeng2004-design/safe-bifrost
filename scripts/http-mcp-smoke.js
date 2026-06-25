#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { CHATGPT_CORE_TOOL_NAMES } from "../dist/tools/toolCatalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const serverPath = resolve(root, "dist", "httpServer.js");

const host = "127.0.0.1";
const port = 17331;
const mcpUrl = `http://${host}:${port}/mcp`;

const tempRoot = mkdtempSync(join(tmpdir(), "patchwarden-http-"));
const workspaceRoot = join(tempRoot, "workspace");
const configPath = join(tempRoot, "patchwarden.config.json");

let passed = 0;
let failed = 0;
let serverProcess = null;
let serverStderr = "";

function ok(name) {
  console.log(`  ok - ${name}`);
  passed++;
}

function fail(name, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`  not ok - ${name}: ${message}`);
  failed++;
}

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (error) {
    fail(name, error);
  }
}

function parseSseMessage(text) {
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) {
    throw new Error(`No SSE data line in response: ${text.slice(0, 200)}`);
  }
  return JSON.parse(dataLines.join("\n"));
}

async function rpc(method, params = {}, extraHeaders = {}) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1_000_000),
      method,
      params,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const payload = parseSseMessage(text);
  if (payload.error) {
    return { isError: true, error: payload.error };
  }
  return payload.result;
}

function toolText(result) {
  return String(result?.content?.[0]?.text || "");
}

function toolJson(result) {
  return JSON.parse(toolText(result));
}

console.log("\n=== PatchWarden HTTP MCP Smoke Tests ===\n");

try {
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, "hello.txt"), "hello from http smoke\n", "utf-8");
  writeFileSync(join(workspaceRoot, ".env"), "SECRET=blocked\n", "utf-8");
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
        httpPort: port,
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(`Starting HTTP MCP server on ${mcpUrl}...`);
  serverProcess = spawn("node", [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      PATCHWARDEN_CONFIG: configPath,
      PATCHWARDEN_HTTP_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  serverProcess.stderr.on("data", (chunk) => {
    serverStderr += chunk.toString();
  });

  await sleep(3000);
  if (serverProcess.exitCode !== null) {
    throw new Error(`HTTP server exited early: ${serverStderr}`);
  }

  await test("initialize returns server info", async () => {
    const result = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "http-mcp-smoke", version: "1.0.0" },
    });
    if (result.serverInfo?.name !== "patchwarden") {
      throw new Error(`Unexpected server info: ${JSON.stringify(result.serverInfo)}`);
    }
  });

  await test("healthz returns structured local readiness", async () => {
    const response = await fetch(`http://${host}:${port}/healthz`);
    const data = await response.json();
    if (!response.ok || data.mcp_server?.available !== true || data.workspace_root?.available !== true) {
      throw new Error(`Unexpected health response: ${JSON.stringify(data)}`);
    }
  });

  await test("wrong endpoint returns structured 404 guidance", async () => {
    const response = await fetch(`http://${host}:${port}/wrong-path`);
    const data = await response.json();
    if (response.status !== 404 || data.error_code !== "mcp_endpoint_not_found" || data.expected_path !== "/mcp") {
      throw new Error(`Unexpected 404 response: ${JSON.stringify(data)}`);
    }
  });

  await test("tools/list returns expected tools", async () => {
    const result = await rpc("tools/list");
    const toolNames = result.tools.map((tool) => tool.name);
    for (const expected of [
      "save_plan",
      "get_plan",
      "create_task",
      "get_task_status",
      "get_result",
      "get_diff",
      "get_test_log",
      "list_workspace",
      "read_workspace_file",
    ]) {
      if (!toolNames.includes(expected)) {
        throw new Error(`Missing tool ${expected}; got ${toolNames.join(", ")}`);
      }
    }
  });

  await test("list_workspace returns entries", async () => {
    const result = await rpc("tools/call", {
      name: "list_workspace",
      arguments: {},
    });
    const data = toolJson(result);
    if (!Array.isArray(data.entries)) {
      throw new Error("Expected entries array");
    }
  });

  await test("save_plan creates a plan", async () => {
    const result = await rpc("tools/call", {
      name: "save_plan",
      arguments: {
        title: "HTTP Test Plan",
        content: "# HTTP Test\n\nHello from HTTP MCP.",
      },
    });
    const data = toolJson(result);
    if (!data.plan_id || !existsSync(data.path)) {
      throw new Error(`Expected created plan, got ${JSON.stringify(data)}`);
    }
  });

  await test("read_workspace_file reads normal files", async () => {
    const result = await rpc("tools/call", {
      name: "read_workspace_file",
      arguments: { path: "hello.txt" },
    });
    const data = toolJson(result);
    if (!data.content.includes("hello from http smoke")) {
      throw new Error("Unexpected file content");
    }
  });

  await test("read_workspace_file blocks .env", async () => {
    const result = await rpc("tools/call", {
      name: "read_workspace_file",
      arguments: { path: ".env" },
    });
    if (!result.isError) {
      throw new Error("Expected .env read to be blocked");
    }
  });

  await test("read_workspace_file blocks path escape", async () => {
    const result = await rpc("tools/call", {
      name: "read_workspace_file",
      arguments: { path: "../../etc/passwd" },
    });
    if (!result.isError) {
      throw new Error("Expected path escape to be blocked");
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Section: Owner Token Authentication
  // ═══════════════════════════════════════════════════════════

  // Kill the no-token server
  serverProcess.kill("SIGKILL");
  await Promise.race([
    new Promise((resolve) => serverProcess.once("exit", resolve)),
    sleep(2000),
  ]);

  const OWNER_TOKEN = "test-token-secure-abc123";

  // Start server WITH owner token
  console.log("\n  Starting server with owner token...");
  serverProcess = spawn("node", [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      PATCHWARDEN_CONFIG: configPath,
      PATCHWARDEN_HTTP_PORT: String(port),
      PATCHWARDEN_OWNER_TOKEN: OWNER_TOKEN,
      PATCHWARDEN_TOOL_PROFILE: "chatgpt_core",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  serverProcess.stderr.on("data", (chunk) => { serverStderr += chunk.toString(); });
  await sleep(3000);
  // Wait for server to be ready
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`${mcpUrl}/healthz`);
      if (r.status === 200) break;
    } catch {}
    await sleep(500);
  }

  await test("token: no token returns 401", async () => {
    try {
      await rpc("tools/list");
      throw new Error("Should have been rejected");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("401") && !msg.includes("Unauthorized")) {
        throw new Error(`Expected 401, got: ${msg.slice(0, 100)}`);
      }
    }
  });

  await test("token: wrong token returns 401", async () => {
    try {
      await rpc("tools/list", {}, { Authorization: "Bearer wrong-token" });
      throw new Error("Should have been rejected");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("401")) {
        throw new Error(`Expected 401, got: ${msg.slice(0, 100)}`);
      }
    }
  });

  await test("token: correct Bearer token succeeds", async () => {
    const result = await rpc("tools/list", {}, { Authorization: `Bearer ${OWNER_TOKEN}` });
    const names = result.tools?.map((tool) => tool.name) || [];
    if (
      JSON.stringify(names) !== JSON.stringify(CHATGPT_CORE_TOOL_NAMES) ||
      !names.includes("wait_for_task") ||
      !names.includes("get_task_summary") ||
      names.includes("kill_task")
    ) {
      throw new Error(`Expected exact chatgpt_core tools with valid token: ${JSON.stringify(names)}`);
    }
  });

  await test("token: correct x-patchwarden-token header succeeds", async () => {
    const result = await rpc("tools/list", {}, { "x-patchwarden-token": OWNER_TOKEN });
    if (!result.tools || result.tools.length === 0) {
      throw new Error("Expected tools list with valid custom header token");
    }
  });

} catch (error) {
  fail("HTTP MCP smoke setup", error);
} finally {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => serverProcess.once("exit", resolve)),
      sleep(2000),
    ]);
  }
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${"=".repeat(50)}`);
console.log(`${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"=".repeat(50)}\n`);

if (failed > 0) {
  console.error("SOME HTTP MCP TESTS FAILED");
  if (serverStderr) {
    console.error("\nServer stderr:");
    console.error(serverStderr.slice(0, 2000));
  }
  process.exit(1);
}

console.log("ALL HTTP MCP TESTS PASSED\n");
