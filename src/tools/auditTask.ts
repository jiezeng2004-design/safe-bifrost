import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { getTasksDir, getConfig } from "../config.js";
import { guardReadPath, guardWorkspacePath } from "../security/pathGuard.js";
import { guardSensitivePath } from "../security/sensitiveGuard.js";

interface AuditCheck {
  name: string;
  result: "pass" | "warn" | "fail";
  detail: string;
}

interface AuditRisk {
  severity: "low" | "medium" | "high";
  description: string;
}

export interface AuditTaskOutput {
  task_id: string;
  verdict: "pass" | "warn" | "fail";
  summary: string;
  checks: AuditCheck[];
  risks: AuditRisk[];
  confirmed_failures: AuditCheck[];
  possible_false_positives: Array<{
    check: string;
    reason: string;
  }>;
  manual_verification_required: boolean;
  manual_verification_items: string[];
  recommended_next_actions: string[];
}

// Release claim patterns — anything that claims remote publish/release/deploy
const RELEASE_PATTERNS = [
  /npm\s+package\s+version\s+published/i,
  /npm\s+(publish|published)/i,
  /npm\s+release/i,
  /github\s+release\s+created/i,
  /git\s+tag\s+(pushed|created)/i,
  /release\s+zip\s+uploaded/i,
  /npm\s+publish\s+completed/i,
  /deploy(ed|ment)?\s+(to|on)\s+(npm|registry|github)/i,
];

function scanForReleaseClaims(text: string): string[] {
  const found: string[] = [];
  for (const pattern of RELEASE_PATTERNS) {
    const match = text.match(pattern);
    if (match) found.push(match[0]);
  }
  return found;
}

function findMdFiles(dir: string, maxDepth = 3): string[] {
  const results: string[] = [];
  if (!existsSync(dir) || maxDepth <= 0) return results;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
        results.push(...findMdFiles(full, maxDepth - 1));
      } else if (e.isFile() && e.name.endsWith(".md")) {
        results.push(full);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

export function auditTask(taskId: string): AuditTaskOutput {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const taskDir = join(tasksDir, taskId);
  const statusFile = join(taskDir, "status.json");

  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);

  if (!existsSync(statusFile)) {
    throw new Error(`Task not found: "${taskId}"`);
  }

  const statusData = JSON.parse(readFileSync(statusFile, "utf-8"));
  const checks: AuditCheck[] = [];
  const risks: AuditRisk[] = [];
  const actions: string[] = [];
  const possibleFalsePositives: AuditTaskOutput["possible_false_positives"] = [];
  const manualVerificationItems: string[] = [];
  const addManualVerification = (item: string) => {
    if (!manualVerificationItems.includes(item)) manualVerificationItems.push(item);
  };
  const addPossibleFalsePositive = (check: string, reason: string) => {
    if (!possibleFalsePositives.some((item) => item.check === check && item.reason === reason)) {
      possibleFalsePositives.push({ check, reason });
    }
  };

  // ── 1. Task status ──
  const taskStatus = statusData.status || "unknown";
  const failedStatuses = new Set(["failed", "failed_verification", "failed_scope_violation", "failed_policy_violation", "canceled"]);
  checks.push({
    name: "task_status",
    result: taskStatus === "done" ? "pass" : failedStatuses.has(taskStatus) ? "fail" : "warn",
    detail: `Task status is "${taskStatus}".`,
  });
  if (taskStatus !== "done" && !failedStatuses.has(taskStatus)) {
    addManualVerification(`Task status is "${taskStatus}"; audit evidence may be incomplete until terminal state.`);
  }

  // ── 2. result.md ──
  const resultFile = join(taskDir, "result.md");
  const hasResult = existsSync(resultFile);
  checks.push({
    name: "result_md_exists",
    result: hasResult ? "pass" : "fail",
    detail: hasResult ? "result.md found." : "result.md is missing.",
  });
  if (!hasResult) risks.push({ severity: "high", description: "No result.md — cannot verify what agent did." });

  const resultJsonFile = join(taskDir, "result.json");
  checks.push({
    name: "result_json_exists",
    result: existsSync(resultJsonFile) ? "pass" : "fail",
    detail: existsSync(resultJsonFile) ? "result.json found." : "result.json is missing.",
  });

  const verifyJsonFile = join(taskDir, "verify.json");
  checks.push({
    name: "verify_json_exists",
    result: existsSync(verifyJsonFile) ? "pass" : "warn",
    detail: existsSync(verifyJsonFile) ? "verify.json found." : "verify.json is missing.",
  });
  if (!existsSync(verifyJsonFile)) {
    addManualVerification("verify.json is missing; determine whether independent verification was expected.");
  }
  if (existsSync(verifyJsonFile)) {
    try {
      const verify = JSON.parse(readFileSync(verifyJsonFile, "utf-8"));
      checks.push({
        name: "verify_status",
        result: verify.status === "passed" ? "pass" : verify.status === "failed" ? "fail" : "warn",
        detail: `Structured verification status is "${verify.status || "unknown"}".`,
      });
    } catch {
      checks.push({ name: "verify_status", result: "fail", detail: "verify.json is invalid JSON." });
    }
  }

  // Phase 4: Use new_out_of_scope_changes (task-caused) instead of out_of_scope_changes (all)
  // Pre-existing external dirty files that didn't change during the task should NOT fail audit.
  const newOutOfScope = Array.isArray(statusData.new_out_of_scope_changes)
    ? statusData.new_out_of_scope_changes
    : Array.isArray(statusData.out_of_scope_changes)
      ? statusData.out_of_scope_changes
      : [];
  checks.push({
    name: "scope_changes",
    result: newOutOfScope.length > 0 ? "fail" : "pass",
    detail: newOutOfScope.length > 0
      ? `${newOutOfScope.length} new out-of-scope change(s) detected during task execution.`
      : "No new out-of-scope changes recorded.",
  });

  const changedFilesFile = join(taskDir, "changed-files.json");
  if (existsSync(changedFilesFile)) {
    try {
      const changeEvidence = JSON.parse(readFileSync(changedFilesFile, "utf-8"));
      const hygiene = changeEvidence.artifact_hygiene;
      if (hygiene?.counts) {
        const trackedArtifacts = Number(hygiene.counts.tracked_build_artifacts || 0);
        const ignoredArtifacts = Number(hygiene.counts.ignored_untracked_artifacts || 0);
        const runtimeFiles = Number(hygiene.counts.runtime_generated_files || 0);
        const suspicious = Number(hygiene.counts.suspicious_changes || 0);
        checks.push({
          name: "artifact_hygiene",
          result: suspicious > 0 ? "warn" : "pass",
          detail: suspicious > 0
            ? `${suspicious} generated or artifact-like change(s) are tracked or not ignored and require review.`
            : `${ignoredArtifacts} ignored artifact change(s) and ${runtimeFiles} runtime-generated change(s) are classified separately from source risk.`,
        });
        if (trackedArtifacts > 0) {
          risks.push({ severity: "medium", description: `${trackedArtifacts} tracked build artifact change(s) require intentional source-control review.` });
          addPossibleFalsePositive("artifact_hygiene", "Tracked build outputs may be intentional release assets rather than accidental source changes.");
        }
        if (suspicious > 0) {
          actions.push("Review artifact_hygiene.suspicious_changes before accepting the task; add generated paths to Git ignore rules when appropriate.");
          addPossibleFalsePositive("artifact_hygiene", "Artifact-like path classification is heuristic and may include intentionally maintained files.");
          addManualVerification("Review artifact_hygiene.suspicious_changes and decide whether each path is intentional.");
        }
      } else {
        checks.push({ name: "artifact_hygiene", result: "warn", detail: "Change evidence uses the legacy format without artifact classification." });
        addManualVerification("Legacy changed-files evidence has no artifact classification; inspect changed paths manually.");
      }
    } catch {
      checks.push({ name: "artifact_hygiene", result: "warn", detail: "changed-files.json could not be parsed for artifact classification." });
      addManualVerification("changed-files.json could not be parsed; inspect repository changes directly.");
    }
  }

  // ── 3. test.log ──
  const testLogFile = join(taskDir, "test.log");
  const hasTestLog = existsSync(testLogFile);
  checks.push({
    name: "test_log_exists",
    result: hasTestLog ? "pass" : "warn",
    detail: hasTestLog ? "test.log found." : "test.log is missing.",
  });
  if (!hasTestLog) addManualVerification("test.log is missing; confirm whether the task required an agent-side test run.");

  // ── 4. git.diff ──
  const diffFile = join(taskDir, "git.diff");
  checks.push({
    name: "git_diff_exists",
    result: existsSync(diffFile) ? "pass" : "warn",
    detail: existsSync(diffFile) ? "git.diff found." : "git.diff is missing.",
  });
  if (!existsSync(diffFile)) addManualVerification("git.diff is missing; inspect repository state before accepting code changes.");

  // ── 5. repo_path consistency — use resolved_repo_path, NOT resolve() ──
  let repoPathSafe = "";
  let repoConsistent = false;
  try {
    // Prefer the pre-resolved absolute path from task metadata
    const resolvedRepoPath = statusData.resolved_repo_path;
    if (resolvedRepoPath && typeof resolvedRepoPath === "string") {
      repoPathSafe = guardWorkspacePath(resolvedRepoPath, config.workspaceRoot);
    } else if (statusData.repo_path) {
      repoPathSafe = guardWorkspacePath(statusData.repo_path, config.workspaceRoot);
    } else {
      repoPathSafe = resolve(config.workspaceRoot);
    }
    repoConsistent = true;
  } catch {
    repoConsistent = false;
    repoPathSafe = statusData.resolved_repo_path || statusData.repo_path || config.workspaceRoot;
  }
  checks.push({
    name: "repo_path_consistency",
    result: repoConsistent ? "pass" : "fail",
    detail: repoConsistent
      ? `repo_path "${statusData.repo_path || "."}" resolves within workspace.`
      : `repo_path "${statusData.repo_path}" is outside workspace.`,
  });
  if (!repoConsistent) risks.push({ severity: "high", description: "repo_path inconsistent with workspace." });

  // ── 6. package.json scripts ──
  const pkgJsonPath = join(repoPathSafe, "package.json");
  let pkgScripts: string[] = [];
  if (existsSync(pkgJsonPath)) {
    try {
      guardSensitivePath(pkgJsonPath);
      const pkgData = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      pkgScripts = Object.keys(pkgData.scripts || {});
      checks.push({
        name: "package_json_scripts",
        result: "pass",
        detail: `package.json found with ${pkgScripts.length} scripts: ${pkgScripts.join(", ") || "(none)"}.`,
      });
    } catch {
      checks.push({ name: "package_json_scripts", result: "warn", detail: "package.json exists but could not be read (may be sensitive)." });
      addManualVerification("package.json could not be read, so documented commands were not fully cross-checked.");
    }
  }

  // ── 7. Scan all docs (result.md, README.md, docs/**/*.md) ──
  const docsToScan: string[] = [];
  if (hasResult) docsToScan.push(resultFile);
  const readmePath = join(repoPathSafe, "README.md");
  if (existsSync(readmePath)) docsToScan.push(readmePath);
  const docsDir = join(repoPathSafe, "docs");
  if (existsSync(docsDir)) {
    docsToScan.push(...findMdFiles(docsDir));
  }

  // Collect all npm run references from all docs
  const allNpmRunRefs = new Set<string>();
  const allReleaseClaims: string[] = [];

  for (const docPath of docsToScan) {
    let content: string;
    try {
      if (docPath !== resultFile) {
        guardReadPath(docPath, config.workspaceRoot);
        guardSensitivePath(docPath);
      }
      content = readFileSync(docPath, "utf-8");
    } catch {
      continue;
    }

    // Extract npm run xxx
    const refs = content.match(/npm(?:\.cmd)?\s+run\s+([a-zA-Z0-9:_-]+)/gi) || [];
    for (const ref of refs) {
      const scriptName = ref.replace(/npm\s+run\s+/i, "").replace(/[^a-zA-Z0-9:_-]/g, "");
      if (scriptName) allNpmRunRefs.add(scriptName);
    }

    // Check release claims
    const claims = scanForReleaseClaims(content);
    for (const c of claims) allReleaseClaims.push(`[${relative(repoPathSafe, docPath) || docPath}] ${c}`);
  }

  // Cross-check npm run refs against package.json scripts
  for (const scriptName of allNpmRunRefs) {
    if (pkgScripts.length > 0 && !pkgScripts.includes(scriptName)) {
      checks.push({
        name: `npm_script_${scriptName}`,
        result: "warn",
        detail: `Docs mention "npm run ${scriptName}" but this script is missing from package.json.`,
      });
      risks.push({
        severity: "medium",
        description: `Command "npm run ${scriptName}" referenced in docs but not found in package.json scripts.`,
      });
      actions.push(`Verify whether "npm run ${scriptName}" should exist or if the agent fabricated it.`);
      addPossibleFalsePositive(
        `npm_script_${scriptName}`,
        "Documentation may describe another package, historical version, or example command rather than the current package.json."
      );
      addManualVerification(`Check whether documented command "npm run ${scriptName}" belongs to another package or should be added here.`);
    }
  }
  if (allNpmRunRefs.size > 0 && pkgScripts.length > 0) {
    const missing = [...allNpmRunRefs].filter(s => !pkgScripts.includes(s));
    if (missing.length === 0) {
      checks.push({
        name: "npm_scripts_crosscheck",
        result: "pass",
        detail: `All ${allNpmRunRefs.size} npm run references in docs exist in package.json.`,
      });
    }
  }

  // ── 8. Release claims always flagged as unverified ──
  if (allReleaseClaims.length > 0) {
    checks.push({
      name: "release_claims_unverified",
      result: "warn",
      detail: `Found ${allReleaseClaims.length} remote publish/release claim(s): ${allReleaseClaims.slice(0, 3).join("; ")}${allReleaseClaims.length > 3 ? "..." : ""}. These are UNVERIFIED.`,
    });
    risks.push({
      severity: "high",
      description: `${allReleaseClaims.length} remote publish/release/deploy claim(s) found in docs. PatchWarden cannot independently verify npm/GitHub actions. Manual confirmation required.`,
    });
    actions.push("Manually verify all npm publish / GitHub release / git tag claims before accepting the task as complete.");
    addManualVerification("Verify remote npm, GitHub Release, and Git tag claims against authoritative remote services.");
  }

  // ── 9. test.log Exit code check ──
  if (hasTestLog) {
    const testLogContent = readFileSync(testLogFile, "utf-8");

    // Check test_command visibility
    if (statusData.test_command && testLogContent.includes(statusData.test_command)) {
      checks.push({ name: "test_command_in_log", result: "pass", detail: "test.log contains the configured test command." });
    } else if (statusData.test_command) {
      checks.push({ name: "test_command_in_log", result: "warn", detail: `test.log does not clearly show "${statusData.test_command}".` });
      addManualVerification("Confirm that test.log belongs to the configured test command.");
    }

    // Extract Exit code
    const exitMatch = testLogContent.match(/Exit\s*code:\s*(\d+)/i);
    if (exitMatch) {
      const exitCode = parseInt(exitMatch[1]);
      if (exitCode === 0) {
        checks.push({ name: "test_exit_code", result: "pass", detail: "Test exit code is 0." });
      } else {
        checks.push({ name: "test_exit_code", result: "fail", detail: `Test exit code is ${exitCode} (non-zero).` });
        risks.push({ severity: "high", description: `Tests failed with exit code ${exitCode}.` });
        actions.push("Review test.log failures and fix before accepting this task.");
      }
    } else if (statusData.test_command) {
      checks.push({ name: "test_exit_code", result: "warn", detail: "test.log does not contain 'Exit code:' line — cannot verify test result." });
      risks.push({ severity: "medium", description: "Test command was configured but test.log has no exit code." });
      addManualVerification("The configured test command has no recorded exit code; rerun or inspect verification evidence.");
    }
  }

  // ── 10. Summarize ──
  const failCount = checks.filter((c) => c.result === "fail").length;
  const warnCount = checks.filter((c) => c.result === "warn").length;
  const passCount = checks.filter((c) => c.result === "pass").length;
  const verdict: AuditTaskOutput["verdict"] = failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";
  const confirmedFailures = checks.filter((check) => check.result === "fail");

  let summary = `Audit complete: ${passCount} pass, ${warnCount} warn, ${failCount} fail across ${checks.length} checks. `;
  summary += risks.length > 0 ? `${risks.length} risk(s) identified. ` : "No risks identified. ";
  summary += `${confirmedFailures.length} confirmed failure(s), ${possibleFalsePositives.length} possible false-positive warning(s), and ${manualVerificationItems.length} manual verification item(s).`;

  if (actions.length === 0) {
    actions.push("No specific actions recommended.");
  }

  // Write independent-review.md
  const reviewMd = [
    "# Independent Review",
    "",
    `**Task**: ${taskId}`,
    `**Verdict**: ${verdict.toUpperCase()}`,
    "",
    "## Summary",
    summary,
    "",
    "## Checks",
    ...checks.map((c) => `- [${c.result === "pass" ? "x" : " "}] **${c.name}**: ${c.detail}`),
    "",
    "## Risks",
    ...risks.map((r) => `- [${r.severity}] ${r.description}`),
    "",
    "## Confirmed Failures",
    ...(confirmedFailures.length > 0
      ? confirmedFailures.map((check) => `- **${check.name}**: ${check.detail}`)
      : ["- None."]),
    "",
    "## Possible False Positives",
    ...(possibleFalsePositives.length > 0
      ? possibleFalsePositives.map((item) => `- **${item.check}**: ${item.reason}`)
      : ["- None identified."]),
    "",
    "## Manual Verification Required",
    ...(manualVerificationItems.length > 0
      ? manualVerificationItems.map((item) => `- ${item}`)
      : ["- No additional manual verification identified by this audit."]),
    "",
    "## Recommended Actions",
    ...actions.map((a) => `- ${a}`),
  ].join("\n");

  writeFileSync(join(taskDir, "independent-review.md"), reviewMd, "utf-8");

  return {
    task_id: taskId,
    verdict,
    summary,
    checks,
    risks,
    confirmed_failures: confirmedFailures,
    possible_false_positives: possibleFalsePositives,
    manual_verification_required: manualVerificationItems.length > 0,
    manual_verification_items: manualVerificationItems,
    recommended_next_actions: actions,
  };
}
