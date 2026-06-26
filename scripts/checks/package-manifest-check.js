#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const isWindows = process.platform === "win32";
const command = isWindows ? (process.env.ComSpec || "cmd.exe") : "npm";
const args = isWindows
  ? ["/d", "/s", "/c", "npm.cmd pack --dry-run --json"]
  : ["pack", "--dry-run", "--json"];
const result = spawnSync(command, args, {
  encoding: "utf8",
  shell: false,
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || result.error?.message || "npm pack --dry-run --json failed\n");
  process.exit(result.status || 1);
}

let metadata;
try {
  metadata = JSON.parse(result.stdout);
} catch (error) {
  console.error(`[package-manifest-check] Could not parse npm pack JSON: ${error.message}`);
  process.exit(1);
}

const files = metadata?.[0]?.files?.map((entry) => String(entry.path).replace(/\\/g, "/")) || [];
const forbidden = [
  /(^|\/)\.local(\/|$)/i,
  /\.local\.(cmd|ps1)$/i,
  /(^|\/)patchwarden\.config\.json$/i,
  new RegExp(`(^|/)${["safe", "bifrost"].join("-")}\\.config\\.json$`, "i"),
  /(^|\/)\.env$/i,
  /\.dpapi$/i,
  /^docs\/optimization-proposal\.md$/i,
  /(^|\/)kill-patchwarden\.(cmd|ps1)$/i,
];
const leaked = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
if (leaked.length > 0) {
  console.error("[package-manifest-check] Private files would enter the npm package:");
  for (const file of leaked) console.error(`  ${file}`);
  process.exit(1);
}

const required = [
  "PatchWarden.cmd",
  "PatchWarden-Desktop.cmd",
  "scripts/control/manage-patchwarden.ps1",
  "scripts/launchers/Start-PatchWarden-Tunnel.cmd",
  "scripts/launchers/Start-PatchWarden-Direct-Tunnel.cmd",
];
const missing = required.filter((file) => !files.includes(file));
if (missing.length > 0) {
  console.error("[package-manifest-check] Required control files are missing:");
  for (const file of missing) console.error(`  ${file}`);
  process.exit(1);
}

const publicControlFiles = [
  "PatchWarden.cmd",
  "scripts/launchers/Start-PatchWarden-Tunnel.cmd",
  "scripts/launchers/Start-PatchWarden-Direct-Tunnel.cmd",
];
const privateAbsolutePath = /[A-Za-z]:\\(?:Users\\[^\\\r\n]+|ai_agent)\\/i;
const privatePathLeaks = publicControlFiles.filter((file) => {
  try {
    return privateAbsolutePath.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
});
if (privatePathLeaks.length > 0) {
  console.error("[package-manifest-check] Public control files contain machine-specific absolute paths:");
  for (const file of privatePathLeaks) console.error(`  ${file}`);
  process.exit(1);
}

console.log(`[package-manifest-check] OK: ${files.length} package files, no private local launchers.`);
