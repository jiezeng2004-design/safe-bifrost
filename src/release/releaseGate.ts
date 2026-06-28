/**
 * PatchWarden Release Gate — v1.0.0
 *
 * Five-stage release verification gate. Stages run in order; any failed stage
 * blocks all subsequent stages (they become "not_checked").
 *
 *   1. local_ready            — npm run build + npm test + npm run doctor:ci
 *   2. packed_ready           — npm pack --dry-run + forbidden/required checks
 *   3. published_verified     — npm registry confirms version exists
 *   4. github_release_verified— GitHub Releases confirms tag exists
 *   5. ci_verified            — GitHub Actions latest run is green
 *
 * Remote queries use node:https GET only (never child_process curl/git).
 * Network errors resolve to "not_checked" so transient issues don't block.
 * GITHUB_TOKEN is used as Bearer auth but never logged or returned.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { get } from "node:https";

// ── Public types ───────────────────────────────────────────────────

export type ReleaseStage =
  | "local_ready"
  | "packed_ready"
  | "published_verified"
  | "github_release_verified"
  | "ci_verified";

export type ReleaseStageStatus = "passed" | "failed" | "not_checked";

export interface ReleaseGateResult {
  target_stage: ReleaseStage;
  stages: Record<ReleaseStage, ReleaseStageStatus>;
  blocked_reason?: string;
}

export interface StageCheckResult {
  status: ReleaseStageStatus;
  reason?: string;
}

export interface PackedCheckResult extends StageCheckResult {
  manifestPath?: string;
}

export interface HttpResponse {
  statusCode: number;
  data: any;
}

export type HttpGetFn = (
  url: string,
  headers?: Record<string, string>,
  timeoutMs?: number,
) => Promise<HttpResponse>;

export interface ReleaseGateOptions {
  packageName?: string;
  version?: string;
  githubRepo?: string;
  branch?: string;
}

export interface ReleaseGateDeps {
  checkLocalReady?: typeof checkLocalReady;
  checkPackedReady?: typeof checkPackedReady;
  checkPublishedVerified?: typeof checkPublishedVerified;
  checkGitHubReleaseVerified?: typeof checkGitHubReleaseVerified;
  checkCiVerified?: typeof checkCiVerified;
  httpGet?: HttpGetFn;
}

// ── Constants ──────────────────────────────────────────────────────

const STAGE_ORDER: ReleaseStage[] = [
  "local_ready",
  "packed_ready",
  "published_verified",
  "github_release_verified",
  "ci_verified",
];

const LOCAL_TIMEOUT_MS = 300000;
const REMOTE_TIMEOUT_MS = 10000;
const USER_AGENT = "PatchWarden-ReleaseGate";

const PACK_FORBIDDEN_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env$/,
  /(^|[\\/])\.patchwarden([\\/]|$)/,
  /(^|[\\/])patchwarden\.config\.json$/,
  /(^|[\\/])\.local([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /\.dpapi$/i,
];

const PACK_REQUIRED_FILES = ["PatchWarden.cmd", "package.json"];

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Compute a sha256 digest of a token for safe logging.
 * The raw token is never persisted; only this digest may appear in logs.
 */
export function computeTokenDigest(token: string): string {
  const hash = createHash("sha256").update(token, "utf-8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * Perform an HTTPS GET and parse the JSON body.
 * Network errors and timeouts throw — callers catch and convert to "not_checked".
 */
export async function httpsGetJson(
  url: string,
  headers?: Record<string, string>,
  timeoutMs?: number,
): Promise<HttpResponse> {
  const timeout = timeoutMs ?? REMOTE_TIMEOUT_MS;
  return new Promise<HttpResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${timeout}ms`));
    }, timeout);

    const req = get(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json",
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          clearTimeout(timer);
          const body = Buffer.concat(chunks).toString("utf-8");
          let data: any = null;
          if (body.length > 0) {
            try {
              data = JSON.parse(body);
            } catch {
              data = body;
            }
          }
          resolve({ statusCode: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Build GitHub auth headers from GITHUB_TOKEN env var.
 * Returns an empty object when no token is set.
 */
function buildGithubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Classify a packaged file into a category for the artifact manifest.
 */
function classifyFile(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.startsWith("dist/")) return "dist";
  if (lower.startsWith("docs/")) return "docs";
  if (lower.startsWith("examples/")) return "examples";
  if (lower.startsWith("scripts/")) return "scripts";
  if (lower.startsWith("src/")) return "src";
  if (lower.startsWith("ui/")) return "ui";
  if (lower.endsWith(".cmd")) return "control";
  if (lower === "package.json" || lower === "package-lock.json" || lower === "tsconfig.json") {
    return "config";
  }
  if (lower === "license") return "license";
  if (lower === "readme.md" || lower === "readme.en.md") return "readme";
  return "other";
}

// ── Stage checks ───────────────────────────────────────────────────

/**
 * Stage 1: local_ready
 * Runs npm.cmd run build, npm.cmd test, npm.cmd run doctor:ci in repoPath.
 * Returns "passed" only when all three exit with code 0.
 */
export function checkLocalReady(repoPath: string): StageCheckResult {
  const commands = ["npm.cmd run build", "npm.cmd test", "npm.cmd run doctor:ci"];
  for (const cmdStr of commands) {
    try {
      execSync(cmdStr, {
        cwd: repoPath,
        encoding: "utf-8",
        timeout: LOCAL_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      if (err && typeof err === "object" && "status" in err) {
        const code = (err as { status: unknown }).status;
        return {
          status: "failed",
          reason: `Command "${cmdStr}" exited with code ${code}`,
        };
      }
      return {
        status: "failed",
        reason: `Command "${cmdStr}" failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { status: "passed" };
}

/**
 * Stage 2: packed_ready
 * Runs npm.cmd pack --dry-run --json, verifies forbidden files are absent and
 * required control files are present, then writes release-artifact-manifest.json
 * (with sha256 + size + category for every packaged file).
 */
export function checkPackedReady(repoPath: string): PackedCheckResult {
  let packOutput: string;
  try {
    packOutput = execSync("npm.cmd pack --dry-run --json", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: LOCAL_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return {
      status: "failed",
      reason: `npm pack --dry-run failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let packData: unknown;
  try {
    packData = JSON.parse(packOutput);
  } catch (err) {
    return {
      status: "failed",
      reason: `npm pack output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!Array.isArray(packData) || packData.length === 0) {
    return { status: "failed", reason: "npm pack returned empty result array" };
  }

  const filesEntry = packData[0] as { files?: Array<{ path: string; size?: number }>; name?: string };
  const files = Array.isArray(filesEntry.files) ? filesEntry.files : [];
  if (files.length === 0) {
    return { status: "failed", reason: "npm pack reports zero files in artifact" };
  }

  // Check forbidden files
  const forbiddenHits: string[] = [];
  for (const file of files) {
    const normalized = file.path.replace(/\\/g, "/");
    if (PACK_FORBIDDEN_PATTERNS.some((re) => re.test(normalized))) {
      forbiddenHits.push(normalized);
    }
  }

  // Check required files
  const filePaths = new Set(files.map((f) => f.path.replace(/\\/g, "/")));
  const requiredMissing = PACK_REQUIRED_FILES.filter((r) => !filePaths.has(r));

  // Build manifest with sha256 + size + category
  const manifestFiles = files.map((file) => {
    const normalized = file.path.replace(/\\/g, "/");
    const fullPath = join(repoPath, normalized);
    let sha256 = "sha256:unreadable";
    let size = file.size ?? 0;
    try {
      const content = readFileSync(fullPath);
      sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      if (!size) size = content.length;
    } catch {
      // keep defaults
    }
    return { path: normalized, size, sha256, category: classifyFile(normalized) };
  });

  const manifest = {
    generated_at: new Date().toISOString(),
    package_name: filesEntry.name ?? null,
    file_count: files.length,
    total_size: manifestFiles.reduce((sum, f) => sum + f.size, 0),
    files: manifestFiles,
    forbidden_violations: forbiddenHits,
    required_missing: requiredMissing,
  };

  const manifestPath = join(repoPath, "release-artifact-manifest.json");
  try {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  } catch (err) {
    return {
      status: "failed",
      reason: `Failed to write artifact manifest: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (forbiddenHits.length > 0) {
    return {
      status: "failed",
      reason: `Forbidden files in artifact: ${forbiddenHits.join(", ")}`,
      manifestPath,
    };
  }
  if (requiredMissing.length > 0) {
    return {
      status: "failed",
      reason: `Required control files missing: ${requiredMissing.join(", ")}`,
      manifestPath,
    };
  }

  return { status: "passed", manifestPath };
}

/**
 * Stage 3: published_verified
 * Queries the npm registry and confirms the given version exists.
 * Network errors resolve to "not_checked"; a 404 package or missing version is "failed".
 */
export async function checkPublishedVerified(
  packageName: string,
  version: string,
  httpGet?: HttpGetFn,
): Promise<StageCheckResult> {
  const fn = httpGet ?? httpsGetJson;
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
  try {
    const res = await fn(url, {}, REMOTE_TIMEOUT_MS);
    if (res.statusCode >= 500) {
      return { status: "not_checked", reason: `npm registry returned ${res.statusCode}` };
    }
    if (res.statusCode === 404) {
      return { status: "failed", reason: `Package "${packageName}" not found on npm registry` };
    }
    const data = res.data;
    if (!data || !data.versions || typeof data.versions !== "object") {
      return { status: "failed", reason: "npm registry response missing versions object" };
    }
    if (Object.prototype.hasOwnProperty.call(data.versions, version)) {
      return { status: "passed" };
    }
    return {
      status: "failed",
      reason: `Version "${version}" not found for package "${packageName}"`,
    };
  } catch (err) {
    return {
      status: "not_checked",
      reason: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Stage 4: github_release_verified
 * Queries GitHub Releases by tag. 200 = passed, 404 = failed, network error = not_checked.
 * Uses GITHUB_TOKEN as Bearer auth when available; the token is never logged or returned.
 */
export async function checkGitHubReleaseVerified(
  repo: string,
  tag: string,
  httpGet?: HttpGetFn,
): Promise<StageCheckResult> {
  const fn = httpGet ?? httpsGetJson;
  const url = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const headers = buildGithubHeaders();
  try {
    const res = await fn(url, headers, REMOTE_TIMEOUT_MS);
    if (res.statusCode === 200) {
      return { status: "passed" };
    }
    if (res.statusCode === 404) {
      return { status: "failed", reason: `GitHub release for tag "${tag}" not found` };
    }
    return { status: "not_checked", reason: `GitHub API returned ${res.statusCode}` };
  } catch (err) {
    return {
      status: "not_checked",
      reason: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Stage 5: ci_verified
 * Queries GitHub Actions runs for a branch. conclusion "success" = passed,
 * "failure" = failed, null/other = not_checked, network error = not_checked.
 * Uses GITHUB_TOKEN as Bearer auth when available; the token is never logged or returned.
 */
export async function checkCiVerified(
  repo: string,
  branch: string,
  httpGet?: HttpGetFn,
): Promise<StageCheckResult> {
  const fn = httpGet ?? httpsGetJson;
  const url = `https://api.github.com/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`;
  const headers = buildGithubHeaders();
  try {
    const res = await fn(url, headers, REMOTE_TIMEOUT_MS);
    if (res.statusCode !== 200) {
      return { status: "not_checked", reason: `GitHub API returned ${res.statusCode}` };
    }
    const data = res.data;
    const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    if (runs.length === 0) {
      return { status: "not_checked", reason: `No CI runs found for branch "${branch}"` };
    }
    const conclusion = runs[0]?.conclusion;
    if (conclusion === "success") {
      return { status: "passed" };
    }
    if (conclusion === "failure") {
      return { status: "failed", reason: "Latest CI run concluded with failure" };
    }
    return {
      status: "not_checked",
      reason: `Latest CI run conclusion is "${conclusion}" (not success)`,
    };
  } catch (err) {
    return {
      status: "not_checked",
      reason: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Orchestrator ───────────────────────────────────────────────────

/**
 * Run release-gate stages up to and including targetStage, in order.
 * If any stage before the target fails, all subsequent stages become "not_checked"
 * and blocked_reason explains the first failure.
 *
 * The optional `deps` parameter allows injecting mock checkers (for tests).
 */
export async function runReleaseGateCheck(
  repoPath: string,
  targetStage: ReleaseStage,
  options: ReleaseGateOptions = {},
  deps: ReleaseGateDeps = {},
): Promise<ReleaseGateResult> {
  const stages: Record<ReleaseStage, ReleaseStageStatus> = {
    local_ready: "not_checked",
    packed_ready: "not_checked",
    published_verified: "not_checked",
    github_release_verified: "not_checked",
    ci_verified: "not_checked",
  };

  const targetIndex = STAGE_ORDER.indexOf(targetStage);
  if (targetIndex < 0) {
    return {
      target_stage: targetStage,
      stages,
      blocked_reason: `Unknown target stage: ${targetStage}`,
    };
  }

  const localReady = deps.checkLocalReady ?? checkLocalReady;
  const packedReady = deps.checkPackedReady ?? checkPackedReady;
  const publishedVerified = deps.checkPublishedVerified ?? checkPublishedVerified;
  const githubReleaseVerified = deps.checkGitHubReleaseVerified ?? checkGitHubReleaseVerified;
  const ciVerified = deps.checkCiVerified ?? checkCiVerified;
  const httpGet = deps.httpGet;

  let blocked = false;
  let blockedReason: string | undefined;

  for (let i = 0; i <= targetIndex; i++) {
    const stage = STAGE_ORDER[i];
    if (blocked) {
      stages[stage] = "not_checked";
      continue;
    }

    let result: StageCheckResult;
    try {
      switch (stage) {
        case "local_ready":
          result = localReady(repoPath);
          break;
        case "packed_ready":
          result = packedReady(repoPath);
          break;
        case "published_verified": {
          if (!options.packageName || !options.version) {
            result = {
              status: "failed",
              reason: "package_name and version are required for published_verified stage",
            };
          } else {
            result = await publishedVerified(options.packageName, options.version, httpGet);
          }
          break;
        }
        case "github_release_verified": {
          if (!options.githubRepo || !options.version) {
            result = {
              status: "failed",
              reason: "github_repo and version are required for github_release_verified stage",
            };
          } else {
            const tag = `v${options.version}`;
            result = await githubReleaseVerified(options.githubRepo, tag, httpGet);
          }
          break;
        }
        case "ci_verified": {
          if (!options.githubRepo || !options.branch) {
            result = {
              status: "failed",
              reason: "github_repo and branch are required for ci_verified stage",
            };
          } else {
            result = await ciVerified(options.githubRepo, options.branch, httpGet);
          }
          break;
        }
        default:
          result = { status: "not_checked", reason: `Unknown stage: ${stage}` };
      }
    } catch (err) {
      result = {
        status: "failed",
        reason: `Stage "${stage}" threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    stages[stage] = result.status;
    if (result.status === "failed") {
      blocked = true;
      blockedReason = `Stage "${stage}" failed: ${result.reason || "no reason provided"}`;
    }
  }

  const gateResult: ReleaseGateResult = {
    target_stage: targetStage,
    stages,
  };
  if (blockedReason) {
    gateResult.blocked_reason = blockedReason;
  }
  return gateResult;
}
