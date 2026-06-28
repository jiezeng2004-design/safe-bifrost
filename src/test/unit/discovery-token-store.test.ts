import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  issueToken,
  consumeToken,
  peekToken,
  revokeToken,
  clearAllTokens,
  getActiveTokenCount,
  type IssueTokenInput,
} from "../../security/discoveryTokenStore.js";
import { PatchWardenError } from "../../errors.js";

// ── Helpers ───────────────────────────────────────────────────────

function todayDatePart(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function sampleInput(overrides: Partial<IssueTokenInput> = {}): IssueTokenInput {
  return {
    toolName: "read_workspace_file",
    risk: "workspace_read_sensitive",
    query: "read file",
    schemaDigest: "sha256:abc123",
    profile: "full",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("discoveryTokenStore", () => {
  beforeEach(() => {
    clearAllTokens();
  });

  describe("issueToken", () => {
    it("返回 dst_ 前缀 + 日期 + 12 位 hex 格式", () => {
      const token = issueToken(sampleInput());
      const regex = new RegExp(`^dst_${todayDatePart()}_[a-f0-9]{12}$`);
      assert.ok(regex.test(token), `token "${token}" should match dst_YYYYMMDD_hex12`);
    });

    it("默认 expiresAt 为 issuedAt + 10 分钟", () => {
      const token = issueToken(sampleInput());
      const record = peekToken(token);
      assert.ok(record, "record should exist");
      const diff = Date.parse(record!.expiresAt) - Date.parse(record!.issuedAt);
      // 允许 50ms 容差（两次 Date.now 调用间微小差异）
      assert.ok(
        Math.abs(diff - 600000) <= 50,
        `expected diff ~600000ms, got ${diff}ms`
      );
    });

    it("自定义 ttlMs 反映到 expiresAt", () => {
      const token = issueToken(sampleInput({ ttlMs: 30000 }));
      const record = peekToken(token);
      assert.ok(record);
      const diff = Date.parse(record!.expiresAt) - Date.parse(record!.issuedAt);
      assert.ok(
        Math.abs(diff - 30000) <= 50,
        `expected diff ~30000ms, got ${diff}ms`
      );
    });

    it("保存 record 字段完整", () => {
      const token = issueToken(sampleInput({ allowedScope: ["src/"] }));
      const record = peekToken(token);
      assert.ok(record);
      assert.equal(record!.token, token);
      assert.equal(record!.toolName, "read_workspace_file");
      assert.equal(record!.risk, "workspace_read_sensitive");
      assert.deepEqual(record!.allowedScope, ["src/"]);
      assert.equal(record!.query, "read file");
      assert.equal(record!.schemaDigest, "sha256:abc123");
      assert.equal(record!.profile, "full");
    });
  });

  describe("consumeToken", () => {
    it("成功返回 record 并删除（单次使用）", () => {
      const token = issueToken(sampleInput());
      const record = consumeToken(token);
      assert.equal(record.token, token);
      // 再次 consume 应抛 token_not_found
      assert.throws(
        () => consumeToken(token),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "token_not_found");
          return true;
        }
      );
    });

    it("不存在抛 token_not_found", () => {
      assert.throws(
        () => consumeToken("dst_nonexistent_000000000000"),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "token_not_found");
          return true;
        }
      );
    });

    it("过期抛 token_expired", () => {
      // 用负 ttlMs 构造已过期 token
      const token = issueToken(sampleInput({ ttlMs: -1000 }));
      assert.throws(
        () => consumeToken(token),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "token_expired");
          return true;
        }
      );
    });

    it("过期 token 被消费后从 store 删除", () => {
      const token = issueToken(sampleInput({ ttlMs: -1000 }));
      assert.throws(() => consumeToken(token));
      // peek 应返回 null（已删除）
      assert.equal(peekToken(token), null);
    });
  });

  describe("peekToken", () => {
    it("不消费 token（peek 后 consume 仍成功）", () => {
      const token = issueToken(sampleInput());
      const peeked = peekToken(token);
      assert.ok(peeked);
      assert.equal(peeked!.token, token);
      // peek 后 consume 仍能成功
      const consumed = consumeToken(token);
      assert.equal(consumed.token, token);
    });

    it("不存在返回 null", () => {
      assert.equal(peekToken("dst_nonexistent_000000000000"), null);
    });
  });

  describe("revokeToken", () => {
    it("删除 token，返回 true", () => {
      const token = issueToken(sampleInput());
      assert.equal(revokeToken(token), true);
      assert.equal(peekToken(token), null);
    });

    it("不存在返回 false", () => {
      assert.equal(revokeToken("dst_nonexistent_000000000000"), false);
    });
  });

  describe("clearAllTokens", () => {
    it("清空所有 token", () => {
      issueToken(sampleInput());
      issueToken(sampleInput());
      assert.equal(getActiveTokenCount(), 2);
      clearAllTokens();
      assert.equal(getActiveTokenCount(), 0);
    });
  });

  describe("getActiveTokenCount", () => {
    it("正确返回当前 token 数量", () => {
      assert.equal(getActiveTokenCount(), 0);
      issueToken(sampleInput());
      assert.equal(getActiveTokenCount(), 1);
      issueToken(sampleInput());
      assert.equal(getActiveTokenCount(), 2);
    });
  });
});
