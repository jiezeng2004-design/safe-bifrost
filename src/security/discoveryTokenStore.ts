/**
 * v0.8.1: discovery token store — server-side token store for invoke_discovered_tool.
 *
 * discover_tools 为每个搜索结果生成 discoveryToken，server-side 保存 token 真实信息。
 * invoke_discovered_tool 只接受 token id（不信任客户端回传的 token JSON）。
 *
 * 安全契约：
 * - 不引入第三方 npm 依赖（用 node:crypto 的 randomBytes）
 * - 不持久化到磁盘（内存 Map，进程内共享，单例）
 * - token 单次使用语义（consumeToken 后即删除）
 */

import { randomBytes } from "node:crypto";
import { PatchWardenError } from "../errors.js";
import type { ToolRisk } from "../tools/toolRegistry.js";
import type { ToolProfile } from "../tools/toolCatalog.js";

// ── 类型定义 ──────────────────────────────────────────────────────

export interface DiscoveryTokenRecord {
  token: string;           // token id，格式 dst_{YYYYMMDD}_{randomHex12}
  toolName: string;        // 该 token 授权调用的工具名
  risk: ToolRisk;          // 该工具的风险等级
  allowedScope?: string[]; // 允许的文件 scope（可选）
  issuedAt: string;        // ISO 时间戳
  expiresAt: string;       // ISO 时间戳，默认 issuedAt + 10 分钟
  query: string;           // discover_tools 时的查询词
  schemaDigest: string;    // 工具 inputSchema 的 sha256 digest
  profile: ToolProfile;    // discover 时的 profile
}

export interface IssueTokenInput {
  toolName: string;
  risk: ToolRisk;
  query: string;
  schemaDigest: string;
  profile: ToolProfile;
  allowedScope?: string[];
  ttlMs?: number; // 默认 10 * 60 * 1000（10 分钟）
}

// ── 常量 ──────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 分钟

// ── 模块级 token store（单例，进程内共享） ───────────────────────

const tokenStore = new Map<string, DiscoveryTokenRecord>();

// ── 内部工具 ──────────────────────────────────────────────────────

function formatDatePart(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function generateTokenId(): string {
  const datePart = formatDatePart(new Date());
  const randomPart = randomBytes(6).toString("hex"); // 12 位 hex
  return `dst_${datePart}_${randomPart}`;
}

// ── 公共 API ──────────────────────────────────────────────────────

/**
 * 生成并保存 discovery token，返回 token id。
 * token id 格式：dst_{YYYYMMDD}_{randomHex12}
 */
export function issueToken(input: IssueTokenInput): string {
  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
  const token = generateTokenId();

  const record: DiscoveryTokenRecord = {
    token,
    toolName: input.toolName,
    risk: input.risk,
    allowedScope: input.allowedScope,
    issuedAt,
    expiresAt,
    query: input.query,
    schemaDigest: input.schemaDigest,
    profile: input.profile,
  };

  tokenStore.set(token, record);
  return token;
}

/**
 * 消费 token（单次使用语义）。
 * - 不存在 → 抛 PatchWardenError("token_not_found")
 * - 过期（expiresAt 早于现在）→ 抛 PatchWardenError("token_expired")
 * - 有效 → 从 store 删除并返回 record
 */
export function consumeToken(tokenId: string): DiscoveryTokenRecord {
  const record = tokenStore.get(tokenId);
  if (!record) {
    throw new PatchWardenError(
      "token_not_found",
      `Discovery token not found: ${tokenId}`,
      "Call discover_tools to obtain a fresh discovery token before invoking invoke_discovered_tool.",
      true,
      { token: tokenId }
    );
  }

  const now = Date.now();
  const expiresAtMs = Date.parse(record.expiresAt);
  if (expiresAtMs < now) {
    // 过期 token 从 store 删除，避免累积
    tokenStore.delete(tokenId);
    throw new PatchWardenError(
      "token_expired",
      `Discovery token expired: ${tokenId}`,
      "Call discover_tools again to obtain a fresh discovery token.",
      true,
      { token: tokenId, expired_at: record.expiresAt }
    );
  }

  tokenStore.delete(tokenId);
  return record;
}

/**
 * 只读查看 token，不消费、不校验过期。
 * 不存在返回 null，存在返回 record（不删除）。
 */
export function peekToken(tokenId: string): DiscoveryTokenRecord | null {
  const record = tokenStore.get(tokenId);
  return record ?? null;
}

/**
 * 撤销 token，返回是否删除成功。
 */
export function revokeToken(tokenId: string): boolean {
  return tokenStore.delete(tokenId);
}

/**
 * 清空所有 token（测试用）。
 */
export function clearAllTokens(): void {
  tokenStore.clear();
}

/**
 * 返回当前 store 中的 token 数量（测试/诊断用）。
 */
export function getActiveTokenCount(): number {
  return tokenStore.size;
}
