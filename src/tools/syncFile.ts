import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { PatchWardenError } from "../errors.js";
import { getConfig, type PatchWardenConfig } from "../config.js";
import { guardDirectPath, guardDirectWritePath } from "../direct/directGuards.js";
import { guardSensitivePath } from "../security/sensitiveGuard.js";
import { computeFileSha256 } from "../direct/directPatch.js";

export interface SyncFileResult {
  source_path: string;
  target_path: string;
  before_target_sha256: string | null;
  after_target_sha256: string;
  source_sha256: string;
  copied_bytes: number;
  changed: boolean;
}

/**
 * Copy a file from source to target within the same session repo.
 * Both source and target must be inside the session's repo_path.
 */
export function syncFile(
  sessionId: string,
  sourcePath: string,
  targetPath: string,
  options?: {
    expected_source_sha256?: string;
    expected_target_sha256?: string;
  },
  config?: PatchWardenConfig
): SyncFileResult {
  const cfg = config || getConfig();
  const sessionsDir = resolve(cfg.workspaceRoot, cfg.directSessionsDir);

  // Load session to get repo_path
  const sessionFile = resolve(sessionsDir, sessionId, "session.json");
  if (!existsSync(sessionFile)) {
    throw new PatchWardenError(
      "direct_session_not_found",
      `Direct session "${sessionId}" not found.`,
      "Create a direct session first using direct_start_session.",
      true,
      { session_id: sessionId }
    );
  }

  const session = JSON.parse(readFileSync(sessionFile, "utf-8"));
  const repoPath = resolve(session.repo_path);
  const workspaceRoot = cfg.workspaceRoot;

  // Guard source path — must be inside repo
  const resolvedSource = guardDirectPath(sourcePath, repoPath, workspaceRoot);
  guardSensitivePath(resolvedSource);

  if (!existsSync(resolvedSource)) {
    throw new PatchWardenError(
      "source_file_not_found",
      `Source file does not exist: "${sourcePath}".`,
      "Ensure the source path is correct.",
      true,
      { source_path: sourcePath }
    );
  }

  // Guard target path — must be inside repo, not in blocked dirs
  const resolvedTarget = guardDirectWritePath(targetPath, repoPath, workspaceRoot);
  guardSensitivePath(resolvedTarget);

  // Verify source sha256 if provided
  const sourceSha256 = computeFileSha256(resolvedSource);
  if (options?.expected_source_sha256 && options.expected_source_sha256 !== sourceSha256) {
    throw new PatchWardenError(
      "source_hash_mismatch",
      `Source file hash mismatch. Expected "${options.expected_source_sha256}" but got "${sourceSha256}".`,
      "Re-read the source file to get the current sha256.",
      true,
      { expected_sha256: options.expected_source_sha256, actual_sha256: sourceSha256 }
    );
  }

  // Get target sha256 before copy
  let beforeTargetSha256: string | null = null;
  if (existsSync(resolvedTarget)) {
    beforeTargetSha256 = computeFileSha256(resolvedTarget);
    // Verify target sha256 if provided
    if (options?.expected_target_sha256 && options.expected_target_sha256 !== beforeTargetSha256) {
      throw new PatchWardenError(
        "target_hash_mismatch",
        `Target file hash mismatch. Expected "${options.expected_target_sha256}" but got "${beforeTargetSha256}".`,
        "Re-read the target file to get the current sha256.",
        true,
        { expected_sha256: options.expected_target_sha256, actual_sha256: beforeTargetSha256 }
      );
    }
  }

  // Read source content
  const sourceContent = readFileSync(resolvedSource);
  const copiedBytes = sourceContent.length;

  // Create target directory if needed
  mkdirSync(dirname(resolvedTarget), { recursive: true });

  // Write to target
  writeFileSync(resolvedTarget, sourceContent, "utf-8");

  // Compute after hash
  const afterTargetSha256 = computeFileSha256(resolvedTarget);
  const changed = beforeTargetSha256 !== afterTargetSha256;

  return {
    source_path: sourcePath,
    target_path: targetPath,
    before_target_sha256: beforeTargetSha256,
    after_target_sha256: afterTargetSha256,
    source_sha256: sourceSha256,
    copied_bytes: copiedBytes,
    changed,
  };
}
