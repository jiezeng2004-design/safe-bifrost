import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { guardPath, guardWorkspacePath } from "../../security/pathGuard.js";
import { PatchWardenError } from "../../errors.js";

describe("guardPath", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-pathguard-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("allows paths inside workspace", () => {
    const result = guardPath("src/main.ts", tempDir);
    assert.ok(result.startsWith(tempDir));
    assert.ok(result.includes("src"));
    assert.ok(result.includes("main.ts"));
  });

  it("allows root workspace path", () => {
    const result = guardPath(".", tempDir);
    assert.equal(result, resolve(tempDir));
  });

  it("allows empty path as workspace root", () => {
    const result = guardPath("", tempDir);
    assert.equal(result, resolve(tempDir));
  });

  it("rejects path traversal with ..", () => {
    assert.throws(
      () => guardPath("../../../etc/passwd", tempDir),
      PatchWardenError
    );
  });

  it("rejects path traversal nested with ..", () => {
    assert.throws(
      () => guardPath("src/../../../etc/passwd", tempDir),
      PatchWardenError
    );
  });

  it("rejects absolute path outside workspace", () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\System32" : "/etc";
    assert.throws(
      () => guardPath(outside, tempDir),
      PatchWardenError
    );
  });

  it("allows absolute path inside workspace", () => {
    const insidePath = join(tempDir, "src", "main.ts");
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(insidePath, "test", "utf-8");
    const result = guardPath(insidePath, tempDir);
    assert.equal(result, resolve(insidePath));
  });

  it("enforces allowedPrefix", () => {
    mkdirSync(join(tempDir, "allowed"), { recursive: true });
    mkdirSync(join(tempDir, "forbidden"), { recursive: true });
    // Path inside allowed prefix works
    const okResult = guardPath("allowed/file.ts", tempDir, "allowed");
    assert.ok(okResult.includes("allowed"));
    // Path outside allowed prefix fails
    assert.throws(
      () => guardPath("forbidden/file.ts", tempDir, "allowed"),
      PatchWardenError
    );
  });

  it("handles Windows mixed separators", () => {
    const mixedPath = "src\\subdir/file.ts";
    const result = guardPath(mixedPath, tempDir);
    assert.ok(result.startsWith(tempDir));
  });

  it("rejects symlink escape", { skip: process.platform === "win32" ? "Windows symlink permissions unstable" : undefined }, () => {
    const target = mkdtempSync(join(tmpdir(), "pw-symlink-target-"));
    try {
      const linkPath = join(tempDir, "escape-link");
      symlinkSync(target, linkPath);
      assert.throws(
        () => guardPath("escape-link/secret.txt", tempDir),
        PatchWardenError
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("guardWorkspacePath", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-wspath-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("allows relative path inside workspace", () => {
    const result = guardWorkspacePath("my-repo", tempDir);
    assert.equal(result, resolve(tempDir, "my-repo"));
  });

  it("allows absolute path inside workspace", () => {
    const absPath = join(tempDir, "my-repo");
    const result = guardWorkspacePath(absPath, tempDir);
    assert.equal(result, resolve(absPath));
  });

  it("rejects path outside workspace", () => {
    assert.throws(
      () => guardWorkspacePath("../../../etc", tempDir),
      PatchWardenError
    );
  });

  it("rejects different drive letter on Windows", { skip: process.platform !== "win32" ? "Windows-only test" : undefined }, () => {
    // If workspace is on C:, a D: path should be rejected
    const wsDrive = tempDir.match(/^([A-Za-z]):/);
    if (!wsDrive) return;
    const otherDrive = wsDrive[1].toLowerCase() === "c" ? "D" : "C";
    assert.throws(
      () => guardWorkspacePath(`${otherDrive}:\\some\\repo`, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "workspace_path_escape"
    );
  });

  it("defaults to workspace root for empty input", () => {
    const result = guardWorkspacePath("", tempDir);
    assert.equal(result, resolve(tempDir));
  });

  it("defaults to workspace root for dot input", () => {
    const result = guardWorkspacePath(".", tempDir);
    assert.equal(result, resolve(tempDir));
  });
});
