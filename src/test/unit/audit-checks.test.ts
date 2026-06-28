import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChangedFile } from "../../runner/changeCapture.js";
import {
  checkForbiddenScope,
  checkDoneEvidenceMissing,
  checkReadmeChangelogSync,
  checkPackageManifestConsistency,
  checkSensitivePathAccess,
  checkUnrecordedCommandExecution,
} from "../../tools/auditTask.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeChangedFile(path: string, change: ChangedFile["change"] = "modified", oldPath?: string): ChangedFile {
  return {
    path,
    change,
    old_path: oldPath,
    before_sha256: null,
    after_sha256: null,
    tracked: true,
    ignored: false,
    kind: "source",
  };
}

describe("auditTask new checks", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-audit-checks-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 1. checkForbiddenScope ──────────────────────────────────────

  describe("checkForbiddenScope", () => {
    it("returns null when forbidden is null (skip)", () => {
      const result = checkForbiddenScope([makeChangedFile("src/index.ts")], null);
      assert.equal(result, null);
    });

    it("returns null when forbidden is empty array (skip)", () => {
      const result = checkForbiddenScope([makeChangedFile("src/index.ts")], []);
      assert.equal(result, null);
    });

    it("returns pass when changedFiles is empty", () => {
      const result = checkForbiddenScope([], ["src/security/**"]);
      assert.notEqual(result, null);
      assert.equal(result!.result, "pass");
      assert.equal(result!.name, "forbidden_scope_violation");
    });

    it("returns pass when no changed file matches forbidden patterns", () => {
      const result = checkForbiddenScope(
        [makeChangedFile("src/tools/auditTask.ts")],
        ["src/security/**"],
      );
      assert.equal(result!.result, "pass");
    });

    it("returns fail when a changed file matches a ** glob (src/security/** matches src/security/pathGuard.ts)", () => {
      const result = checkForbiddenScope(
        [makeChangedFile("src/security/pathGuard.ts")],
        ["src/security/**"],
      );
      assert.equal(result!.result, "fail");
      assert.ok(result!.detail.includes("src/security/pathGuard.ts"));
      assert.ok(result!.detail.includes("forbidden paths"));
    });

    it("returns fail for src/tools/* matching src/tools/auditTask.ts (single segment)", () => {
      const result = checkForbiddenScope(
        [makeChangedFile("src/tools/auditTask.ts")],
        ["src/tools/*"],
      );
      assert.equal(result!.result, "fail");
    });

    it("returns fail for src/tools/** matching src/tools/auditTask.ts", () => {
      const result = checkForbiddenScope(
        [makeChangedFile("src/tools/auditTask.ts")],
        ["src/tools/**"],
      );
      assert.equal(result!.result, "fail");
    });

    it("single * does NOT match nested path (src/tools/* does not match src/tools/sub/file.ts)", () => {
      const result = checkForbiddenScope(
        [makeChangedFile("src/tools/sub/file.ts")],
        ["src/tools/*"],
      );
      assert.equal(result!.result, "pass");
    });

    it("checks old_path for renamed files", () => {
      const result = checkForbiddenScope(
        [makeChangedFile("src/new-path.ts", "renamed", "src/secret/old.ts")],
        ["src/secret/**"],
      );
      assert.equal(result!.result, "fail");
      assert.ok(result!.detail.includes("src/secret/old.ts"));
    });

    it("handles backslash path separators", () => {
      const result = checkForbiddenScope(
        [makeChangedFile("src\\security\\pathGuard.ts")],
        ["src/security/**"],
      );
      assert.equal(result!.result, "fail");
    });

    it("deduplicates hit paths in detail", () => {
      const result = checkForbiddenScope(
        [makeChangedFile("src/secret/a.ts"), makeChangedFile("src/secret/a.ts")],
        ["src/secret/**"],
      );
      const occurrences = result!.detail.split("src/secret/a.ts").length - 1;
      assert.equal(occurrences, 1, "path should appear only once");
    });
  });

  // ── 2. checkDoneEvidenceMissing ─────────────────────────────────

  describe("checkDoneEvidenceMissing", () => {
    it("returns null when doneEvidence is null (skip)", () => {
      const result = checkDoneEvidenceMissing(tempDir, null);
      assert.equal(result, null);
    });

    it("returns null when doneEvidence is empty (skip)", () => {
      const result = checkDoneEvidenceMissing(tempDir, []);
      assert.equal(result, null);
    });

    it("returns pass when all evidence files exist", () => {
      writeFileSync(join(tempDir, "result.md"), "# Result", "utf-8");
      writeFileSync(join(tempDir, "test.log"), "ok", "utf-8");
      const result = checkDoneEvidenceMissing(tempDir, ["result.md", "test.log"]);
      assert.equal(result!.result, "pass");
      assert.equal(result!.name, "done_evidence_missing");
      assert.ok(result!.detail.includes("present"));
    });

    it("returns warn when some evidence files are missing", () => {
      writeFileSync(join(tempDir, "result.md"), "# Result", "utf-8");
      const result = checkDoneEvidenceMissing(tempDir, ["result.md", "test.log", "git.diff"]);
      assert.equal(result!.result, "warn");
      assert.ok(result!.detail.includes("test.log"));
      assert.ok(result!.detail.includes("git.diff"));
      assert.ok(!result!.detail.includes("result.md"));
    });

    it("returns warn when all evidence files are missing", () => {
      const result = checkDoneEvidenceMissing(tempDir, ["result.md", "test.log"]);
      assert.equal(result!.result, "warn");
      assert.ok(result!.detail.includes("result.md"));
      assert.ok(result!.detail.includes("test.log"));
    });
  });

  // ── 3. checkReadmeChangelogSync ─────────────────────────────────

  describe("checkReadmeChangelogSync", () => {
    it("returns null when no code files changed (skip)", () => {
      const result = checkReadmeChangelogSync([
        makeChangedFile("README.md"),
        makeChangedFile("docs/guide.md"),
      ]);
      assert.equal(result, null);
    });

    it("returns null when changedFiles is empty (skip)", () => {
      const result = checkReadmeChangelogSync([]);
      assert.equal(result, null);
    });

    it("returns warn when code changed but no README/CHANGELOG updated", () => {
      const result = checkReadmeChangelogSync([
        makeChangedFile("src/index.ts"),
        makeChangedFile("src/tools/auditTask.ts"),
      ]);
      assert.equal(result!.result, "warn");
      assert.equal(result!.name, "readme_changelog_sync");
      assert.ok(result!.detail.includes("not updated"));
    });

    it("returns pass when README.md is also changed", () => {
      const result = checkReadmeChangelogSync([
        makeChangedFile("src/index.ts"),
        makeChangedFile("README.md"),
      ]);
      assert.equal(result!.result, "pass");
    });

    it("returns pass when CHANGELOG.md is also changed", () => {
      const result = checkReadmeChangelogSync([
        makeChangedFile("src/index.ts"),
        makeChangedFile("CHANGELOG.md"),
      ]);
      assert.equal(result!.result, "pass");
    });

    it("is case-insensitive for README.md basename", () => {
      const result = checkReadmeChangelogSync([
        makeChangedFile("src/index.ts"),
        makeChangedFile("docs/Readme.md"),
      ]);
      assert.equal(result!.result, "pass");
    });

    it("detects code files by various extensions", () => {
      const extensions = [".ts", ".js", ".py", ".go", ".rs", ".java"];
      for (const ext of extensions) {
        const result = checkReadmeChangelogSync([makeChangedFile(`src/file${ext}`)]);
        assert.equal(result!.result, "warn", `extension ${ext} should be detected as code`);
      }
    });

    it("does not treat .md as code", () => {
      const result = checkReadmeChangelogSync([makeChangedFile("docs/guide.md")]);
      assert.equal(result, null);
    });
  });

  // ── 4. checkPackageManifestConsistency ──────────────────────────

  describe("checkPackageManifestConsistency", () => {
    it("returns null when package.json is not in changed files (skip)", () => {
      const result = checkPackageManifestConsistency(
        [makeChangedFile("src/index.ts")],
        tempDir,
      );
      assert.equal(result, null);
    });

    it("returns pass when package.json has valid name and version", () => {
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "patchwarden", version: "0.7.2" }),
        "utf-8",
      );
      const result = checkPackageManifestConsistency(
        [makeChangedFile("package.json")],
        tempDir,
      );
      assert.equal(result!.result, "pass");
      assert.equal(result!.name, "package_manifest_consistency");
    });

    it("returns warn when package.json is missing version field", () => {
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "patchwarden" }),
        "utf-8",
      );
      const result = checkPackageManifestConsistency(
        [makeChangedFile("package.json")],
        tempDir,
      );
      assert.equal(result!.result, "warn");
    });

    it("returns warn when package.json is missing name field", () => {
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ version: "0.7.2" }),
        "utf-8",
      );
      const result = checkPackageManifestConsistency(
        [makeChangedFile("package.json")],
        tempDir,
      );
      assert.equal(result!.result, "warn");
    });

    it("returns warn when package.json is invalid JSON", () => {
      writeFileSync(join(tempDir, "package.json"), "{ not valid json", "utf-8");
      const result = checkPackageManifestConsistency(
        [makeChangedFile("package.json")],
        tempDir,
      );
      assert.equal(result!.result, "warn");
    });

    it("returns warn when package.json does not exist on disk", () => {
      const result = checkPackageManifestConsistency(
        [makeChangedFile("package.json")],
        tempDir,
      );
      assert.equal(result!.result, "warn");
    });

    it("detects package.json case-insensitively by basename", () => {
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "x", version: "1.0.0" }),
        "utf-8",
      );
      const result = checkPackageManifestConsistency(
        [makeChangedFile("subdir/Package.json")],
        tempDir,
      );
      assert.equal(result!.result, "pass");
    });

    it("returns warn when name/version are empty strings", () => {
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "", version: "" }),
        "utf-8",
      );
      const result = checkPackageManifestConsistency(
        [makeChangedFile("package.json")],
        tempDir,
      );
      assert.equal(result!.result, "warn");
    });
  });

  // ── 5. checkSensitivePathAccess ─────────────────────────────────

  describe("checkSensitivePathAccess", () => {
    it("returns null when changedFiles is empty (skip)", () => {
      const result = checkSensitivePathAccess([]);
      assert.equal(result, null);
    });

    it("returns pass when no sensitive paths are accessed", () => {
      const result = checkSensitivePathAccess([
        makeChangedFile("src/index.ts"),
        makeChangedFile("README.md"),
      ]);
      assert.equal(result!.result, "pass");
      assert.equal(result!.name, "sensitive_path_access");
      assert.ok(result!.detail.includes("No sensitive"));
    });

    it("returns fail when .env is accessed", () => {
      const result = checkSensitivePathAccess([makeChangedFile(".env")]);
      assert.equal(result!.result, "fail");
      assert.ok(result!.detail.includes(".env"));
    });

    it("returns fail when id_rsa is accessed", () => {
      const result = checkSensitivePathAccess([makeChangedFile("id_rsa")]);
      assert.equal(result!.result, "fail");
    });

    it("returns fail when credentials.json is accessed", () => {
      const result = checkSensitivePathAccess([makeChangedFile("credentials.json")]);
      assert.equal(result!.result, "fail");
    });

    it("returns fail when a sensitive path is in a subdirectory", () => {
      const result = checkSensitivePathAccess([
        makeChangedFile("src/index.ts"),
        makeChangedFile("config/secrets.pem"),
      ]);
      assert.equal(result!.result, "fail");
      assert.ok(result!.detail.includes("config/secrets.pem"));
    });

    it("returns fail when old_path of a renamed file is sensitive", () => {
      const result = checkSensitivePathAccess([
        makeChangedFile("src/new-location.ts", "renamed", ".env"),
      ]);
      assert.equal(result!.result, "fail");
      assert.ok(result!.detail.includes(".env"));
    });

    it("returns pass for src/index.ts (non-sensitive)", () => {
      const result = checkSensitivePathAccess([makeChangedFile("src/index.ts")]);
      assert.equal(result!.result, "pass");
    });

    it("deduplicates hit paths in detail", () => {
      const result = checkSensitivePathAccess([
        makeChangedFile(".env"),
        makeChangedFile(".env"),
      ]);
      const occurrences = result!.detail.split(".env").length - 1;
      assert.equal(occurrences, 1, "path should appear only once");
    });
  });

  // ── 6. checkUnrecordedCommandExecution ──────────────────────────

  describe("checkUnrecordedCommandExecution", () => {
    it("returns null when both contents are null (skip)", () => {
      const result = checkUnrecordedCommandExecution(null, null, [], null);
      assert.equal(result, null);
    });

    it("returns null when both contents are empty strings (skip)", () => {
      const result = checkUnrecordedCommandExecution("", "", [], null);
      assert.equal(result, null);
    });

    it("returns pass when test log command is in whitelist (npm test)", () => {
      const result = checkUnrecordedCommandExecution(
        "Running npm test\nExit code: 0",
        null,
        [],
        "npm test",
      );
      assert.equal(result!.result, "pass");
      assert.equal(result!.name, "unrecorded_command_execution");
      assert.ok(result!.detail.includes("whitelist"));
    });

    it("returns warn when npm run build is not in whitelist", () => {
      const result = checkUnrecordedCommandExecution(
        "Running npm run build\nDone",
        null,
        [],
        null,
      );
      assert.equal(result!.result, "warn");
      assert.ok(result!.detail.includes("build"));
    });

    it("returns pass when npm run build IS in whitelist (via verify_commands)", () => {
      const result = checkUnrecordedCommandExecution(
        "Running npm run build\nDone",
        null,
        ["npm run build"],
        null,
      );
      assert.equal(result!.result, "pass");
    });

    it("returns pass when npm run build IS in whitelist (via test_command)", () => {
      const result = checkUnrecordedCommandExecution(
        "Running npm run build\nDone",
        null,
        [],
        "npm run build",
      );
      assert.equal(result!.result, "pass");
    });

    it("scans result.md content as well as test.log", () => {
      const result = checkUnrecordedCommandExecution(
        null,
        "I ran npm run deploy to publish",
        ["npm test"],
        "npm test",
      );
      assert.equal(result!.result, "warn");
      assert.ok(result!.detail.includes("deploy"));
    });

    it("handles npm.cmd variant", () => {
      const result = checkUnrecordedCommandExecution(
        "npm.cmd run build\nDone",
        null,
        [],
        null,
      );
      assert.equal(result!.result, "warn");
      assert.ok(result!.detail.includes("build"));
    });

    it("handles npx commands", () => {
      const result = checkUnrecordedCommandExecution(
        "npx eslint src/\nDone",
        null,
        [],
        null,
      );
      assert.equal(result!.result, "warn");
      assert.ok(result!.detail.includes("eslint"));
    });

    it("handles node commands", () => {
      const result = checkUnrecordedCommandExecution(
        "node ./scripts/check.js\nDone",
        null,
        [],
        null,
      );
      assert.equal(result!.result, "warn");
      assert.ok(result!.detail.includes("scripts/check.js"));
    });

    it("returns pass when whitelist contains all discovered commands", () => {
      const log = "npm run build && npm test && npx tsc";
      const result = checkUnrecordedCommandExecution(
        log,
        null,
        ["npm run build", "npx tsc"],
        "npm test",
      );
      assert.equal(result!.result, "pass");
    });
    it("recognizes commands reached transitively through npm scripts and local verifier files", () => {
      mkdirSync(join(tempDir, "scripts"), { recursive: true });
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({
          scripts: {
            test: "node scripts/verify-all.js",
            build: "node scripts/build.js",
            check: "node scripts/check.js",
          },
        }),
        "utf-8",
      );
      writeFileSync(
        join(tempDir, "scripts", "verify-all.js"),
        "npm run build\nnpm run check\n",
        "utf-8",
      );
      const result = checkUnrecordedCommandExecution(
        "npm test\nnode scripts/verify-all.js\nnpm run build\nnpm run check\n",
        null,
        [],
        "npm test",
        tempDir,
      );
      assert.equal(result!.result, "pass");
      assert.ok(result!.detail.includes("transitive_verified_command"));
    });

    it("fails high-risk publication commands even when they look intentional", () => {
      const result = checkUnrecordedCommandExecution(
        "npm publish --access public\n",
        null,
        ["npm publish --access public"],
        null,
        tempDir,
      );
      assert.equal(result!.result, "fail");
      assert.ok(result!.detail.includes("High-risk"));
    });

    it("returns pass when there are no commands in the log", () => {
      const result = checkUnrecordedCommandExecution(
        "No commands here, just text.\nExit code: 0",
        null,
        [],
        null,
      );
      assert.equal(result!.result, "pass");
    });

    it("deduplicates unrecorded commands in detail", () => {
      const result = checkUnrecordedCommandExecution(
        "npm run build && npm run build && npm run build",
        null,
        [],
        null,
      );
      const occurrences = result!.detail.split("build").length - 1;
      assert.equal(occurrences, 1, "command should appear only once");
    });
  });
});
