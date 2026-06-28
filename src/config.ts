import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// ── Type definitions ──────────────────────────────────────────────

export interface AgentConfig {
  command: string;
  args: string[];
}

export interface PatchWardenConfig {
  workspaceRoot: string;
  plansDir: string;
  tasksDir: string;
  assessmentsDir: string;
  assessmentTtlSeconds: number;
  agents: Record<string, AgentConfig>;
  allowedTestCommands: string[];
  repoAllowedTestCommands?: Record<string, string[]>;
  maxReadFileBytes: number;
  defaultTaskTimeoutSeconds: number;
  maxTaskTimeoutSeconds: number;
  watcherStaleSeconds: number;
  toolProfile?: "full" | "chatgpt_core" | "chatgpt_direct" | "chatgpt_search";
  repoAliases?: Record<string, string>;
  enableAgentAssessment?: boolean;
  agentAssessmentTimeoutSeconds?: number;
  agentAssessmentMaxOutputBytes?: number;
  agentAssessmentAgentName?: string;
  enableDirectProfile?: boolean;
  directSessionsDir: string;
  directSessionTtlSeconds: number;
  directMaxPatchBytes: number;
  directMaxFileBytes: number;
  directAllowedCommands?: string[];
  repoDirectAllowedCommands?: Record<string, string[]>;
}

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: PatchWardenConfig = {
  workspaceRoot: process.cwd(),
  plansDir: ".patchwarden/plans",
  tasksDir: ".patchwarden/tasks",
  assessmentsDir: ".patchwarden/assessments",
  assessmentTtlSeconds: 3600,
  agents: {
    codex: {
      command: "codex",
      args: ["exec", "--cd", "{repo}", "{prompt}"],
    },
    opencode: {
      command: "opencode",
      args: ["run", "{prompt}"],
    },
  },
  allowedTestCommands: [
    "npm test",
    "npm run test",
    "npm run lint",
    "npm run format:check",
    "npm run build",
    "npm run dist",
    "npm run doctor",
    "pnpm test",
    "pnpm run test",
    "pnpm run lint",
    "pnpm run format:check",
    "pnpm run build",
    "pnpm run dist",
    "pnpm run doctor",
    "pytest",
    "cargo test",
  ],
  repoAllowedTestCommands: {},
  maxReadFileBytes: 200_000,
  defaultTaskTimeoutSeconds: 900,
  maxTaskTimeoutSeconds: 3600,
  watcherStaleSeconds: 30,
  toolProfile: "full",
  enableAgentAssessment: false,
  agentAssessmentTimeoutSeconds: 120,
  agentAssessmentMaxOutputBytes: 524288,
  enableDirectProfile: false,
  directSessionsDir: ".patchwarden/direct-sessions",
  directSessionTtlSeconds: 3600,
  directMaxPatchBytes: 200_000,
  directMaxFileBytes: 500_000,
  directAllowedCommands: [
    "npm test",
    "npm run test",
    "npm run build",
    "npm run lint",
    "node --check main.js",
  ],
  repoDirectAllowedCommands: {},
};

// ── Load config ───────────────────────────────────────────────────

let _config: PatchWardenConfig | null = null;

export function loadConfig(configPath?: string): PatchWardenConfig {
  if (_config) return _config;
  return loadConfigInternal(configPath);
}

export function reloadConfig(configPath?: string): PatchWardenConfig {
  _config = null;
  return loadConfigInternal(configPath);
}

function loadConfigInternal(configPath?: string): PatchWardenConfig {
  const explicitPath = configPath || process.env.PATCHWARDEN_CONFIG;
  const candidatePaths = explicitPath
    ? [explicitPath]
    : [
        resolve(process.cwd(), "patchwarden.config.json"),
        resolve(process.cwd(), ".patchwarden.json"),
      ];

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        const rawText = stripBom(readFileSync(p, "utf-8"));
        const raw = JSON.parse(rawText);
        _config = normalizeConfig({ ...DEFAULT_CONFIG, ...raw } as PatchWardenConfig);
        return _config;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to load PatchWarden config "${p}": ${message}`);
      }
    }
  }

  if (explicitPath) {
    throw new Error(`PatchWarden config not found: "${explicitPath}"`);
  }

  _config = normalizeConfig({ ...DEFAULT_CONFIG });
  return _config;
}

export function getConfig(): PatchWardenConfig {
  if (!_config) return loadConfig();
  return _config;
}

/** Resolve workspaceRoot: expand relative paths */
export function resolveWorkspaceRoot(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot);
}

/** Resolve plans/tasks dirs relative to workspaceRoot */
export function getPlansDir(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot, config.plansDir);
}

export function getTasksDir(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot, config.tasksDir);
}

export function getAssessmentsDir(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot, config.assessmentsDir);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function normalizeConfig(config: PatchWardenConfig): PatchWardenConfig {
  if (!config.workspaceRoot || typeof config.workspaceRoot !== "string") {
    throw new Error("workspaceRoot must be a non-empty string");
  }
  if (!config.plansDir || typeof config.plansDir !== "string") {
    throw new Error("plansDir must be a non-empty string");
  }
  if (!config.tasksDir || typeof config.tasksDir !== "string") {
    throw new Error("tasksDir must be a non-empty string");
  }
  if (!config.assessmentsDir || typeof config.assessmentsDir !== "string") {
    throw new Error("assessmentsDir must be a non-empty string");
  }
  if (!Number.isInteger(config.assessmentTtlSeconds) || config.assessmentTtlSeconds < 60 || config.assessmentTtlSeconds > 86400) {
    throw new Error("assessmentTtlSeconds must be an integer from 60 to 86400");
  }
  if (!config.agents || typeof config.agents !== "object") {
    throw new Error("agents must be an object");
  }
  if (!Array.isArray(config.allowedTestCommands)) {
    throw new Error("allowedTestCommands must be an array");
  }
  if (config.allowedTestCommands.some((command) => typeof command !== "string" || command.trim() === "")) {
    throw new Error("allowedTestCommands must contain only non-empty command strings");
  }
  if (!config.repoAllowedTestCommands || typeof config.repoAllowedTestCommands !== "object" || Array.isArray(config.repoAllowedTestCommands)) {
    throw new Error("repoAllowedTestCommands must be an object mapping workspace-relative repository paths to command arrays");
  }
  const repoAllowedTestCommands: Record<string, string[]> = {};
  for (const [repoKey, commands] of Object.entries(config.repoAllowedTestCommands)) {
    const normalizedKey = normalizeRepoKey(repoKey);
    const resolvedRepo = resolve(config.workspaceRoot, normalizedKey);
    const relativeRepo = relative(resolve(config.workspaceRoot), resolvedRepo);
    if (isAbsolute(repoKey) || relativeRepo === ".." || relativeRepo.startsWith(`..${sep}`) || isAbsolute(relativeRepo)) {
      throw new Error(`repoAllowedTestCommands key must stay inside workspaceRoot: "${repoKey}"`);
    }
    if (!Array.isArray(commands) || commands.some((command) => typeof command !== "string" || command.trim() === "")) {
      throw new Error(`repoAllowedTestCommands["${repoKey}"] must be an array of non-empty command strings`);
    }
    repoAllowedTestCommands[normalizedKey] = [...new Set(commands.map((command) => command.trim()))];
  }
  if (!Number.isFinite(config.maxReadFileBytes) || config.maxReadFileBytes <= 0) {
    throw new Error("maxReadFileBytes must be a positive number");
  }
  if (!Number.isInteger(config.defaultTaskTimeoutSeconds) || config.defaultTaskTimeoutSeconds <= 0) {
    throw new Error("defaultTaskTimeoutSeconds must be a positive integer");
  }
  if (!Number.isInteger(config.maxTaskTimeoutSeconds) || config.maxTaskTimeoutSeconds <= 0) {
    throw new Error("maxTaskTimeoutSeconds must be a positive integer");
  }
  if (config.defaultTaskTimeoutSeconds > config.maxTaskTimeoutSeconds) {
    throw new Error("defaultTaskTimeoutSeconds cannot exceed maxTaskTimeoutSeconds");
  }
  if (!Number.isInteger(config.watcherStaleSeconds) || config.watcherStaleSeconds < 5 || config.watcherStaleSeconds > 3600) {
    throw new Error("watcherStaleSeconds must be an integer from 5 to 3600");
  }
  if (
    config.toolProfile !== undefined &&
    config.toolProfile !== "full" &&
    config.toolProfile !== "chatgpt_core" &&
    config.toolProfile !== "chatgpt_direct" &&
    config.toolProfile !== "chatgpt_search"
  ) {
    throw new Error('toolProfile must be "full", "chatgpt_core", "chatgpt_direct", or "chatgpt_search"');
  }
  if (config.enableAgentAssessment !== undefined && typeof config.enableAgentAssessment !== "boolean") {
    throw new Error("enableAgentAssessment must be a boolean");
  }
  if (config.agentAssessmentTimeoutSeconds !== undefined) {
    if (!Number.isInteger(config.agentAssessmentTimeoutSeconds) || config.agentAssessmentTimeoutSeconds < 10 || config.agentAssessmentTimeoutSeconds > 600) {
      throw new Error("agentAssessmentTimeoutSeconds must be an integer from 10 to 600");
    }
  }
  if (config.agentAssessmentMaxOutputBytes !== undefined) {
    if (!Number.isInteger(config.agentAssessmentMaxOutputBytes) || config.agentAssessmentMaxOutputBytes < 16384 || config.agentAssessmentMaxOutputBytes > 8388608) {
      throw new Error("agentAssessmentMaxOutputBytes must be an integer from 16384 to 8388608");
    }
  }
  if (config.agentAssessmentAgentName !== undefined && typeof config.agentAssessmentAgentName !== "string") {
    throw new Error("agentAssessmentAgentName must be a string");
  }
  if (config.enableDirectProfile !== undefined && typeof config.enableDirectProfile !== "boolean") {
    throw new Error("enableDirectProfile must be a boolean");
  }
  if (!config.directSessionsDir || typeof config.directSessionsDir !== "string") {
    throw new Error("directSessionsDir must be a non-empty string");
  }
  if (!Number.isInteger(config.directSessionTtlSeconds) || config.directSessionTtlSeconds < 60 || config.directSessionTtlSeconds > 86400) {
    throw new Error("directSessionTtlSeconds must be an integer from 60 to 86400");
  }
  if (!Number.isInteger(config.directMaxPatchBytes) || config.directMaxPatchBytes <= 0) {
    throw new Error("directMaxPatchBytes must be a positive integer");
  }
  if (!Number.isInteger(config.directMaxFileBytes) || config.directMaxFileBytes <= 0) {
    throw new Error("directMaxFileBytes must be a positive integer");
  }
  if (config.directAllowedCommands !== undefined) {
    if (!Array.isArray(config.directAllowedCommands)) {
      throw new Error("directAllowedCommands must be an array");
    }
    if (config.directAllowedCommands.some((command) => typeof command !== "string" || command.trim() === "")) {
      throw new Error("directAllowedCommands must contain only non-empty command strings");
    }
  }
  if (config.repoDirectAllowedCommands !== undefined) {
    if (typeof config.repoDirectAllowedCommands !== "object" || Array.isArray(config.repoDirectAllowedCommands)) {
      throw new Error("repoDirectAllowedCommands must be an object mapping workspace-relative repository paths to command arrays");
    }
    const repoDirectAllowedCommands: Record<string, string[]> = {};
    for (const [repoKey, commands] of Object.entries(config.repoDirectAllowedCommands)) {
      const normalizedKey = normalizeRepoKey(repoKey);
      const resolvedRepo = resolve(config.workspaceRoot, normalizedKey);
      const relativeRepo = relative(resolve(config.workspaceRoot), resolvedRepo);
      if (isAbsolute(repoKey) || relativeRepo === ".." || relativeRepo.startsWith(`..${sep}`) || isAbsolute(relativeRepo)) {
        throw new Error(`repoDirectAllowedCommands key must stay inside workspaceRoot: "${repoKey}"`);
      }
      if (!Array.isArray(commands) || commands.some((command) => typeof command !== "string" || command.trim() === "")) {
        throw new Error(`repoDirectAllowedCommands["${repoKey}"] must be an array of non-empty command strings`);
      }
      repoDirectAllowedCommands[normalizedKey] = [...new Set(commands.map((command) => command.trim()))];
    }
    config.repoDirectAllowedCommands = repoDirectAllowedCommands;
  }

  return {
    ...config,
    workspaceRoot: resolve(config.workspaceRoot),
    allowedTestCommands: [...new Set(config.allowedTestCommands.map((command) => command.trim()))],
    repoAllowedTestCommands,
  };
}

export function getRepoAllowedTestCommands(config: PatchWardenConfig, repoPath: string): string[] {
  const target = comparablePath(resolve(repoPath));
  for (const [repoKey, commands] of Object.entries(config.repoAllowedTestCommands || {})) {
    if (comparablePath(resolve(config.workspaceRoot, repoKey)) === target) return [...commands];
  }
  return [];
}

export function getAllConfiguredTestCommands(config: PatchWardenConfig): string[] {
  return [...new Set([
    ...config.allowedTestCommands,
    ...Object.values(config.repoAllowedTestCommands || {}).flat(),
  ])];
}

export function getDirectSessionsDir(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot, config.directSessionsDir);
}

export function getRepoDirectAllowedCommands(config: PatchWardenConfig, repoPath: string): string[] {
  const target = comparablePath(resolve(repoPath));
  for (const [repoKey, commands] of Object.entries(config.repoDirectAllowedCommands || {})) {
    if (comparablePath(resolve(config.workspaceRoot, repoKey)) === target) return [...commands];
  }
  return [];
}

export function getAllConfiguredDirectCommands(config: PatchWardenConfig): string[] {
  return [...new Set([
    ...(config.directAllowedCommands || []),
    ...Object.values(config.repoDirectAllowedCommands || {}).flat(),
  ])];
}

function normalizeRepoKey(value: string): string {
  const trimmed = String(value).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return trimmed === "" ? "." : trimmed;
}

function comparablePath(value: string): string {
  const normalized = resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
