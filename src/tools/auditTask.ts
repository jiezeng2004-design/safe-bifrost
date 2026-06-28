// @ts-nocheck

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
  acceptance: {
    verdict: string;
    status: string;
    reason: string;
    reasons: string[];
    required_evidence: string[];
    next_suggested_task: string;
    fail_checks: AuditCheck[];
    warn_checks: AuditCheck[];
  };
  summary: string;
  checks: AuditCheck[];
  risks: AuditRisk[];
  confirmed_failures: AuditCheck[];
  possible_false_positives: Array<{ check: string; reason: string }>;
  manual_verification_required: boolean;
  manual_verification_items: string[];
  recommended_next_actions: string[];
}
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, basename, sep, isAbsolute } from "node:path";
import { getTasksDir, getConfig } from "../config.js";
import { guardReadPath, guardWorkspacePath } from "../security/pathGuard.js";
import { guardSensitivePath, isSensitivePath } from "../security/sensitiveGuard.js";
import { evaluateAcceptance } from "../goal/acceptanceEngine.js";
import { renderAcceptanceMarkdown } from "../goal/acceptanceTemplate.js";
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
function scanForReleaseClaims(text) {
    const found = [];
    for (const pattern of RELEASE_PATTERNS) {
        const match = text.match(pattern);
        if (match)
            found.push(match[0]);
    }
    return found;
}
function findMdFiles(dir, maxDepth = 3) {
    const results = [];
    if (!existsSync(dir) || maxDepth <= 0)
        return results;
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = join(dir, e.name);
            if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
                results.push(...findMdFiles(full, maxDepth - 1));
            }
            else if (e.isFile() && e.name.endsWith(".md")) {
                results.push(full);
            }
        }
    }
    catch { /* skip unreadable dirs */ }
    return results;
}
// ── v0.7.2: New audit checks (exported for testing) ────────────────
/**
 * Convert a glob pattern (supporting `**` and `*`) into a RegExp.
 * `**` matches any number of path segments (including zero);
 * `*` matches a single path segment (no `/`).
 * Path separators in the pattern are expected to be `/`.
 */
function globToRegExp(pattern) {
    // Normalize backslashes to forward slashes for matching consistency.
    const normalized = pattern.replace(/\\/g, "/");
    let re = "^";
    for (let i = 0; i < normalized.length; i++) {
        const ch = normalized[i];
        if (ch === "*") {
            if (normalized[i + 1] === "*") {
                // Consume the second '*' (and an optional following '/')
                i++;
                if (normalized[i + 1] === "/") {
                    i++;
                    // `**/` matches zero or more leading segments, or nothing.
                    re += "(?:.*/)?";
                }
                else {
                    // `**` at end or without trailing slash — match anything.
                    re += ".*";
                }
            }
            else {
                // Single `*` matches one segment (no `/`).
                re += "[^/]*";
            }
        }
        else if ("/.+^$(){}|[]\\".includes(ch)) {
            re += "\\" + ch;
        }
        else {
            re += ch;
        }
    }
    re += "$";
    return new RegExp(re);
}
/**
 * Check 1: forbidden_scope_violation (fail level).
 * Returns null when no forbidden patterns are configured (skip).
 * Returns pass when changed files do not match any forbidden pattern.
 * Returns fail when any changed file path (or old_path) matches a forbidden glob.
 */
export function checkForbiddenScope(changedFiles, forbidden) {
    if (!forbidden || forbidden.length === 0)
        return null;
    if (changedFiles.length === 0) {
        return { name: "forbidden_scope_violation", result: "pass", detail: "No forbidden path violations." };
    }
    const patterns = forbidden.map((p) => globToRegExp(p));
    const hits = [];
    for (const file of changedFiles) {
        const candidates = [file.path];
        if (file.old_path)
            candidates.push(file.old_path);
        for (const candidate of candidates) {
            const normalized = candidate.replace(/\\/g, "/");
            if (patterns.some((re) => re.test(normalized))) {
                hits.push(normalized);
            }
        }
    }
    if (hits.length > 0) {
        return {
            name: "forbidden_scope_violation",
            result: "fail",
            detail: `Changed files hit forbidden paths: ${[...new Set(hits)].join(", ")}`,
        };
    }
    return { name: "forbidden_scope_violation", result: "pass", detail: "No forbidden path violations." };
}
/**
 * Check 2: done_evidence_missing (warn level).
 * Returns null when no done_evidence list is configured (skip).
 * Returns pass when all listed files exist in the task directory.
 * Returns warn when any listed file is missing.
 */
export function checkDoneEvidenceMissing(taskDir, doneEvidence) {
    if (!doneEvidence || doneEvidence.length === 0)
        return null;
    const missing = [];
    for (const filename of doneEvidence) {
        if (!existsSync(join(taskDir, filename))) {
            missing.push(filename);
        }
    }
    if (missing.length > 0) {
        return {
            name: "done_evidence_missing",
            result: "warn",
            detail: `Missing: ${missing.join(", ")}`,
        };
    }
    return { name: "done_evidence_missing", result: "pass", detail: "All done_evidence files present." };
}
const CODE_EXTENSIONS = new Set([
    ".ts", ".js", ".jsx", ".tsx", ".py", ".go", ".java", ".rs",
    ".c", ".cpp", ".cs", ".rb", ".php", ".swift", ".kt", ".scala",
]);
/**
 * Check 3: readme_changelog_sync (warn level).
 * Returns null when no code files (by extension) were changed (skip).
 * Returns pass when README.md or CHANGELOG.md (basename, case-insensitive) is also changed.
 * Returns warn when code changed but neither documentation file was updated.
 */
export function checkReadmeChangelogSync(changedFiles) {
    const paths = changedFiles.map((f) => f.path);
    const hasCodeChange = paths.some((p) => {
        const lower = p.toLowerCase();
        const dot = lower.lastIndexOf(".");
        if (dot === -1)
            return false;
        return CODE_EXTENSIONS.has(lower.slice(dot));
    });
    if (!hasCodeChange)
        return null;
    const docsUpdated = paths.some((p) => {
        const name = basename(p).toLowerCase();
        return name === "readme.md" || name === "changelog.md";
    });
    if (docsUpdated) {
        return {
            name: "readme_changelog_sync",
            result: "pass",
            detail: "README.md or CHANGELOG.md updated with code changes.",
        };
    }
    return {
        name: "readme_changelog_sync",
        result: "warn",
        detail: "Code changes detected but README.md/CHANGELOG.md not updated.",
    };
}
/**
 * Check 4: package_manifest_consistency (warn level).
 * Returns null when package.json is not among changed files (skip).
 * Returns pass when package.json parses as JSON and has non-empty name and version strings.
 * Returns warn otherwise.
 */
export function checkPackageManifestConsistency(changedFiles, repoPathSafe) {
    const includesPackageJson = changedFiles.some((f) => basename(f.path).toLowerCase() === "package.json");
    if (!includesPackageJson)
        return null;
    try {
        const pkgPath = join(repoPathSafe, "package.json");
        const raw = readFileSync(pkgPath, "utf-8");
        const parsed = JSON.parse(raw);
        const hasName = typeof parsed.name === "string" && parsed.name.length > 0;
        const hasVersion = typeof parsed.version === "string" && parsed.version.length > 0;
        if (hasName && hasVersion) {
            return {
                name: "package_manifest_consistency",
                result: "pass",
                detail: "package.json manifest fields are valid.",
            };
        }
    }
    catch {
        // fall through to warn
    }
    return {
        name: "package_manifest_consistency",
        result: "warn",
        detail: "package.json could not be parsed or missing name/version.",
    };
}
/**
 * Check 5: sensitive_path_access (fail level).
 * Returns null when there are no changed files (skip).
 * Returns pass when no changed file path (or old_path) is sensitive.
 * Returns fail when any changed file path is flagged by isSensitivePath.
 */
export function checkSensitivePathAccess(changedFiles) {
    if (changedFiles.length === 0)
        return null;
    const hits = [];
    for (const file of changedFiles) {
        const candidates = [file.path];
        if (file.old_path)
            candidates.push(file.old_path);
        for (const candidate of candidates) {
            if (isSensitivePath(candidate)) {
                hits.push(candidate);
            }
        }
    }
    if (hits.length > 0) {
        return {
            name: "sensitive_path_access",
            result: "fail",
            detail: `Sensitive paths accessed: ${[...new Set(hits)].join(", ")}`,
        };
    }
    return { name: "sensitive_path_access", result: "pass", detail: "No sensitive path access detected." };
}
const HIGH_RISK_COMMAND_PATTERNS = [
    /\bnpm(?:\.cmd)?\s+publish\b/i,
    /\bgit\s+push\b/i,
    /\bcurl\s+https?:\/\//i,
    /\bInvoke-WebRequest\b/i,
    /\bRemove-Item\b[\s\S]{0,80}\b-Recurse\b/i,
    /\brm\s+-rf\b/i,
];
function extractCommands(text) {
    const found = [];
    const runRe = /npm(?:\.cmd)?\s+run\s+([a-zA-Z0-9:_-]+)/gi;
    let m;
    while ((m = runRe.exec(text)) !== null) found.push({ type: "npm-run", name: m[1] });
    const bareRe = /npm(?:\.cmd)?\s+(?!run\b)([a-zA-Z]+)/gi;
    while ((m = bareRe.exec(text)) !== null) found.push({ type: "npm-bare", name: m[1] });
    const nodeRe = /node\s+([a-zA-Z0-9_./\\-]+)/gi;
    while ((m = nodeRe.exec(text)) !== null) found.push({ type: "node", name: normalizeCommandName(m[1]) });
    const npxRe = /npx\s+([a-zA-Z0-9_./\\@-]+)/gi;
    while ((m = npxRe.exec(text)) !== null) found.push({ type: "npx", name: normalizeCommandName(m[1]) });
    const pythonRe = /python(?:3|\.exe)?\s+([a-zA-Z0-9_./\\-]+)/gi;
    while ((m = pythonRe.exec(text)) !== null) found.push({ type: "python", name: normalizeCommandName(m[1]) });
    return found;
}
function normalizeCommandName(value) {
    return value.replace(/\\/g, "/").replace(/^\.\//, "");
}
function commandKey(command) {
    return command.name;
}
function readPackageScripts(repoPath) {
    if (!repoPath) return {};
    const pkgJsonPath = join(repoPath, "package.json");
    if (!existsSync(pkgJsonPath)) return {};
    try {
        guardSensitivePath(pkgJsonPath);
        const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
        if (!parsed.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) return {};
        return Object.fromEntries(Object.entries(parsed.scripts).filter(([, value]) => typeof value === "string"));
    }
    catch {
        return {};
    }
}
function buildCommandWhitelist(verifyCommands, testCommand, repoPath) {
    const scripts = readPackageScripts(repoPath);
    const allowed = new Set();
    const transitive = new Set();
    const queue = [];
    const sources = [...verifyCommands];
    if (testCommand) sources.push(testCommand);
    for (const src of sources) {
        for (const command of extractCommands(src)) {
            allowed.add(commandKey(command));
            queue.push({ command, depth: 0 });
        }
    }
    let inspectedFiles = 0;
    const seen = new Set();
    while (queue.length > 0) {
        const { command, depth } = queue.shift();
        if (depth > 4) continue;
        const key = `${command.type}:${command.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const scriptName = command.type === "npm-run" || command.type === "npm-bare" ? command.name : null;
        if (scriptName && scripts[scriptName]) {
            for (const nested of extractCommands(scripts[scriptName])) {
                transitive.add(commandKey(nested));
                allowed.add(commandKey(nested));
                queue.push({ command: nested, depth: depth + 1 });
            }
        }
        if ((command.type === "node" || command.type === "python") && repoPath && inspectedFiles < 20) {
            const nestedText = readLocalScript(repoPath, command.name);
            if (nestedText) {
                inspectedFiles++;
                for (const nested of extractCommands(nestedText)) {
                    transitive.add(commandKey(nested));
                    allowed.add(commandKey(nested));
                    queue.push({ command: nested, depth: depth + 1 });
                }
            }
        }
    }
    return { allowed, transitive };
}
function readLocalScript(repoPath, scriptPath) {
    const resolvedRepo = resolve(repoPath);
    const resolvedScript = resolve(resolvedRepo, scriptPath);
    const rel = relative(resolvedRepo, resolvedScript);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "" || isAbsolute(rel)) return null;
    if (!existsSync(resolvedScript)) return null;
    try {
        const stat = statSync(resolvedScript);
        if (!stat.isFile() || stat.size > 200000) return null;
        return readFileSync(resolvedScript, "utf-8");
    }
    catch {
        return null;
    }
}
function findHighRiskCommandEvidence(text) {
    const found = [];
    for (const pattern of HIGH_RISK_COMMAND_PATTERNS) {
        const match = text.match(pattern);
        if (match) found.push(match[0]);
    }
    return [...new Set(found)];
}
export function checkUnrecordedCommandExecution(testLogContent: string | null, resultMdContent: string | null, verifyCommands: string[], testCommand: string | null, repoPath: string | null = null) {
    const hasLog = testLogContent && testLogContent.length > 0;
    const hasResult = resultMdContent && resultMdContent.length > 0;
    if (!hasLog && !hasResult) return null;
    const combined = `${testLogContent || ""}\n${resultMdContent || ""}`;
    const highRisk = findHighRiskCommandEvidence(combined);
    if (highRisk.length > 0) {
        return { name: "unrecorded_command_execution", result: "fail", detail: `High-risk command evidence: ${highRisk.join(", ")}` };
    }
    const whitelist = buildCommandWhitelist(verifyCommands, testCommand, repoPath);
    const discovered = [];
    if (hasLog) discovered.push(...extractCommands(testLogContent));
    if (hasResult) discovered.push(...extractCommands(resultMdContent));
    const unrecorded = new Set();
    for (const cmd of discovered) {
        if (!whitelist.allowed.has(commandKey(cmd))) unrecorded.add(commandKey(cmd));
    }
    if (unrecorded.size > 0) {
        return { name: "unrecorded_command_execution", result: "warn", detail: `Unrecorded commands: ${[...unrecorded].join(", ")}` };
    }
    const transitive = [...whitelist.transitive].filter((command) => discovered.some((entry) => commandKey(entry) === command));
    return {
        name: "unrecorded_command_execution",
        result: "pass",
        detail: transitive.length > 0 ? `All commands are whitelisted; transitive_verified_command: ${transitive.join(", ")}` : "All commands in whitelist.",
    };
}
export function auditTask(taskId) {
    const config = getConfig();
    const tasksDir = getTasksDir(config);
    const taskDir = join(tasksDir, taskId);
    const statusFile = join(taskDir, "status.json");
    guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);
    if (!existsSync(statusFile)) {
        throw new Error(`Task not found: "${taskId}"`);
    }
    const statusData = JSON.parse(readFileSync(statusFile, "utf-8"));
    const checks = [];
    const risks = [];
    const actions = [];
    const possibleFalsePositives = [];
    const manualVerificationItems = [];
    const addManualVerification = (item) => {
        if (!manualVerificationItems.includes(item))
            manualVerificationItems.push(item);
    };
    const addPossibleFalsePositive = (check, reason) => {
        if (!possibleFalsePositives.some((item) => item.check === check && item.reason === reason)) {
            possibleFalsePositives.push({ check, reason });
        }
    };
    // ── 1. Task status ──
    const taskStatus = statusData.status || "unknown";
    const failedStatuses = new Set(["failed", "failed_verification", "failed_scope_violation", "failed_policy_violation", "canceled"]);
    const doneStatuses = new Set(["done", "done_by_agent"]);
    checks.push({
        name: "task_status",
        result: doneStatuses.has(taskStatus) ? "pass" : failedStatuses.has(taskStatus) ? "fail" : "warn",
        detail: `Task status is "${taskStatus}".`,
    });
    if (!doneStatuses.has(taskStatus) && !failedStatuses.has(taskStatus)) {
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
    if (!hasResult)
        risks.push({ severity: "high", description: "No result.md — cannot verify what agent did." });
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
        }
        catch {
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
    // Extract changed_files from change evidence (used by several v0.7.2 checks).
    let changedFiles = [];
    const changedFilesFile = join(taskDir, "changed-files.json");
    if (existsSync(changedFilesFile)) {
        try {
            const changeEvidence = JSON.parse(readFileSync(changedFilesFile, "utf-8"));
            if (Array.isArray(changeEvidence.changed_files)) {
                changedFiles = changeEvidence.changed_files;
            }
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
            }
            else {
                checks.push({ name: "artifact_hygiene", result: "warn", detail: "Change evidence uses the legacy format without artifact classification." });
                addManualVerification("Legacy changed-files evidence has no artifact classification; inspect changed paths manually.");
            }
        }
        catch {
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
    if (!hasTestLog)
        addManualVerification("test.log is missing; confirm whether the task required an agent-side test run.");
    // ── 4. git.diff ──
    const diffFile = join(taskDir, "git.diff");
    checks.push({
        name: "git_diff_exists",
        result: existsSync(diffFile) ? "pass" : "warn",
        detail: existsSync(diffFile) ? "git.diff found." : "git.diff is missing.",
    });
    if (!existsSync(diffFile))
        addManualVerification("git.diff is missing; inspect repository state before accepting code changes.");
    // ── 5. repo_path consistency — use resolved_repo_path, NOT resolve() ──
    let repoPathSafe = "";
    let repoConsistent = false;
    try {
        // Prefer the pre-resolved absolute path from task metadata
        const resolvedRepoPath = statusData.resolved_repo_path;
        if (resolvedRepoPath && typeof resolvedRepoPath === "string") {
            repoPathSafe = guardWorkspacePath(resolvedRepoPath, config.workspaceRoot);
        }
        else if (statusData.repo_path) {
            repoPathSafe = guardWorkspacePath(statusData.repo_path, config.workspaceRoot);
        }
        else {
            repoPathSafe = resolve(config.workspaceRoot);
        }
        repoConsistent = true;
    }
    catch {
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
    if (!repoConsistent)
        risks.push({ severity: "high", description: "repo_path inconsistent with workspace." });
    // ── 6. package.json scripts ──
    const pkgJsonPath = join(repoPathSafe, "package.json");
    let pkgScripts = [];
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
        }
        catch {
            checks.push({ name: "package_json_scripts", result: "warn", detail: "package.json exists but could not be read (may be sensitive)." });
            addManualVerification("package.json could not be read, so documented commands were not fully cross-checked.");
        }
    }
    // ── 7. Scan all docs (result.md, README.md, docs/**/*.md) ──
    const docsToScan = [];
    if (hasResult)
        docsToScan.push(resultFile);
    const readmePath = join(repoPathSafe, "README.md");
    if (existsSync(readmePath))
        docsToScan.push(readmePath);
    const docsDir = join(repoPathSafe, "docs");
    if (existsSync(docsDir)) {
        docsToScan.push(...findMdFiles(docsDir));
    }
    // Collect all npm run references from all docs
    const allNpmRunRefs = new Set();
    const allReleaseClaims = [];
    for (const docPath of docsToScan) {
        let content;
        try {
            if (docPath !== resultFile) {
                guardReadPath(docPath, config.workspaceRoot);
                guardSensitivePath(docPath);
            }
            content = readFileSync(docPath, "utf-8");
        }
        catch {
            continue;
        }
        // Extract npm run xxx
        const refs = content.match(/npm(?:\.cmd)?\s+run\s+([a-zA-Z0-9:_-]+)/gi) || [];
        for (const ref of refs) {
            const scriptName = ref.replace(/npm\s+run\s+/i, "").replace(/[^a-zA-Z0-9:_-]/g, "");
            if (scriptName)
                allNpmRunRefs.add(scriptName);
        }
        // Check release claims
        const claims = scanForReleaseClaims(content);
        for (const c of claims)
            allReleaseClaims.push(`[${relative(repoPathSafe, docPath) || docPath}] ${c}`);
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
            addPossibleFalsePositive(`npm_script_${scriptName}`, "Documentation may describe another package, historical version, or example command rather than the current package.json.");
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
    let testLogContent = null;
    if (hasTestLog) {
        let logContent;
        try {
            logContent = readFileSync(testLogFile, "utf-8");
        }
        catch {
            logContent = "";
        }
        testLogContent = logContent;
        // Check test_command visibility
        if (statusData.test_command && logContent.includes(statusData.test_command)) {
            checks.push({ name: "test_command_in_log", result: "pass", detail: "test.log contains the configured test command." });
        }
        else if (statusData.test_command) {
            checks.push({ name: "test_command_in_log", result: "warn", detail: `test.log does not clearly show "${statusData.test_command}".` });
            addManualVerification("Confirm that test.log belongs to the configured test command.");
        }
        // Extract Exit code
        const exitMatch = logContent.match(/Exit\s*code:\s*(\d+)/i);
        if (exitMatch) {
            const exitCode = parseInt(exitMatch[1]);
            if (exitCode === 0) {
                checks.push({ name: "test_exit_code", result: "pass", detail: "Test exit code is 0." });
            }
            else {
                checks.push({ name: "test_exit_code", result: "fail", detail: `Test exit code is ${exitCode} (non-zero).` });
                risks.push({ severity: "high", description: `Tests failed with exit code ${exitCode}.` });
                actions.push("Review test.log failures and fix before accepting this task.");
            }
        }
        else if (statusData.test_command) {
            checks.push({ name: "test_exit_code", result: "warn", detail: "test.log does not contain 'Exit code:' line — cannot verify test result." });
            risks.push({ severity: "medium", description: "Test command was configured but test.log has no exit code." });
            addManualVerification("The configured test command has no recorded exit code; rerun or inspect verification evidence.");
        }
    }
    // ── v0.7.2: New audit checks ──
    // Read result.md content (guarded) for the unrecorded_command_execution check.
    let resultMdContent = null;
    if (hasResult) {
        try {
            resultMdContent = readFileSync(resultFile, "utf-8");
        }
        catch {
            resultMdContent = null;
        }
    }
    const verifyCommands = Array.isArray(statusData.verify_commands) ? statusData.verify_commands : [];
    const testCommand = typeof statusData.test_command === "string" ? statusData.test_command : null;
    const forbidden = Array.isArray(statusData.forbidden) ? statusData.forbidden : null;
    const doneEvidence = Array.isArray(statusData.done_evidence) ? statusData.done_evidence : null;
    const newChecks = [
        checkForbiddenScope(changedFiles, forbidden),
        checkDoneEvidenceMissing(taskDir, doneEvidence),
        checkReadmeChangelogSync(changedFiles),
        checkPackageManifestConsistency(changedFiles, repoPathSafe),
        checkSensitivePathAccess(changedFiles),
        checkUnrecordedCommandExecution(testLogContent, resultMdContent, verifyCommands, testCommand, repoPathSafe),
    ];
    for (const check of newChecks) {
        if (check)
            checks.push(check);
    }
    // ── 10. Summarize ──
    const failCount = checks.filter((c) => c.result === "fail").length;
    const warnCount = checks.filter((c) => c.result === "warn").length;
    const passCount = checks.filter((c) => c.result === "pass").length;
    const verdict = failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";
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
    // ── v0.7.2: 集成 acceptanceEngine ──
    const releaseClaimsUnverified = allReleaseClaims.length > 0;
    const acceptanceEvidence = {
        task_id: taskId,
        task_status: taskStatus,
        result_md_exists: hasResult,
        result_json_exists: existsSync(resultJsonFile),
        verify_json_exists: existsSync(verifyJsonFile),
        test_log_exists: hasTestLog,
        git_diff_exists: existsSync(join(taskDir, "git.diff")),
        verify_status: (() => {
            if (!existsSync(verifyJsonFile))
                return null;
            try {
                const v = JSON.parse(readFileSync(verifyJsonFile, "utf-8"));
                return v.status === "passed" ? "passed" : v.status === "failed" ? "failed" : "skipped";
            }
            catch {
                return null;
            }
        })(),
        new_out_of_scope_changes: newOutOfScope,
        goal: statusData.goal ?? null,
        scope: Array.isArray(statusData.scope) ? statusData.scope : null,
        forbidden: Array.isArray(statusData.forbidden) ? statusData.forbidden : null,
        verification: Array.isArray(statusData.verification) ? statusData.verification : null,
        done_evidence: Array.isArray(statusData.done_evidence) ? statusData.done_evidence : null,
        artifact_status: statusData.artifact_status ?? null,
        release_claims_unverified: releaseClaimsUnverified,
        checks: checks.map((c) => ({ name: c.name, result: c.result, detail: c.detail })),
    };
    const acceptanceResult = evaluateAcceptance(acceptanceEvidence);
    // 回写 status.json 的 acceptance_status（仅对 done_by_agent 有意义）
    if (taskStatus === "done_by_agent") {
        const updatedStatus = {
            ...statusData,
            acceptance_status: acceptanceResult.acceptance_status,
            updated_at: new Date().toISOString(),
        };
        writeFileSync(statusFile, JSON.stringify(updatedStatus, null, 2), "utf-8");
    }
    // 导出 ACCEPTANCE.md
    const acceptanceMd = renderAcceptanceMarkdown(taskId, acceptanceResult, acceptanceEvidence);
    writeFileSync(join(taskDir, "ACCEPTANCE.md"), acceptanceMd, "utf-8");
    return {
        task_id: taskId,
        verdict,
        acceptance: {
            verdict: acceptanceResult.verdict,
            status: acceptanceResult.acceptance_status ?? "null",
            reason: acceptanceResult.reason,
            reasons: acceptanceResult.reasons,
            required_evidence: acceptanceResult.required_evidence,
            next_suggested_task: acceptanceResult.next_suggested_task,
            fail_checks: acceptanceResult.fail_checks,
            warn_checks: acceptanceResult.warn_checks,
        },
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
