import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { isSensitivePath, guardSensitivePath } from "../../security/sensitiveGuard.js";
import { PatchWardenError } from "../../errors.js";

describe("isSensitivePath", () => {
  it("blocks .env files", () => {
    assert.equal(isSensitivePath(".env"), true);
    assert.equal(isSensitivePath("path/to/.env"), true);
    assert.equal(isSensitivePath(".env.production"), true);
    assert.equal(isSensitivePath(".env.local"), true);
  });

  it("blocks .ENV case insensitive", () => {
    assert.equal(isSensitivePath(".ENV"), true);
    assert.equal(isSensitivePath("path/to/.ENV"), true);
    assert.equal(isSensitivePath(".Env.Production"), true);
  });

  it("blocks config.json case insensitive", () => {
    assert.equal(isSensitivePath("config.json"), true);
    assert.equal(isSensitivePath("Config.json"), true);
    assert.equal(isSensitivePath("CONFIG.JSON"), true);
    assert.equal(isSensitivePath("path/to/Config.json"), true);
  });

  it("blocks SSH keys", () => {
    assert.equal(isSensitivePath("id_rsa"), true);
    assert.equal(isSensitivePath("id_ed25519"), true);
    assert.equal(isSensitivePath("id_ecdsa"), true);
    assert.equal(isSensitivePath("path/to/id_rsa"), true);
    assert.equal(isSensitivePath(".ssh/id_rsa"), true);
  });

  it("blocks credentials and tokens", () => {
    assert.equal(isSensitivePath("credentials"), true);
    assert.equal(isSensitivePath("path/to/credentials.json"), true);
    assert.equal(isSensitivePath("token.txt"), true);
    // access_token does NOT match because the pattern requires token at start or after /
    assert.equal(isSensitivePath("access_token"), false);
    assert.equal(isSensitivePath("path/to/token"), true);
    assert.equal(isSensitivePath(".netrc"), true);
    assert.equal(isSensitivePath(".npmrc"), true);
    assert.equal(isSensitivePath(".pypirc"), true);
  });

  it("blocks private key files", () => {
    assert.equal(isSensitivePath("server.pem"), true);
    assert.equal(isSensitivePath("private.key"), true);
    assert.equal(isSensitivePath("cert.pfx"), true);
    assert.equal(isSensitivePath("cert.p12"), true);
  });

  it("blocks browser data files", () => {
    assert.equal(isSensitivePath("cookies"), true);
    assert.equal(isSensitivePath("cookies.db"), true);
    assert.equal(isSensitivePath("Web Data"), true);
    assert.equal(isSensitivePath("Login Data"), true);
    assert.equal(isSensitivePath("Local State"), true);
  });

  it("blocks .git-credentials", () => {
    assert.equal(isSensitivePath(".git-credentials"), true);
    assert.equal(isSensitivePath("path/to/.git-credentials"), true);
  });

  it("blocks docker and kube config", () => {
    assert.equal(isSensitivePath(".docker/config.json"), true);
    assert.equal(isSensitivePath(".kube/config"), true);
  });

  it("allows .patchwarden safe prefix", () => {
    assert.equal(isSensitivePath(".patchwarden/tasks/task-001/status.json"), false);
    assert.equal(isSensitivePath(".patchwarden/config.json"), false);
    assert.equal(isSensitivePath(".patchwarden"), false);
  });

  it("allows non-sensitive files", () => {
    assert.equal(isSensitivePath("src/main.ts"), false);
    assert.equal(isSensitivePath("README.md"), false);
    assert.equal(isSensitivePath("package.json"), false);
    assert.equal(isSensitivePath("docs/guide.md"), false);
  });

  it("handles Windows backslash paths", () => {
    assert.equal(isSensitivePath("path\\to\\.env"), true);
    assert.equal(isSensitivePath("path\\to\\config.json"), true);
    assert.equal(isSensitivePath(".patchwarden\\tasks\\status.json"), false);
  });

  it("handles null byte in path", () => {
    // config.json with null byte appended — the $ anchor means this won't match
    // because the string doesn't end with "config.json"
    const nullPath = "config.json\x00.txt";
    assert.equal(isSensitivePath(nullPath), false);
    // But plain config.json still matches
    assert.equal(isSensitivePath("config.json"), true);
  });

  it("handles Unicode lookalike characters", () => {
    // Full-width dot (U+FF0E) should not match .env pattern
    // This is expected behavior — Unicode lookalikes are NOT matched
    const fullWidthPath = "\uFF0Eenv";
    assert.equal(isSensitivePath(fullWidthPath), false);
  });
});

describe("guardSensitivePath", () => {
  it("throws PatchWardenError for sensitive paths", () => {
    assert.throws(
      () => guardSensitivePath(".env"),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "sensitive_path_blocked"
    );
  });

  it("does not throw for non-sensitive paths", () => {
    assert.doesNotThrow(() => guardSensitivePath("src/main.ts"));
    assert.doesNotThrow(() => guardSensitivePath("README.md"));
  });

  it("does not throw for .patchwarden paths", () => {
    assert.doesNotThrow(() => guardSensitivePath(".patchwarden/tasks/status.json"));
  });
});
