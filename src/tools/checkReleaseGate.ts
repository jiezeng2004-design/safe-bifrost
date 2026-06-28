import { getConfig } from "../config.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import {
  runReleaseGateCheck,
  type ReleaseStage,
} from "../release/releaseGate.js";

export interface CheckReleaseGateInput {
  repo_path: string;
  target_stage: ReleaseStage;
  package_name?: string;
  version?: string;
  github_repo?: string;
  branch?: string;
}

/**
 * MCP tool handler for the release gate.
 *
 * Validates repo_path against the workspace boundary, runs the release-gate
 * stages up to target_stage, and returns the result as a JSON text blob.
 */
export async function checkReleaseGate(
  input: CheckReleaseGateInput,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  const config = getConfig();
  const repoPath = guardWorkspacePath(input.repo_path, config.workspaceRoot);

  const result = await runReleaseGateCheck(
    repoPath,
    input.target_stage,
    {
      packageName: input.package_name,
      version: input.version,
      githubRepo: input.github_repo,
      branch: input.branch,
    },
  );

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
