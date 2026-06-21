# PatchWarden

Current release: **v0.4.0**. See the
[v0.4.0 release notes](docs/release-v0.4.0.md).

> **Renamed in v0.4.0:** PatchWarden replaces the former Safe-Bifrost package.
> This is an intentional pre-1.0 breaking rename with new CLI, environment,
> configuration, and runtime paths. See the
> [migration guide](docs/migration-from-safe-bifrost.md).

PatchWarden is a local Model Context Protocol (MCP) bridge for safe
plan-and-execute coding workflows.

It lets ChatGPT, Codex, Claude, or another MCP client save a plan, create a
workspace-scoped task, let a local agent execute it, and then read back the
result, git diff, test log, and task status.

![PatchWarden ChatGPT connector demo](docs/assets/patchwarden-chatgpt-demo.svg)

## Why

Many local coding bridges give the upstream model broad shell access.
PatchWarden takes a narrower route:

```text
ChatGPT Web or another MCP client
-> PatchWarden MCP tools
-> save_plan / create_task
-> watcher finds pending tasks
-> local agent executes
-> result.md / result.json / diff.patch / verify.json / status.json
-> client reviews the result
```

The MCP client can plan and review, but it does not receive a general shell
tool.

## Features

- MCP stdio server with workspace-scoped tools.
- Optional HTTP MCP server bound to `127.0.0.1`.
- ChatGPT Connector / OpenAI Secure MCP Tunnel workflow.
- Automatic watcher for pending tasks.
- Local runner that captures `result.md`, `git.diff`, `test.log`, and
  `status.json`.
- Task phases, heartbeat timestamps, progress reports, cancellation, forced
  termination, and bounded task timeouts.
- Server-side `wait_for_task` long polling so ChatGPT can remain in one tool
  loop until the agent reaches a terminal state.
- `create_task` accepts a saved `plan_id`, an auditable `inline_plan`, or one
  of five guarded task templates.
- A supervised Windows tunnel launcher retries recoverable disconnects and
  writes local, redacted runtime health state.
- Structured `result.json`, `verify.json`, `diff.patch`, and
  `get_task_summary` acceptance evidence.
- Workspace-wide before/after fingerprints that fail a task when changes are
  detected outside its explicit `repo_path`.
- Before/after file fingerprints for stronger change evidence.
- File reads contained to one configured `workspaceRoot`.
- Sensitive file blocking for `.env`, tokens, SSH keys, credentials, cookies,
  and similar paths.
- Low-risk plan storage: ordinary build/test/release language is accepted;
  explicit credential theft, destructive disk deletion, and backdoor plans are blocked.
- Task artifacts are returned with secret-like values redacted instead of
  failing the entire read.
- Pending task artifacts return structured `available: false` evidence with
  task phase, watcher health, pending reason, and the next safe tool call.
- Structured `result.json`, `verify.json`, and `get_task_summary` values are
  recursively redacted and report `redacted` plus `redaction_categories`.
- Agent command allowlist through `patchwarden.config.json`.
- Test command exact-match allowlist.
- Windows-friendly helper scripts.
- Read-only `doctor` command for local setup diagnostics.

## MCP Tools and Profiles

PatchWarden has two deterministic tool profiles. `full` is the default for
ordinary local development and exposes all tools listed below. The Windows
tunnel stdio wrapper explicitly uses `chatgpt_core`, a stable 16-tool profile
ordered for the create/wait/review loop:

`health_check`, `list_agents`, `list_workspace`, `read_workspace_file`,
`save_plan`, `create_task`, `wait_for_task`, `get_task_summary`, `get_diff`,
`get_result`, `get_result_json`, `get_test_log`, `get_task_status`, `list_tasks`,
`cancel_task`, `audit_task`.

The full profile exposes:

- `list_workspace`
- `read_workspace_file`
- `save_plan`
- `get_plan`
- `health_check`
- `list_agents`
- `create_task`
- `get_task_status`
- `get_result`
- `get_result_json`
- `get_diff`
- `get_test_log`
- `list_tasks`
- `cancel_task`
- `kill_task`
- `retry_task`
- `get_task_progress`
- `wait_for_task`
- `get_task_summary`
- `get_task_stdout_tail`
- `get_task_log_tail`
- `audit_task`

## Install

Requirements:

- Node.js 18 or newer
- npm
- Git, if you want `git.diff`
- A configured local coding agent such as `opencode` or `codex`

Windows PowerShell:

```powershell
cd path\to\patchwarden
npm.cmd ci
npm.cmd run build
npm.cmd test
```

Linux, macOS, or WSL:

```bash
cd patchwarden
npm ci
npm run build
npm test
```

## Configure

Create `patchwarden.config.json` in the project root. Do not commit this
file.

```json
{
  "workspaceRoot": "D:/path/to/test-or-project-workspace",
  "plansDir": ".patchwarden/plans",
  "tasksDir": ".patchwarden/tasks",
  "toolProfile": "full",
  "agents": {
    "opencode": {
      "command": "opencode",
      "args": ["run", "{prompt}"]
    }
  },
  "allowedTestCommands": [
    "npm test",
    "npm run build",
    "npm run doctor",
    "npm run check:tool-manifest"
  ],
  "maxReadFileBytes": 200000,
  "defaultTaskTimeoutSeconds": 900,
  "maxTaskTimeoutSeconds": 3600,
  "watcherStaleSeconds": 30,
  "httpPort": 7331
}
```

Important rules:

- Use a small project directory for `workspaceRoot`.
- Do not set `workspaceRoot` to a drive root, home directory, Desktop,
  Downloads, or Documents.
- Do not place secrets inside the workspace.
- Keep agent commands and test commands narrow.

## Run Locally

Build first:

```powershell
npm.cmd run build
```

Run the stdio MCP server:

```powershell
$env:PATCHWARDEN_CONFIG = "path\to\patchwarden.config.json"
node dist\index.js
```

Run the watcher in another terminal:

```powershell
$env:PATCHWARDEN_CONFIG = "path\to\patchwarden.config.json"
npm.cmd run watch
```

Run the HTTP MCP server for local tunnel mode:

```powershell
$env:PATCHWARDEN_CONFIG = "path\to\patchwarden.config.json"
npm.cmd run start:http
```

The HTTP server binds only to `127.0.0.1`.

## ChatGPT Connector

The intended ChatGPT flow is:

```text
ChatGPT Web
-> ChatGPT Connector
-> OpenAI Secure MCP Tunnel
-> PatchWarden MCP server
-> watcher
-> local agent
```

For stdio tunnel mode on Windows, use the launcher:

```text
scripts/patchwarden-mcp-stdio.cmd
```

This wrapper sets `PATCHWARDEN_CONFIG`, changes into the PatchWarden project
root, and starts `node dist/index.js`. It prevents tunnel-client from using
the tunnel-client directory as the MCP workspace.

### One-Click Windows Launcher

For local development, run:

```text
Start-PatchWarden-Tunnel.cmd
```

The launcher:

- asks for your tunnel runtime API key on first use, then stores it encrypted
  with Windows DPAPI under `%APPDATA%\patchwarden`
- asks for a tunnel ID if `PATCHWARDEN_TUNNEL_ID` is not already set
- starts a hidden watcher owned by the launcher when no healthy external watcher exists
- supervises only its owned watcher and retries stale/exited instances with a
  capped 2/5/10/20/30-second backoff
- runs machine-readable `tunnel-client doctor` checks
- performs a real stdio MCP `initialize` plus `tools/list` preflight and stops
  before tunnel startup if the core tools or v0.4.0 schemas are missing
- supervises `tunnel-client run`, probes readiness, and retries recoverable
  exits with a capped 5/10/20/30-second backoff
- stops on non-retryable authentication, configuration, region, or control
  plane errors instead of looping blindly

Optional environment variables:

```powershell
$env:PATCHWARDEN_TUNNEL_ID = "tunnel_xxx"
$env:TUNNEL_CLIENT_EXE = "C:\path\to\tunnel-client.exe"
$env:OPENCODE_BIN_DIR = "C:\path\to\opencode-ai\bin"
$env:HTTPS_PROXY = "http://127.0.0.1:7892"
$env:PATCHWARDEN_CREDENTIAL_PATH = "C:\private\patchwarden-key.dpapi"
```

The saved key is bound to the current Windows user and computer. It is never
written to the repository or printed to logs. To remove it, run
`Reset-PatchWarden-Tunnel-Key.cmd`.

Never commit API keys, runtime keys, tunnel IDs, local account names, or
private workspace IDs.

If ChatGPT reports a tunnel 404 or cannot call any MCP tool, run:

```text
Check-PatchWarden-Health.cmd
```

This local-only diagnostic reports source/dist version, the actual MCP process
source, tool profile/count/names/schema hash, workspace/tasks access, watcher
freshness, configured agents, tunnel readiness, and other detected
PatchWarden processes. It only warns about mixed versions and never ends a
process. Runtime status is stored under `%LOCALAPPDATA%\patchwarden\runtime`
and does not contain the API key or Tunnel ID.

For an expanded read-only diagnosis, call
`health_check({"detail":"self_diagnostic"})`. It adds allowlist counts,
configured agents, recent task failures, and catalog consistency evidence
without creating a task that depends on the watcher.

If you need to fully restart everything (after a config change, version
upgrade, or hung process), double-click:

```text
Restart-PatchWarden.cmd
```

This stops only the process tree recorded as owned by the current launcher,
rebuilds the project, clears stale runtime state, and opens a fresh tunnel
launcher window. It does not stop unrelated or legacy PatchWarden instances.

## Demo

See [docs/demo.md](docs/demo.md) for a privacy-safe ChatGPT connector demo and
expected outputs.

## Troubleshooting

### ChatGPT lists the tunnel-client directory

If `list_workspace` returns only `tunnel-client.exe`, the MCP child process did
not receive `PATCHWARDEN_CONFIG` or started from the wrong working directory.

Fix: use `scripts/patchwarden-mcp-stdio.cmd` as the tunnel MCP command, then
restart tunnel-client.

### ChatGPT tool call times out

Check the tunnel-client UI at:

```text
http://127.0.0.1:8080/ui
```

If logs show:

```text
unsupported_country_region_territory
403 Forbidden
```

then the current proxy exit region is not supported by the OpenAI API control
plane. Change to a supported region and restart tunnel-client.

### ChatGPT stops after `create_task`

An MCP server cannot send a new message into ChatGPT after the assistant turn
has ended. Do not rely on a prompt that says only "wait and check later".
Immediately call `wait_for_task` after `create_task`. If its response contains
`continuation_required: true`, call it again in the same assistant turn. When
`terminal: true`, use the included summary and then call `audit_task` for the
independent review. Each wait is capped at 30 seconds to stay below common
connector and tunnel request timeouts.

### ChatGPT still shows an older tool list

Tool catalogs can remain attached to a connector session that was opened
before the tunnel was refreshed. First run `Check-PatchWarden-Health.cmd` and
confirm `configured_tunnel_manifest.tool_profile` is `chatgpt_core`, its
`tool_count` is 16, and the next tunnel status reports `core_tools_ready` as
true. Then refresh or reconnect the Connector and open a
new ChatGPT conversation. Do not use the old conversation as proof that the
new schema was loaded. `health_check` exposes `server_version`, `schema_epoch`,
and `tool_manifest_sha256` so the same tool names with stale schemas can still
be distinguished.

If an old conversation calls a tool that is no longer in the active profile,
PatchWarden returns `tool_catalog_mismatch` with the current tool manifest and
refresh instructions instead of a generic unavailable-tool error.

### Task remains queued and watcher is stale

`create_task`, `get_task_status`, `list_tasks`, and pending artifact reads all
return the same watcher evidence. A stale or missing watcher leaves the task
saved but sets `execution_blocked: true`, `continuation_required: false`, and
points to `health_check`. The Windows launcher automatically retries only the
watcher process it created; external and legacy instances are never stopped.

If logs show direct connection timeouts to `api.openai.com`, set a proxy:

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7892"
```

### ChatGPT Connector creation fails

Verify:

- tunnel-client is running
- the tunnel is associated with the correct ChatGPT workspace
- the connector uses `Channel`, not `Server URL`
- authentication is set to `None` unless you have implemented OAuth
- browser translation extensions are disabled on Platform pages

## Recommended Workflow

Start with `health_check` and `list_agents`. `create_task` requires an explicit
`repo_path`; it never silently falls back to the workspace root. Prefer
`verify_commands` from the exact schema allowlist. Immediately enter the
`wait_for_task(timeout_seconds: 25)` loop and keep calling it while
`continuation_required` is true. The legacy `wait_seconds` name remains
supported; if both aliases are sent, their values must match. Each wait
defaults to 25 seconds and is capped at 30 seconds.
Use `cancel_task` for graceful cancellation or `kill_task` for immediate
termination. Final acceptance starts with `get_task_summary`, followed by
`audit_task` and any detailed artifacts needed for review.

Do not use the entire `workspaceRoot` as the task repository unless that is
truly the intended repository. Prefer a relative subdirectory such as
`desktop-pet-wangzai`; absolute paths are also accepted when they resolve
inside `workspaceRoot`.

`create_task` requires exactly one plan source: `plan_id`, `inline_plan`, or
`template`. The existing `save_plan` flow remains compatible. A shorter inline
flow looks like:

```json
{
  "agent": "opencode",
  "repo_path": "desktop-pet-wangzai",
  "inline_plan": "Implement the requested small feature without changing unrelated files.",
  "verify_commands": [
    "npm run build",
    "npm test"
  ]
}
```

Guarded templates are `inspect_only`, `feature_small`, `fix_tests`,
`release_check`, and `rollback_scope_violation`. Template tasks also require a
`goal`; the rollback review additionally requires `source_task_id` and never
performs an automatic rollback. `inspect_only` and rollback review tasks fail
with `failed_policy_violation` if they change repository files.

`list_tasks` accepts `status`, `repo_path`, `active_only`, and `limit`. Each
entry includes its computed `pending_reason` and watcher state.

1. `list_workspace` — explore the project
2. `save_plan` — ChatGPT writes the implementation plan
3. `create_task` with `repo_path` and `verify_commands`
4. `wait_for_task` — repeat in the same turn until `terminal: true`
5. `get_task_summary` — inspect scope, verification, files, and artifacts
6. `get_result_json` / `get_diff` / `get_test_log` — inspect detailed evidence
7. `audit_task` — independent verification (checks claims vs reality)

> **Important:**
> - `task done` means the agent finished executing — it does NOT mean the work is correct or complete.
> - `failed_scope_violation` takes precedence over acceptance. Review
>   `rollback_scope_violation_plan.md`; PatchWarden never auto-rolls back concurrent/user edits.
> - `failed_verification` means at least one independent allow-listed command failed;
>   inspect `verify.log` before retrying.
> - `failed_policy_violation` means a no-changes template unexpectedly changed
>   repository files; inspect the diff and use the backup-first follow-up prompt.
> - `audit_task` provides an independent review, but still requires human judgment.
> - Local `result.md` claims about `npm publish`, `git push`, or `GitHub release` are **unverified**.
> - Publishing, tagging, pushing, and npm publish must be confirmed manually.
> - Before running `doctor`, create `patchwarden.config.json` from the example template.

### Task artifacts

- `result.md`: human-readable execution report and agent output.
- `result.json`: structured status, paths, changed files, scope evidence,
  verification state, warnings, errors, and next steps for tools.
- `verify.json`: one structured record per independently executed allow-listed
  verification command, including cwd, exit code, output tails, and timing.
- `verify.log`: readable form of the same independent verification evidence.
- `diff.patch`: complete task change evidence. `get_diff.patch_mode` is
  `textual`, `no_changes`, or `hash_only`; hash-only responses include an
  `unavailable_reason`. Large textual responses return a bounded patch head,
  byte counts, truncation evidence, and the complete local `diff_patch_path`.
- `file-stats.json`: standalone per-file additions/deletions and aggregate counts.
- `rollback_scope_violation_plan.md`: review-only list of repo-external changes;
  it never includes normal in-repo changes and never performs rollback itself.

## Security Model

PatchWarden intentionally avoids general shell execution through MCP tools.

- MCP clients cannot pass arbitrary shell commands.
- Agent commands must be configured ahead of time.
- Test commands must match `allowedTestCommands` exactly.
- File reads are contained to `workspaceRoot`.
- Sensitive file names are blocked even inside the workspace.
- The runner does not commit, push, delete files, or reset repositories.
- HTTP mode binds to `127.0.0.1` only.

This is still a local automation bridge. Treat connector access as powerful
and use a dedicated test workspace first.

## Development

Windows PowerShell:

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor
npm.cmd run check:tool-manifest
npm.cmd run test:tunnel-supervisor
npm.cmd run test:watcher-supervisor
npm.cmd run pack:clean
```

Package checks:

```powershell
npm.cmd run verify:package
npm.cmd run pack:clean
```

The clean archive excludes:

- `node_modules/`
- `.patchwarden/`
- `*.log`
- `.env`
- `patchwarden.config.json`
- local release artifacts

## Roadmap

- [x] stdio MCP server
- [x] plan and task CRUD
- [x] runner and watcher
- [x] HTTP MCP server
- [x] ChatGPT Connector tunnel docs
- [x] doctor command
- [ ] worktree isolation
- [ ] multi-agent task queue
- [ ] dashboard

## License

MIT
