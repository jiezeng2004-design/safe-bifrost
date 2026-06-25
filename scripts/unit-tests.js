#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const root = resolve(scriptDir, "..");
const unitDir = resolve(root, "dist", "test", "unit");

if (!existsSync(unitDir)) {
  console.error(`[unit-tests] Missing compiled test directory: ${unitDir}`);
  console.error("[unit-tests] Run npm run build before npm run test:unit.");
  process.exit(1);
}

const testFiles = readdirSync(unitDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => resolve(unitDir, name));

if (testFiles.length === 0) {
  console.error(`[unit-tests] No compiled unit tests found in ${unitDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
});

if (result.error) {
  console.error(`[unit-tests] Failed to run unit tests: ${result.error.message}`);
  process.exit(1);
}

process.exit(typeof result.status === "number" ? result.status : 1);
