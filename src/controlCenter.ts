#!/usr/bin/env node
/**
 * PatchWarden Control Center — local HTTP dashboard service.
 *
 * Binds to 127.0.0.1 only. Serves the static UI from `ui/` and exposes a set
 * of fault-tolerant JSON APIs for inspecting runtime state and driving
 * `scripts/control/manage-patchwarden.ps1` for process lifecycle.
 *
 * Run: node dist/controlCenter.js
 *   or: npm run start:control
 *
 * Port override: PATCHWARDEN_CONTROL_PORT=<n>  or  --port <n>
 */

import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { homedir } from "node:os";
import {
  getTasksDir,
  getDirectSessionsDir,
  loadConfig,
  resolveWorkspaceRoot,
  type PatchWardenConfig,
} from "./config.js";
import { listTasks, type TaskEntry } from "./tools/listTasks.js";
import { listAgents, type AgentAvailability } from "./tools/listAgents.js";
import { readWatcherStatus, type WatcherStatusSnapshot } from "./watcherStatus.js";
import { redactSensitiveContent } from "./security/contentRedaction.js";
import { guardWorkspacePath } from "./security/pathGuard.js";
import { auditTask } from "./tools/auditTask.js";
import { PATCHWARDEN_VERSION, TOOL_SCHEMA_EPOCH } from "./version.js";

// ── Paths ─────────────────────────────────────────────────────────

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = join(projectRoot, "ui");
const manageScriptPath = join(projectRoot, "scripts", "control", "manage-patchwarden.ps1");
const PAGE_ALIASES: Record<string, string> = {
  "/dashboard.html": "pages/dashboard.html",
  "/tasks.html": "pages/tasks.html",
  "/workspace.html": "pages/workspace.html",
  "/audit.html": "pages/audit.html",
  "/task-detail.html": "pages/task-detail.html",
  "/direct-sessions.html": "pages/direct-sessions.html",
  "/logs.html": "pages/logs.html",
};

// ── Config (fault-tolerant bootstrap) ─────────────────────────────

function createFallbackConfig(): PatchWardenConfig {
  return {
    workspaceRoot: process.cwd(),
    plansDir: ".patchwarden/plans",
    tasksDir: ".patchwarden/tasks",
    assessmentsDir: ".patchwarden/assessments",
    assessmentTtlSeconds: 3600,
    agents: {},
    allowedTestCommands: [],
    repoAllowedTestCommands: {},
    maxReadFileBytes: 200_000,
    defaultTaskTimeoutSeconds: 900,
    maxTaskTimeoutSeconds: 3600,
    watcherStaleSeconds: 30,
    toolProfile: "full",
    enableDirectProfile: false,
    directSessionsDir: ".patchwarden/direct-sessions",
    directSessionTtlSeconds: 3600,
    directMaxPatchBytes: 200_000,
    directMaxFileBytes: 500_000,
  };
}

let config: PatchWardenConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(
    `[control-center] WARNING: Failed to load config (${errorMessage(err)}). Using fallback defaults.`
  );
  config = createFallbackConfig();
}

// ── Control token (in-memory only) ────────────────────────────────

const controlToken = randomUUID();

// ── Port resolution ───────────────────────────────────────────────

function resolvePort(): number {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && i + 1 < argv.length) {
      const n = parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    const m = arg.match(/^--port=(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  const envPort = parseInt(process.env.PATCHWARDEN_CONTROL_PORT || "", 10);
  if (Number.isFinite(envPort) && envPort >= 0) return envPort;
  return 8090;
}

const port = resolvePort();
const host = "127.0.0.1";

// Core/Direct probe base URLs — overridable for tests so the smoke test does
// not depend on the real 8080/8081 ports being free on the host.
const CORE_BASE_URL = process.env.PATCHWARDEN_CORE_URL || "http://127.0.0.1:8080";
const DIRECT_BASE_URL = process.env.PATCHWARDEN_DIRECT_URL || "http://127.0.0.1:8081";
const DEFAULT_TUNNEL_CLIENT_EXE = "D:\\ai_agent\\tunnel-client-v0.0.9--context-conduit-topaz-windows-amd64\\tunnel-client.exe";
const CONTROL_CENTER_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0a0e14"/>
  <path d="M32 52s17-8 17-27V14L32 8 15 14v11c0 19 17 27 17 27z" fill="#111820" stroke="#2dd4a8" stroke-width="4" stroke-linejoin="round"/>
  <path d="M24 32l6 6 12-14" fill="none" stroke="#2dd4a8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// ── Helpers ───────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getRuntimeRoot(direct: boolean): string {
  const base =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "patchwarden")
      : join(homedir(), ".patchwarden");
  return join(base, direct ? "runtime-direct" : "runtime");
}

function getControlCenterLogDir(): string {
  // Test/local override: when set to an absolute path, use it directly so the
  // smoke test can redirect status/events/log files into a sandbox-writable
  // directory under the project root instead of LOCALAPPDATA.
  const override = process.env.PATCHWARDEN_CONTROL_LOG_DIR;
  if (override && isAbsolute(override)) return override;
  const base =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "patchwarden")
      : join(homedir(), ".patchwarden");
  return join(base, "control-center");
}

// Status + events files live alongside the control-center logs so the launcher
// can discover a running instance without probing the port blindly.
const controlCenterStatusPath = join(getControlCenterLogDir(), "control-center-status.json");
const controlCenterEventsPath = join(getControlCenterLogDir(), "control-center-events.jsonl");
const MAX_EVENT_LINES = 2000;

const ALLOWED_LOG_TAILS = new Set([100, 300, 1000]);

function resolveTailParam(value: string | null): number {
  if (value === null) return 100;
  const n = parseInt(value, 10);
  if (Number.isFinite(n) && ALLOWED_LOG_TAILS.has(n)) return n;
  return 100;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  let payload: string;
  try {
    payload = JSON.stringify(body);
  } catch (err) {
    payload = JSON.stringify({ error: `serialization failed: ${errorMessage(err)}` });
    status = 500;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function checkControlToken(req: IncomingMessage): boolean {
  const header = req.headers["x-patchwarden-control-token"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== "string" || provided.length === 0) return false;
  return provided === controlToken;
}

function readBody(req: IncomingMessage): Promise<unknown | null> {
  return new Promise((resolve) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > 1024 * 1024) {
        aborted = true;
        try { req.destroy(); } catch { /* ignore */ }
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf-8");
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function readJsonFileSafe<T = unknown>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as T;
  } catch {
    return null;
  }
}

function readTextFileSafe(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function readFileTail(filePath: string, lines = 100): string {
  if (!existsSync(filePath)) return "";
  const content = readFileSync(filePath, "utf-8");
  const allLines = content.split(/\r?\n/);
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  return allLines.slice(-lines).join("\n");
}

function findLatestLog(dir: string, pattern: RegExp): string | null {
  if (!existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries.filter((e) => e.isFile() && pattern.test(e.name));
  if (files.length === 0) return null;
  let latestName = files[0].name;
  let latestMtime = -1;
  for (const f of files) {
    try {
      const m = statSync(join(dir, f.name)).mtimeMs;
      if (m > latestMtime) {
        latestMtime = m;
        latestName = f.name;
      }
    } catch {
      /* keep current */
    }
  }
  return join(dir, latestName);
}

// ── Health probing ────────────────────────────────────────────────

interface HealthProbe {
  available: boolean;
  status: number | null;
  reason: string | null;
}

function probeHealthStatus(targetUrl: string): Promise<HealthProbe> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result: HealthProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
      finish({ available: false, status: null, reason: "timeout after 2000ms" });
    }, 2000);
    try {
      const req = httpGet(targetUrl, { signal: controller.signal }, (resp) => {
        resp.resume();
        const status = resp.statusCode ?? 0;
        // Only 2xx counts as available. A 404 from an unrelated service (or a
        // 4xx/5xx from the real service) must NOT be treated as healthy.
        if (status >= 200 && status < 300) {
          finish({ available: true, status, reason: null });
        } else {
          finish({ available: false, status, reason: `unexpected status ${status}` });
        }
      });
      req.on("error", (err) => {
        finish({ available: false, status: null, reason: err.message });
      });
    } catch (err) {
      finish({ available: false, status: null, reason: errorMessage(err) });
    }
  });
}

interface RuntimeHealth {
  available: boolean;
  reason: string | null;
  healthz: { status: number } | null;
  readyz: { status: number } | null;
}

async function probeRuntimeHealth(baseUrl: string): Promise<RuntimeHealth> {
  const [h, r] = await Promise.all([
    probeHealthStatus(`${baseUrl}/healthz`),
    probeHealthStatus(`${baseUrl}/readyz`),
  ]);
  if (h.available && r.available && h.status !== null && r.status !== null) {
    return { available: true, reason: null, healthz: { status: h.status }, readyz: { status: r.status } };
  }
  const failed = !h.available ? h : r;
  return { available: false, reason: failed.reason ?? "unavailable", healthz: null, readyz: null };
}

// ── Runtime file readers ──────────────────────────────────────────

function readTunnelStatus(direct: boolean): Record<string, unknown> {
  const filePath = join(getRuntimeRoot(direct), "tunnel-status.json");
  if (!existsSync(filePath)) return { observed: false };
  try {
    const data = readJsonFileSafe<Record<string, unknown>>(filePath);
    if (data === null) return { observed: true, error: "invalid JSON" };
    return { observed: true, ...data };
  } catch (err) {
    return { observed: true, error: errorMessage(err) };
  }
}

interface ToolManifestSummary {
  tool_profile: string | null;
  tool_count: number | null;
  schema_epoch: string | null;
  tool_manifest_sha256: string | null;
  tool_names: string[] | null;
}

function readToolManifest(direct: boolean): ToolManifestSummary {
  const empty: ToolManifestSummary = {
    tool_profile: null,
    tool_count: null,
    schema_epoch: null,
    tool_manifest_sha256: null,
    tool_names: null,
  };
  const filePath = join(getRuntimeRoot(direct), "tool-manifest.json");
  if (!existsSync(filePath)) return empty;
  const data = readJsonFileSafe<Record<string, unknown>>(filePath);
  if (!data) return empty;
  return {
    tool_profile: typeof data.tool_profile === "string" ? data.tool_profile : null,
    tool_count: typeof data.tool_count === "number" ? data.tool_count : null,
    schema_epoch: typeof data.schema_epoch === "string" ? data.schema_epoch : null,
    tool_manifest_sha256: typeof data.tool_manifest_sha256 === "string" ? data.tool_manifest_sha256 : null,
    tool_names: Array.isArray(data.tool_names) ? (data.tool_names as string[]) : null,
  };
}

function readTunnelUrl(direct: boolean): { url: string | null; reason: string | null } {
  const filePath = join(getRuntimeRoot(direct), "tunnel-health-url.txt");
  if (!existsSync(filePath)) return { url: null, reason: "tunnel-health-url.txt not found" };
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return { url: null, reason: "tunnel-health-url.txt is empty" };
    return { url: content, reason: null };
  } catch (err) {
    return { url: null, reason: errorMessage(err) };
  }
}

// ── Safe wrappers around reusable modules ─────────────────────────

function readWatcherStatusSafe(): WatcherStatusSnapshot {
  try {
    return readWatcherStatus(config);
  } catch (err) {
    return {
      status: "unreadable",
      available: false,
      stale_after_seconds: config.watcherStaleSeconds,
      last_heartbeat_at: null,
      heartbeat_age_seconds: null,
      heartbeat_pid: null,
      instance_id: null,
      launcher_pid: null,
      reason: errorMessage(err),
      activity: null,
    };
  }
}

function listAgentsSafe(): AgentAvailability[] {
  try {
    return listAgents().agents;
  } catch {
    return [];
  }
}

function resolveWorkspaceRootSafe(): string | null {
  try {
    return resolveWorkspaceRoot(config);
  } catch {
    return null;
  }
}

interface StatusTasks {
  tasks: unknown[];
  total: number;
  active: number;
  stale: number;
  stale_task_ids: string[];
  reason: string | null;
}

// ── Stale task classification ─────────────────────────────────────

interface StaleClassification {
  is_stale: boolean;
  stale_reasons: string[];
}

const TERMINAL_TASK_STATUSES = new Set([
  "done",
  "failed",
  "failed_verification",
  "failed_scope_violation",
  "failed_policy_violation",
  "canceled",
  "timeout",
]);

/**
 * Classify a task as stale based on Phase 2 rules:
 *  - status=running but last_heartbeat_at exceeds threshold
 *  - phase=collecting_artifacts exceeds threshold
 *  - current_command=null AND watcher currently healthy
 *  - task last_heartbeat_at significantly earlier than current watcher heartbeat
 *
 * Only pending/running tasks can be stale; terminal tasks are never stale.
 */
function classifyStaleTask(
  task: TaskEntry,
  watcher: WatcherStatusSnapshot,
  nowMs = Date.now()
): StaleClassification {
  const reasons: string[] = [];
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return { is_stale: false, stale_reasons: reasons };
  }
  // Only pending/running are candidates for staleness.
  if (task.status !== "pending" && task.status !== "running") {
    return { is_stale: false, stale_reasons: reasons };
  }

  const staleThresholdMs = config.watcherStaleSeconds * 1000;
  const hbMs = Date.parse(task.last_heartbeat_at || "");
  const heartbeatAgeMs = Number.isFinite(hbMs) ? Math.max(0, nowMs - hbMs) : null;

  // Rule 1: running with stale heartbeat
  if (task.status === "running" && heartbeatAgeMs !== null && heartbeatAgeMs > staleThresholdMs) {
    reasons.push("heartbeat_stale");
  }

  // Rule 2: collecting_artifacts phase exceeds threshold
  if (task.phase === "collecting_artifacts" && heartbeatAgeMs !== null && heartbeatAgeMs > staleThresholdMs) {
    reasons.push("collecting_artifacts_stale");
  }

  // Rule 3: running with no current_command while watcher is healthy
  if (
    task.status === "running" &&
    (task.current_command === null || task.current_command === "") &&
    watcher.status === "healthy"
  ) {
    reasons.push("running_no_command_watcher_healthy");
  }

  // Rule 4: task heartbeat significantly earlier than watcher heartbeat
  if (heartbeatAgeMs !== null && watcher.last_heartbeat_at) {
    const watcherHbMs = Date.parse(watcher.last_heartbeat_at);
    if (Number.isFinite(watcherHbMs)) {
      const gapMs = watcherHbMs - hbMs;
      // Task heartbeat is "significantly earlier" than watcher heartbeat when
      // the task has not heartbeat for at least 2x the stale threshold while
      // the watcher is alive.
      if (gapMs > staleThresholdMs * 2 && watcher.status === "healthy") {
        reasons.push("heartbeat_far_behind_watcher");
      }
    }
  }

  return { is_stale: reasons.length > 0, stale_reasons: reasons };
}

function augmentTaskWithStale(task: TaskEntry, watcher: WatcherStatusSnapshot, nowMs = Date.now()): TaskEntry & StaleClassification {
  const cls = classifyStaleTask(task, watcher, nowMs);
  return { ...task, is_stale: cls.is_stale, stale_reasons: cls.stale_reasons };
}

function listTasksForStatus(): StatusTasks {
  try {
    const result = listTasks({ limit: 100 });
    const watcher = result.watcher;
    const now = Date.now();
    let active = 0;
    let stale = 0;
    const staleTaskIds: string[] = [];
    const augmented = result.tasks.map((t) => {
      const a = augmentTaskWithStale(t, watcher, now);
      if (t.status === "pending" || t.status === "running") active++;
      if (a.is_stale) {
        stale++;
        staleTaskIds.push(t.task_id);
      }
      return a;
    });
    return { tasks: augmented, total: result.total, active, stale, stale_task_ids: staleTaskIds, reason: null };
  } catch (err) {
    return { tasks: [], total: 0, active: 0, stale: 0, stale_task_ids: [], reason: errorMessage(err) };
  }
}

// ── manage-patchwarden.ps1 invocation ─────────────────────────────

interface ManageResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runManageAction(action: string, mode: string): Promise<ManageResult> {
  return new Promise((resolveP, rejectP) => {
    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", manageScriptPath, action, mode, "-Background"],
        { cwd: projectRoot, windowsHide: true }
      );
    } catch (err) {
      rejectP(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      rejectP(new Error(`manage-patchwarden.ps1 timed out after 60s (action=${action}, mode=${mode})`));
    }, 60_000);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectP(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

// ── Static file serving ───────────────────────────────────────────

function serveStatic(res: ServerResponse, urlPath: string): void {
  let candidate = "";
  try {
    const normalized = urlPath.startsWith("/") ? urlPath.slice(1) : urlPath;
    let decoded: string;
    try {
      decoded = decodeURIComponent(normalized);
    } catch {
      sendJson(res, 400, { error: "Invalid path encoding" });
      return;
    }
    if (decoded.includes("\0")) {
      sendJson(res, 400, { error: "Invalid path" });
      return;
    }
    const segments = decoded.split("/").filter(Boolean);
    if (segments.some((s) => s === "..")) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    candidate = resolve(uiRoot, ...segments);
    const rel = relative(uiRoot, candidate);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
    return;
  }
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const ext = extname(candidate).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
    const content = readFileSync(candidate);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

function serveFavicon(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(CONTROL_CENTER_FAVICON);
}

// ── Control Center status file + activity timeline ────────────────

interface ControlCenterStatusFile {
  pid: number;
  port: number;
  started_at: string;
  url: string;
  version: string;
}

function writeStatusFile(): void {
  const status: ControlCenterStatusFile = {
    pid: process.pid,
    port,
    started_at: new Date().toISOString(),
    url: `http://${host}:${port}/`,
    version: PATCHWARDEN_VERSION,
  };
  try {
    mkdirSync(getControlCenterLogDir(), { recursive: true });
    writeFileSync(controlCenterStatusPath, JSON.stringify(status, null, 2), "utf-8");
  } catch (err) {
    console.error(`[control-center] Failed to write status file: ${errorMessage(err)}`);
  }
}

function removeStatusFile(): void {
  try {
    if (existsSync(controlCenterStatusPath)) {
      unlinkSync(controlCenterStatusPath);
    }
  } catch (err) {
    console.error(`[control-center] Failed to remove status file: ${errorMessage(err)}`);
  }
}

interface ControlCenterEvent {
  timestamp: string;
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * Append a single event line to the JSONL timeline. Best-effort: a write
 * failure is logged but never crashes the server. Trims the file to
 * MAX_EVENT_LINES lazily when it grows past 1.5x the cap, so we don't pay the
 * trim cost on every event.
 */
function recordEvent(type: string, payload?: Record<string, unknown>): void {
  const event: ControlCenterEvent = {
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
  try {
    mkdirSync(getControlCenterLogDir(), { recursive: true });
    appendFileSync(controlCenterEventsPath, JSON.stringify(event) + "\n", "utf-8");
  } catch (err) {
    console.error(`[control-center] Failed to write event: ${errorMessage(err)}`);
  }
  // Lazy trim: only when the file grows well past the cap.
  try {
    const stat = statSync(controlCenterEventsPath);
    if (stat.size > 512 * 1024) {
      trimEventsFile();
    }
  } catch {
    /* ignore */
  }
}

function trimEventsFile(): void {
  try {
    if (!existsSync(controlCenterEventsPath)) return;
    const raw = readFileSync(controlCenterEventsPath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length <= MAX_EVENT_LINES) return;
    const trimmed = lines.slice(lines.length - MAX_EVENT_LINES);
    writeFileSync(controlCenterEventsPath, trimmed.join("\n") + "\n", "utf-8");
  } catch (err) {
    console.error(`[control-center] Failed to trim events file: ${errorMessage(err)}`);
  }
}

function readEvents(limit: number): ControlCenterEvent[] {
  if (!existsSync(controlCenterEventsPath)) return [];
  try {
    const raw = readFileSync(controlCenterEventsPath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    const sliced = lines.slice(Math.max(0, lines.length - limit));
    const events: ControlCenterEvent[] = [];
    for (const line of sliced) {
      try {
        events.push(JSON.parse(line) as ControlCenterEvent);
      } catch {
        /* skip malformed line */
      }
    }
    return events;
  } catch {
    return [];
  }
}

// ── Health suggestions ────────────────────────────────────────────

interface Suggestion {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  action?: string;
  link?: string;
}

interface StatusSnapshotForSuggestions {
  core: RuntimeHealth;
  direct: RuntimeHealth;
  watcher: WatcherStatusSnapshot;
  tunnel: { core: Record<string, unknown>; direct: Record<string, unknown> };
  agents: AgentAvailability[];
  tasks: StatusTasks;
}

function buildSuggestions(s: StatusSnapshotForSuggestions): Suggestion[] {
  const out: Suggestion[] = [];

  if (!s.core.available) {
    out.push({
      code: "core_stopped",
      severity: "warning",
      message: "Core 未运行，建议启动 Core profile",
      action: "/api/core/start",
    });
  }
  if (!s.direct.available) {
    out.push({
      code: "direct_stopped",
      severity: "warning",
      message: "Direct 未运行，建议启动 Direct profile",
      action: "/api/direct/start",
    });
  }

  if (s.watcher.status === "stale" || s.watcher.status === "unreadable") {
    out.push({
      code: "watcher_stale",
      severity: "error",
      message: "Watcher 处于 " + s.watcher.status + " 状态，建议 Restart All",
      action: "/api/restart-all",
    });
  }

  if (s.tasks.stale > 0) {
    out.push({
      code: "stale_task",
      severity: "warning",
      message: "存在 " + s.tasks.stale + " 个 stale 任务，建议查看并 reconcile",
      link: "/pages/tasks.html?filter=stale",
    });
  }

  const coreTunnelReady = !!(s.tunnel.core && s.tunnel.core.ready);
  const directTunnelReady = !!(s.tunnel.direct && s.tunnel.direct.ready);
  if (!coreTunnelReady || !directTunnelReady) {
    out.push({
      code: "tunnel_not_ready",
      severity: "warning",
      message: "Tunnel 未就绪，建议重启 profile 或检查代理",
      action: "/api/restart-all",
    });
  }

  const missingAgents = s.agents.filter((a) => !a.available);
  if (missingAgents.length > 0) {
    out.push({
      code: "agent_missing",
      severity: "info",
      message: "Agent 未就绪：" + missingAgents.map((a) => a.name).join(", ") + "（请检查 opencode/claude 路径）",
    });
  }

  return out;
}

// ── Observed state-change detection (drives activity timeline) ────

interface StatusSnapshotDigest {
  core_available: boolean;
  direct_available: boolean;
  watcher_status: string;
  task_statuses: Record<string, string>;
}

let lastStatusDigest: StatusSnapshotDigest | null = null;

function buildStatusDigest(s: StatusSnapshotForSuggestions): StatusSnapshotDigest {
  const task_statuses: Record<string, string> = {};
  for (const t of s.tasks.tasks) {
    const entry = t as TaskEntry & StaleClassification;
    task_statuses[entry.task_id] = entry.status;
  }
  return {
    core_available: s.core.available,
    direct_available: s.direct.available,
    watcher_status: s.watcher.status,
    task_statuses,
  };
}

function diffAndRecordEvents(prev: StatusSnapshotDigest, curr: StatusSnapshotDigest): void {
  if (prev.core_available !== curr.core_available) {
    recordEvent("core.status_changed", { from: prev.core_available, to: curr.core_available });
  }
  if (prev.direct_available !== curr.direct_available) {
    recordEvent("direct.status_changed", { from: prev.direct_available, to: curr.direct_available });
  }
  if (prev.watcher_status !== curr.watcher_status) {
    recordEvent("watcher.status_changed", { from: prev.watcher_status, to: curr.watcher_status });
  }
  for (const [taskId, newStatus] of Object.entries(curr.task_statuses)) {
    const oldStatus = prev.task_statuses[taskId];
    if (oldStatus && oldStatus !== newStatus) {
      recordEvent("task.status_changed", { task_id: taskId, from: oldStatus, to: newStatus });
    }
  }
}

// ── API handlers ──────────────────────────────────────────────────

async function handleStatus(res: ServerResponse): Promise<void> {
  try {
    const [coreHealth, directHealth, watcher, tunnelCore, tunnelDirect, toolsCore, toolsDirect, agents, workspaceRoot, tasks] = await Promise.all([
      probeRuntimeHealth(CORE_BASE_URL).catch((err): RuntimeHealth => ({
        available: false,
        reason: errorMessage(err),
        healthz: null,
        readyz: null,
      })),
      probeRuntimeHealth(DIRECT_BASE_URL).catch((err): RuntimeHealth => ({
        available: false,
        reason: errorMessage(err),
        healthz: null,
        readyz: null,
      })),
      Promise.resolve(readWatcherStatusSafe()),
      Promise.resolve(readTunnelStatus(false)),
      Promise.resolve(readTunnelStatus(true)),
      Promise.resolve(readToolManifest(false)),
      Promise.resolve(readToolManifest(true)),
      Promise.resolve(listAgentsSafe()),
      Promise.resolve(resolveWorkspaceRootSafe()),
      Promise.resolve(listTasksForStatus()),
    ]);
    const snapshotForSuggestions: StatusSnapshotForSuggestions = {
      core: coreHealth,
      direct: directHealth,
      watcher,
      tunnel: { core: tunnelCore, direct: tunnelDirect },
      agents,
      tasks,
    };
    const suggestions = buildSuggestions(snapshotForSuggestions);
    const tunnelClientExe = findTunnelClientExecutable();

    // Diff against the previous poll to record observed state-change events.
    // This is the only place that observes Core/Direct/watcher/task transitions
    // (the control center is otherwise stateless and pull-driven).
    const digest = buildStatusDigest(snapshotForSuggestions);
    if (lastStatusDigest) {
      diffAndRecordEvents(lastStatusDigest, digest);
    }
    lastStatusDigest = digest;

    sendJson(res, 200, {
      core: coreHealth,
      direct: directHealth,
      watcher,
      tunnel: { core: tunnelCore, direct: tunnelDirect },
      tools: { core: toolsCore, direct: toolsDirect },
      agents,
      workspace_root: workspaceRoot,
      tasks,
      suggestions,
      setup: {
        tunnel_client: {
          available: tunnelClientExe !== null,
          path: tunnelClientExe,
          default_path: DEFAULT_TUNNEL_CLIENT_EXE,
        },
        workspace_root: workspaceRoot,
        watcher: {
          status: watcher.status,
          available: watcher.available,
          reason: watcher.reason,
        },
      },
    });
  } catch (err) {
    sendJson(res, 200, { error: errorMessage(err), partial: true });
  }
}

function handleTasks(res: ServerResponse): void {
  try {
    const result = listTasks({ limit: 100 });
    const watcher = result.watcher;
    const now = Date.now();
    const augmented = result.tasks.map((t) => augmentTaskWithStale(t, watcher, now));
    const staleCount = augmented.filter((t) => t.is_stale).length;
    sendJson(res, 200, {
      tasks: augmented,
      total: result.total,
      returned: augmented.length,
      watcher,
      stale_count: staleCount,
    });
  } catch (err) {
    sendJson(res, 200, {
      tasks: [],
      total: 0,
      returned: 0,
      watcher: null,
      stale_count: 0,
      error: errorMessage(err),
    });
  }
}

function handleStaleTasks(res: ServerResponse): void {
  try {
    const result = listTasks({ limit: 100 });
    const watcher = result.watcher;
    const now = Date.now();
    const staleTasks = result.tasks
      .map((t) => augmentTaskWithStale(t, watcher, now))
      .filter((t) => t.is_stale);
    sendJson(res, 200, {
      stale_tasks: staleTasks,
      total: staleTasks.length,
      watcher,
      stale_threshold_seconds: config.watcherStaleSeconds,
      reason: null,
    });
  } catch (err) {
    sendJson(res, 200, { stale_tasks: [], total: 0, reason: errorMessage(err) });
  }
}

/**
 * Reconcile a stale task. Does NOT delete the task. Reads the task files,
 * decides whether it is safe to mark the task as stale/archived, writes a
 * reconcile record, and (when safe) annotates status.json with reconcile
 * metadata. The task status enum is never changed — only metadata is added.
 */
function handleReconcile(res: ServerResponse, taskId: string): void {
  try {
    if (
      taskId === "." ||
      taskId === ".." ||
      taskId.includes("/") ||
      taskId.includes("\\") ||
      taskId.includes("\0")
    ) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    const tasksDir = getTasksDir(config);
    const taskDir = join(tasksDir, taskId);
    if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }

    const statusPath = join(taskDir, "status.json");
    const runtimePath = join(taskDir, "runtime.json");
    const statusData = readJsonFileSafe<Record<string, unknown>>(statusPath) ?? {};
    const runtimeData = readJsonFileSafe<Record<string, unknown>>(runtimePath) ?? {};

    const watcher = readWatcherStatusSafe();
    const taskEntry: TaskEntry = {
      task_id: taskId,
      plan_id: String(statusData.plan_id || ""),
      title: "",
      agent: String(statusData.agent || ""),
      status: String(statusData.status || "pending") as TaskEntry["status"],
      phase: String(runtimeData.phase || statusData.phase || "queued") as TaskEntry["phase"],
      created_at: String(statusData.created_at || ""),
      updated_at: String(statusData.updated_at || ""),
      workspace_root: String(statusData.workspace_root || config.workspaceRoot),
      repo_path: String(statusData.repo_path || "."),
      resolved_repo_path: String(statusData.resolved_repo_path || statusData.repo_path || config.workspaceRoot),
      test_command: String(statusData.test_command || ""),
      verify_commands: Array.isArray(statusData.verify_commands) ? (statusData.verify_commands as string[]) : [],
      error: statusData.error ? String(statusData.error) : null,
      last_heartbeat_at: String(runtimeData.last_heartbeat_at || statusData.last_heartbeat_at || statusData.updated_at || ""),
      current_command: runtimeData.current_command === undefined ? null : String(runtimeData.current_command || "") || null,
      timeout_seconds: Number(statusData.timeout_seconds) || config.defaultTaskTimeoutSeconds,
      pending_reason: null,
      watcher_status: watcher.status,
    };

    const cls = classifyStaleTask(taskEntry, watcher);
    const isTerminal = TERMINAL_TASK_STATUSES.has(taskEntry.status);

    // Safe to mark stale/archived when:
    //  - terminal status  -> archive (already finished)
    //  - stale AND watcher is not actively driving it (no current_command OR watcher not healthy)
    let decision: "marked_stale" | "marked_archived" | "no_action";
    let safe = false;
    if (isTerminal) {
      decision = "marked_archived";
      safe = true;
    } else if (
      cls.is_stale &&
      (taskEntry.current_command === null || taskEntry.current_command === "" || watcher.status !== "healthy")
    ) {
      decision = "marked_stale";
      safe = true;
    } else {
      decision = "no_action";
      safe = false;
    }

    const reconciledAt = new Date().toISOString();
    const reconcileRecord = {
      task_id: taskId,
      reconciled_at: reconciledAt,
      decision,
      safe,
      previous_status: taskEntry.status,
      previous_phase: taskEntry.phase,
      is_stale: cls.is_stale,
      stale_reasons: cls.stale_reasons,
      watcher_status: watcher.status,
      watcher_last_heartbeat_at: watcher.last_heartbeat_at,
      task_last_heartbeat_at: taskEntry.last_heartbeat_at || null,
      task_current_command: taskEntry.current_command,
      notes:
        decision === "no_action"
          ? "Task does not currently qualify for safe reconcile (still actively running or watcher is healthy)."
          : "Task annotated with reconcile metadata; original status preserved. No files were deleted.",
    };

    // Write the reconcile record artifact.
    try {
      writeFileSync(join(taskDir, "reconcile.json"), JSON.stringify(reconcileRecord, null, 2), "utf-8");
    } catch (writeErr) {
      sendJson(res, 500, { error: `Failed to write reconcile record: ${errorMessage(writeErr)}` });
      return;
    }

    // Annotate status.json with reconcile metadata (do not mutate status enum).
    if (safe) {
      const annotated = {
        ...statusData,
        reconcile_state: decision === "marked_archived" ? "archived" : "stale",
        reconciled_at: reconciledAt,
      };
      try {
        writeFileSync(statusPath, JSON.stringify(annotated, null, 2), "utf-8");
      } catch (writeErr) {
        sendJson(res, 500, { error: `Failed to annotate status.json: ${errorMessage(writeErr)}` });
        return;
      }
    }

    recordEvent("task.reconciled", {
      task_id: taskId,
      decision,
      safe,
      previous_status: taskEntry.status,
      is_stale: cls.is_stale,
    });
    sendJson(res, 200, reconcileRecord);
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

function handleTaskDetail(res: ServerResponse, taskId: string): void {
  try {
    const tasksDir = getTasksDir(config);
    const taskDir = join(tasksDir, taskId);
    if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }

    const statusData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "status.json"));
    const runtimeData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "runtime.json"));
    const resultData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "result.json"));
    const auditData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "audit.json"));
    const verifyData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "verify.json"));
    const changedFiles = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "changed-files.json"));
    const fileStats = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "file-stats.json"));
    const reconcileData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "reconcile.json"));

    // independent-review.md is the primary audit artifact (written by audit_task)
    const reviewPath = join(taskDir, "independent-review.md");
    let independentReview: { verdict: string | null; content: string | null } = { verdict: null, content: null };
    if (existsSync(reviewPath)) {
      const content = readTextFileSafe(reviewPath) ?? "";
      independentReview = { verdict: parseReviewVerdict(content), content };
    }

    // Verification summary from verify.json
    const verificationSummary = verifyData
      ? {
          status: verifyData.status ?? null,
          commands: Array.isArray(verifyData.commands) ? verifyData.commands : null,
          checked_at: fileMtimeIso(join(taskDir, "verify.json")),
        }
      : null;

    // Warnings / errors collected from status.error, result.warnings, error.log
    const warnings: string[] = [];
    const errors: string[] = [];
    if (statusData && statusData.error) errors.push(String(statusData.error));
    if (resultData && Array.isArray(resultData.warnings)) {
      for (const w of resultData.warnings) warnings.push(String(w));
    }
    if (resultData && resultData.error) errors.push(String(resultData.error));
    const errorLog = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "error.log"));
    if (errorLog && errorLog.message) errors.push(String(errorLog.message));

    // Stale classification (best-effort, using watcher snapshot)
    let stale: StaleClassification | null = null;
    if (statusData) {
      const watcher = readWatcherStatusSafe();
      const entry: TaskEntry = {
        task_id: taskId,
        plan_id: String(statusData.plan_id || ""),
        title: "",
        agent: String(statusData.agent || ""),
        status: String(statusData.status || "pending") as TaskEntry["status"],
        phase: String(runtimeData?.phase || statusData.phase || "queued") as TaskEntry["phase"],
        created_at: String(statusData.created_at || ""),
        updated_at: String(statusData.updated_at || ""),
        workspace_root: String(statusData.workspace_root || config.workspaceRoot),
        repo_path: String(statusData.repo_path || "."),
        resolved_repo_path: String(statusData.resolved_repo_path || statusData.repo_path || config.workspaceRoot),
        test_command: String(statusData.test_command || ""),
        verify_commands: Array.isArray(statusData.verify_commands) ? (statusData.verify_commands as string[]) : [],
        error: statusData.error ? String(statusData.error) : null,
        last_heartbeat_at: String(runtimeData?.last_heartbeat_at || statusData.last_heartbeat_at || statusData.updated_at || ""),
        current_command: runtimeData?.current_command === undefined ? null : String(runtimeData.current_command || "") || null,
        timeout_seconds: Number(statusData.timeout_seconds) || config.defaultTaskTimeoutSeconds,
        pending_reason: null,
        watcher_status: watcher.status,
      };
      stale = classifyStaleTask(entry, watcher);
    }

    sendJson(res, 200, {
      task_id: taskId,
      status: statusData,
      runtime: runtimeData,
      result: resultData,
      audit: auditData,
      independent_review: independentReview,
      diff_patch: readTextFileSafe(join(taskDir, "diff.patch")),
      test_log: readTextFileSafe(join(taskDir, "test.log")) ?? readTextFileSafe(join(taskDir, "test-log.txt")),
      verify_log: readTextFileSafe(join(taskDir, "verify.log")),
      changed_files: changedFiles,
      file_stats: fileStats,
      verification_summary: verificationSummary,
      warnings,
      errors,
      stale,
      reconcile: reconcileData,
      task_dir: taskDir,
    });
  } catch (err) {
    sendJson(res, 200, { task_id: taskId, error: errorMessage(err) });
  }
}

/**
 * Run audit_task for a task. Only safe to delegate when the task directory
 * exists and the task is in a terminal state (auditing a running task mid-flight
 * would race with the watcher writing artifacts).
 */
function handleTaskAudit(res: ServerResponse, taskId: string): void {
  try {
    if (
      taskId === "." ||
      taskId === ".." ||
      taskId.includes("/") ||
      taskId.includes("\\") ||
      taskId.includes("\0")
    ) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    const tasksDir = getTasksDir(config);
    const taskDir = join(tasksDir, taskId);
    if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    const statusData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "status.json"));
    const taskStatus = statusData ? String(statusData.status || "") : "";
    if (!TERMINAL_TASK_STATUSES.has(taskStatus as string)) {
      sendJson(res, 409, {
        error: "Task is not in a terminal state; audit_task can only run safely after completion.",
        status: taskStatus || "unknown",
      });
      return;
    }
    const output = auditTask(taskId);
    recordEvent("task.audited", { task_id: taskId, previous_status: taskStatus });
    sendJson(res, 200, { ok: true, audit: output });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

function handleOpenTaskFolder(res: ServerResponse, taskId: string): void {
  try {
    if (
      taskId === "." ||
      taskId === ".." ||
      taskId.includes("/") ||
      taskId.includes("\\") ||
      taskId.includes("\0")
    ) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    const tasksDir = getTasksDir(config);
    const taskDir = join(tasksDir, taskId);
    if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    let cmd: string;
    if (process.platform === "win32") {
      cmd = "explorer.exe";
    } else if (process.platform === "darwin") {
      cmd = "open";
    } else {
      cmd = "xdg-open";
    }
    try {
      const child = spawn(cmd, [taskDir], { detached: true, stdio: "ignore" });
      child.on("error", () => { /* ignore spawn errors */ });
      child.unref();
    } catch {
      /* ignore */
    }
    sendJson(res, 200, { ok: true, path: taskDir });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

type LogCategory = "core" | "direct" | "watcher" | "control-center";

function handleLogs(res: ServerResponse, category: LogCategory, tailLines: number): void {
  try {
    let dir: string;
    let stdoutPath: string;
    let stderrPath: string;
    let stdoutExists: boolean;
    let stderrExists: boolean;

    if (category === "control-center") {
      dir = getControlCenterLogDir();
      stdoutPath = join(dir, "control-center.stdout.log");
      stderrPath = join(dir, "control-center.stderr.log");
      stdoutExists = existsSync(stdoutPath);
      stderrExists = existsSync(stderrPath);
    } else if (category === "watcher") {
      dir = getRuntimeRoot(false);
      const sp = findLatestLog(dir, /^watcher-.*\.stdout\.log$/);
      const ep = findLatestLog(dir, /^watcher-.*\.stderr\.log$/);
      stdoutPath = sp ?? "";
      stderrPath = ep ?? "";
      stdoutExists = sp !== null;
      stderrExists = ep !== null;
    } else {
      // core | direct -> tunnel client logs in the matching runtime dir
      dir = getRuntimeRoot(category === "direct");
      stdoutPath = join(dir, "tunnel-client.stdout.log");
      stderrPath = join(dir, "tunnel-client.stderr.log");
      stdoutExists = existsSync(stdoutPath);
      stderrExists = existsSync(stderrPath);
    }

    if (!stdoutExists && !stderrExists) {
      sendJson(res, 200, {
        stdout: "",
        stderr: "",
        category,
        tail: tailLines,
        reason: "log file not found",
      });
      return;
    }

    const stdoutRaw = stdoutExists ? readFileTail(stdoutPath, tailLines) : "";
    const stderrRaw = stderrExists ? readFileTail(stderrPath, tailLines) : "";
    const stdout = redactSensitiveContent(stdoutRaw).content;
    const stderr = redactSensitiveContent(stderrRaw).content;
    sendJson(res, 200, { stdout, stderr, category, tail: tailLines, reason: null });
  } catch (err) {
    sendJson(res, 200, { stdout: "", stderr: "", category, tail: tailLines, reason: errorMessage(err) });
  }
}

function handleWorkspace(res: ServerResponse): void {
  let workspaceRoot: string | null = null;
  let directories: string[] = [];
  let agents: AgentAvailability[] = [];
  let configSummary: { toolProfile: string | null; allowedTestCommandsCount: number; enableDirectProfile: boolean } | null = null;

  try {
    workspaceRoot = resolveWorkspaceRoot(config);
  } catch {
    workspaceRoot = null;
  }
  if (workspaceRoot) {
    try {
      directories = readdirSync(workspaceRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      directories = [];
    }
  }
  try {
    agents = listAgents().agents;
  } catch {
    agents = [];
  }
  try {
    configSummary = {
      toolProfile: config.toolProfile ?? null,
      allowedTestCommandsCount: config.allowedTestCommands.length,
      enableDirectProfile: config.enableDirectProfile ?? false,
    };
  } catch {
    configSummary = null;
  }
  sendJson(res, 200, { workspace_root: workspaceRoot, directories, agents, config: configSummary });
}

/**
 * On-demand `git status --short` for a single repo under workspaceRoot.
 * The repo parameter is resolved against workspaceRoot and must stay inside it;
 * any path traversal attempt is rejected with 400. This intentionally does NOT
 * run a full workspace scan — only the repo the user clicked is inspected.
 */
function handleWorkspaceRepoStatus(res: ServerResponse, repoParam: string): void {
  try {
    let workspaceRoot: string;
    try {
      workspaceRoot = resolveWorkspaceRoot(config);
    } catch (err) {
      sendJson(res, 500, { error: `workspace root unavailable: ${errorMessage(err)}` });
      return;
    }

    // Reject obvious traversal in the raw parameter before resolving.
    if (repoParam.includes("\0") || repoParam.includes("..")) {
      sendJson(res, 400, { error: "Invalid repo path: traversal segments are not allowed" });
      return;
    }

    let repoAbs: string;
    try {
      // guardWorkspacePath rejects absolute paths outside workspace and any
      // resolved path that escapes workspaceRoot.
      repoAbs = guardWorkspacePath(repoParam || ".", workspaceRoot);
    } catch (err) {
      sendJson(res, 400, { error: `Invalid repo path: ${errorMessage(err)}` });
      return;
    }

    if (!existsSync(repoAbs) || !statSync(repoAbs).isDirectory()) {
      sendJson(res, 404, { error: "Repo directory not found", repo_path: repoParam });
      return;
    }

    // Only `git status --short` is permitted; no arbitrary git subcommand.
    // Timeout guards against a hung git prompt (e.g. credential dialog).
    execFile(
      "git",
      ["status", "--short"],
      { cwd: repoAbs, maxBuffer: 1024 * 1024, timeout: 8000, windowsHide: true, encoding: "utf-8" },
      (err, stdout, stderr) => {
        if (err) {
          // Not a git repo, git missing, or git errored — return a structured
          // failure rather than 500 so the UI can render it gracefully.
          sendJson(res, 200, {
            repo_path: repoParam,
            resolved_repo_path: repoAbs,
            is_git_repo: false,
            changed_files_count: 0,
            untracked_count: 0,
            modified_count: 0,
            is_clean: true,
            short_status: "",
            error: errorMessage(err),
            stderr: stderr ? String(stderr).slice(0, 500) : "",
          });
          return;
        }
        const text = String(stdout);
        const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
        let modified = 0;
        let untracked = 0;
        for (const line of lines) {
          const xy = line.slice(0, 2);
          if (xy === "??") untracked++;
          else modified++;
        }
        sendJson(res, 200, {
          repo_path: repoParam,
          resolved_repo_path: repoAbs,
          is_git_repo: true,
          changed_files_count: lines.length,
          untracked_count: untracked,
          modified_count: modified,
          is_clean: lines.length === 0,
          short_status: text,
          error: null,
        });
      }
    );
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

// ── Direct sessions ───────────────────────────────────────────────

interface DirectSessionSummary {
  session_id: string;
  repo_path: string;
  resolved_repo_path: string;
  created_at: string;
  expires_at: string;
  finalized: boolean;
  finalized_at: string | null;
  audited: boolean;
  changed_files_total: number | null;
  verification_summary: unknown | null;
  audit_decision: string | null;
  audit_checked_at: string | null;
  title: string;
}

function readDirectSessionSummary(sessionDir: string, sessionId: string): DirectSessionSummary | null {
  const sessionFile = join(sessionDir, "session.json");
  if (!existsSync(sessionFile)) return null;
  const data = readJsonFileSafe<Record<string, unknown>>(sessionFile);
  if (!data) return null;

  // summary.json holds the finalized change summary (changed_files_total, etc.)
  const summaryFile = join(sessionDir, "summary.json");
  const summary = readJsonFileSafe<Record<string, unknown>>(summaryFile);
  const changedFilesTotal = summary
    ? typeof summary.changed_files_total === "number"
      ? summary.changed_files_total
      : null
    : null;

  // audit.json (written by audit_session) holds the audit decision
  const auditFile = join(sessionDir, "audit.json");
  const audit = readJsonFileSafe<Record<string, unknown>>(auditFile);
  const auditDecision = audit
    ? typeof audit.decision === "string"
      ? audit.decision
      : typeof audit.verdict === "string"
        ? audit.verdict
        : null
    : null;
  const auditCheckedAt = audit
    ? typeof audit.checked_at === "string"
      ? audit.checked_at
      : fileMtimeIso(auditFile)
    : null;

  // verification summary: read from session.json verification_runs (last run)
  let verificationSummary: unknown | null = null;
  if (Array.isArray(data.verification_runs) && data.verification_runs.length > 0) {
    const runs = data.verification_runs as Array<Record<string, unknown>>;
    verificationSummary = runs[runs.length - 1];
  }

  return {
    session_id: sessionId,
    repo_path: typeof data.repo_path === "string" ? data.repo_path : "",
    resolved_repo_path: typeof data.resolved_repo_path === "string" ? data.resolved_repo_path : "",
    created_at: typeof data.created_at === "string" ? data.created_at : "",
    expires_at: typeof data.expires_at === "string" ? data.expires_at : "",
    finalized: Boolean(data.finalized),
    finalized_at: typeof data.finalized_at === "string" ? data.finalized_at : null,
    audited: Boolean(data.audited),
    changed_files_total: changedFilesTotal,
    verification_summary: verificationSummary,
    audit_decision: auditDecision,
    audit_checked_at: auditCheckedAt,
    title: typeof data.title === "string" ? data.title : "",
  };
}

function handleDirectSessions(res: ServerResponse): void {
  try {
    const sessionsDir = getDirectSessionsDir(config);
    if (!existsSync(sessionsDir)) {
      // Directory missing -> empty list, never 500.
      sendJson(res, 200, { sessions: [], total: 0, reason: null });
      return;
    }
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (err) {
      sendJson(res, 200, { sessions: [], total: 0, reason: errorMessage(err) });
      return;
    }
    const summaries: DirectSessionSummary[] = [];
    for (const entry of entries) {
      const summary = readDirectSessionSummary(join(sessionsDir, entry.name), entry.name);
      if (summary) summaries.push(summary);
    }
    // Sort by created_at descending.
    summaries.sort((a, b) => b.created_at.localeCompare(a.created_at));
    sendJson(res, 200, { sessions: summaries, total: summaries.length, reason: null });
  } catch (err) {
    sendJson(res, 200, { sessions: [], total: 0, reason: errorMessage(err) });
  }
}

function handleDirectSessionDetail(res: ServerResponse, sessionId: string): void {
  try {
    if (
      sessionId === "." ||
      sessionId === ".." ||
      sessionId.includes("/") ||
      sessionId.includes("\\") ||
      sessionId.includes("\0")
    ) {
      sendJson(res, 400, { error: "Invalid session id" });
      return;
    }
    const sessionsDir = getDirectSessionsDir(config);
    const sessionDir = join(sessionsDir, sessionId);
    if (!existsSync(sessionDir) || !statSync(sessionDir).isDirectory()) {
      sendJson(res, 404, { error: "Direct session not found" });
      return;
    }
    const summary = readDirectSessionSummary(sessionDir, sessionId);
    sendJson(res, 200, {
      session_id: sessionId,
      summary,
      session: readJsonFileSafe(join(sessionDir, "session.json")),
      summary_md: readTextFileSafe(join(sessionDir, "summary.md")),
      diff_patch: readTextFileSafe(join(sessionDir, "diff.patch")),
      audit_json: readJsonFileSafe(join(sessionDir, "audit.json")),
      audit_md: readTextFileSafe(join(sessionDir, "audit.md")),
      changed_files: readJsonFileSafe(join(sessionDir, "changed-files.json")),
    });
  } catch (err) {
    sendJson(res, 200, { session_id: sessionId, error: errorMessage(err) });
  }
}

function parseReviewVerdict(content: string): string | null {
  // independent-review.md format: "**Verdict**: PASS" (case-insensitive)
  const m = content.match(/\*\*Verdict\*\*\s*:\s*([A-Za-z]+)/);
  return m ? m[1].toLowerCase() : null;
}

function fileMtimeIso(filePath: string): string | null {
  try {
    const m = statSync(filePath).mtime;
    return m ? m.toISOString() : null;
  } catch {
    return null;
  }
}

function handleAudit(res: ServerResponse): void {
  try {
    const audits: Array<Record<string, unknown>> = [];

    // 1. tasks/*/independent-review.md (written by audit_task — the primary audit artifact)
    // 2. tasks/*/audit.json (legacy/explicit JSON audit, if present)
    const tasksDir = getTasksDir(config);
    if (existsSync(tasksDir)) {
      let taskEntries: import("node:fs").Dirent[] = [];
      try {
        taskEntries = readdirSync(tasksDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        taskEntries = [];
      }
      for (const entry of taskEntries) {
        const taskDir = join(tasksDir, entry.name);

        // independent-review.md
        const reviewFile = join(taskDir, "independent-review.md");
        if (existsSync(reviewFile)) {
          const content = readTextFileSafe(reviewFile) ?? "";
          audits.push({
            task_id: entry.name,
            source: "independent-review.md",
            verdict: parseReviewVerdict(content),
            checked_at: fileMtimeIso(reviewFile),
            content_excerpt: content.slice(0, 500),
          });
        }

        // audit.json (explicit JSON audit if present)
        const auditFile = join(taskDir, "audit.json");
        if (existsSync(auditFile)) {
          const data = readJsonFileSafe<Record<string, unknown>>(auditFile);
          if (data) {
            audits.push({
              task_id: entry.name,
              source: "audit.json",
              checked_at: data.checked_at ?? fileMtimeIso(auditFile),
              ...data,
            });
          }
        }
      }
    }

    // 3. direct-sessions/*/audit.json (written by Direct audit_session)
    const sessionsDir = getDirectSessionsDir(config);
    if (existsSync(sessionsDir)) {
      let sessionEntries: import("node:fs").Dirent[] = [];
      try {
        sessionEntries = readdirSync(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        sessionEntries = [];
      }
      for (const entry of sessionEntries) {
        const auditFile = join(sessionsDir, entry.name, "audit.json");
        if (!existsSync(auditFile)) continue;
        const data = readJsonFileSafe<Record<string, unknown>>(auditFile);
        if (data) {
          audits.push({
            source: "direct-session",
            session_id: data.session_id ?? entry.name,
            checked_at: fileMtimeIso(auditFile),
            ...data,
          });
        }
      }
    }

    // Sort by checked_at descending (missing timestamps sort last).
    audits.sort((a, b) => {
      const ac = String(a.checked_at ?? "");
      const bc = String(b.checked_at ?? "");
      return bc.localeCompare(ac);
    });
    const limited = audits.slice(0, 50);
    sendJson(res, 200, { audits: limited, total: limited.length });
  } catch (err) {
    sendJson(res, 200, { audits: [], reason: errorMessage(err) });
  }
}

function handleTunnelUiUrl(res: ServerResponse): void {
  sendJson(res, 200, {
    core: readTunnelUrl(false),
    direct: readTunnelUrl(true),
  });
}

type ControlMode = "core" | "direct";

function selectedControlModes(mode: string): ControlMode[] {
  if (mode === "core" || mode === "direct") return [mode];
  return ["core", "direct"];
}

function launcherPathForMode(mode: ControlMode): string {
  const launcherName = mode === "direct" ? "Start-PatchWarden-Direct-Tunnel.cmd" : "Start-PatchWarden-Tunnel.cmd";
  return join(projectRoot, "scripts", "launchers", launcherName);
}

function findExecutableOnPath(fileName: string): string | null {
  const pathValue = process.env.PATH || "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    const direct = join(entry, fileName);
    if (existsSync(direct)) return direct;
    if (process.platform === "win32" && !extname(fileName)) {
      for (const ext of extensions) {
        const candidate = join(entry, fileName + ext.toLowerCase());
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function findTunnelClientExecutable(): string | null {
  if (process.env.PATCHWARDEN_CONTROL_FORCE_MISSING_TUNNEL_CLIENT === "1") return null;
  const explicit = process.env.TUNNEL_CLIENT_EXE || process.env.PATCHWARDEN_TUNNEL_CLIENT_EXE;
  if (explicit && existsSync(explicit)) return explicit;
  const fromPath = findExecutableOnPath("tunnel-client.exe") ?? findExecutableOnPath("tunnel-client");
  if (fromPath) return fromPath;

  const candidates = [
    DEFAULT_TUNNEL_CLIENT_EXE,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "patchwarden", "tunnel-client.exe") : null,
    process.env.APPDATA ? join(process.env.APPDATA, "tunnel-client", "tunnel-client.exe") : null,
    join(homedir(), "tunnel-client", "tunnel-client.exe"),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function preflightManageAction(action: string, mode: string): { status: number; body: Record<string, unknown> } | null {
  if (action !== "start" && action !== "restart") return null;

  const missingLaunchers = selectedControlModes(mode)
    .map((m) => ({ mode: m, path: launcherPathForMode(m) }))
    .filter((entry) => !existsSync(entry.path));
  const tunnelClient = findTunnelClientExecutable();
  const missing: string[] = [];
  if (!tunnelClient) missing.push("tunnel-client.exe");
  for (const entry of missingLaunchers) missing.push(`${entry.mode} launcher`);

  if (missing.length === 0) return null;

  return {
    status: 409,
    body: {
      ok: false,
      action,
      mode,
      error:
        "Control Center preflight failed. Start/restart from the Web UI is non-interactive, so required runtime dependencies must be available before launching.",
      missing,
      next_steps: [
        "Install tunnel-client.exe or set TUNNEL_CLIENT_EXE / PATCHWARDEN_TUNNEL_CLIENT_EXE to its full path.",
        `Default checked path: ${DEFAULT_TUNNEL_CLIENT_EXE}`,
        "Verify the launcher files under scripts/launchers are present.",
        "Then retry from PatchWarden Control Center or PatchWarden-Control-Tray.cmd.",
      ],
    },
  };
}

async function handleManageAction(res: ServerResponse, action: string, mode: string): Promise<void> {
  try {
    const preflight = preflightManageAction(action, mode);
    if (preflight) {
      recordEvent("manage." + mode + "." + action + ".preflight_failed", {
        missing: preflight.body.missing,
      });
      sendJson(res, preflight.status, preflight.body);
      return;
    }
    const result = await runManageAction(action, mode);
    recordEvent("manage." + mode + "." + action, {
      exit_code: result.exitCode,
      ok: result.exitCode === 0,
    });
    sendJson(res, 200, {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (err) {
    recordEvent("manage." + mode + "." + action + ".failed", { error: errorMessage(err) });
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

function handleEvents(res: ServerResponse, limit: number): void {
  const events = readEvents(limit);
  sendJson(res, 200, {
    events,
    total: events.length,
    limit,
  });
}

function handleOpenLogsFolder(res: ServerResponse): void {
  try {
    const target = getRuntimeRoot(false);
    let cmd: string;
    if (process.platform === "win32") {
      cmd = "explorer.exe";
    } else if (process.platform === "darwin") {
      cmd = "open";
    } else {
      cmd = "xdg-open";
    }
    try {
      const child = spawn(cmd, [target], { detached: true, stdio: "ignore" });
      child.on("error", () => { /* ignore spawn errors */ });
      child.unref();
    } catch {
      /* ignore */
    }
    sendJson(res, 200, { ok: true, path: target });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

// ── Request router ────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || host}`);
  const pathname = parsedUrl.pathname;
  const method = (req.method || "GET").toUpperCase();

  // Static routes
  if (method === "GET" && pathname === "/") {
    serveStatic(res, "pages/dashboard.html");
    return;
  }
  const pageAlias = PAGE_ALIASES[pathname];
  if (method === "GET" && pageAlias) {
    serveStatic(res, pageAlias);
    return;
  }
  if (method === "GET" && pathname === "/control-token.json") {
    sendJson(res, 200, { token: controlToken });
    return;
  }
  if (method === "GET" && pathname === "/favicon.ico") {
    serveFavicon(res);
    return;
  }
  if (
    method === "GET" &&
    (pathname === "/colors_and_type.css" ||
      pathname.startsWith("/pages/") ||
      pathname.startsWith("/partials/") ||
      pathname.startsWith("/vendor/"))
  ) {
    serveStatic(res, pathname);
    return;
  }

  // GET API routes
  if (method === "GET" && pathname === "/api/status") {
    await handleStatus(res);
    return;
  }
  if (method === "GET" && pathname === "/api/tasks") {
    handleTasks(res);
    return;
  }
  if (method === "GET" && pathname === "/api/tasks/stale") {
    handleStaleTasks(res);
    return;
  }
  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (method === "GET" && taskMatch) {
    let taskId: string;
    try {
      taskId = decodeURIComponent(taskMatch[1]);
    } catch {
      taskId = taskMatch[1];
    }
    if (
      taskId === "." ||
      taskId === ".." ||
      taskId.includes("/") ||
      taskId.includes("\\") ||
      taskId.includes("\0")
    ) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    handleTaskDetail(res, taskId);
    return;
  }
  // Logs: /api/logs/<category>?tail=<100|300|1000>
  const logsMatch = pathname.match(/^\/api\/logs\/([a-z-]+)$/);
  if (method === "GET" && logsMatch) {
    const rawCat = logsMatch[1];
    const category = rawCat === "core" || rawCat === "direct" || rawCat === "watcher" || rawCat === "control-center"
      ? (rawCat as LogCategory)
      : null;
    if (!category) {
      sendJson(res, 404, { error: "Unknown log category" });
      return;
    }
    const tail = resolveTailParam(parsedUrl.searchParams.get("tail"));
    handleLogs(res, category, tail);
    return;
  }
  if (method === "GET" && pathname === "/api/workspace") {
    handleWorkspace(res);
    return;
  }
  // On-demand git status for a single repo (path-traversal safe).
  // The repo segment is URL-decoded; traversal is rejected by guardWorkspacePath.
  const workspaceRepoMatch = pathname.match(/^\/api\/workspace\/([^/]+(?:\/[^/]+)*)\/status$/);
  if (method === "GET" && workspaceRepoMatch) {
    let repoParam: string;
    try {
      repoParam = decodeURIComponent(workspaceRepoMatch[1]);
    } catch {
      sendJson(res, 400, { error: "Invalid repo path encoding" });
      return;
    }
    handleWorkspaceRepoStatus(res, repoParam);
    return;
  }
  if (method === "GET" && pathname === "/api/direct-sessions") {
    handleDirectSessions(res);
    return;
  }
  const directSessionMatch = pathname.match(/^\/api\/direct-sessions\/([^/]+)$/);
  if (method === "GET" && directSessionMatch) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(directSessionMatch[1]);
    } catch {
      sessionId = directSessionMatch[1];
    }
    handleDirectSessionDetail(res, sessionId);
    return;
  }
  if (method === "GET" && pathname === "/api/audit") {
    handleAudit(res);
    return;
  }
  if (method === "GET" && pathname === "/api/tunnel-ui-url") {
    handleTunnelUiUrl(res);
    return;
  }
  if (method === "GET" && pathname === "/api/events") {
    const limitParam = parsedUrl.searchParams.get("limit");
    let limit = 100;
    if (limitParam !== null) {
      const n = parseInt(limitParam, 10);
      if (Number.isFinite(n) && n > 0 && n <= 1000) limit = n;
    }
    handleEvents(res, limit);
    return;
  }
  if (method === "GET" && pathname === "/api/control-center-status") {
    // Public read of the status file (used by tray/launcher to confirm identity).
    if (!existsSync(controlCenterStatusPath)) {
      sendJson(res, 200, { running: false });
      return;
    }
    const data = readJsonFileSafe<ControlCenterStatusFile>(controlCenterStatusPath);
    if (!data) {
      sendJson(res, 200, { running: false });
      return;
    }
    sendJson(res, 200, { running: true, ...data });
    return;
  }

  // POST API routes (all require control token)
  if (method === "POST") {
    await readBody(req); // drain optional body
    if (!checkControlToken(req)) {
      sendJson(res, 403, { error: "Missing or invalid control token" });
      return;
    }
    if (pathname === "/api/start-all") return handleManageAction(res, "start", "all");
    if (pathname === "/api/stop-all") return handleManageAction(res, "stop", "all");
    if (pathname === "/api/restart-all") return handleManageAction(res, "restart", "all");
    if (pathname === "/api/core/start") return handleManageAction(res, "start", "core");
    if (pathname === "/api/core/stop") return handleManageAction(res, "stop", "core");
    if (pathname === "/api/direct/start") return handleManageAction(res, "start", "direct");
    if (pathname === "/api/direct/stop") return handleManageAction(res, "stop", "direct");
    if (pathname === "/api/open-logs-folder") {
      handleOpenLogsFolder(res);
      return;
    }
    // POST /api/tasks/:taskId/reconcile (token already validated above)
    const reconcileMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/reconcile$/);
    if (reconcileMatch) {
      let taskId: string;
      try {
        taskId = decodeURIComponent(reconcileMatch[1]);
      } catch {
        taskId = reconcileMatch[1];
      }
      handleReconcile(res, taskId);
      return;
    }
    // POST /api/tasks/:taskId/audit — run audit_task safely
    const auditMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/audit$/);
    if (auditMatch) {
      let taskId: string;
      try {
        taskId = decodeURIComponent(auditMatch[1]);
      } catch {
        taskId = auditMatch[1];
      }
      handleTaskAudit(res, taskId);
      return;
    }
    // POST /api/tasks/:taskId/open-folder — open task folder in file explorer
    const openFolderMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/open-folder$/);
    if (openFolderMatch) {
      let taskId: string;
      try {
        taskId = decodeURIComponent(openFolderMatch[1]);
      } catch {
        taskId = openFolderMatch[1];
      }
      handleOpenTaskFolder(res, taskId);
      return;
    }
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

// ── Server bootstrap ──────────────────────────────────────────────

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: errorMessage(err) });
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  });
});

server.on("error", (err) => {
  console.error(`[control-center] Server error: ${errorMessage(err)}`);
  process.exit(1);
});

server.listen(port, host, () => {
  const addr = server.address();
  const formatted = addr && typeof addr === "object" ? `http://${addr.address}:${addr.port}/` : `http://${host}:${port}/`;
  console.error(`[control-center] PatchWarden v${PATCHWARDEN_VERSION} (schema epoch ${TOOL_SCHEMA_EPOCH})`);
  console.error(`[control-center] Workspace: ${config.workspaceRoot}`);
  console.error(`[control-center] Listening: ${formatted}`);
  console.error(`[control-center] Bound to 127.0.0.1 only — not exposed to network`);
  // Persist status file so the launcher can detect a running instance and
  // open the browser without spawning a second server.
  writeStatusFile();
  recordEvent("control_center.started", {
    pid: process.pid,
    port,
    url: formatted,
    version: PATCHWARDEN_VERSION,
  });
});

function shutdown(): void {
  console.error("[control-center] Shutting down...");
  recordEvent("control_center.stopped", { pid: process.pid });
  removeStatusFile();
  server.close(() => {
    try { process.exit(0); } catch { /* ignore */ }
  });
  setTimeout(() => {
    try { process.exit(0); } catch { /* ignore */ }
  }, 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
