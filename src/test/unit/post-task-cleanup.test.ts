import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPostTaskCleanup } from "../../runner/postTaskCleanup.js";

describe("postTaskCleanup", () => {
  it("removes untracked low-risk artifacts and skips tracked or excluded paths", () => {
    const root = mkdtempSync(join(tmpdir(), "pw-cleanup-"));
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "PatchWarden Test"], { cwd: root, stdio: "ignore" });

      mkdirSync(join(root, "tracked", "__pycache__"), { recursive: true });
      writeFileSync(join(root, "tracked", "__pycache__", "keep.pyc"), "tracked", "utf-8");
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });

      mkdirSync(join(root, "backend", "__pycache__"), { recursive: true });
      mkdirSync(join(root, ".venv", "__pycache__"), { recursive: true });
      mkdirSync(join(root, "node_modules", "pkg", "__pycache__"), { recursive: true });
      mkdirSync(join(root, "docs", "__pycache__"), { recursive: true });
      writeFileSync(join(root, "backend", "__pycache__", "drop.pyc"), "drop", "utf-8");
      writeFileSync(join(root, ".venv", "__pycache__", "skip.pyc"), "skip", "utf-8");
      writeFileSync(join(root, "node_modules", "pkg", "__pycache__", "skip.pyc"), "skip", "utf-8");
      writeFileSync(join(root, "docs", "__pycache__", "skip.pyc"), "skip", "utf-8");

      const taskDir = join(root, ".patchwarden", "tasks", "task-1");
      mkdirSync(taskDir, { recursive: true });
      const report = runPostTaskCleanup(root, taskDir);

      assert.ok(report.removed.some((entry) => entry.path === "backend/__pycache__"));
      assert.ok(report.skipped.some((entry) => entry.path === "tracked/__pycache__" && entry.skip_reason === "tracked_by_git"));
      assert.equal(report.source_files_touched, 0);
      assert.ok(!existsSync(join(root, "backend", "__pycache__")));
      assert.ok(existsSync(join(root, "tracked", "__pycache__", "keep.pyc")));
      assert.ok(existsSync(join(root, ".venv", "__pycache__", "skip.pyc")));
      assert.ok(existsSync(join(root, "node_modules", "pkg", "__pycache__", "skip.pyc")));
      assert.ok(existsSync(join(root, "docs", "__pycache__", "skip.pyc")));

      const written = JSON.parse(readFileSync(join(taskDir, "post-task-cleanup.json"), "utf-8"));
      assert.equal(written.enabled, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
