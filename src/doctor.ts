#!/usr/bin/env node
/**
 * Safe-Bifrost Doctor — read-only diagnostic checks
 *
 * Usage: node dist/doctor.js  or  npm run doctor
 *
 * Checks 15 aspects of the environment and configuration.
 * Never modifies files, installs dependencies, or starts services.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { loadConfig, getConfig } from "./config.js";
import { guardPath } from "./security/pathGuard.js";
import { isSensitivePath } from "./security/sensitiveGuard.js";

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

console.log("Safe-Bifrost Doctor\n");

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
  resolve(process.cwd(), "safe-bifrost.config.json"),
  process.env.SAFE_BIFROST_CONFIG || "",
].filter(Boolean);

let configPathUsed = "";
for (const p of configPaths) {
  if (existsSync(p)) { configPathUsed = p; break; }
}

check("Config file exists", configPathUsed !== "",
  configPathUsed
    ? configPathUsed
    : 'Create one: cp examples/config.example.json safe-bifrost.config.json');

// 5. SAFE_BIFROST_CONFIG env
if (process.env.SAFE_BIFROST_CONFIG) {
  results.push(`[OK]   SAFE_BIFROST_CONFIG = ${process.env.SAFE_BIFROST_CONFIG}`);
  ok++;
} else {
  results.push(`[OK]   SAFE_BIFROST_CONFIG not set (using default: safe-bifrost.config.json)`);
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

// 13. Agent command check
if (config) {
  const agents = config.agents || {};
  for (const [name, agentCfg] of Object.entries(agents) as [string, any][]) {
    const cmdName = agentCfg.command;
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
  console.log("   Fix FAIL items before using Safe-Bifrost.");
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
