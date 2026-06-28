#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// v0.7.2: tasks complete with "done_by_agent" (pending acceptance) instead of "done".
// Both are valid successful completion statuses for lifecycle smoke tests.
const isDoneStatus = (s) => s === "done" || s === "done_by_agent";

const tempRoot = mkdtempSync(join(tmpdir(), "patchwarden-lifecycle-"));
const workspaceRoot = join(tempRoot, "workspace");
const repoPath = join(workspaceRoot, "repo");
const plainRepoPath = join(workspaceRoot, "plain-repo");
const configPath = join(tempRoot, "patchwarden.config.json");
let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`  ok - ${name}`);
  passed++;
}

function fail(name, error) {
  console.error(`  not ok - ${name}: ${error instanceof Error ? error.message : String(error)}`);
  failed++;
}

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (error) {
    fail(name, error);
  }
}

function git(args, cwd = repoPath) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

async function waitForRunning(getTaskStatus, taskId) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = getTaskStatus(taskId);
    if (status.status === "running") return status;
    await sleep(100);
  }
  throw new Error(`Task ${taskId} did not enter running state`);
}

async function raceWithTimeout(promise, ms, msg) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

console.log("\n=== PatchWarden Lifecycle Smoke Tests ===\n");

try {
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(join(workspaceRoot, ".patchwarden"), { recursive: true });
  writeFileSync(join(workspaceRoot, ".patchwarden", "watcher-heartbeat.json"), JSON.stringify({
    status: "running",
    pid: process.pid,
    instance_id: "lifecycle-smoke-watcher",
    launcher_pid: process.pid,
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
  }), "utf-8");
  writeFileSync(join(repoPath, "README.md"), "# Lifecycle fixture\n", "utf-8");
  writeFileSync(join(repoPath, "main.js"), "console.log('fixture');\n", "utf-8");
  writeFileSync(join(repoPath, "second.js"), "console.log('second');\n", "utf-8");
  writeFileSync(join(repoPath, "delete-me.txt"), "delete fixture\n", "utf-8");
  writeFileSync(join(repoPath, ".gitignore"), "dist/\nrelease/\nsync-store.json\n*.log\n", "utf-8");
  mkdirSync(join(repoPath, "release"), { recursive: true });
  writeFileSync(join(repoPath, "release", "tracked.txt"), "tracked artifact fixture\n", "utf-8");
  mkdirSync(plainRepoPath, { recursive: true });
  writeFileSync(join(plainRepoPath, "README.md"), "# Non-Git fixture\n", "utf-8");
  git(["init"]);
  git(["add", "README.md", "main.js", "second.js", "delete-me.txt", ".gitignore"]);
  git(["add", "-f", "release/tracked.txt"]);
  git(["-c", "user.name=PatchWarden Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);

  writeFileSync(
    configPath,
    JSON.stringify({
      workspaceRoot,
      plansDir: ".patchwarden/plans",
      tasksDir: ".patchwarden/tasks",
      agents: {
        writer: {
          command: process.execPath,
          args: [
            "-e",
            "const fs=require('fs');fs.appendFileSync('README.md','task change\\n');fs.writeFileSync('new-file.txt','new file\\n')",
          ],
        },
        slow: {
          command: process.execPath,
          args: ["-e", "setTimeout(()=>console.log('finished'),30000)"],
        },
        scopebreaker: {
          command: process.execPath,
          args: ["-e", "require('fs').writeFileSync('../outside-scope.txt','unexpected\\n')"],
        },
        noop: {
          command: process.execPath,
          args: ["-e", "console.log('no changes')"],
        },
        largewriter: {
          command: process.execPath,
          args: ["-e", "require('fs').writeFileSync('large.txt','x'.repeat(260000)+'\\n')"],
        },
        deleter: {
          command: process.execPath,
          args: ["-e", "require('fs').unlinkSync('delete-me.txt')"],
        },
        binarywriter: {
          command: process.execPath,
          args: ["-e", "require('fs').writeFileSync('fixture.bin',Buffer.from([0,1,2,3,255,0,10]))"],
        },
        artifactwriter: {
          command: process.execPath,
          args: [
            "-e",
            "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/app.exe','build');fs.writeFileSync('sync-store.json','{}');fs.appendFileSync('release/tracked.txt','changed\\n');fs.writeFileSync('generated.exe','review')",
          ],
        },
      },
      allowedTestCommands: ["node --check main.js", "node --check second.js", "node --check missing.js"],
      maxReadFileBytes: 200000,
      defaultTaskTimeoutSeconds: 10,
      maxTaskTimeoutSeconds: 60,
      watcherStaleSeconds: 3600,
    }, null, 2),
    "utf-8"
  );
  process.env.PATCHWARDEN_CONFIG = configPath;

  const { savePlan } = await import("../../dist/tools/savePlan.js");
  const { createTask } = await import("../../dist/tools/createTask.js");
  const { getTaskStatus } = await import("../../dist/tools/getTaskStatus.js");
  const { cancelTask } = await import("../../dist/tools/cancelTask.js");
  const { killTask } = await import("../../dist/tools/killTask.js");
  const { getDiff } = await import("../../dist/tools/taskOutputs.js");
  const { listAgents } = await import("../../dist/tools/listAgents.js");
  const { getTaskSummary } = await import("../../dist/tools/getTaskSummary.js");
  const { auditTask } = await import("../../dist/tools/auditTask.js");
  const { waitForTask } = await import("../../dist/tools/waitForTask.js");
  const { runTask } = await import("../../dist/runner/runTask.js");
  const { reloadConfig } = await import("../../dist/config.js");

  await test("list_agents reports configured executables", async () => {
    const result = listAgents();
    if (result.total !== 8 || result.agents.some((agent) => !agent.available)) {
      throw new Error(`Unexpected agent availability: ${JSON.stringify(result)}`);
    }
  });

  await test("git diff captures tracked and untracked task changes", async () => {
    writeFileSync(join(repoPath, "preexisting-user-file.txt"), "preexisting and untouched\n", "utf-8");
    const plan = savePlan({ title: "Change capture", content: "Modify fixture files." });
    const task = createTask({
      plan_id: plan.plan_id,
      agent: "writer",
      repo_path: "repo",
      verify_commands: ["node --check main.js", "node --check second.js"],
    });
    const result = await runTask(task.task_id);
    if (!isDoneStatus(result.status)) throw new Error(`Writer task ended ${result.status}: ${result.error}`);
    const status = getTaskStatus(task.task_id);
    const changed = status.changed_files || [];
    if (!changed.some((file) => file.path === "README.md" && file.change === "modified")) {
      throw new Error(`README.md modification missing: ${JSON.stringify(changed)}`);
    }
    if (!changed.some((file) => file.path === "new-file.txt" && file.change === "added")) {
      throw new Error(`new-file.txt addition missing: ${JSON.stringify(changed)}`);
    }
    const diff = getDiff(task.task_id);
    if (diff.patch_mode !== "textual" || diff.unavailable_reason !== null) {
      throw new Error(`Expected textual Git patch: ${JSON.stringify(diff)}`);
    }
    if (!diff.content.includes("README.md") || !diff.content.includes("new-file.txt")) {
      throw new Error("git.diff did not include both tracked and untracked evidence");
    }
    if (diff.content.includes("preexisting-user-file.txt")) {
      throw new Error("Task diff included an unchanged pre-existing user file");
    }
    if (!status.diff_available) throw new Error("diff_available should be true");
    if (!diff.file_stats?.some((file) => file.path === "new-file.txt" && file.status === "added" && file.additions > 0)) {
      throw new Error(`Missing added file stats: ${JSON.stringify(diff.file_stats)}`);
    }
    for (const artifact of ["result.json", "verify.json", "verify.log", "diff.patch", "file-stats.json"]) {
      if (!existsSync(join(task.path, artifact))) throw new Error(`${artifact} missing`);
    }
    const summary = getTaskSummary(task.task_id);
    if (summary.verify_status !== "passed" || summary.verify_commands.length !== 2 || summary.acceptance_status !== "ready_for_review") {
      throw new Error(`Unexpected summary: ${JSON.stringify(summary)}`);
    }
    const structured = JSON.parse(readFileSync(join(task.path, "result.json"), "utf-8"));
    if (structured.verify_status !== "passed" || !Array.isArray(structured.errors) || !Array.isArray(structured.commands_observed)) {
      throw new Error(`result.json contract mismatch: ${JSON.stringify(structured)}`);
    }
    for (const artifact of ["result.json", "diff.patch", "git.diff", "test.log"]) {
      rmSync(join(task.path, artifact), { force: true });
    }
    const degraded = getTaskSummary(task.task_id);
    if (degraded.result_json_available || degraded.diff_available || degraded.test_log_available) {
      throw new Error(`Missing artifacts were not exposed: ${JSON.stringify(degraded)}`);
    }
    if (!degraded.warnings.some((warning) => warning.includes("result.json is missing")) ||
        !degraded.warnings.some((warning) => warning.includes("diff.patch is missing")) ||
        !degraded.warnings.some((warning) => warning.includes("test.log is missing"))) {
      throw new Error(`Missing artifact warnings incomplete: ${JSON.stringify(degraded.warnings)}`);
    }
  });

  await test("inspect_only template fails when the agent changes repository files", async () => {
    const task = createTask({
      template: "inspect_only",
      goal: "Inspect the fixture without modifying files",
      agent: "writer",
      repo_path: "repo",
    });
    const result = await runTask(task.task_id);
    if (result.status !== "failed_policy_violation") {
      throw new Error(`Expected failed_policy_violation: ${JSON.stringify(result)}`);
    }
    const summary = getTaskSummary(task.task_id);
    if (summary.change_policy !== "no_changes" || summary.suggested_next_action !== "review_unexpected_changes") {
      throw new Error(`Unexpected policy summary: ${JSON.stringify(summary)}`);
    }
  });

  await test("legacy test_command becomes one independent verification command", async () => {
    const plan = savePlan({ title: "Legacy verification", content: "No changes." });
    const task = createTask({
      plan_id: plan.plan_id,
      agent: "noop",
      repo_path: "repo",
      test_command: "node --check main.js",
    });
    const result = await runTask(task.task_id);
    const verify = JSON.parse(readFileSync(join(task.path, "verify.json"), "utf-8"));
    if (!isDoneStatus(result.status) || verify.status !== "passed" || verify.commands.length !== 1) {
      throw new Error(`Legacy verification mismatch: ${JSON.stringify({ result, verify })}`);
    }
    if (verify.commands[0].cwd !== repoPath || !("stdout_tail" in verify.commands[0]) || !("stderr_tail" in verify.commands[0])) {
      throw new Error(`Verification command evidence incomplete: ${JSON.stringify(verify.commands[0])}`);
    }
  });

  await test("no-change task returns an explicit empty diff result", async () => {
    const plan = savePlan({ title: "No diff", content: "Do not change files." });
    const task = createTask({ plan_id: plan.plan_id, agent: "noop", repo_path: "repo" });
    const result = await runTask(task.task_id);
    if (!isDoneStatus(result.status)) throw new Error(`No-op task failed: ${JSON.stringify(result)}`);
    const diff = getDiff(task.task_id);
    const verify = JSON.parse(readFileSync(join(task.path, "verify.json"), "utf-8"));
    if (verify.status !== "skipped") throw new Error(`Expected skipped verification: ${JSON.stringify(verify)}`);
    if (diff.diff_available !== false || diff.changed_files?.length !== 0 || diff.message !== "No task file changes detected") {
      throw new Error(`No-diff response unclear: ${JSON.stringify(diff)}`);
    }
    if (diff.patch_mode !== "no_changes" || diff.unavailable_reason !== null) {
      throw new Error(`Expected explicit no_changes patch mode: ${JSON.stringify(diff)}`);
    }
    rmSync(join(task.path, "result.json"), { force: true });
    const fallback = getTaskSummary(task.task_id);
    if (!fallback.terminal || fallback.result_json_available || !fallback.summary) {
      throw new Error(`Summary fallback failed: ${JSON.stringify(fallback)}`);
    }
  });

  await test("large diff response is truncated while diff.patch remains complete", async () => {
    const plan = savePlan({ title: "Large diff", content: "Create a large text file." });
    const task = createTask({ plan_id: plan.plan_id, agent: "largewriter", repo_path: "repo" });
    const result = await runTask(task.task_id);
    if (!isDoneStatus(result.status)) throw new Error(`Large task failed: ${JSON.stringify(result)}`);
    const diff = getDiff(task.task_id);
    const patchSize = readFileSync(join(task.path, "diff.patch"), "utf-8").length;
    if (!diff.truncated || !diff.patch_head || !diff.diff_patch_path || patchSize <= diff.content.length) {
      throw new Error(`Large diff contract mismatch: ${JSON.stringify({ diff, patchSize })}`);
    }
  });

  await test("non-Git repositories return hash-only evidence with a reason", async () => {
    const plan = savePlan({ title: "Non-Git evidence", content: "Modify files in a non-Git repository." });
    const task = createTask({ plan_id: plan.plan_id, agent: "writer", repo_path: "plain-repo" });
    const result = await runTask(task.task_id);
    if (!isDoneStatus(result.status)) throw new Error(`Non-Git task failed: ${JSON.stringify(result)}`);
    const diff = getDiff(task.task_id);
    if (
      diff.patch_mode !== "hash_only" ||
      !diff.unavailable_reason?.includes("not a Git worktree") ||
      !diff.changed_files?.some((file) => file.path === "README.md")
    ) {
      throw new Error(`Non-Git diff evidence mismatch: ${JSON.stringify(diff)}`);
    }
  });

  await test("binary Git changes remain reviewable as a textual Git binary patch", async () => {
    const plan = savePlan({ title: "Binary evidence", content: "Create a binary fixture." });
    const task = createTask({ plan_id: plan.plan_id, agent: "binarywriter", repo_path: "repo" });
    const result = await runTask(task.task_id);
    if (!isDoneStatus(result.status)) throw new Error(`Binary task failed: ${JSON.stringify(result)}`);
    const diff = getDiff(task.task_id);
    if (diff.patch_mode !== "textual" || !diff.content.includes("GIT binary patch")) {
      throw new Error(`Binary patch evidence mismatch: ${JSON.stringify(diff)}`);
    }
  });

  await test("artifact hygiene separates source, ignored output, runtime data, and suspicious changes", async () => {
    const plan = savePlan({ title: "Artifact hygiene", content: "Generate representative task outputs." });
    const task = createTask({ plan_id: plan.plan_id, agent: "artifactwriter", repo_path: "repo" });
    const result = await runTask(task.task_id);
    if (!isDoneStatus(result.status)) throw new Error(`Artifact task failed: ${JSON.stringify(result)}`);
    const standard = getTaskSummary(task.task_id);
    const compact = getTaskSummary(task.task_id, { view: "compact", max_items: 1 });
    const counts = standard.artifact_hygiene?.counts || {};
    if (
      counts.tracked_build_artifacts < 1 ||
      counts.ignored_untracked_artifacts < 2 ||
      counts.runtime_generated_files < 1 ||
      counts.suspicious_changes < 2
    ) {
      throw new Error(`Artifact classification mismatch: ${JSON.stringify(standard.artifact_hygiene)}`);
    }
    if (compact.view !== "compact" || "log_tails" in compact || compact.artifact_hygiene.max_items !== 1) {
      throw new Error(`Compact summary leaked standard detail: ${JSON.stringify(compact)}`);
    }
    if (!Array.isArray(standard.changed_files) || standard.changed_files.length < 4) {
      throw new Error("Standard summary no longer preserves full changed-file evidence");
    }
    const audit = auditTask(task.task_id);
    const hygieneCheck = audit.checks.find((check) => check.name === "artifact_hygiene");
    if (!hygieneCheck || hygieneCheck.result !== "warn") {
      throw new Error(`Audit did not surface suspicious artifact evidence: ${JSON.stringify(audit)}`);
    }
  });

  await test("deleted tracked files are identified with file stats", async () => {
    const plan = savePlan({ title: "Delete fixture", content: "Delete the designated fixture file." });
    const task = createTask({ plan_id: plan.plan_id, agent: "deleter", repo_path: "repo" });
    const result = await runTask(task.task_id);
    if (!isDoneStatus(result.status)) throw new Error(`Delete task failed: ${JSON.stringify(result)}`);
    const diff = getDiff(task.task_id);
    if (!diff.file_stats?.some((file) => file.path === "delete-me.txt" && file.status === "deleted")) {
      throw new Error(`Deleted file stats missing: ${JSON.stringify(diff.file_stats)}`);
    }
  });

  await test("wait_for_task stays in the tool loop and returns terminal acceptance", async () => {
    const plan = savePlan({ title: "Wait loop", content: "Finish normally." });
    const task = createTask({ plan_id: plan.plan_id, agent: "writer", repo_path: "repo" });
    const running = runTask(task.task_id);
    const waited = await waitForTask(task.task_id, 5);
    await raceWithTimeout(running, 15000, "wait_for_task loop did not terminate within 15s");
    if (!waited.terminal || waited.continuation_required || !waited.summary) {
      throw new Error(`Unexpected wait response: ${JSON.stringify(waited)}`);
    }
    if (waited.summary.view !== "compact" || "log_tails" in waited.summary) {
      throw new Error(`Terminal wait should embed compact evidence: ${JSON.stringify(waited.summary)}`);
    }
  });

  await test("wait_for_task explicitly requires another call when the task is not terminal", async () => {
    const plan = savePlan({ title: "Pending wait", content: "Remain queued for this check." });
    const task = createTask({ plan_id: plan.plan_id, agent: "slow", repo_path: "repo" });
    const waited = await waitForTask(task.task_id, 1);
    if (waited.terminal || !waited.timed_out || !waited.continuation_required) {
      throw new Error(`Expected continuation response: ${JSON.stringify(waited)}`);
    }
    cancelTask(task.task_id);
  });

  await test("running task summary includes heartbeat, phase, command, and elapsed time", async () => {
    const plan = savePlan({ title: "Running summary", content: "Wait." });
    const task = createTask({ plan_id: plan.plan_id, agent: "slow", repo_path: "repo", timeout_seconds: 30 });
    const running = runTask(task.task_id);
    await waitForRunning(getTaskStatus, task.task_id);
    await sleep(50);
    const summary = getTaskSummary(task.task_id);
    if (summary.terminal || !summary.last_heartbeat_at || !summary.phase || !summary.current_command || summary.elapsed_ms < 0) {
      throw new Error(`Running summary incomplete: ${JSON.stringify(summary)}`);
    }
    cancelTask(task.task_id);
    await raceWithTimeout(running, 15000, "running summary cancel did not terminate within 15s");
  });

  await test("verification failure produces failed_verification and structured evidence", async () => {
    const plan = savePlan({ title: "Verify failure", content: "Finish normally." });
    const task = createTask({
      plan_id: plan.plan_id,
      agent: "writer",
      repo_path: "repo",
      verify_commands: ["node --check missing.js"],
    });
    const result = await runTask(task.task_id);
    if (result.status !== "failed_verification") throw new Error(`Unexpected result: ${JSON.stringify(result)}`);
    const verify = JSON.parse(readFileSync(join(task.path, "verify.json"), "utf-8"));
    if (verify.status !== "failed" || verify.commands?.[0]?.exit_code === 0) {
      throw new Error(`Verification evidence mismatch: ${JSON.stringify(verify)}`);
    }
    const resultMd = readFileSync(join(task.path, "result.md"), "utf-8");
    const resultJson = JSON.parse(readFileSync(join(task.path, "result.json"), "utf-8"));
    if (!resultMd.includes("node --check missing.js") || !resultJson.summary.includes("node --check missing.js")) {
      throw new Error("Failed verification command missing from result artifacts");
    }
    const summary = getTaskSummary(task.task_id);
    if (
      resultJson.failed_command !== "node --check missing.js" ||
      resultJson.suggested_next_action !== "create_followup_task" ||
      !resultJson.safe_followup_prompt?.includes("Do not change unrelated files") ||
      summary.suggested_next_action !== "create_followup_task"
    ) {
      throw new Error(`Failure follow-up evidence missing: ${JSON.stringify(resultJson)}`);
    }
  });

  await test("out-of-scope workspace changes fail the task and generate a rollback plan", async () => {
    const plan = savePlan({ title: "Scope violation", content: "Do not leave the repository." });
    const task = createTask({
      plan_id: plan.plan_id,
      agent: "scopebreaker",
      repo_path: "repo",
      verify_commands: ["node --check main.js"],
    });
    const result = await runTask(task.task_id);
    if (result.status !== "failed_scope_violation") throw new Error(`Unexpected result: ${JSON.stringify(result)}`);
    const structured = JSON.parse(readFileSync(join(task.path, "result.json"), "utf-8"));
    if (!structured.out_of_scope_changes?.some((file) => file.path === "outside-scope.txt")) {
      throw new Error(`Missing scope evidence: ${JSON.stringify(structured.out_of_scope_changes)}`);
    }
    if (structured.verify_status !== "failed") throw new Error(`Scope violation verify status must fail: ${structured.verify_status}`);
    const rollbackPath = join(task.path, "rollback_scope_violation_plan.md");
    if (!existsSync(rollbackPath)) throw new Error("rollback_scope_violation_plan.md missing");
    const rollback = readFileSync(rollbackPath, "utf-8");
    if (!rollback.includes("outside-scope.txt") || rollback.includes("README.md") || rollback.includes("new-file.txt")) {
      throw new Error(`Rollback plan contains wrong files: ${rollback}`);
    }
    const summary = getTaskSummary(task.task_id);
    if (summary.verify_status !== "failed" || summary.out_of_scope_changes.length === 0 || summary.acceptance_status !== "failed") {
      throw new Error(`Scope summary mismatch: ${JSON.stringify(summary)}`);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 4: Tracked external dirty tests (separate workspace)
  // ═══════════════════════════════════════════════════════════

  await test("pre-existing tracked external dirty unchanged → warning only, done", async () => {
    // Create a separate workspace with git at the root
    const ws2 = join(tempRoot, "workspace-tracked-dirty");
    const repo2 = join(ws2, "repo");
    const ext2 = join(ws2, "external");
    mkdirSync(repo2, { recursive: true });
    mkdirSync(ext2, { recursive: true });
    mkdirSync(join(ws2, ".patchwarden"), { recursive: true });
    writeFileSync(join(ws2, ".patchwarden", "watcher-heartbeat.json"), JSON.stringify({
      status: "running", pid: process.pid, instance_id: "td-watcher", launcher_pid: process.pid,
      started_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString(),
    }), "utf-8");

    writeFileSync(join(repo2, "main.js"), "console.log('main');\n", "utf-8");
    writeFileSync(join(ext2, "external-tracked.txt"), "external tracked content\n", "utf-8");

    git(["init"], ws2);
    git(["add", "repo/main.js", "external/external-tracked.txt"], ws2);
    git(["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", "init"], ws2);

    // Now modify external file to create pre-existing dirty state
    writeFileSync(join(ext2, "external-tracked.txt"), "pre-existing dirty content\n", "utf-8");

    const cfg2 = join(tempRoot, "config-tracked-dirty.json");
    writeFileSync(cfg2, JSON.stringify({
      workspaceRoot: ws2,
      plansDir: ".patchwarden/plans",
      tasksDir: ".patchwarden/tasks",
      agents: {
        noop: { command: process.execPath, args: ["-e", "console.log('noop')"] },
      },
      allowedTestCommands: ["node --check main.js"],
      maxReadFileBytes: 200000,
      defaultTaskTimeoutSeconds: 10,
      watcherStaleSeconds: 3600,
    }, null, 2), "utf-8");

    const oldConfig = process.env.PATCHWARDEN_CONFIG;
    process.env.PATCHWARDEN_CONFIG = cfg2;
    reloadConfig(cfg2);

    const plan = savePlan({ title: "Noop with external dirty", content: "Do nothing." });
    const task = createTask({ plan_id: plan.plan_id, agent: "noop", repo_path: "repo", verify_commands: ["node --check main.js"] });
    const result = await runTask(task.task_id);

    if (!isDoneStatus(result.status)) {
      throw new Error(`Expected done, got: ${JSON.stringify(result)}`);
    }
    const structured = JSON.parse(readFileSync(join(task.path, "result.json"), "utf-8"));

    // Must have pre-existing external dirty warning
    if (!structured.warnings?.some((w) => w.includes("Pre-existing external dirty"))) {
      throw new Error(`Missing pre-existing dirty warning: ${JSON.stringify(structured.warnings)}`);
    }

    // new_out_of_scope_changes must be empty (file didn't change during task)
    if (structured.new_out_of_scope_changes?.length > 0) {
      throw new Error(`Should have no new out-of-scope changes: ${JSON.stringify(structured.new_out_of_scope_changes)}`);
    }

    // verify_status should NOT be failed
    if (structured.verify_status === "failed") {
      throw new Error(`verify_status should not be failed: ${structured.verify_status}`);
    }

    // get_task_summary acceptance_status should NOT be failed
    const summary = getTaskSummary(task.task_id);
    if (summary.acceptance_status === "failed") {
      throw new Error(`acceptance_status should not be failed: ${summary.acceptance_status}`);
    }

    // audit_task should NOT fail scope_changes
    const audit = auditTask(task.task_id);
    const scopeCheck = audit.checks.find((c) => c.name === "scope_changes");
    if (!scopeCheck || scopeCheck.result !== "pass") {
      throw new Error(`audit scope_changes should pass: ${JSON.stringify(scopeCheck)}`);
    }

    // Restore config AFTER all assertions
    process.env.PATCHWARDEN_CONFIG = oldConfig;
    reloadConfig(oldConfig);

    // Print result.json key fields for reporting
    console.log(`    [result.json] status=${structured.status}, verify_status=${structured.verify_status}, new_out_of_scope=${JSON.stringify(structured.new_out_of_scope_changes)}, preexisting=${JSON.stringify(structured.preexisting_external_dirty_files)}, warnings=${JSON.stringify(structured.warnings)}`);
  });

  await test("pre-existing tracked external dirty changed during task → failed_scope_violation", async () => {
    const ws2 = join(tempRoot, "workspace-tracked-dirty2");
    const repo2 = join(ws2, "repo");
    const ext2 = join(ws2, "external");
    mkdirSync(repo2, { recursive: true });
    mkdirSync(ext2, { recursive: true });
    mkdirSync(join(ws2, ".patchwarden"), { recursive: true });
    writeFileSync(join(ws2, ".patchwarden", "watcher-heartbeat.json"), JSON.stringify({
      status: "running", pid: process.pid, instance_id: "td-watcher2", launcher_pid: process.pid,
      started_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString(),
    }), "utf-8");

    writeFileSync(join(repo2, "main.js"), "console.log('main');\n", "utf-8");
    writeFileSync(join(ext2, "external-tracked.txt"), "external tracked content\n", "utf-8");

    git(["init"], ws2);
    git(["add", "repo/main.js", "external/external-tracked.txt"], ws2);
    git(["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", "init"], ws2);

    // Modify external file BEFORE task (pre-existing dirty)
    writeFileSync(join(ext2, "external-tracked.txt"), "pre-existing dirty content\n", "utf-8");

    const cfg2 = join(tempRoot, "config-tracked-dirty2.json");
    writeFileSync(cfg2, JSON.stringify({
      workspaceRoot: ws2,
      plansDir: ".patchwarden/plans",
      tasksDir: ".patchwarden/tasks",
      agents: {
        extmod: { command: process.execPath, args: ["-e", "require('fs').appendFileSync('../external/external-tracked.txt',' modified by task\\n')"] },
      },
      allowedTestCommands: ["node --check main.js"],
      maxReadFileBytes: 200000,
      defaultTaskTimeoutSeconds: 10,
      watcherStaleSeconds: 3600,
    }, null, 2), "utf-8");

    const oldConfig = process.env.PATCHWARDEN_CONFIG;
    process.env.PATCHWARDEN_CONFIG = cfg2;
    reloadConfig(cfg2);

    const plan = savePlan({ title: "External dirty modifier", content: "Modify external tracked file." });
    const task = createTask({ plan_id: plan.plan_id, agent: "extmod", repo_path: "repo", verify_commands: ["node --check main.js"] });
    const result = await runTask(task.task_id);

    if (result.status !== "failed_scope_violation") {
      throw new Error(`Expected failed_scope_violation, got: ${JSON.stringify(result)}`);
    }
    const structured = JSON.parse(readFileSync(join(task.path, "result.json"), "utf-8"));

    // new_out_of_scope_changes must contain the external tracked file
    if (!structured.new_out_of_scope_changes?.some((f) => f.path.includes("external-tracked.txt"))) {
      throw new Error(`Missing new out-of-scope change: ${JSON.stringify(structured.new_out_of_scope_changes)}`);
    }

    // verify_status must be failed
    if (structured.verify_status !== "failed") {
      throw new Error(`verify_status must be failed: ${structured.verify_status}`);
    }

    // rollback plan must contain the file
    const rollbackPath = join(task.path, "rollback_scope_violation_plan.md");
    if (!existsSync(rollbackPath)) throw new Error("rollback_scope_violation_plan.md missing");
    const rollback = readFileSync(rollbackPath, "utf-8");
    if (!rollback.includes("external-tracked.txt")) {
      throw new Error(`Rollback plan missing external-tracked.txt: ${rollback}`);
    }

    // get_task_summary acceptance_status must be failed
    const summary = getTaskSummary(task.task_id);
    if (summary.acceptance_status !== "failed") {
      throw new Error(`acceptance_status must be failed: ${summary.acceptance_status}`);
    }

    // audit_task verdict must be fail
    const audit = auditTask(task.task_id);
    if (audit.verdict !== "fail") {
      throw new Error(`audit verdict must be fail: ${audit.verdict}`);
    }

    // Restore config AFTER all assertions
    process.env.PATCHWARDEN_CONFIG = oldConfig;
    reloadConfig(oldConfig);

    console.log(`    [result.json] status=${structured.status}, verify_status=${structured.verify_status}, new_out_of_scope=${JSON.stringify(structured.new_out_of_scope_changes)}, preexisting=${JSON.stringify(structured.preexisting_external_dirty_files)}, warnings=${JSON.stringify(structured.warnings)}`);
  });

  await test("clean tracked external file changed during task → failed_scope_violation", async () => {
    const ws2 = join(tempRoot, "workspace-tracked-dirty3");
    const repo2 = join(ws2, "repo");
    const ext2 = join(ws2, "external");
    mkdirSync(repo2, { recursive: true });
    mkdirSync(ext2, { recursive: true });
    mkdirSync(join(ws2, ".patchwarden"), { recursive: true });
    writeFileSync(join(ws2, ".patchwarden", "watcher-heartbeat.json"), JSON.stringify({
      status: "running", pid: process.pid, instance_id: "td-watcher3", launcher_pid: process.pid,
      started_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString(),
    }), "utf-8");

    writeFileSync(join(repo2, "main.js"), "console.log('main');\n", "utf-8");
    writeFileSync(join(ext2, "external-tracked.txt"), "external tracked content\n", "utf-8");

    git(["init"], ws2);
    git(["add", "repo/main.js", "external/external-tracked.txt"], ws2);
    git(["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", "init"], ws2);

    // External file is clean (committed state) — no pre-existing dirty

    const cfg2 = join(tempRoot, "config-tracked-dirty3.json");
    writeFileSync(cfg2, JSON.stringify({
      workspaceRoot: ws2,
      plansDir: ".patchwarden/plans",
      tasksDir: ".patchwarden/tasks",
      agents: {
        extmod: { command: process.execPath, args: ["-e", "require('fs').appendFileSync('../external/external-tracked.txt',' modified by task\\n')"] },
      },
      allowedTestCommands: ["node --check main.js"],
      maxReadFileBytes: 200000,
      defaultTaskTimeoutSeconds: 10,
      watcherStaleSeconds: 3600,
    }, null, 2), "utf-8");

    const oldConfig = process.env.PATCHWARDEN_CONFIG;
    process.env.PATCHWARDEN_CONFIG = cfg2;
    reloadConfig(cfg2);

    const plan = savePlan({ title: "Clean external modifier", content: "Modify clean external tracked file." });
    const task = createTask({ plan_id: plan.plan_id, agent: "extmod", repo_path: "repo", verify_commands: ["node --check main.js"] });
    const result = await runTask(task.task_id);

    if (result.status !== "failed_scope_violation") {
      throw new Error(`Expected failed_scope_violation, got: ${JSON.stringify(result)}`);
    }
    const structured = JSON.parse(readFileSync(join(task.path, "result.json"), "utf-8"));

    // new_out_of_scope_changes must contain the external tracked file (clean→dirty)
    if (!structured.new_out_of_scope_changes?.some((f) => f.path.includes("external-tracked.txt"))) {
      throw new Error(`Missing new out-of-scope change: ${JSON.stringify(structured.new_out_of_scope_changes)}`);
    }

    // verify_status must be failed
    if (structured.verify_status !== "failed") {
      throw new Error(`verify_status must be failed: ${structured.verify_status}`);
    }

    // get_task_summary acceptance_status must be failed
    const summary = getTaskSummary(task.task_id);
    if (summary.acceptance_status !== "failed") {
      throw new Error(`acceptance_status must be failed: ${summary.acceptance_status}`);
    }

    // audit_task verdict must be fail
    const audit = auditTask(task.task_id);
    if (audit.verdict !== "fail") {
      throw new Error(`audit verdict must be fail: ${audit.verdict}`);
    }

    // Restore config AFTER all assertions
    process.env.PATCHWARDEN_CONFIG = oldConfig;
    reloadConfig(oldConfig);

    console.log(`    [result.json] status=${structured.status}, verify_status=${structured.verify_status}, new_out_of_scope=${JSON.stringify(structured.new_out_of_scope_changes)}, preexisting=${JSON.stringify(structured.preexisting_external_dirty_files)}, warnings=${JSON.stringify(structured.warnings)}`);
  });

  await test("tracked external file rename → failed_scope_violation", async () => {
    const ws2 = join(tempRoot, "workspace-tracked-rename");
    const repo2 = join(ws2, "repo");
    const ext2 = join(ws2, "external");
    mkdirSync(repo2, { recursive: true });
    mkdirSync(ext2, { recursive: true });
    mkdirSync(join(ws2, ".patchwarden"), { recursive: true });
    writeFileSync(join(ws2, ".patchwarden", "watcher-heartbeat.json"), JSON.stringify({
      status: "running", pid: process.pid, instance_id: "td-watcher-rename", launcher_pid: process.pid,
      started_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString(),
    }), "utf-8");

    writeFileSync(join(repo2, "main.js"), "console.log('main');\n", "utf-8");
    writeFileSync(join(ext2, "external-tracked.txt"), "external tracked content\n", "utf-8");

    git(["init"], ws2);
    git(["add", "repo/main.js", "external/external-tracked.txt"], ws2);
    git(["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", "init"], ws2);

    // External file is clean (committed state) — no pre-existing dirty

    const cfg2 = join(tempRoot, "config-tracked-rename.json");
    writeFileSync(cfg2, JSON.stringify({
      workspaceRoot: ws2,
      plansDir: ".patchwarden/plans",
      tasksDir: ".patchwarden/tasks",
      agents: {
        extrenamer: { command: process.execPath, args: ["-e", "require('fs').renameSync('../external/external-tracked.txt','../external/external-renamed.txt')"] },
      },
      allowedTestCommands: ["node --check main.js"],
      maxReadFileBytes: 200000,
      defaultTaskTimeoutSeconds: 10,
      watcherStaleSeconds: 3600,
    }, null, 2), "utf-8");

    const oldConfig = process.env.PATCHWARDEN_CONFIG;
    process.env.PATCHWARDEN_CONFIG = cfg2;
    reloadConfig(cfg2);

    const plan = savePlan({ title: "External rename", content: "Rename external tracked file." });
    const task = createTask({ plan_id: plan.plan_id, agent: "extrenamer", repo_path: "repo", verify_commands: ["node --check main.js"] });
    const result = await runTask(task.task_id);

    if (result.status !== "failed_scope_violation") {
      throw new Error(`Expected failed_scope_violation, got: ${JSON.stringify(result)}`);
    }
    const structured = JSON.parse(readFileSync(join(task.path, "result.json"), "utf-8"));

    // new_out_of_scope_changes must contain rename evidence (old or new path)
    const hasRenameEvidence = structured.new_out_of_scope_changes?.some(
      (f) => f.path.includes("external-renamed.txt") || f.path.includes("external-tracked.txt") || f.change === "renamed"
    );
    if (!hasRenameEvidence) {
      throw new Error(`Missing rename evidence in new_out_of_scope_changes: ${JSON.stringify(structured.new_out_of_scope_changes)}`);
    }

    // verify_status must be failed
    if (structured.verify_status !== "failed") {
      throw new Error(`verify_status must be failed: ${structured.verify_status}`);
    }

    // get_task_summary acceptance_status must be failed
    const summary = getTaskSummary(task.task_id);
    if (summary.acceptance_status !== "failed") {
      throw new Error(`acceptance_status must be failed: ${summary.acceptance_status}`);
    }

    // audit_task verdict must be fail
    const audit = auditTask(task.task_id);
    if (audit.verdict !== "fail") {
      throw new Error(`audit verdict must be fail: ${audit.verdict}`);
    }

    // Restore config AFTER all assertions
    process.env.PATCHWARDEN_CONFIG = oldConfig;
    reloadConfig(oldConfig);

    console.log(`    [result.json] status=${structured.status}, verify_status=${structured.verify_status}, new_out_of_scope=${JSON.stringify(structured.new_out_of_scope_changes)}, preexisting=${JSON.stringify(structured.preexisting_external_dirty_files)}, warnings=${JSON.stringify(structured.warnings)}`);
  });

  await test("timeout terminates a long-running agent", async () => {
    const plan = savePlan({ title: "Timeout", content: "Wait." });
    const task = createTask({ plan_id: plan.plan_id, agent: "slow", repo_path: "repo", timeout_seconds: 1 });
    const started = Date.now();
    const result = await runTask(task.task_id);
    if (result.status !== "failed" || !result.error?.includes("timed out")) {
      throw new Error(`Expected timeout failure, got ${JSON.stringify(result)}`);
    }
    if (Date.now() - started > 10000) throw new Error("Timeout took too long to stop the process");
    const status = getTaskStatus(task.task_id);
    if (status.phase !== "failed" || !status.last_heartbeat_at) {
      throw new Error(`Missing timeout phase/heartbeat: ${JSON.stringify(status)}`);
    }
    if (!existsSync(join(task.path, "progress.md"))) throw new Error("progress.md missing");
  });

  await test("cancel_task safely stops a running agent", async () => {
    const plan = savePlan({ title: "Cancel", content: "Wait." });
    const task = createTask({ plan_id: plan.plan_id, agent: "slow", repo_path: "repo", timeout_seconds: 30 });
    const running = runTask(task.task_id);
    await waitForRunning(getTaskStatus, task.task_id);
    const request = cancelTask(task.task_id);
    if (!request.cancel_requested || request.force_kill_requested) {
      throw new Error(`Unexpected cancel response: ${JSON.stringify(request)}`);
    }
    const result = await raceWithTimeout(running, 15000, "cancel_task did not terminate within 15s");
    if (result.status !== "canceled") throw new Error(`Expected canceled, got ${JSON.stringify(result)}`);
  });

  await test("kill_task immediately stops a running agent", async () => {
    const plan = savePlan({ title: "Kill", content: "Wait." });
    const task = createTask({ plan_id: plan.plan_id, agent: "slow", repo_path: "repo", timeout_seconds: 30 });
    const running = runTask(task.task_id);
    await waitForRunning(getTaskStatus, task.task_id);
    const request = killTask(task.task_id);
    if (!request.force_kill_requested) throw new Error(`Unexpected kill response: ${JSON.stringify(request)}`);
    const result = await raceWithTimeout(running, 15000, "kill_task did not terminate within 15s");
    if (result.status !== "canceled" || !result.error?.includes("kill_task")) {
      throw new Error(`Expected killed/canceled result, got ${JSON.stringify(result)}`);
    }
  });
} catch (error) {
  fail("lifecycle smoke setup", error);
} finally {
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}

console.log(`\n${"=".repeat(50)}`);
console.log(`${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"=".repeat(50)}\n`);

if (failed > 0) process.exit(1);
console.log("ALL LIFECYCLE TESTS PASSED\n");

// Safety: force exit after cleanup in case any stray timer/handle keeps the event loop alive.
// All child processes are killed by the runner; this only guards against OS-level pipe drains.
process.exit(0);
