import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const EXCLUDED_DIRS = new Set([".git", ".venv", "node_modules", "samples", "docs"]);
const CLEANUP_DIRS = new Set(["__pycache__", "dist", "release_packages", "temp_files"]);
const CLEANUP_FILES = [/\.pyc$/i];

export interface PostTaskCleanupEntry {
  path: string;
  reason: string;
}

export interface PostTaskCleanupReport {
  enabled: boolean;
  removed: PostTaskCleanupEntry[];
  skipped: Array<PostTaskCleanupEntry & { skip_reason: string }>;
  source_files_touched: number;
}

export function runPostTaskCleanup(repoPath: string, taskDir: string): PostTaskCleanupReport {
  const report: PostTaskCleanupReport = {
    enabled: true,
    removed: [],
    skipped: [],
    source_files_touched: 0,
  };
  const root = resolve(repoPath);
  const candidates = collectCandidates(root);
  for (const candidate of candidates) {
    const rel = toRepoRelative(root, candidate.path);
    if (!rel || isExcluded(rel)) {
      report.skipped.push({ path: rel || ".", reason: candidate.reason, skip_reason: "excluded_path" });
      continue;
    }
    if (hasTrackedGitContent(root, rel)) {
      report.skipped.push({ path: rel, reason: candidate.reason, skip_reason: "tracked_by_git" });
      continue;
    }
    if (!isIgnoredOrUntracked(root, rel)) {
      report.skipped.push({ path: rel, reason: candidate.reason, skip_reason: "not_ignored_or_untracked" });
      continue;
    }
    try {
      rmSync(candidate.path, { recursive: true, force: true });
      report.removed.push({ path: rel, reason: candidate.reason });
    } catch (error) {
      report.skipped.push({
        path: rel,
        reason: candidate.reason,
        skip_reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  writeFileSync(join(taskDir, "post-task-cleanup.json"), JSON.stringify(report, null, 2), "utf-8");
  return report;
}

function collectCandidates(root: string): PostTaskCleanupEntry[] {
  const found = new Map<string, string>();
  walk(root, (path, isDir) => {
    const name = basename(path);
    if (isDir) {
      if (name === "__pycache__") found.set(path, "python_bytecode_cache");
      if (name === "dist" && toRepoRelative(root, path) === "frontend/dist") found.set(path, "frontend_build_output");
      if (name === "release_packages") found.set(path, "release_package_output");
      if (name === "temp_files" && toRepoRelative(root, path) === "backend/temp_files") found.set(path, "backend_temp_files");
    } else if (CLEANUP_FILES.some((pattern) => pattern.test(name))) {
      found.set(path, "python_bytecode_file");
    }
  });
  return [...found].map(([path, reason]) => ({ path, reason }));
}

function walk(dir: string, visit: (path: string, isDir: boolean) => void): void {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const isDir = entry.isDirectory();
    visit(full, isDir);
    if (isDir && !EXCLUDED_DIRS.has(entry.name) && !CLEANUP_DIRS.has(entry.name)) {
      walk(full, visit);
    }
  }
}

function hasTrackedGitContent(root: string, rel: string): boolean {
  if (!isGitWorktree(root)) return false;
  try {
    const output = execFileSync("git", ["ls-files", "--", rel], {
      cwd: root,
      encoding: "utf-8",
      windowsHide: true,
    });
    return output.trim().length > 0;
  } catch {
    return true;
  }
}

function isIgnoredOrUntracked(root: string, rel: string): boolean {
  if (!isGitWorktree(root)) return true;
  try {
    execFileSync("git", ["check-ignore", "-q", "--", rel], {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    try {
      const output = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", rel], {
        cwd: root,
        encoding: "utf-8",
        windowsHide: true,
      });
      return output.trim().length > 0 || !existsSync(resolve(root, rel));
    } catch {
      return false;
    }
  }
}

function isGitWorktree(root: string): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      encoding: "utf-8",
      windowsHide: true,
    }).trim() === "true";
  } catch {
    return false;
  }
}

function toRepoRelative(root: string, target: string): string {
  const resolved = resolve(target);
  const rel = relative(root, resolved);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    return "";
  }
  return rel.replace(/\\/g, "/");
}

function isExcluded(rel: string): boolean {
  const parts = rel.split("/");
  return parts.some((part) => EXCLUDED_DIRS.has(part));
}
