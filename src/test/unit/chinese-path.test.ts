import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("Chinese path handling", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-chinese-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes and reads status.json with Chinese repo_path", () => {
    const chinesePath = "念念小伴_release";
    const status = {
      task_id: "test-001",
      status: "pending",
      repo_path: chinesePath,
      resolved_repo_path: resolve(tempDir, chinesePath),
    };
    const statusFile = join(tempDir, "status.json");
    writeFileSync(statusFile, JSON.stringify(status, null, 2), "utf-8");

    const raw = readFileSync(statusFile, "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.repo_path, chinesePath);
    assert.equal(parsed.resolved_repo_path, resolve(tempDir, chinesePath));
  });

  it("preserves Chinese characters through JSON stringify/parse", () => {
    const testPaths = [
      "念念小伴_release",
      "测试项目",
      "项目目录/子目录",
      "日本語プロジェクト",
      "한국어_프로젝트",
    ];
    for (const path of testPaths) {
      const json = JSON.stringify({ repo_path: path });
      const parsed = JSON.parse(json);
      assert.equal(parsed.repo_path, path, `Path "${path}" was corrupted`);
    }
  });

  it("creates and reads directories with Chinese names", () => {
    const chineseDir = join(tempDir, "念念小伴_release");
    mkdirSync(chineseDir, { recursive: true });
    assert.ok(existsSync(chineseDir));

    const filePath = join(chineseDir, "status.json");
    const data = { repo_path: "念念小伴_release", status: "running" };
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");

    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.repo_path, "念念小伴_release");
  });

  it("handles Chinese characters in result.md", () => {
    const resultMd = [
      "# PatchWarden Task Result",
      "",
      "## Status",
      "done",
      "",
      "## Files changed",
      "- modified: 念念小伴_release/src/main.ts",
      "- added: 测试项目/config.json",
      "",
    ].join("\n");
    const resultFile = join(tempDir, "result.md");
    writeFileSync(resultFile, resultMd, "utf-8");

    const content = readFileSync(resultFile, "utf-8");
    assert.ok(content.includes("念念小伴_release"));
    assert.ok(content.includes("测试项目"));
  });

  it("handles mixed Chinese and ASCII paths", () => {
    const mixedPath = "src/组件/Button.tsx";
    const data = { path: mixedPath };
    const json = JSON.stringify(data);
    const parsed = JSON.parse(json);
    assert.equal(parsed.path, mixedPath);
  });

  it("handles Chinese characters in error messages", () => {
    const errorMsg = 'repo_path "念念小伴_release" is outside workspace';
    const errorFile = join(tempDir, "error.log");
    writeFileSync(errorFile, errorMsg, "utf-8");

    const content = readFileSync(errorFile, "utf-8");
    assert.ok(content.includes("念念小伴_release"));
  });

  it("handles Windows backslash paths with Chinese characters", () => {
    const winPath = "念念小伴_release\\src\\main.ts";
    const normalized = winPath.replace(/\\/g, "/");
    assert.equal(normalized, "念念小伴_release/src/main.ts");
  });
});
