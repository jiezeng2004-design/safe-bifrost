#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "patchwarden-doctor-"));
const workspaceRoot = join(tempRoot, "workspace");
const configPath = join(tempRoot, "patchwarden.config.json");

try {
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    workspaceRoot,
    plansDir: ".patchwarden/plans",
    tasksDir: ".patchwarden/tasks",
    agents: {
      fixture: { command: process.execPath, args: ["-e", "console.log('fixture')"] },
    },
    allowedTestCommands: ["npm test", "npm run lint"],
    maxReadFileBytes: 200000,
    defaultTaskTimeoutSeconds: 30,
    maxTaskTimeoutSeconds: 60,
  }, null, 2), "utf-8");

  const result = spawnSync(process.execPath, ["dist/doctor.js"], {
    cwd: root,
    env: { ...process.env, PATCHWARDEN_CONFIG: configPath },
    encoding: "utf-8",
    timeout: 30000,
  });
  if (result.status !== 0) {
    throw new Error(`doctor exited ${result.status}: ${result.stdout}\n${result.stderr}`);
  }
  const requiredLines = [
    "[OK]   workspaceRoot exists",
    "[OK]   repo_path resolver supports relative and absolute paths",
    "[OK]   save_plan security rules loaded",
    "[OK]   Read-only task artifact allowlist",
    "[OK]   Task directory writable",
    "[OK]   Example task directory read/write",
    "[OK]   allowedTestCommands is non-empty",
    "[OK]   Release gate module loadable",
  ];
  for (const line of requiredLines) {
    if (!result.stdout.includes(line)) throw new Error(`doctor output missing stable line: ${line}`);
  }
  console.log("ok - doctor stable output and self-checks");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
