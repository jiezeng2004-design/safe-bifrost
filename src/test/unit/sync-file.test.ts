import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { syncFile } from "../../tools/syncFile.js";
import { computeFileSha256 } from "../../direct/directPatch.js";
import type { PatchWardenConfig } from "../../config.js";

function makeConfig(workspaceRoot: string): PatchWardenConfig {
  return {
    workspaceRoot,
    plansDir: ".patchwarden/plans",
    tasksDir: ".patchwarden/tasks",
    assessmentsDir: ".patchwarden/assessments",
    assessmentTtlSeconds: 3600,
    agents: { codex: { command: "codex", args: ["exec", "{prompt}"] } },
    allowedTestCommands: ["npm test"],
    repoAllowedTestCommands: {},
    maxReadFileBytes: 200_000,
    defaultTaskTimeoutSeconds: 900,
    maxTaskTimeoutSeconds: 3600,
    watcherStaleSeconds: 30,
    directSessionsDir: ".patchwarden/direct-sessions",
    directSessionTtlSeconds: 3600,
    directMaxPatchBytes: 200_000,
    directMaxFileBytes: 500_000,
  };
}

describe("syncFile", () => {
  let tempDir: string;
  let config: PatchWardenConfig;
  let repoPath: string;
  let sessionsDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-syncfile-"));
    config = makeConfig(tempDir);
    repoPath = join(tempDir, "my-repo");
    sessionsDir = join(tempDir, ".patchwarden", "direct-sessions");
    sessionId = "test-session-001";

    mkdirSync(repoPath, { recursive: true });
    mkdirSync(join(sessionsDir, sessionId), { recursive: true });

    writeFileSync(
      join(sessionsDir, sessionId, "session.json"),
      JSON.stringify({
        session_id: sessionId,
        repo_path: repoPath,
        status: "active",
        created_at: new Date().toISOString(),
      }),
      "utf-8"
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("copies a file from source to target", () => {
    const sourceContent = "console.log('hello world');";
    mkdirSync(join(repoPath, "mobile_app"), { recursive: true });
    writeFileSync(join(repoPath, "mobile_app", "app.js"), sourceContent, "utf-8");

    const result = syncFile(sessionId, "mobile_app/app.js", "windows_app/app/app.js", undefined, config);

    assert.equal(result.changed, true);
    assert.equal(result.copied_bytes, sourceContent.length);
    assert.equal(result.before_target_sha256, null);
    assert.ok(result.after_target_sha256);

    const targetContent = readFileSync(join(repoPath, "windows_app", "app", "app.js"), "utf-8");
    assert.equal(targetContent, sourceContent);
  });

  it("returns changed=false when target already has same content", () => {
    const sourceContent = "same content";
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "dst"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), sourceContent, "utf-8");
    writeFileSync(join(repoPath, "dst", "file.ts"), sourceContent, "utf-8");

    const result = syncFile(sessionId, "src/file.ts", "dst/file.ts", undefined, config);

    assert.equal(result.changed, false);
    assert.ok(result.before_target_sha256);
    assert.equal(result.before_target_sha256, result.after_target_sha256);
  });

  it("returns changed=true when target has different content", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "dst"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "new content", "utf-8");
    writeFileSync(join(repoPath, "dst", "file.ts"), "old content", "utf-8");

    const result = syncFile(sessionId, "src/file.ts", "dst/file.ts", undefined, config);

    assert.equal(result.changed, true);
    assert.notEqual(result.before_target_sha256, result.after_target_sha256);
  });

  it("rejects source path outside repo", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    assert.throws(
      () => syncFile(sessionId, "../../../etc/passwd", "dst/file.ts", undefined, config),
      Error
    );
  });

  it("rejects target path outside repo", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "../../../etc/evil", undefined, config),
      Error
    );
  });

  it("rejects sensitive source files", () => {
    writeFileSync(join(repoPath, ".env"), "SECRET=abc123", "utf-8");

    assert.throws(
      () => syncFile(sessionId, ".env", "dst/.env", undefined, config),
      Error
    );
  });

  it("rejects sensitive target files", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "config.json", undefined, config),
      Error
    );
  });

  it("rejects writing to node_modules", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "node_modules/evil/index.js", undefined, config),
      Error
    );
  });

  it("rejects writing to dist", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "dist/main.js", undefined, config),
      Error
    );
  });

  it("rejects non-existent session", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    assert.throws(
      () => syncFile("non-existent-session", "src/file.ts", "dst/file.ts", undefined, config),
      Error
    );
  });

  it("rejects non-existent source file", () => {
    assert.throws(
      () => syncFile(sessionId, "non-existent/file.ts", "dst/file.ts", undefined, config),
      Error
    );
  });

  it("validates expected_source_sha256", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    const correctHash = computeFileSha256(join(repoPath, "src", "file.ts"));

    const result = syncFile(sessionId, "src/file.ts", "dst/file.ts", {
      expected_source_sha256: correctHash,
    }, config);
    assert.equal(result.source_sha256, correctHash);

    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "dst2/file.ts", {
        expected_source_sha256: "wronghash",
      }, config),
      Error
    );
  });

  it("validates expected_target_sha256", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "dst"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "new content", "utf-8");
    writeFileSync(join(repoPath, "dst", "file.ts"), "old content", "utf-8");

    const correctTargetHash = computeFileSha256(join(repoPath, "dst", "file.ts"));

    const result = syncFile(sessionId, "src/file.ts", "dst/file.ts", {
      expected_target_sha256: correctTargetHash,
    }, config);
    assert.equal(result.before_target_sha256, correctTargetHash);

    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "dst/file.ts", {
        expected_target_sha256: "wronghash",
      }, config),
      Error
    );
  });

  it("creates target directory if it doesn't exist", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    const result = syncFile(sessionId, "src/file.ts", "deep/nested/path/file.ts", undefined, config);

    assert.equal(result.changed, true);
    assert.ok(existsSync(join(repoPath, "deep", "nested", "path", "file.ts")));
  });
});
