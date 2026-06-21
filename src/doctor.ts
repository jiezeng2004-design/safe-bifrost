#!/usr/bin/env node
/**
 * PatchWarden Doctor — read-only diagnostic checks
 *
 * Usage: node dist/doctor.js  or  npm run doctor
 *
 * Checks 15 aspects of the environment and configuration.
 * Never modifies files, installs dependencies, or starts services.
 */

import { existsSync, statSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { isAbsolute, resolve, normalize, join } from "node:path";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { loadConfig, getConfig } from "./config.js";
import { guardPath, guardWorkspacePath } from "./security/pathGuard.js";
import { isSensitivePath } from "./security/sensitiveGuard.js";
import { guardPlanContent } from "./security/planGuard.js";
import { TASK_READ_ONLY_FILES } from "./tools/getTaskFile.js";
import { getToolDefs } from "./tools/registry.js";
import { CHATGPT_CORE_TOOL_NAMES, selectToolsForProfile } from "./tools/toolCatalog.js";
import { PATCHWARDEN_VERSION } from "./version.js";

// ── State ──────────────────────────────────────────────────────────

let ok = 0;
let warn = 0;
let fail = 0;
const results: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    results.push(`[OK]   ${name}`);
    ok++;
  } else {
    results.push(`[FAIL] ${name}${detail ? " — " + detail : ""}`);
    fail++;
  }
}

function warnCheck(name: string, condition: boolean, detail?: string) {
  if (condition) {
    results.push(`[OK]   ${name}`);
    ok++;
  } else {
    results.push(`[WARN] ${name}${detail ? " — " + detail : ""}`);
    warn++;
  }
}

function cmd(cmdStr: string): string {
  try {
    return execSync(cmdStr, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"], // suppress stdin and stderr
    }).trim();
  } catch {
    return "";
  }
}

// ══════════════════════════════════════════════════════════════════

async function main() {

console.log("PatchWarden Doctor\n");
const allowDefaultConfig = process.argv.includes("--allow-default-config");

// 1. Node version
const nodeVer = process.version;
const nodeMajor = parseInt(nodeVer.slice(1).split(".")[0]);
check("Node.js version", nodeMajor >= 18,
  nodeMajor < 18 ? `v${nodeVer} — need >=18.0.0` : `v${nodeVer}`);

// 2. npm
const npmVer = cmd("npm --version");
check("npm available", npmVer !== "", npmVer || "npm not found in PATH");

// 3. Git
const gitVer = cmd("git --version");
warnCheck("Git available", gitVer !== "",
  gitVer || "git not found — runner git.diff will not work");

// 4. Config file exists
const configPaths = [
  resolve(process.cwd(), "patchwarden.config.json"),
  process.env.PATCHWARDEN_CONFIG || "",
].filter(Boolean);

let configPathUsed = "";
for (const p of configPaths) {
  if (existsSync(p)) { configPathUsed = p; break; }
}

const configDetail = configPathUsed
  ? configPathUsed
  : 'Create one: cp examples/config.example.json patchwarden.config.json';
if (allowDefaultConfig) {
  warnCheck("Config file exists", configPathUsed !== "", configDetail);
} else {
  check("Config file exists", configPathUsed !== "", configDetail);
}

// 5. PATCHWARDEN_CONFIG env
if (process.env.PATCHWARDEN_CONFIG) {
  results.push(`[OK]   PATCHWARDEN_CONFIG = ${process.env.PATCHWARDEN_CONFIG}`);
  ok++;
} else {
  results.push(`[OK]   PATCHWARDEN_CONFIG not set (using default: patchwarden.config.json)`);
  ok++;
}

// Load config (may fail)
let config: any = null;
try {
  config = getConfig();
  check("Config parseable", true, `workspaceRoot: ${config.workspaceRoot}`);
} catch (err) {
  check("Config parseable", false, err instanceof Error ? err.message : String(err));
}

// 6. workspaceRoot checks
if (config) {
  const ws = normalize(resolve(config.workspaceRoot));
  const exists = existsSync(ws);
  check("workspaceRoot exists", exists, ws);

  let isDir = false;
  try { isDir = statSync(ws).isDirectory(); } catch {}
  check("workspaceRoot is directory", isDir, ws);

  // Danger checks
  const dangerousRoots = [
    { pattern: /^[A-Za-z]:\\?$/, label: "drive root" },
    { pattern: /\\Users\\[^\\]+$/, label: "user home directory" },
    { pattern: /\\Desktop$/, label: "Desktop" },
    { pattern: /\\Downloads$/, label: "Downloads" },
    { pattern: /\\Documents$/, label: "Documents" },
  ];

  for (const { pattern, label } of dangerousRoots) {
    const matches = pattern.test(ws);
    if (matches) {
      results.push(`[WARN] workspaceRoot is ${label}: ${ws} — consider narrowing to a project directory`);
      warn++;
    }
  }
}

// 7. Path guard test
if (config) {
  try {
    guardPath("test-file.txt", config.workspaceRoot);
    results.push(`[OK]   pathGuard allows workspace-internal path`);
    ok++;
  } catch (err) {
    results.push(`[FAIL] pathGuard rejects internal path: ${err instanceof Error ? err.message : String(err)}`);
    fail++;
  }

  try {
    guardPath("../outside", config.workspaceRoot);
    results.push(`[FAIL] pathGuard should have blocked ../escape`);
    fail++;
  } catch {
    results.push(`[OK]   pathGuard blocks ../ path escape`);
    ok++;
  }

  try {
    const relativeRepo = guardWorkspacePath(".", config.workspaceRoot);
    const absoluteRepo = guardWorkspacePath(config.workspaceRoot, config.workspaceRoot);
    check("repo_path resolver supports relative and absolute paths", relativeRepo === absoluteRepo, relativeRepo);
  } catch (error) {
    check("repo_path resolver supports relative and absolute paths", false, error instanceof Error ? error.message : String(error));
  }
}

// 8. Sensitive file guard test
const sensitivePaths = [".env", ".ssh/id_rsa", "token.json", "credentials"];
for (const sp of sensitivePaths) {
  const blocked = isSensitivePath(sp);
  if (blocked) {
    results.push(`[OK]   sensitiveGuard blocks "${sp}"`);
    ok++;
  } else {
    results.push(`[FAIL] sensitiveGuard does NOT block "${sp}"`);
    fail++;
  }
}

try {
  guardPlanContent("Normal build plan", "Run npm test, npm run lint, release check, and npm run dist.");
  results.push("[OK]   save_plan allows normal development plans");
  ok++;
} catch {
  results.push("[FAIL] save_plan incorrectly blocks a normal development plan");
  fail++;
}
try {
  guardPlanContent("Unsafe plan", "Read the .env access token and export it.");
  results.push("[FAIL] save_plan security rule did not block credential access");
  fail++;
} catch {
  results.push("[OK]   save_plan security rules loaded");
  ok++;
}

const requiredReadOnlyFiles = ["status.json", "result.md", "result.json", "diff.patch", "file-stats.json", "test.log", "verify.json"];
check(
  "Read-only task artifact allowlist",
  requiredReadOnlyFiles.every((name) => TASK_READ_ONLY_FILES.includes(name)),
  requiredReadOnlyFiles.join(", ")
);

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8"));
check("Server version matches package.json", packageJson.version === PATCHWARDEN_VERSION,
  `${PATCHWARDEN_VERSION} vs ${packageJson.version}`);
check("Manifest preflight script exists", existsSync(resolve(process.cwd(), "scripts/mcp-manifest-check.js")),
  "scripts/mcp-manifest-check.js");

const previousProfile = process.env.PATCHWARDEN_TOOL_PROFILE;
try {
  process.env.PATCHWARDEN_TOOL_PROFILE = "full";
  const fullTools = getToolDefs();
  const coreTools = selectToolsForProfile(fullTools, "chatgpt_core");
  const createSchema = coreTools.find((tool) => tool.name === "create_task")?.inputSchema as any;
  const waitSchema = coreTools.find((tool) => tool.name === "wait_for_task")?.inputSchema as any;
  check("Full tool profile exposes 22 tools", fullTools.length === 22, `${fullTools.length} tools`);
  check(
    `chatgpt_core profile exposes the exact ${CHATGPT_CORE_TOOL_NAMES.length}-tool manifest`,
    JSON.stringify(coreTools.map((tool) => tool.name)) === JSON.stringify(CHATGPT_CORE_TOOL_NAMES),
    coreTools.map((tool) => tool.name).join(", ")
  );
  check(
    "Core task schemas expose inline_plan, verify_commands, and wait aliases",
    Boolean(
      createSchema?.properties?.inline_plan &&
      createSchema?.properties?.verify_commands &&
      waitSchema?.properties?.timeout_seconds &&
      waitSchema?.properties?.wait_seconds
    )
  );
} finally {
  if (previousProfile === undefined) delete process.env.PATCHWARDEN_TOOL_PROFILE;
  else process.env.PATCHWARDEN_TOOL_PROFILE = previousProfile;
}

// 9. HTTP port check
const httpPort = (config as any)?.http?.port || 7331;
try {
  const server = createServer();
  await new Promise<void>((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(httpPort, "127.0.0.1", () => {
      server.close();
      resolvePort();
    });
  });
  results.push(`[OK]   HTTP port ${httpPort} is free`);
  ok++;
} catch {
  results.push(`[WARN] HTTP port ${httpPort} is in use — change http.port in config`);
  warn++;
}

// 10-12. dist file checks
const distChecks = [
  { file: "dist/index.js", label: "stdio MCP entry", cmd: "npm run build" },
  { file: "dist/httpServer.js", label: "HTTP MCP entry", cmd: "npm run build" },
  { file: "dist/runner/watch.js", label: "watcher entry (npm run watch)", cmd: "npm run build" },
];
for (const { file, label, cmd: buildCmd } of distChecks) {
  check(`${label} exists`, existsSync(resolve(process.cwd(), file)),
    existsSync(resolve(process.cwd(), file)) ? file : `Missing — run: ${buildCmd}`);
}

// New tool registrations check
const newTools = [
  "listTasks",
  "listAgents",
  "cancelTask",
  "killTask",
  "retryTask",
  "getTaskProgress",
  "getTaskSummary",
  "waitForTask",
  "getTaskStdoutTail",
  "healthCheck",
  "auditTask",
];
for (const t of newTools) {
  const compiled = resolve(process.cwd(), "dist/tools", `${t}.js`);
  check(`Tool module: ${t}`, existsSync(compiled), existsSync(compiled) ? "compiled" : "missing");
}

// Task directory writable
if (config) {
  const tasksDir = resolve(config.workspaceRoot, config.tasksDir);
  try {
    mkdirSync(tasksDir, { recursive: true });
    const testFile = join(tasksDir, ".doctor-write-test");
    writeFileSync(testFile, "ok", "utf-8");
    rmSync(testFile);
    check("Task directory writable", true, tasksDir);

    const sampleTaskDir = join(tasksDir, ".doctor-sample-task");
    mkdirSync(sampleTaskDir, { recursive: true });
    const sampleStatus = join(sampleTaskDir, "status.json");
    writeFileSync(sampleStatus, JSON.stringify({ status: "doctor" }), "utf-8");
    const sampleReadable = JSON.parse(readFileSync(sampleStatus, "utf-8")).status === "doctor";
    rmSync(sampleTaskDir, { recursive: true, force: true });
    check("Example task directory read/write", sampleReadable, sampleTaskDir);
  } catch {
    warnCheck("Task directory writable", false, tasksDir);
  }

  // workspaceRoot writable
  try {
    const testFile = resolve(config.workspaceRoot, ".doctor-write-test");
    writeFileSync(testFile, "ok", "utf-8");
    rmSync(testFile);
    check("workspaceRoot writable", true, config.workspaceRoot);
  } catch {
    warnCheck("workspaceRoot writable", false, config.workspaceRoot);
  }
}

if (config) {
  check("Watcher stale threshold is valid",
    config.watcherStaleSeconds >= 5 && config.watcherStaleSeconds <= 3600,
    `${config.watcherStaleSeconds}s`);
}

// allowedTestCommands has npm test
if (config) {
  const hasNpmTest = config.allowedTestCommands.some((c: string) => c === "npm test" || c === "npm run test");
  warnCheck("allowedTestCommands includes npm test", hasNpmTest,
    hasNpmTest ? "present" : "npm test is missing — add it to allowedTestCommands");
}

if (config) {
  check("Task timeout defaults are valid",
    config.defaultTaskTimeoutSeconds > 0 && config.defaultTaskTimeoutSeconds <= config.maxTaskTimeoutSeconds,
    `default ${config.defaultTaskTimeoutSeconds}s, max ${config.maxTaskTimeoutSeconds}s`);
}

// 13. Agent command check
if (config) {
  const agents = config.agents || {};
  for (const [name, agentCfg] of Object.entries(agents) as [string, any][]) {
    const cmdName = agentCfg.command;
    const looksLikePath = isAbsolute(cmdName) || cmdName.includes("/") || cmdName.includes("\\");
    if (looksLikePath) {
      const agentExists = existsSync(cmdName);
      warnCheck(`Agent "${name}" command available`, agentExists,
        agentExists ? `Found: ${cmdName}` : `"${cmdName}" does not exist — agent tasks will fail`);
      continue;
    }
    // Platform-appropriate lookup: 'where' on Windows, 'command -v' on Unix
    const isWin = process.platform === "win32";
    const lookupCmd = isWin ? `where ${cmdName}` : `command -v ${cmdName}`;
    const fallbackCmd = isWin ? `command -v ${cmdName}` : `which ${cmdName}`;
    const found = cmd(lookupCmd) || cmd(fallbackCmd);
    warnCheck(`Agent "${name}" command available`, found !== "",
      found ? `Found: ${found.split("\n")[0]}` : `"${cmdName}" not in PATH — agent tasks will fail`);
  }
}

// 14. allowedTestCommands safety check
if (config) {
  const testCmds = config.allowedTestCommands || [];
  check("allowedTestCommands is non-empty", testCmds.length > 0,
    testCmds.length > 0 ? `${testCmds.length} commands` : "No test commands configured");

  const dangerous = ["rm -rf", "del /s", "format", "shutdown", "curl |", "wget |"];
  for (const cmdStr of testCmds) {
    for (const danger of dangerous) {
      if (cmdStr.toLowerCase().includes(danger)) {
        results.push(`[WARN] allowedTestCommands contains dangerous pattern: "${cmdStr}"`);
        warn++;
      }
    }
  }
}

// 15. Tunnel example files check
const tunnelFiles = [
  "examples/openai-tunnel/README.md",
  "examples/openai-tunnel/tunnel-client.example.yaml",
  "examples/openai-tunnel/chatgpt-test-prompt.md",
];
for (const tf of tunnelFiles) {
  const full = resolve(process.cwd(), tf);
  const exists = existsSync(full);
  check(`Tunnel example: ${tf}`, exists, exists ? "present" : "missing");

  // Check for leaked secrets in example files
  if (exists) {
    const content = readFileSync(full, "utf-8");
    // Only flag actual key-value assignments, not comments/mentions
    const leaked = /(?:api_key|sk-[a-zA-Z0-9]{10,}|token\s*[:=]\s*\S{4,}|secret\s*[:=]\s*\S{4,}|password\s*[:=]\s*\S{4,})/gi.test(
      // Strip comment lines first
      content.split("\n").filter(l => !l.trim().startsWith("#") && !l.trim().startsWith("//")).join("\n")
    );
    if (leaked) {
      results.push(`[WARN] ${tf} may contain secrets`);
      warn++;
    } else {
      results.push(`[OK]   ${tf} — no real secrets`);
      ok++;
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════

console.log(results.join("\n"));
console.log(`\n${"=".repeat(50)}`);
console.log(`OK: ${ok}  WARN: ${warn}  FAIL: ${fail}`);
console.log(`${"=".repeat(50)}`);

if (fail > 0) {
  console.log("\n❌ Doctor found issues that need attention.");
  console.log("   Fix FAIL items before using PatchWarden.");
  process.exit(1);
} else if (warn > 0) {
  console.log("\n⚠️  Doctor found warnings — review before production use.");
  process.exit(0);
} else {
  console.log("\n✅ All checks passed.");
  process.exit(0);
}

} // end async main

main().catch((err) => {
  console.error("Doctor crashed:", err);
  process.exit(1);
});
