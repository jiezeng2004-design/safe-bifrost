import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  readFileSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getTasksDir, getPlansDir, getConfig, resolveWorkspaceRoot } from "../config.js";
import { guardPath, guardWorkspacePath } from "../security/pathGuard.js";
import {
  guardTestCommand,
} from "../security/commandGuard.js";
import { writeTaskProgress } from "../taskProgress.js";
import { writeTaskRuntime } from "../taskRuntime.js";
import { validateAssessmentFreshness } from "../assessments/assessmentStore.js";
import { buildAgentInvocation, buildExecutionPrompt } from "./agentInvocation.js";
import type { TaskPhase, TaskStatus } from "../tools/createTask.js";
import {
  buildChangeArtifacts,
  captureRepoSnapshot,
  compareSnapshots,
  emptyArtifactHygiene,
  writeSnapshot,
  extractExternalDirtyFiles,
  findNewExternalDirtyFiles,
  buildArtifactManifest,
  groupChangedFiles,
  type ChangedFile,
  type ChangeArtifacts,
  type ExternalDirtyFile,
  type ArtifactManifest,
} from "./changeCapture.js";
import { PatchWardenError, errorPayload } from "../errors.js";
import { diagnoseAndroidBuild } from "../tools/androidDoctor.js";
import { runPostTaskCleanup, type PostTaskCleanupReport } from "./postTaskCleanup.js";

const HEARTBEAT_INTERVAL_MS = 2000;
const GRACEFUL_KILL_MS = 2000;
const MAX_CAPTURE_CHARS = 100_000;
const ARTIFACT_COLLECTION_TIMEOUT_MS = 60_000;

interface TaskRunResult {
  task_id: string;
  status: TaskStatus;
  error: string | null;
}

type TerminationReason = "canceled" | "killed" | "timeout" | null;

interface ManagedProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
  terminationReason: TerminationReason;
}

interface TestExecutionResult extends ManagedProcessResult {
  command: string;
  cwd: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  skipped?: boolean;
}

interface VerifyCommandRecord {
  command: string;
  cwd: string;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  status: "passed" | "failed" | "canceled" | "timed_out";
}

interface VerifyReport {
  status: "passed" | "failed" | "skipped";
  requested_commands: string[];
  commands: VerifyCommandRecord[];
  failure_reason?: string;
}

export async function runTask(taskId: string): Promise<TaskRunResult> {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const plansDir = getPlansDir(config);
  const wsRoot = resolveWorkspaceRoot(config);
  const taskDir = resolve(tasksDir, taskId);
  guardPath(taskDir, wsRoot, config.tasksDir);

  const statusFile = join(taskDir, "status.json");
  if (!existsSync(statusFile)) throw new Error(`Task not found: "${taskId}"`);

  const initialStatus = readStatus(statusFile);
  const planId = String(initialStatus.plan_id || "");
  const agentName = String(initialStatus.agent || "");
  const rawRepoPath = String(initialStatus.resolved_repo_path || initialStatus.repo_path || wsRoot);
  const testCommand = String(initialStatus.test_command || "");
  const changePolicy = String(initialStatus.change_policy || "repo_scoped_changes");
  let verifyCommands: string[];
  let timeoutSeconds: number;
  try {
    timeoutSeconds = normalizeTimeout(initialStatus.timeout_seconds, config);
  } catch (error) {
    return failBeforeExecution(taskId, taskDir, errorMessage(error), error);
  }
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + timeoutSeconds * 1000;

  let repoPath: string;
  try {
    repoPath = guardWorkspacePath(rawRepoPath, wsRoot);
  } catch (error) {
    const message = `repo_path validation failed: ${errorMessage(error)}`;
    return failBeforeExecution(taskId, taskDir, message, error);
  }
  try {
    verifyCommands = normalizeVerifyCommands(initialStatus.verify_commands, testCommand, config, repoPath);
  } catch (error) {
    const message = `verification metadata validation failed: ${errorMessage(error)}`;
    return failBeforeExecution(taskId, taskDir, message, error);
  }

  // ── Assessment freshness revalidation before execution ──
  const assessmentId = String(initialStatus.assessment_id || "");
  if (assessmentId) {
    try {
      const preExecSnapshot = captureRepoSnapshot(repoPath);
      const validation = validateAssessmentFreshness(assessmentId, preExecSnapshot);
      if (!validation.valid) {
        const message = `assessment validation failed: ${validation.failure_reason}. Re-run create_task with execution_mode=assess_only to get a fresh assessment_id.`;
        return failBeforeExecution(taskId, taskDir, message);
      }
    } catch (error) {
      const message = `assessment validation error: ${errorMessage(error)}`;
      return failBeforeExecution(taskId, taskDir, message, error);
    }
  }

  updateStatus(taskDir, {
    status: "running",
    phase: "preparing",
    started_at: new Date(startedAtMs).toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    timeout_seconds: timeoutSeconds,
    current_command: null,
    error: null,
  });
  // v0.7.0: record task_started_at and watcher_instance_id so diagnose_task
  // can detect PID reuse and orphaned tasks. watcher_instance_id comes from
  // the watcher process env; when run_task MCP tool is used directly, this
  // field is intentionally left undefined so ownership cannot be falsely claimed.
  writeTaskRuntime(taskDir, {
    task_started_at: new Date(startedAtMs).toISOString(),
    watcher_instance_id: process.env.PATCHWARDEN_WATCHER_INSTANCE_ID || undefined,
  });
  setTaskPhase(taskDir, "preparing", null, "Capturing pre-task repository state.");

  let beforeSnapshot;
  let beforeWorkspaceSnapshot;
  let externalDirtyBaseline: ExternalDirtyFile[] = [];
  try {
    beforeSnapshot = captureRepoSnapshot(repoPath);
    beforeWorkspaceSnapshot = repoPath === wsRoot ? beforeSnapshot : captureRepoSnapshot(wsRoot);
    writeSnapshot(taskDir, "git-before.json", beforeSnapshot);
    writeSnapshot(taskDir, "workspace-before.json", beforeWorkspaceSnapshot);
    // Phase 4: Record external dirty files as baseline before task execution
    externalDirtyBaseline = extractExternalDirtyFiles(beforeWorkspaceSnapshot, repoPath, wsRoot);
  } catch (error) {
    const message = `Pre-task snapshot failed: ${errorMessage(error)}`;
    return failBeforeExecution(taskId, taskDir, message, error);
  }

  let agentResult: ManagedProcessResult | null = null;
  let testResult: TestExecutionResult = skippedTest(testCommand, repoPath, "Agent did not complete successfully.");
  const verifyResults: TestExecutionResult[] = [];
  let finalStatus: TaskStatus = "failed";
  let finalError: string | null = null;
  let lastCaughtError: unknown = null;

  try {
    const planFile = resolve(plansDir, planId, "plan.md");
    if (!existsSync(planFile)) throw new Error(`Plan not found: "${planId}". Save the plan first.`);
    const planContent = readFileSync(planFile, "utf-8");
    const prompt = buildExecutionPrompt(planContent, repoPath, testCommand);
    const invocation = buildAgentInvocation(agentName, repoPath, prompt, config);
    const agentCommandLabel = invocation.commandLabel;

    setTaskPhase(taskDir, "executing_agent", agentCommandLabel);
    agentResult = await runManagedProcess({
      command: invocation.command,
      args: invocation.args,
      cwd: repoPath,
      taskDir,
      statusFile,
      phase: "executing_agent",
      currentCommand: agentCommandLabel,
      deadlineMs,
      stdoutPath: join(taskDir, "stdout.log"),
      stderrPath: join(taskDir, "stderr.log"),
    });

    if (agentResult.terminationReason === "canceled" || agentResult.terminationReason === "killed") {
      finalStatus = "canceled";
      finalError = agentResult.terminationReason === "killed"
        ? "Task was terminated by kill_task."
        : "Task was canceled by user request.";
    } else if (agentResult.terminationReason === "timeout") {
      finalError = `Task timed out after ${timeoutSeconds} seconds during agent execution.`;
    } else if (agentResult.spawnError) {
      finalError = `Agent spawn failed: ${agentResult.spawnError}`;
    } else if (agentResult.exitCode !== 0) {
      finalError = `Agent exited with code ${agentResult.exitCode}.`;
    } else if (verifyCommands.length > 0) {
      for (const command of verifyCommands) {
        setTaskPhase(taskDir, "running_tests", command);
        const verification = await runTrustedTestCommand(command, repoPath, taskDir, statusFile, deadlineMs);
        verifyResults.push(verification);
        if (verification.terminationReason || Date.now() >= deadlineMs) break;
      }
      testResult = verifyResults[0] || skippedTest(testCommand, repoPath, "No verification command ran.");
      const interrupted = verifyResults.find((result) => result.terminationReason);
      const failedVerification = verifyResults.find((result) => result.spawnError || result.exitCode !== 0);
      if (interrupted?.terminationReason === "canceled" || interrupted?.terminationReason === "killed") {
        finalStatus = "canceled";
        finalError = interrupted.terminationReason === "killed"
          ? "Task was terminated by kill_task during verification."
          : "Task was canceled during verification.";
      } else if (interrupted?.terminationReason === "timeout" || Date.now() >= deadlineMs) {
        finalError = `Task timed out after ${timeoutSeconds} seconds during verification.`;
      } else if (failedVerification) {
        finalStatus = "failed_verification";
        finalError = failedVerification.spawnError
          ? `Verification command \"${failedVerification.command}\" could not start: ${failedVerification.spawnError}`
          : `Verification command \"${failedVerification.command}\" exited with code ${failedVerification.exitCode}.`;
      } else if (verifyResults.length === verifyCommands.length) {
        finalStatus = "done_by_agent";
      } else {
        finalError = "Verification did not complete all configured commands.";
      }
    } else {
      testResult = skippedTest(testCommand, repoPath, "No verification command configured.");
      finalStatus = "done_by_agent";
    }
  } catch (error) {
    lastCaughtError = error;
    finalError = errorMessage(error);
  }

  let cleanupReport: PostTaskCleanupReport = {
    enabled: true,
    removed: [],
    skipped: [],
    source_files_touched: 0,
  };
  if (finalStatus !== "canceled") {
    try {
      cleanupReport = runPostTaskCleanup(repoPath, taskDir);
      updateStatus(taskDir, { cleanup: cleanupReport });
    } catch (error) {
      cleanupReport = {
        enabled: true,
        removed: [],
        skipped: [{ path: ".", reason: "post_task_cleanup", skip_reason: errorMessage(error) }],
        source_files_touched: 0,
      };
      writeFileSync(join(taskDir, "post-task-cleanup.json"), JSON.stringify(cleanupReport, null, 2), "utf-8");
      updateStatus(taskDir, { cleanup: cleanupReport });
    }
  }
  setTaskPhase(taskDir, "collecting_artifacts", null, "Capturing post-task state and writing reports.");
  const artifactCollectionStartedAt = new Date().toISOString();
  let changes: ChangeArtifacts;
  let artifactStatus: "collected" | "partial" | "failed" | "timeout" = "collected";
  let artifactCollectionError: string | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    // Phase 5: Wrap artifact collection with a timeout
    const collectionResult = await Promise.race([
      Promise.resolve().then(() => {
        const afterSnapshot = captureRepoSnapshot(repoPath);
        writeSnapshot(taskDir, "git-after.json", afterSnapshot);
        return buildChangeArtifacts(repoPath, beforeSnapshot, afterSnapshot);
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("Artifact collection timed out")), ARTIFACT_COLLECTION_TIMEOUT_MS);
      }),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    changes = collectionResult;
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    lastCaughtError = error;
    artifactCollectionError = errorMessage(error);
    if (artifactCollectionError.includes("timed out")) {
      artifactStatus = "timeout";
    } else {
      artifactStatus = "failed";
    }
    changes = {
      changed_files: [],
      diff: `(change capture failed: ${artifactCollectionError})\n`,
      diff_available: false,
      diff_truncated: false,
      diff_size_bytes: 0,
      additions: 0,
      deletions: 0,
      file_stats: [],
      workspace_dirty_before: beforeSnapshot.workspace_dirty,
      workspace_dirty_after: beforeSnapshot.workspace_dirty,
      patch_mode: "hash_only",
      unavailable_reason: `Change capture failed: ${artifactCollectionError}`,
      artifact_hygiene: emptyArtifactHygiene(),
    };
    // Phase 5: Write partial_result.md when artifact collection fails
    writeFileSync(join(taskDir, "partial_result.md"), [
      "# PatchWarden Partial Result",
      "",
      `Task: ${taskId}`,
      "",
      "## Artifact Collection Status",
      artifactStatus,
      "",
      "## Error",
      artifactCollectionError,
      "",
      "## Agent Status",
      agentResult ? `Exit code: ${agentResult.exitCode}` : "Agent did not run",
      "",
      "## Verification Status",
      verifyResults.length > 0 ? verifyResults.map((r) => `- ${r.command}: exit ${r.exitCode}`).join("\n") : "No verification ran",
      "",
      "## Note",
      "Artifact collection did not complete. The task result may be incomplete. Review stdout.log, stderr.log, and verify.json for details.",
      "",
    ].join("\n"), "utf-8");
    // Don't override test failure with artifact failure
    if (finalStatus === "done_by_agent") {
      finalError = `Change capture failed: ${artifactCollectionError}`;
      finalStatus = "failed";
    } else {
      finalError ||= `Change capture failed: ${artifactCollectionError}`;
    }
  }
  const artifactCollectionFinishedAt = new Date().toISOString();

  let outOfScopeChanges: ChangedFile[] = [];
  let preexistingExternalDirty: ExternalDirtyFile[] = externalDirtyBaseline;
  let newOutOfScopeChanges: ExternalDirtyFile[] = [];
  try {
    const afterWorkspaceSnapshot = repoPath === wsRoot ? captureRepoSnapshot(repoPath) : captureRepoSnapshot(wsRoot);
    writeSnapshot(taskDir, "workspace-after.json", afterWorkspaceSnapshot);
    const allExternalDirty = extractExternalDirtyFiles(afterWorkspaceSnapshot, repoPath, wsRoot);
    // Phase 4: Only NEW external dirty files (not in baseline) are scope violations
    newOutOfScopeChanges = findNewExternalDirtyFiles(externalDirtyBaseline, allExternalDirty);
    outOfScopeChanges = compareSnapshots(beforeWorkspaceSnapshot, afterWorkspaceSnapshot)
      .filter((file) =>
        !isPathInside(resolve(wsRoot, file.path), repoPath) ||
        Boolean(file.old_path && !isPathInside(resolve(wsRoot, file.old_path), repoPath))
      );
  } catch (error) {
    finalError ||= `Workspace scope capture failed: ${errorMessage(error)}`;
    if (finalStatus === "done_by_agent") finalStatus = "failed";
  }

  // Phase 4: Pre-existing external dirty files are warnings, not failures
  const preexistingWarnings: string[] = preexistingExternalDirty.length > 0
    ? [`Pre-existing external dirty files (not caused by this task): ${preexistingExternalDirty.length} file(s)`]
    : [];

  if (newOutOfScopeChanges.length > 0) {
    finalStatus = "failed_scope_violation";
    finalError = `Detected ${newOutOfScopeChanges.length} new change(s) outside resolved_repo_path during task execution.`;
    writeFileSync(join(taskDir, "rollback-plan.json"), JSON.stringify({
      task_id: taskId,
      status: "review_required",
      automatic_rollback_performed: false,
      warning: "Review ownership and concurrent edits before rollback. PatchWarden did not modify or restore these files.",
      out_of_scope_changes: newOutOfScopeChanges,
      preexisting_external_dirty_files: preexistingExternalDirty,
    }, null, 2), "utf-8");
    writeFileSync(join(taskDir, "rollback_scope_violation_plan.md"), [
      "# Scope Violation Rollback Plan",
      "",
      `Task: ${taskId}`,
      "",
      "PatchWarden did not automatically roll back any file. Review concurrent or user-owned edits before acting.",
      "",
      "## New out-of-scope files (caused by this task)",
      ...newOutOfScopeChanges.map((file) => `- ${file.change}: ${file.path}`),
      "",
    ].join("\n"), "utf-8");
  } else if (changePolicy === "no_changes" && changes.changed_files.length > 0) {
    finalStatus = "failed_policy_violation";
    finalError = `Task policy requires no repository changes, but detected ${changes.changed_files.length} change(s).`;
  }

  writeFileSync(join(taskDir, "git.diff"), changes.diff, "utf-8");
  writeFileSync(join(taskDir, "diff.patch"), changes.diff, "utf-8");
  writeFileSync(join(taskDir, "changed-files.json"), JSON.stringify(changes, null, 2), "utf-8");

  // Phase 6: Generate artifact_manifest.json and group changed files
  const artifactManifest: ArtifactManifest = buildArtifactManifest(changes.changed_files, repoPath, taskId);
  writeFileSync(join(taskDir, "artifact_manifest.json"), JSON.stringify(artifactManifest, null, 2), "utf-8");
  const changedFileGroups = groupChangedFiles(changes.changed_files);

  writeFileSync(join(taskDir, "file-stats.json"), JSON.stringify({
    task_id: taskId,
    additions: changes.additions,
    deletions: changes.deletions,
    files: changes.file_stats,
  }, null, 2), "utf-8");
  writeFileSync(join(taskDir, "test.log"), buildTestLog(testResult), "utf-8");
  const verifyJson = buildVerifyJson(verifyCommands, verifyResults, repoPath);
  // Phase 4: Use newOutOfScopeChanges (not outOfScopeChanges) for verify_status
  // to stay consistent with finalStatus. Pre-existing external dirty files
  // that didn't change during the task should NOT cause verify_status to fail.
  if (newOutOfScopeChanges.length > 0) {
    verifyJson.status = "failed";
    verifyJson.failure_reason = "scope_violation";
  } else if (finalStatus === "failed_policy_violation") {
    verifyJson.status = "failed";
    verifyJson.failure_reason = "change_policy_violation";
  }
  writeFileSync(join(taskDir, "verify.json"), JSON.stringify(verifyJson, null, 2), "utf-8");
  writeFileSync(join(taskDir, "verify.log"), buildVerifyLog(verifyJson.commands), "utf-8");

  if (!["canceled", "done_by_agent", "failed_verification", "failed_scope_violation", "failed_policy_violation"].includes(finalStatus)) finalStatus = "failed";
  const finalPhase: TaskPhase = finalStatus === "done_by_agent" ? "done_by_agent" : finalStatus;
  const followup = buildFailureFollowup(finalStatus, finalError, verifyJson.commands);

  // Phase 7: Run Android build environment diagnostics if android_app exists
  const androidDiagnostic = diagnoseAndroidBuild(repoPath);
  let androidWarning: string | null = null;
  if (androidDiagnostic.status !== "skip") {
    if (androidDiagnostic.status === "fail") {
      androidWarning = "Android project exists, APK not built because Android SDK is missing.";
    } else if (androidDiagnostic.status === "warn") {
      const apkCheck = androidDiagnostic.checks.find((c) => c.check === "APK output path");
      if (apkCheck && apkCheck.status !== "ok") {
        androidWarning = `Android build environment has warnings: ${apkCheck.reason}`;
      }
    }
  }

  const resultMd = buildResultMarkdown({
    taskId,
    planId,
    agent: agentName,
    status: finalStatus,
    error: finalError,
    agentResult,
    testResult,
    verify: verifyJson,
    changes,
    outOfScopeChanges,
    artifactStatus,
    artifactManifest,
    changedFileGroups,
    androidDiagnostic,
    androidWarning,
    preexistingWarnings,
  });
  writeFileSync(join(taskDir, "result.md"), resultMd, "utf-8");
  writeFileSync(join(taskDir, "result.json"), JSON.stringify({
    task_id: taskId,
    status: finalStatus,
    agent: agentName,
    workspace_root: wsRoot,
    repo_path: initialStatus.repo_path,
    resolved_repo_path: repoPath,
    plan_source: initialStatus.plan_source || "saved",
    template: initialStatus.template || null,
    change_policy: changePolicy,
    summary: finalError || "Agent execution and configured verification completed successfully.",
    changed_files: changes.changed_files,
    changed_file_groups: {
      source_changes: changedFileGroups.source_changes.length,
      docs_changes: changedFileGroups.docs_changes.length,
      config_changes: changedFileGroups.config_changes.length,
      test_changes: changedFileGroups.test_changes.length,
      release_artifacts: changedFileGroups.release_artifacts.length,
      runtime_generated_files: changedFileGroups.runtime_generated_files.length,
    },
    artifact_hygiene: changes.artifact_hygiene,
    artifact_status: artifactStatus,
    artifact_collection_error: artifactCollectionError,
    artifact_collection_started_at: artifactCollectionStartedAt,
    artifact_collection_finished_at: artifactCollectionFinishedAt,
    cleanup: cleanupReport,
    artifact_manifest: artifactManifest,
    out_of_scope_changes: outOfScopeChanges,
    new_out_of_scope_changes: newOutOfScopeChanges,
    preexisting_external_dirty_files: preexistingExternalDirty,
    target_repo_status: changes.workspace_dirty_after ? "dirty" : "clean",
    workspace_status: changes.workspace_dirty_after ? "dirty" : "clean",
    android_diagnostic: androidDiagnostic,
    verify_status: verifyJson.status,
    verify_commands: verifyJson.commands,
    commands_run: verifyJson.commands.map((command) => ({
      command: command.command,
      cwd: command.cwd,
      exit_code: command.exit_code,
    })),
    commands_observed: [],
    verify: verifyJson,
    artifacts: [
      "result.md", "result.json", "diff.patch", "git.diff", "test.log", "verify.log", "verify.json", "changed-files.json", "file-stats.json", "artifact_manifest.json", "post-task-cleanup.json",
      ...(outOfScopeChanges.length > 0 ? ["rollback_scope_violation_plan.md", "rollback-plan.json"] : []),
      ...(artifactStatus !== "collected" ? ["partial_result.md"] : []),
    ],
    warnings: [
      ...beforeSnapshot.warnings,
      ...(changes.diff_truncated ? ["diff.patch was truncated; changed-files.json retains file evidence."] : []),
      ...preexistingWarnings,
      ...(androidWarning ? [androidWarning] : []),
    ],
    errors: finalError ? [finalError] : [],
    known_issues: finalError ? [finalError] : [],
    failure_reason: followup.failure_reason,
    failed_command: followup.failed_command,
    suggested_next_action: followup.suggested_next_action,
    safe_followup_prompt: followup.safe_followup_prompt,
    next_steps: finalStatus === "done_by_agent"
      ? ["Review get_task_summary and audit_task before accepting the work."]
      : ["Resolve the reported failure before accepting the work."],
  }, null, 2), "utf-8");
  if (finalError) {
    // Phase 9: Preserve PatchWardenError structured info in error.log
    const structuredError = errorPayload(lastCaughtError);
    writeFileSync(join(taskDir, "error.log"), JSON.stringify({
      summary: finalError,
      ...structuredError,
    }, null, 2), "utf-8");
  }

  const finishedAt = new Date().toISOString();
  updateStatus(taskDir, {
    status: finalStatus,
    phase: finalPhase,
    current_command: null,
    last_heartbeat_at: finishedAt,
    finished_at: finishedAt,
    error: finalError,
    changed_files: changes.changed_files.map(({ path, change }) => ({ path, change })),
    artifact_hygiene_counts: changes.artifact_hygiene.counts,
    artifact_status: artifactStatus,
    artifact_collection_error: artifactCollectionError,
    artifact_collection_started_at: artifactCollectionStartedAt,
    artifact_collection_finished_at: artifactCollectionFinishedAt,
    cleanup: cleanupReport,
    out_of_scope_changes: outOfScopeChanges,
    new_out_of_scope_changes: newOutOfScopeChanges,
    preexisting_external_dirty_files: preexistingExternalDirty,
    verify_status: verifyJson.status,
    verify_commands: verifyCommands,
    diff_available: changes.diff_available,
    diff_truncated: changes.diff_truncated,
    workspace_dirty_before: changes.workspace_dirty_before,
    workspace_dirty_after: changes.workspace_dirty_after,
    workspace_dirty: changes.workspace_dirty_after,
    acceptance_status: finalStatus === "done_by_agent" ? "pending" : null,
  });
  writeTaskRuntime(taskDir, {
    phase: finalPhase,
    current_command: null,
    last_heartbeat_at: finishedAt,
    runner_pid: process.pid,
    child_pid: undefined,
  });
  writeTaskProgress(taskDir, finalPhase, {
    heartbeatAt: finishedAt,
    note: finalError || `Task finished with status ${finalStatus}.`,
  });

  return { task_id: taskId, status: finalStatus, error: finalError };
}

function buildFailureFollowup(
  status: TaskStatus,
  error: string | null,
  commands: VerifyCommandRecord[]
): {
  failure_reason: string | null;
  failed_command: string | null;
  suggested_next_action: string;
  safe_followup_prompt: string | null;
} {
  const failed = commands.find((command) => command.status !== "passed");
  if (status === "done_by_agent" || status === "done") {
    return {
      failure_reason: null,
      failed_command: null,
      suggested_next_action: "audit_task",
      safe_followup_prompt: null,
    };
  }
  if (status === "failed_verification") {
    return {
      failure_reason: error || "Independent verification failed.",
      failed_command: failed?.command || null,
      suggested_next_action: "create_followup_task",
      safe_followup_prompt: `Fix the failing verification${failed?.command ? ` (${failed.command})` : ""} inside the same repository. Do not change unrelated files, weaken checks, commit, push, or publish.`,
    };
  }
  if (status === "failed_scope_violation") {
    return {
      failure_reason: error || "Changes were detected outside resolved_repo_path.",
      failed_command: null,
      suggested_next_action: "review_scope_violation",
      safe_followup_prompt: "Review rollback_scope_violation_plan.md and prepare a backup-first recovery proposal. Do not automatically delete, reset, or restore files.",
    };
  }
  if (status === "failed_policy_violation") {
    return {
      failure_reason: error || "The task violated its no-changes policy.",
      failed_command: null,
      suggested_next_action: "review_unexpected_changes",
      safe_followup_prompt: "Inspect the unexpected repository changes and propose a backup-first recovery. Do not automatically revert or delete files.",
    };
  }
  if (status === "canceled") {
    return {
      failure_reason: error || "Task was canceled.",
      failed_command: failed?.command || null,
      suggested_next_action: "inspect_task_logs",
      safe_followup_prompt: null,
    };
  }
  return {
    failure_reason: error || "Task execution failed.",
    failed_command: failed?.command || null,
    suggested_next_action: "inspect_task_logs",
    safe_followup_prompt: "Inspect result.json, stderr.log, and verify.json, then create a narrowly scoped follow-up task inside the same repository.",
  };
}

async function runManagedProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  taskDir: string;
  statusFile: string;
  phase: TaskPhase;
  currentCommand: string;
  deadlineMs: number;
  stdoutPath?: string;
  stderrPath?: string;
}): Promise<ManagedProcessResult> {
  if (Date.now() >= options.deadlineMs) {
    return { exitCode: null, stdout: "", stderr: "", spawnError: null, terminationReason: "timeout" };
  }

  let child: ChildProcess;
  try {
    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: "", spawnError: errorMessage(error), terminationReason: null };
  }
  // v0.7.0: record child_started_at immediately so diagnose_task can detect
  // PID reuse by comparing this timestamp with the live process start time.
  writeTaskRuntime(options.taskDir, {
    child_pid: child.pid,
    child_started_at: new Date().toISOString(),
  });

  const stdoutStream = openStream(options.stdoutPath);
  const stderrStream = openStream(options.stderrPath);
  let stdout = "";
  let stderr = "";
  let spawnError: string | null = null;
  let terminationReason: TerminationReason = null;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let childExitFinish: ((code: number | null) => void) | null = null;
  let terminationStarted = false;

  const heartbeat = () => {
    const now = new Date().toISOString();
    const activePhase: TaskPhase = terminationReason
      ? (terminationReason === "canceled" ? "canceling" : "terminating")
      : options.phase;
    writeTaskRuntime(options.taskDir, {
      phase: activePhase,
      last_heartbeat_at: now,
      current_command: options.currentCommand,
      runner_pid: process.pid,
      child_pid: child.pid,
    });
    writeTaskProgress(options.taskDir, activePhase, {
      heartbeatAt: now,
      currentCommand: options.currentCommand,
    });

    const control = readStatus(options.statusFile);
    if (control.force_kill_requested) requestTermination("killed", true);
    else if (control.cancel_requested) requestTermination("canceled", false);
    else if (Date.now() >= options.deadlineMs) requestTermination("timeout", true);
  };

  const requestTermination = (reason: Exclude<TerminationReason, null>, force: boolean) => {
    if (terminationStarted) return;
    terminationStarted = true;
    terminationReason = reason;
    const phase: TaskPhase = force ? "terminating" : "canceling";
    setTaskPhase(options.taskDir, phase, options.currentCommand, `${reason} requested; stopping child process.`);
    if (force) {
      forceKill(child);
    } else {
      gracefulKill(child);
      forceTimer = setTimeout(() => forceKill(child), GRACEFUL_KILL_MS);
    }
    // Fallback: if neither close nor exit fires within 10s after taskkill,
    // force-resolve to prevent the runner from hanging indefinitely.
    // Only starts AFTER termination is requested — normal long tasks are unaffected.
    fallbackTimer = setTimeout(() => {
      try { forceKill(child); } catch {}
      try { child.kill("SIGKILL"); } catch {}
      // Resolve the exit promise via the shared finish handle
      if (childExitFinish) childExitFinish(null);
    }, 10000);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stdout = appendBounded(stdout, text);
    stdoutStream?.write(text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stderr = appendBounded(stderr, text);
    stderrStream?.write(text);
  });

  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  const exitCode = await new Promise<number | null>((resolveExit) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      childExitFinish = null;
      resolveExit(code);
    };
    childExitFinish = finish;
    child.once("close", (code) => finish(code));
    child.once("exit", (code) => {
      // On Windows, "close" can lag behind "exit" when stdio pipes drain
      // after taskkill. Resolve on exit to avoid hanging the runner, but
      // still let "close" fire if it arrives first.
      finish(code);
    });
    child.once("error", (error) => {
      spawnError = error.message;
      finish(null);
    });
  });

  clearInterval(heartbeatTimer);
  if (forceTimer) clearTimeout(forceTimer);
  stdoutStream?.destroy();
  stderrStream?.destroy();
  writeTaskRuntime(options.taskDir, {
    phase: options.phase,
    last_heartbeat_at: new Date().toISOString(),
    current_command: null,
    runner_pid: process.pid,
    child_pid: undefined,
  });

  return { exitCode, stdout, stderr, spawnError, terminationReason };
}

async function runTrustedTestCommand(
  testCommand: string,
  repoPath: string,
  taskDir: string,
  statusFile: string,
  deadlineMs: number
): Promise<TestExecutionResult> {
  const config = getConfig();
  const trusted = guardTestCommand(testCommand, config, repoPath);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const parts = trusted.split(/\s+/).filter(Boolean);
  let command = parts[0];
  let args = parts.slice(1);
  if (process.platform === "win32" && /^(npm|npm\.cmd|pnpm|pnpm\.cmd)$/i.test(command)) {
    const shim = /^pnpm/i.test(command) ? "pnpm.cmd" : "npm.cmd";
    command = process.env.ComSpec || "cmd.exe";
    args = ["/d", "/s", "/c", shim, ...args];
  }
  const result = await runManagedProcess({
    command,
    args,
    cwd: repoPath,
    taskDir,
    statusFile,
    phase: "running_tests",
    currentCommand: trusted,
    deadlineMs,
    stdoutPath: join(taskDir, "test.stdout.log"),
    stderrPath: join(taskDir, "test.stderr.log"),
  });
  const finishedAtMs = Date.now();
  return {
    ...result,
    command: trusted,
    cwd: repoPath,
    started_at: startedAt,
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: finishedAtMs - startedAtMs,
  };
}

function buildTestLog(result: TestExecutionResult): string {
  if (result.skipped) return `${result.command || "(no test command)"}\nExit code: not run\n${result.stderr}\n`;
  return [
    `$ ${result.command}`,
    `Exit code: ${result.exitCode}`,
    result.terminationReason ? `Termination: ${result.terminationReason}` : "",
    result.spawnError ? `Spawn error: ${result.spawnError}` : "",
    "",
    result.stdout || "(no output)",
    result.stderr ? `\nSTDERR:\n${result.stderr}` : "",
  ].filter((line) => line !== "").join("\n");
}

function buildResultMarkdown(input: {
  taskId: string;
  planId: string;
  agent: string;
  status: TaskStatus;
  error: string | null;
  agentResult: ManagedProcessResult | null;
  testResult: TestExecutionResult;
  verify: VerifyReport;
  changes: ChangeArtifacts;
  outOfScopeChanges: ChangedFile[];
  artifactStatus?: string;
  artifactManifest?: ArtifactManifest;
  changedFileGroups?: { source_changes: ChangedFile[]; docs_changes: ChangedFile[]; config_changes: ChangedFile[]; test_changes: ChangedFile[]; release_artifacts: ChangedFile[]; runtime_generated_files: ChangedFile[] };
  androidDiagnostic?: { status: string; checks?: Array<{ check: string; status: string; reason: string }> };
  androidWarning?: string | null;
  preexistingWarnings?: string[];
}): string {
  const changed = input.changes.changed_files.length
    ? input.changes.changed_files.map((file) => `- ${file.change}: ${file.path}`).join("\n")
    : "(no task file changes detected)";
  const outOfScope = input.outOfScopeChanges.length
    ? input.outOfScopeChanges.map((file) => `- ${file.change}: ${file.old_path ? `${file.old_path} -> ` : ""}${file.path}`).join("\n")
    : "(none)";

  // Phase 6: Artifact manifest summary
  const artifactCount = input.artifactManifest?.artifacts.length || 0;
  const artifactLines = artifactCount > 0
    ? input.artifactManifest!.artifacts.map((a) => `- ${a.type}: ${a.path} (${a.size} bytes, sha256: ${a.sha256.slice(0, 16)}...)`).join("\n")
    : "(no release artifacts)";

  // Phase 6: Changed file group summary
  const groupLines = input.changedFileGroups
    ? [
        `- source_changes: ${input.changedFileGroups.source_changes.length}`,
        `- docs_changes: ${input.changedFileGroups.docs_changes.length}`,
        `- config_changes: ${input.changedFileGroups.config_changes.length}`,
        `- test_changes: ${input.changedFileGroups.test_changes.length}`,
        `- release_artifacts: ${input.changedFileGroups.release_artifacts.length}`,
        `- runtime_generated_files: ${input.changedFileGroups.runtime_generated_files.length}`,
      ].join("\n")
    : "";

  // Phase 7: Android diagnostic summary
  let androidSection = "";
  if (input.androidDiagnostic && input.androidDiagnostic.status !== "skip") {
    const checkLines = (input.androidDiagnostic.checks || [])
      .map((c) => `- [${c.status}] ${c.check}: ${c.reason}`)
      .join("\n");
    androidSection = [
      "## Android Build Environment",
      `Status: ${input.androidDiagnostic.status}`,
      ...(input.androidWarning ? [`Warning: ${input.androidWarning}`] : []),
      checkLines,
      "",
    ].join("\n");
  }

  // Phase 4: Pre-existing warnings
  const preexistingSection = input.preexistingWarnings && input.preexistingWarnings.length > 0
    ? ["## Pre-existing Warnings", ...input.preexistingWarnings, ""].join("\n")
    : "";

  return [
    "# PatchWarden Task Result",
    "",
    "## Status",
    input.status,
    "",
    "## Agent",
    input.agent,
    "",
    "## Plan",
    input.planId,
    "",
    "## Completed",
    new Date().toISOString(),
    "",
    "## Files changed",
    changed,
    "",
    "## Changed file groups",
    groupLines,
    "",
    "## Release artifacts",
    artifactLines,
    "",
    "## Verification",
    `- diff_available: ${input.changes.diff_available}`,
    `- diff_truncated: ${input.changes.diff_truncated}`,
    `- workspace_dirty_before: ${input.changes.workspace_dirty_before}`,
    `- workspace_dirty_after: ${input.changes.workspace_dirty_after}`,
    `- verify_status: ${input.verify.status}`,
    `- verify_commands: ${input.verify.commands.length}/${input.verify.requested_commands.length} executed`,
    `- out_of_scope_changes: ${input.outOfScopeChanges.length}`,
    `- artifact_status: ${input.artifactStatus || "collected"}`,
    "",
    "## Out-of-scope changes",
    outOfScope,
    "",
    preexistingSection,
    androidSection,
    "## Summary",
    input.error || "Agent execution and configured verification completed successfully.",
    "",
    "## Risks",
    input.status === "done_by_agent" || input.status === "done"
      ? "- Review git.diff and changed-files.json before accepting the task."
      : "- Task did not complete successfully; outputs may be partial.",
    "",
    "---",
    "",
    "## Agent stdout",
    "",
    "```",
    input.agentResult?.stdout || "(no output)",
    "```",
    "",
    "## Agent stderr",
    "",
    "```",
    input.agentResult?.stderr || "(empty)",
    "```",
  ].join("\n");
}

function skippedTest(command: string, cwd: string, reason: string): TestExecutionResult {
  const now = new Date().toISOString();
  return {
    command,
    cwd,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    skipped: true,
    exitCode: null,
    stdout: "",
    stderr: reason,
    spawnError: null,
    terminationReason: null,
  };
}

function buildVerifyJson(requested: string[], results: TestExecutionResult[], cwd: string): VerifyReport {
  const commands = results.map((result): VerifyCommandRecord => ({
    command: result.command,
    cwd: result.cwd || cwd,
    exit_code: result.exitCode,
    stdout_tail: summarizeOutput(result.stdout),
    stderr_tail: summarizeOutput(result.spawnError || result.stderr),
    started_at: result.started_at,
    finished_at: result.finished_at,
    duration_ms: result.duration_ms,
    status: result.terminationReason === "timeout"
      ? "timed_out"
      : result.terminationReason
        ? "canceled"
        : result.exitCode === 0 && !result.spawnError
          ? "passed"
          : "failed",
  }));
  const status: VerifyReport["status"] = requested.length === 0
    ? "skipped"
    : commands.length === requested.length && commands.every((command) => command.status === "passed")
      ? "passed"
      : "failed";
  return { status, requested_commands: requested, commands };
}

function buildVerifyLog(commands: VerifyCommandRecord[]): string {
  if (commands.length === 0) return "Verification skipped: no verify_commands configured.\n";
  return commands.map((entry) => [
    `$ ${entry.command}`,
    `cwd: ${entry.cwd}`,
    `status: ${entry.status}`,
    `exit_code: ${entry.exit_code}`,
    `started_at: ${entry.started_at}`,
    `finished_at: ${entry.finished_at}`,
    `duration_ms: ${entry.duration_ms}`,
    "stdout:",
    entry.stdout_tail || "(empty)",
    "stderr:",
    entry.stderr_tail || "(empty)",
  ].join("\n")).join("\n\n");
}

function normalizeVerifyCommands(
  value: unknown,
  legacyTestCommand: string,
  config: ReturnType<typeof getConfig>,
  repoPath: string
): string[] {
  if (value !== undefined && !Array.isArray(value)) {
    throw new Error("Invalid task verify_commands metadata; expected an array.");
  }
  return [...new Set([
    ...((value as unknown[] | undefined) || []).map((command) => guardTestCommand(String(command), config, repoPath)),
    ...(legacyTestCommand ? [guardTestCommand(legacyTestCommand, config, repoPath)] : []),
  ])];
}

function summarizeOutput(value: string): string {
  const trimmed = (value || "").trim();
  return trimmed.length <= 4000 ? trimmed : `${trimmed.slice(0, 4000)}\n...(truncated)`;
}

function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeTimeout(value: unknown, config: ReturnType<typeof getConfig>): number {
  const timeout = value == null ? config.defaultTaskTimeoutSeconds : Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > config.maxTaskTimeoutSeconds) {
    throw new Error(`Invalid task timeout. Expected 1-${config.maxTaskTimeoutSeconds} seconds.`);
  }
  return timeout;
}

function failBeforeExecution(taskId: string, taskDir: string, message: string, caughtError?: unknown): TaskRunResult {
  // Phase 9: Preserve PatchWardenError structured info in error.log
  const structuredError = caughtError ? errorPayload(caughtError) : { error: message };
  writeFileSync(join(taskDir, "error.log"), JSON.stringify({
    summary: message,
    ...structuredError,
  }, null, 2), "utf-8");
  const current = readStatus(join(taskDir, "status.json"));
  const now = new Date().toISOString();
  const verify: VerifyReport = {
    status: "failed",
    requested_commands: Array.isArray(current.verify_commands) ? current.verify_commands : [],
    commands: [],
  };
  writeFileSync(join(taskDir, "verify.json"), JSON.stringify(verify, null, 2), "utf-8");
  writeFileSync(join(taskDir, "verify.log"), `Verification did not run: ${message}\n`, "utf-8");
  writeFileSync(join(taskDir, "test.log"), `(not run)\nExit code: not run\n${message}\n`, "utf-8");
  writeFileSync(join(taskDir, "git.diff"), "(task failed before change capture)\n", "utf-8");
  writeFileSync(join(taskDir, "diff.patch"), "(task failed before change capture)\n", "utf-8");
  writeFileSync(join(taskDir, "file-stats.json"), JSON.stringify({
    task_id: taskId,
    additions: 0,
    deletions: 0,
    files: [],
  }, null, 2), "utf-8");
  const result = {
    task_id: taskId,
    status: "failed",
    agent: current.agent || "",
    workspace_root: current.workspace_root || "",
    repo_path: current.repo_path || "",
    resolved_repo_path: current.resolved_repo_path || "",
    summary: message,
    changed_files: [],
    out_of_scope_changes: [],
    verify_status: verify.status,
    verify_commands: verify.commands,
    commands_run: [],
    commands_observed: [],
    verify,
    artifacts: ["result.md", "result.json", "diff.patch", "git.diff", "test.log", "verify.log", "verify.json", "file-stats.json"],
    warnings: [],
    errors: [message],
    known_issues: [message],
    failure_reason: message,
    failed_command: null,
    suggested_next_action: "inspect_task_logs",
    safe_followup_prompt: "Inspect result.json and error.log, correct the task metadata or configuration, and retry without widening repository scope.",
    next_steps: ["Fix task metadata or configuration and retry the task."],
  };
  writeFileSync(join(taskDir, "result.json"), JSON.stringify(result, null, 2), "utf-8");
  writeFileSync(join(taskDir, "result.md"), `# PatchWarden Task Result\n\n## Status\nfailed\n\n## Summary\n${message}\n`, "utf-8");
  updateStatus(taskDir, {
    status: "failed",
    phase: "failed",
    error: message,
    finished_at: now,
    verify_status: "failed",
    changed_files: [],
    out_of_scope_changes: [],
  });
  writeTaskProgress(taskDir, "failed", { note: message });
  return { task_id: taskId, status: "failed", error: message };
}

function setTaskPhase(
  taskDir: string,
  phase: TaskPhase,
  currentCommand: string | null,
  note?: string
): void {
  const now = new Date().toISOString();
  updateStatus(taskDir, { phase, current_command: currentCommand, last_heartbeat_at: now });
  writeTaskRuntime(taskDir, {
    phase,
    current_command: currentCommand,
    last_heartbeat_at: now,
    runner_pid: process.pid,
  });
  writeTaskProgress(taskDir, phase, { currentCommand, heartbeatAt: now, note });
}

function updateStatus(taskDir: string, patch: Record<string, unknown>): void {
  const statusFile = join(taskDir, "status.json");
  const current = readStatus(statusFile);
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  writeFileSync(statusFile, JSON.stringify(next, null, 2), "utf-8");
}

function readStatus(statusFile: string): Record<string, any> {
  return JSON.parse(readFileSync(statusFile, "utf-8"));
}

function gracefulKill(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {}
}

function forceKill(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status !== 0) child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

function openStream(path?: string): WriteStream | null {
  return path ? createWriteStream(path, { flags: "a" }) : null;
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_CAPTURE_CHARS
    ? combined
    : combined.slice(combined.length - MAX_CAPTURE_CHARS);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
