import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../config.js";
import { safeDirectSummary, safeAuditDirectSession, safeDiffSummary, safeResult, safeTestSummary } from "../../tools/safeViews.js";

let tempDir: string;
let prevConfigEnv: string | undefined;

function writeConfig() {
  const configPath = join(tempDir, "patchwarden.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaceRoot: tempDir,
      tasksDir: ".patchwarden/tasks",
      plansDir: ".patchwarden/plans",
      assessmentsDir: ".patchwarden/assessments",
      directSessionsDir: ".patchwarden/direct-sessions",
      agents: {},
      allowedTestCommands: ["npm test"],
      directAllowedCommands: ["npm test"],
      enableDirectProfile: true,
    }),
    "utf-8"
  );
  prevConfigEnv = process.env.PATCHWARDEN_CONFIG;
  process.env.PATCHWARDEN_CONFIG = configPath;
  reloadConfig();
}

describe("safeViews", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-safeviews-"));
    writeConfig();
  });

  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = prevConfigEnv;
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns bounded task summaries without log or diff content", () => {
    const taskId = "task-safe-001";
    const taskDir = join(tempDir, ".patchwarden", "tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.json"), JSON.stringify({
      task_id: taskId,
      status: "done_by_agent",
      phase: "done_by_agent",
      repo_path: "repo",
      resolved_repo_path: join(tempDir, "repo"),
      verify_status: "passed",
    }), "utf-8");
    writeFileSync(join(taskDir, "result.json"), JSON.stringify({
      task_id: taskId,
      status: "done_by_agent",
      summary: "Finished safely",
      changed_files: [{ path: "src/index.ts", change: "modified" }],
      verify_status: "passed",
      warnings: [],
    }), "utf-8");
    writeFileSync(join(taskDir, "verify.json"), JSON.stringify({
      status: "passed",
      commands: [{ command: "npm test", status: "passed", exit_code: 0, stdout_tail: "SECRET_STDOUT", stderr_tail: "SECRET_STDERR" }],
    }), "utf-8");
    writeFileSync(join(taskDir, "changed-files.json"), JSON.stringify({
      changed_files: [{ path: "src/index.ts", change: "modified", tracked: true, ignored: false, kind: "source" }],
      additions: 1,
      deletions: 0,
      diff_available: true,
      diff_truncated: false,
      patch_mode: "textual",
      artifact_hygiene: { counts: { source_changes: 1 }, source_changes: [], tracked_build_artifacts: [], ignored_untracked_artifacts: [], runtime_generated_files: [], suspicious_changes: [] },
    }), "utf-8");
    writeFileSync(join(taskDir, "git.diff"), "SECRET_DIFF", "utf-8");
    writeFileSync(join(taskDir, "test.log"), "SECRET_TEST_LOG", "utf-8");

    const payload = JSON.stringify({
      result: safeResult(taskId),
      tests: safeTestSummary(taskId),
      diff: safeDiffSummary(taskId),
    });
    assert.ok(!payload.includes("SECRET_STDOUT"));
    assert.ok(!payload.includes("SECRET_STDERR"));
    assert.ok(!payload.includes("SECRET_DIFF"));
    assert.ok(!payload.includes("SECRET_TEST_LOG"));
    assert.ok(payload.includes("src/index.ts"));
  });

  it("returns Direct safe summaries without verification tails", () => {
    const sessionId = "direct-safe-001";
    const sessionDir = join(tempDir, ".patchwarden", "direct-sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const session = {
      session_id: sessionId,
      title: "safe direct",
      repo_path: "repo",
      resolved_repo_path: join(tempDir, "repo"),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      server_version: "1.0.0",
      schema_epoch: "test",
      tool_manifest_sha256: "x".repeat(64),
      workspace_snapshot_before: { head: null, status: "", files: {}, workspace_dirty: false, warnings: [], is_git: false },
      workspace_fingerprint_before: "fingerprint",
      allowed_commands: ["npm test"],
      operations: [],
      verification_runs: [{
        command: "npm test",
        exit_code: 0,
        passed: true,
        timed_out: false,
        stdout_tail: "SECRET_DIRECT_STDOUT",
        stderr_tail: "SECRET_DIRECT_STDERR",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        log_path: join(sessionDir, "verification.log"),
      }],
      finalized: true,
      finalized_at: new Date().toISOString(),
      audited: false,
      change_artifacts: {
        changed_files: [],
        diff: "SECRET_DIRECT_DIFF",
        diff_available: true,
        diff_truncated: false,
        diff_size_bytes: 18,
        additions: 0,
        deletions: 0,
        file_stats: [],
        workspace_dirty_before: false,
        workspace_dirty_after: false,
        patch_mode: "no_changes",
        unavailable_reason: null,
        artifact_hygiene: { counts: { source_changes: 0, tracked_build_artifacts: 0, ignored_untracked_artifacts: 0, runtime_generated_files: 0, suspicious_changes: 0 }, source_changes: [], tracked_build_artifacts: [], ignored_untracked_artifacts: [], runtime_generated_files: [], suspicious_changes: [] },
      },
    };
    writeFileSync(join(sessionDir, "session.json"), JSON.stringify(session, null, 2), "utf-8");

    const payload = JSON.stringify({
      summary: safeDirectSummary(sessionId),
      audit: safeAuditDirectSession(sessionId),
    });
    assert.ok(!payload.includes("SECRET_DIRECT_STDOUT"));
    assert.ok(!payload.includes("SECRET_DIRECT_STDERR"));
    assert.ok(!payload.includes("SECRET_DIRECT_DIFF"));
    assert.ok(payload.includes("npm test"));
  });
});
