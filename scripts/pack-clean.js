#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const root = resolve(scriptDir, "..");
const releaseDir = resolve(root, "release");
const archivePath = resolve(root, "safe-bifrost-release.tar.gz");

const include = [
  "dist",
  "docs",
  "examples",
  "scripts",
  "src",
  ".gitignore",
  "LICENSE",
  "README.md",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
];

const forbidden = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.safe-bifrost([\\/]|$)/,
  /(^|[\\/])safe-bifrost\.config\.json$/,
  /(^|[\\/])\.env$/,
  /\.log$/,
];

console.log("[pack-clean] Preparing clean release directory...");
rmSync(releaseDir, { recursive: true, force: true });
rmSync(archivePath, { force: true });
mkdirSync(releaseDir, { recursive: true });

for (const item of include) {
  const source = resolve(root, item);
  const target = resolve(releaseDir, item);
  if (!existsSync(source)) {
    console.log(`  skip missing: ${item}`);
    continue;
  }
  cpSync(source, target, {
    recursive: true,
    filter(sourcePath) {
      const rel = toPosix(relative(root, sourcePath));
      return !isForbidden(rel);
    },
  });
  console.log(`  copied: ${item}`);
}

const releaseFiles = listFiles(releaseDir);
const badReleaseEntries = releaseFiles.filter((file) =>
  isForbidden(toPosix(relative(releaseDir, file)))
);
if (badReleaseEntries.length > 0) {
  console.error("[pack-clean] Forbidden files in release directory:");
  for (const file of badReleaseEntries) {
    console.error(`  ${relative(releaseDir, file)}`);
  }
  process.exit(1);
}

console.log("[pack-clean] Creating tar.gz archive...");

// Convert Windows paths to WSL/Linux paths when tar is a Unix binary
function toTarPath(p) {
  if (process.platform === "win32") {
    return p;
  }
  return p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, "/");
}

const tarArchivePath = toTarPath(archivePath);
const tarReleaseDir = toTarPath(releaseDir);

execFileSync("tar", ["-czf", tarArchivePath, "-C", tarReleaseDir, "."], {
  stdio: "inherit",
});

const archiveEntries = execFileSync("tar", ["-tzf", tarArchivePath], {
  encoding: "utf-8",
})
  .split(/\r?\n/)
  .filter(Boolean)
  .map((entry) => toPosix(entry.replace(/^\.\//, "")));

const badArchiveEntries = archiveEntries.filter(isForbidden);
if (badArchiveEntries.length > 0) {
  console.error("[pack-clean] Forbidden files in archive:");
  for (const entry of badArchiveEntries) {
    console.error(`  ${entry}`);
  }
  rmSync(archivePath, { force: true });
  process.exit(1);
}

const sizeKb = (statSync(archivePath).size / 1024).toFixed(1);
console.log(`[pack-clean] Release directory: ${releaseFiles.length} files`);
console.log(`[pack-clean] Archive: ${archivePath} (${sizeKb} KB)`);
console.log("[pack-clean] OK");

function listFiles(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push(...listFiles(fullPath));
    } else {
      entries.push(fullPath);
    }
  }
  return entries;
}

function isForbidden(value) {
  return forbidden.some((pattern) => pattern.test(value));
}

function toPosix(value) {
  return value.replace(/\\/g, "/");
}
