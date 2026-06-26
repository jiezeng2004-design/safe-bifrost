#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const allowedLegacyFiles = new Set([
  ".gitignore",
  ".npmignore",
  "README.md",
  "README.en.md",
  "docs/migration-from-safe-bifrost.md",
  "docs/release-v0.3.0.md",
  "docs/release-v0.4.0.md",
  "docs/release-v0.6.0.md",
  "scripts/checks/brand-check.js",
  "scripts/release/pack-clean.js",
]);
const legacyPattern = /safe-bifrost|Safe-Bifrost|SAFE_BIFROST|SafeBifrost|safe_bifrost/;

const EXCLUDE_DIRS = new Set(["node_modules", ".npm-cache", "dist", "release", ".patchwarden", ".git", "logs", "tmp", "coverage", "build", "out", ".next"]);

let trackedFiles;
let inGit = false;
try {
  trackedFiles = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
  )
    .split(/\r?\n/)
    .filter(Boolean);
  inGit = true;
} catch {
  // Not a git repository — fall back to filesystem walk
  console.warn("[brand-check] Not a Git repository; using filesystem walk.");
  trackedFiles = walkFiles(".");
  if (trackedFiles.length === 0) {
    console.warn("[brand-check] WARNING: no files found in non-Git walk. Exiting cleanly.");
    process.exit(0);
  }
}

const failures = [];

for (const file of trackedFiles) {
  const normalized = file.replace(/\\/g, "/");
  if (allowedLegacyFiles.has(normalized)) continue;
  if (legacyPattern.test(normalized)) {
    failures.push(`${normalized}: legacy brand in path`);
    continue;
  }
  try {
    const content = readFileSync(file);
    if (!content.includes(0) && legacyPattern.test(content.toString("utf-8"))) {
      failures.push(`${normalized}: legacy brand in content`);
    }
  } catch {
    // skip unreadable files
  }
}

if (failures.length > 0) {
  console.error("[brand-check] Legacy brand found outside the approved migration/history files:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

const label = inGit ? "tracked files checked" : "files scanned (non-Git fallback)";
console.log(`[brand-check] OK: ${trackedFiles.length} ${label}.`);

function walkFiles(root) {
  const results = [];
  const visit = (dir) => {
    if (results.length > 10000) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length > 10000) break;
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        visit(join(dir, e.name));
      } else if (e.isFile()) {
        const rel = relative(root, join(dir, e.name)).replace(/\\/g, "/");
        results.push(rel);
      }
    }
  };
  visit(root);
  return results;
}
