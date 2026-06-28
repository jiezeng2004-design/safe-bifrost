import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  runReleaseGateCheck,
  checkPublishedVerified,
  checkGitHubReleaseVerified,
  checkCiVerified,
  computeTokenDigest,
  type HttpGetFn,
  type HttpResponse,
  type ReleaseGateDeps,
} from "../../release/releaseGate.js";

// ── Mock helpers ───────────────────────────────────────────────────

/**
 * Build a mock httpGet that responds based on the URL.
 * Each responder returns an HttpResponse synchronously (wrapped in a Promise).
 */
function mockHttpGet(responder: (url: string) => HttpResponse): HttpGetFn {
  return async (url: string) => responder(url);
}

/**
 * Build a mock httpGet that captures headers (for token-leak assertions).
 */
function mockHttpGetCapture(
  responder: (url: string) => HttpResponse,
  capture: { headers?: Record<string, string> },
): HttpGetFn {
  return async (url: string, headers?: Record<string, string>) => {
    capture.headers = { ...(headers || {}) };
    return responder(url);
  };
}

/**
 * Build a mock httpGet that always throws (simulates network error).
 */
function mockHttpGetError(error: Error): HttpGetFn {
  return async () => {
    throw error;
  };
}

// ── 1. checkPublishedVerified ──────────────────────────────────────

describe("checkPublishedVerified", () => {
  it("version exists → passed", async () => {
    const httpGet = mockHttpGet(() => ({
      statusCode: 200,
      data: { versions: { "1.0.0": {}, "0.9.0": {} } },
    }));
    const result = await checkPublishedVerified("patchwarden", "1.0.0", httpGet);
    assert.equal(result.status, "passed");
  });

  it("version does not exist → failed", async () => {
    const httpGet = mockHttpGet(() => ({
      statusCode: 200,
      data: { versions: { "0.9.0": {} } },
    }));
    const result = await checkPublishedVerified("patchwarden", "9.9.9", httpGet);
    assert.equal(result.status, "failed");
    assert.ok(result.reason?.includes("9.9.9"));
  });

  it("network error → not_checked", async () => {
    const httpGet = mockHttpGetError(new Error("connect ECONNREFUSED"));
    const result = await checkPublishedVerified("patchwarden", "1.0.0", httpGet);
    assert.equal(result.status, "not_checked");
    assert.ok(result.reason?.includes("Network error"));
  });

  it("package 404 → failed", async () => {
    const httpGet = mockHttpGet(() => ({
      statusCode: 404,
      data: { error: "Not found" },
    }));
    const result = await checkPublishedVerified("nonexistent-pkg", "1.0.0", httpGet);
    assert.equal(result.status, "failed");
  });
});

// ── 2. checkGitHubReleaseVerified ──────────────────────────────────

describe("checkGitHubReleaseVerified", () => {
  it("200 → passed", async () => {
    const httpGet = mockHttpGet(() => ({
      statusCode: 200,
      data: { tag_name: "v1.0.0" },
    }));
    const result = await checkGitHubReleaseVerified("user/repo", "v1.0.0", httpGet);
    assert.equal(result.status, "passed");
  });

  it("404 → failed", async () => {
    const httpGet = mockHttpGet(() => ({
      statusCode: 404,
      data: { message: "Not Found" },
    }));
    const result = await checkGitHubReleaseVerified("user/repo", "v1.0.0", httpGet);
    assert.equal(result.status, "failed");
    assert.ok(result.reason?.includes("v1.0.0"));
  });

  it("network error → not_checked", async () => {
    const httpGet = mockHttpGetError(new Error("connect ETIMEDOUT"));
    const result = await checkGitHubReleaseVerified("user/repo", "v1.0.0", httpGet);
    assert.equal(result.status, "not_checked");
  });

  it("token is used as Bearer but never appears in result", async () => {
    const TOKEN = "test-token";
    process.env.GITHUB_TOKEN = TOKEN;
    const capture: { headers?: Record<string, string> } = {};
    const httpGet = mockHttpGetCapture(
      () => ({ statusCode: 200, data: { tag_name: "v1.0.0" } }),
      capture,
    );

    try {
      const result = await checkGitHubReleaseVerified("user/repo", "v1.0.0", httpGet);
      assert.equal(result.status, "passed");

      // Authorization header was set correctly (token used internally)
      assert.equal(capture.headers?.["Authorization"], `Bearer ${TOKEN}`);

      // Raw token must NOT appear anywhere in the serialized result
      const resultStr = JSON.stringify(result);
      assert.ok(
        !resultStr.includes(TOKEN),
        "raw GITHUB_TOKEN must not leak into the result object",
      );

      // The token digest is different from the raw token
      const digest = computeTokenDigest(TOKEN);
      assert.ok(digest !== TOKEN, "digest must differ from raw token");
      assert.ok(digest.startsWith("sha256:"));
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });
});

// ── 3. checkCiVerified ─────────────────────────────────────────────

describe("checkCiVerified", () => {
  it("conclusion=success → passed", async () => {
    const httpGet = mockHttpGet(() => ({
      statusCode: 200,
      data: { workflow_runs: [{ conclusion: "success" }] },
    }));
    const result = await checkCiVerified("user/repo", "main", httpGet);
    assert.equal(result.status, "passed");
  });

  it("conclusion=failure → failed", async () => {
    const httpGet = mockHttpGet(() => ({
      statusCode: 200,
      data: { workflow_runs: [{ conclusion: "failure" }] },
    }));
    const result = await checkCiVerified("user/repo", "main", httpGet);
    assert.equal(result.status, "failed");
  });

  it("conclusion=null → not_checked", async () => {
    const httpGet = mockHttpGet(() => ({
      statusCode: 200,
      data: { workflow_runs: [{ conclusion: null }] },
    }));
    const result = await checkCiVerified("user/repo", "main", httpGet);
    assert.equal(result.status, "not_checked");
  });

  it("network error → not_checked", async () => {
    const httpGet = mockHttpGetError(new Error("connect ECONNREFUSED"));
    const result = await checkCiVerified("user/repo", "main", httpGet);
    assert.equal(result.status, "not_checked");
  });
});

// ── 4. runReleaseGateCheck orchestration ───────────────────────────

describe("runReleaseGateCheck", () => {
  it("target=local_ready passed → local_ready=passed, rest not_checked, no blocked_reason", async () => {
    const deps: ReleaseGateDeps = {
      checkLocalReady: () => ({ status: "passed" }),
    };
    const result = await runReleaseGateCheck("/fake/repo", "local_ready", {}, deps);
    assert.equal(result.target_stage, "local_ready");
    assert.equal(result.stages.local_ready, "passed");
    assert.equal(result.stages.packed_ready, "not_checked");
    assert.equal(result.stages.published_verified, "not_checked");
    assert.equal(result.stages.github_release_verified, "not_checked");
    assert.equal(result.stages.ci_verified, "not_checked");
    assert.equal(result.blocked_reason, undefined);
  });

  it("local_ready failed → subsequent stages all not_checked, blocked_reason non-empty", async () => {
    const deps: ReleaseGateDeps = {
      checkLocalReady: () => ({ status: "failed", reason: "build exited with code 1" }),
    };
    const result = await runReleaseGateCheck(
      "/fake/repo",
      "ci_verified",
      {
        packageName: "patchwarden",
        version: "1.0.0",
        githubRepo: "user/repo",
        branch: "main",
      },
      deps,
    );
    assert.equal(result.stages.local_ready, "failed");
    assert.equal(result.stages.packed_ready, "not_checked");
    assert.equal(result.stages.published_verified, "not_checked");
    assert.equal(result.stages.github_release_verified, "not_checked");
    assert.equal(result.stages.ci_verified, "not_checked");
    assert.ok(result.blocked_reason, "blocked_reason should be non-empty");
    assert.ok(
      result.blocked_reason!.includes("local_ready"),
      "blocked_reason should mention the failed stage",
    );
  });

  it("full pass-through: all stages passed up to ci_verified", async () => {
    const deps: ReleaseGateDeps = {
      checkLocalReady: () => ({ status: "passed" }),
      checkPackedReady: () => ({ status: "passed", manifestPath: "/fake/release-artifact-manifest.json" }),
      checkPublishedVerified: async () => ({ status: "passed" }),
      checkGitHubReleaseVerified: async () => ({ status: "passed" }),
      checkCiVerified: async () => ({ status: "passed" }),
    };
    const result = await runReleaseGateCheck(
      "/fake/repo",
      "ci_verified",
      {
        packageName: "patchwarden",
        version: "1.0.0",
        githubRepo: "user/repo",
        branch: "main",
      },
      deps,
    );
    assert.equal(result.stages.local_ready, "passed");
    assert.equal(result.stages.packed_ready, "passed");
    assert.equal(result.stages.published_verified, "passed");
    assert.equal(result.stages.github_release_verified, "passed");
    assert.equal(result.stages.ci_verified, "passed");
    assert.equal(result.blocked_reason, undefined);
  });

  it("missing options for a required stage → failed with clear reason", async () => {
    const deps: ReleaseGateDeps = {
      checkLocalReady: () => ({ status: "passed" }),
      checkPackedReady: () => ({ status: "passed" }),
    };
    // published_verified needs packageName + version, neither provided
    const result = await runReleaseGateCheck(
      "/fake/repo",
      "published_verified",
      {},
      deps,
    );
    assert.equal(result.stages.local_ready, "passed");
    assert.equal(result.stages.packed_ready, "passed");
    assert.equal(result.stages.published_verified, "failed");
    assert.ok(result.blocked_reason?.includes("published_verified"));
  });
});

// ── 5. Function name spelling (Verified, not Verfied) ─────────────

describe("function name spelling", () => {
  it("checkPublishedVerified is a function (not Verfied)", () => {
    assert.equal(typeof checkPublishedVerified, "function");
  });

  it("checkGitHubReleaseVerified is a function", () => {
    assert.equal(typeof checkGitHubReleaseVerified, "function");
  });

  it("checkCiVerified is a function", () => {
    assert.equal(typeof checkCiVerified, "function");
  });

  it("runReleaseGateCheck is a function", () => {
    assert.equal(typeof runReleaseGateCheck, "function");
  });
});

// ── 6. computeTokenDigest ──────────────────────────────────────────

describe("computeTokenDigest", () => {
  it("returns sha256: prefix with hex digest", () => {
    const digest = computeTokenDigest("test-token");
    assert.ok(digest.startsWith("sha256:"));
    // sha256 hex is 64 chars + "sha256:" prefix = 71 chars
    assert.equal(digest.length, 71);
  });

  it("does not contain the raw token", () => {
    const TOKEN = "test-token";
    const digest = computeTokenDigest(TOKEN);
    assert.ok(!digest.includes(TOKEN), "digest must not contain the raw token");
  });

  it("is deterministic for the same input", () => {
    const d1 = computeTokenDigest("abc");
    const d2 = computeTokenDigest("abc");
    assert.equal(d1, d2);
  });
});
