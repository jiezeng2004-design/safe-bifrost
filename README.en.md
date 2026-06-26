# PatchWarden

<p align="right">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

[![npm version](https://img.shields.io/npm/v/patchwarden.svg)](https://www.npmjs.com/package/patchwarden)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Current stable release: **v0.6.4**. See the
[release notes](docs/release-v0.6.4.md),
[migration guide](docs/migration-from-safe-bifrost.md), and
[GitHub Release](https://github.com/jiezeng2004-design/PatchWarden/releases/tag/v0.6.4).

PatchWarden is a local-first MCP safety and verification layer for AI coding
agents, with workspace confinement, command allowlists, scope-violation
detection, and auditable task evidence.

ChatGPT, Codex, OpenCode, or another MCP client can plan and review work.
PatchWarden stores that plan as a workspace-scoped task, lets a preconfigured
local agent execute it, and returns results, diffs, artifact manifests, and
independent verification evidence.

![PatchWarden ChatGPT connector demo](docs/assets/patchwarden-chatgpt-demo.svg)

> [!IMPORTANT]
> PatchWarden is not a general-purpose remote shell. MCP clients cannot run
> arbitrary commands: files must remain inside the configured workspace,
> agents must be registered in advance, verification commands must exactly
> match the allowlist, and sensitive paths are blocked.

## Contents

- [What PatchWarden solves](#what-patchwarden-solves)
- [How PatchWarden differs](#how-patchwarden-differs)
- [Evidence example](#evidence-example)
- [Runtime architecture](#runtime-architecture)
- [Requirements](#requirements)
- [Five-minute quick start](#five-minute-quick-start)
- [Complete configuration guide](#complete-configuration-guide)
- [Connect OpenCode](#connect-opencode)
- [Connect Codex](#connect-codex)
- [Connect ChatGPT](#connect-chatgpt)
- [Proxy configuration: read this first](#proxy-configuration-read-this-first)
- [Recommended task workflow](#recommended-task-workflow)
- [HTTP MCP mode](#http-mcp-mode)
- [Diagnostics and health checks](#diagnostics-and-health-checks)
- [Lessons learned and troubleshooting](#lessons-learned-and-troubleshooting)
- [Security boundaries and local data](#security-boundaries-and-local-data)
- [Upgrading and migration](#upgrading-and-migration)
- [Development and release verification](#development-and-release-verification)

## What PatchWarden solves

Many local coding bridges expose a broad shell to the upstream model.
PatchWarden uses a narrower, auditable task channel:

- Upstream models call explicit MCP tools instead of assembling arbitrary
  shell commands.
- Every task must specify a `repo_path` inside `workspaceRoot`.
- Agent launch commands come from local configuration, not model input.
- Verification commands must exactly match `allowedTestCommands`.
- Every completed task records structured results, a full diff, file
  statistics, and independent verification output.
- Changes outside the requested repository cause a scope violation instead of
  being silently accepted.
- Sensitive paths such as `.env` files, tokens, SSH keys, cookies, and
  credential stores are blocked by default.

Good use cases:

- Let ChatGPT plan and review while OpenCode or Codex executes locally.
- Add an auditable plan → task → verify flow to a local MCP client.
- Review `result.json`, `diff.patch`, and `verify.json` after execution.
- Automate tasks that need workspace containment, command allowlists, and
  sensitive-data protection.

PatchWarden is not designed for:

- Giving an MCP client unrestricted shell access.
- Managing an entire drive, home directory, or directory full of private data.
- Unattended commits, pushes, releases, or production changes.

## How PatchWarden differs

PatchWarden sits between an MCP client and local coding tools. It is not a
replacement for every adjacent layer:

| Layer | Primary job | PatchWarden's role |
| --- | --- | --- |
| Sandbox | Isolate a process or filesystem at runtime. | Add task-level policy, evidence, verification, and review records around local agent work. |
| Coding agent | Edit code and run local tools. | Launch only preconfigured agents with trusted argument templates and bounded repositories. |
| Generic MCP server | Expose tools to an MCP client. | Expose a constrained task workflow instead of a broad shell or arbitrary filesystem access. |

The first reusable capability to evaluate independently is:

> Artifact manifest + verified completion evidence

This capability is intentionally small: a task can finish with structured
status, changed-file groups, release-artifact metadata, verification records,
and scope-violation evidence in JSON. Other projects can inspect or adapt that
evidence model without adopting PatchWarden's full runtime.

## Evidence example

A completed task writes bounded, reviewable artifacts under
`.patchwarden/tasks/<task_id>/`. The high-signal files are:

- `result.json` - final status, verification status, changed-file groups, and warnings.
- `artifact_manifest.json` - generated artifacts with size, type, and SHA-256.
- `verify.json` - exact verification commands and exit codes.
- `diff.patch` - complete source diff when Git evidence is available.
- `rollback_scope_violation_plan.md` - review plan when a task changes files outside `repo_path`.

Example compact evidence:

```json
{
  "task_id": "task_20260625_010513_ad59bb",
  "status": "done",
  "verify_status": "passed",
  "changed_file_groups": {
    "source_changes": 2,
    "docs_changes": 1,
    "config_changes": 0,
    "test_changes": 1,
    "release_artifacts": 1,
    "runtime_generated_files": 0
  },
  "artifact_status": "collected",
  "artifact_manifest": {
    "artifacts": [
      {
        "path": "release/app.zip",
        "type": "zip",
        "size": 467725,
        "sha256": "03731a12990718325d3cb9ecdc9dbc899fc840e8ef6e2de3e810577999b5f864"
      }
    ]
  },
  "new_out_of_scope_changes": []
}
```


A scope violation remains explicit:

```json
{
  "status": "failed_scope_violation",
  "verify_status": "failed",
  "new_out_of_scope_changes": [
    {
      "path": "external/external-renamed.txt",
      "change": "modified"
    }
  ]
}
```

## Runtime architecture

```text
ChatGPT / Codex / OpenCode / another MCP client
                    |
                    v
          PatchWarden MCP Server
                    |
          save_plan / create_task
                    |
                    v
       .patchwarden/tasks/<task_id>/
                    |
              Watcher finds task
                    |
                    v
       Local agent (OpenCode / Codex)
                    |
                    v
 result.json / diff.patch / verify.json / status.json
                    |
                    v
          Client reviews and audits
```

A complete setup normally has three distinct roles:

1. **MCP Server** — started by Codex, OpenCode, or the tunnel.
2. **Watcher** — monitors pending tasks and launches the local agent.
3. **Local agent** — modifies the code and must be registered in advance.

> [!WARNING]
> “MCP connected” does not mean tasks can execute. If the Watcher is not
> running, `create_task` can still save a task, but the task remains queued and
> reports `execution_blocked: true`.

## Requirements

- Node.js 18 or newer
- npm
- Git (optional, but reliable `git.diff` evidence requires it)
- At least one local coding agent, such as OpenCode or the Codex CLI
- Windows tunnel mode also requires `tunnel-client.exe`, a Tunnel ID, and a
  runtime API key

Check the Windows environment in PowerShell:

```powershell
node -v
npm.cmd -v
git --version
where.exe opencode
where.exe codex
```

If `where.exe codex` only returns the Codex Desktop executable under
WindowsApps, it may not be a callable Codex CLI. Install or point to the real
CLI, or configure OpenCode as the execution agent.

## Five-minute quick start

### Option A: run from source (recommended)

Source mode is the easiest way to use the Watcher, Windows launchers, and
diagnostic scripts together.

Windows PowerShell:

```powershell
git clone https://github.com/jiezeng2004-design/PatchWarden.git
cd .\PatchWarden
npm.cmd ci
npm.cmd run build
Copy-Item .\examples\config.example.json .\patchwarden.config.json
```

Edit `patchwarden.config.json` and set at least:

- `workspaceRoot`
- `agents`
- `allowedTestCommands`

Run diagnostics:

```powershell
npm.cmd run doctor
```

Start the Watcher:

```powershell
$env:PATCHWARDEN_CONFIG = (Resolve-Path .\patchwarden.config.json)
npm.cmd run watch
```

Keep this window open, then configure OpenCode, Codex, or ChatGPT as described
below.

### Option B: use the npm package

The npm package is convenient for launching a pinned MCP server. Task
execution still requires a separate Watcher.

```powershell
New-Item -ItemType Directory .\patchwarden-runtime
Set-Location .\patchwarden-runtime
npm.cmd init -y
npm.cmd install patchwarden@0.6.4
Copy-Item .\node_modules\patchwarden\examples\config.example.json .\patchwarden.config.json
$env:PATCHWARDEN_CONFIG = (Resolve-Path .\patchwarden.config.json)
node .\node_modules\patchwarden\dist\runner\watch.js
```

An MCP client can launch:

```text
npx.cmd -y patchwarden@0.6.4
```

Pin the version in important environments instead of using `latest`
unconditionally.

## Complete configuration guide

Create a local configuration from the example:

```powershell
Copy-Item .\examples\config.example.json .\patchwarden.config.json
```

Recommended Windows example:

```json
{
  "workspaceRoot": "D:/ai_agent/codex_program",
  "plansDir": ".patchwarden/plans",
  "tasksDir": ".patchwarden/tasks",
  "toolProfile": "full",
  "agents": {
    "opencode": {
      "command": "opencode",
      "args": ["run", "{prompt}"]
    },
    "codex": {
      "command": "codex",
      "args": ["exec", "--cd", "{repo}", "{prompt}"]
    }
  },
  "allowedTestCommands": [
    "npm test",
    "npm run build",
    "npm run lint",
    "pytest"
  ],
  "repoAllowedTestCommands": {
    "desktop-app": ["npm run release:check"]
  },
  "maxReadFileBytes": 200000,
  "defaultTaskTimeoutSeconds": 900,
  "maxTaskTimeoutSeconds": 3600,
  "watcherStaleSeconds": 30,
  "httpPort": 7331
}
```

Configuration fields:

| Field | Required | Description |
| --- | --- | --- |
| `workspaceRoot` | Yes | The only workspace root PatchWarden may access. |
| `plansDir` | Yes | Plan directory, normally `.patchwarden/plans`. |
| `tasksDir` | Yes | Task and result directory, normally `.patchwarden/tasks`. |
| `toolProfile` | No | `full` or `chatgpt_core`; use `full` for local clients. |
| `agents` | Yes | Execution-agent allowlist; supports `{repo}` and `{prompt}` placeholders. |
| `allowedTestCommands` | Yes | Exact allowlist for independent verification commands. |
| `repoAllowedTestCommands` | No | Extra exact commands keyed by workspace-relative repository path; wildcards are unsupported. |
| `maxReadFileBytes` | Yes | Maximum bytes returned by one MCP file read. |
| `defaultTaskTimeoutSeconds` | Yes | Default task timeout. |
| `maxTaskTimeoutSeconds` | Yes | Maximum timeout a client may request. |
| `watcherStaleSeconds` | Yes | Watcher heartbeat expiry, from 5 to 3600 seconds. |
| `repoAliases` | No | Short aliases for repositories inside the workspace. |
| `httpPort` | No | Local HTTP MCP port; default is 7331. |
| `http.ownerTokenEnv` | No | Environment variable that contains the HTTP owner token. |

Important configuration rules:

- In Windows JSON, prefer paths such as `D:/path/to/project`.
- If you use backslashes, escape them as `D:\\path\\to\\project`.
- Do not set `workspaceRoot` to a drive root, home directory, Desktop,
  Downloads, or Documents.
- `plansDir` and `tasksDir` are resolved relative to `workspaceRoot`.
- `repo_path` must stay inside `workspaceRoot` and cannot escape with `..`.
- `allowedTestCommands` uses exact matching; similar commands are not
  automatically authorized.
- Repository-specific commands come only from trusted local configuration;
  a target repository cannot authorize itself through `package.json`.
- Configuration may contain private paths and should not be committed.

Set the configuration path:

```powershell
$env:PATCHWARDEN_CONFIG = "D:\path\to\patchwarden.config.json"
```

This environment variable affects only the current PowerShell process and its
children. Set it again in every separately opened terminal that starts a
Watcher or MCP Server.

## Connect OpenCode

Local source mode is recommended so the MCP Server, Watcher, and
configuration remain on the same version.

Edit:

```text
%USERPROFILE%\.config\opencode\opencode.jsonc
```

Example:

```jsonc
{
  "mcp": {
    "patchwarden": {
      "type": "local",
      "command": [
        "node",
        "D:/path/to/PatchWarden/dist/index.js"
      ],
      "environment": {
        "PATCHWARDEN_CONFIG": "D:/path/to/PatchWarden/patchwarden.config.json",
        "PATCHWARDEN_TOOL_PROFILE": "full"
      },
      "enabled": true
    }
  }
}
```

Verify the connection:

```powershell
opencode mcp list
```

Expected result:

```text
patchwarden connected
```

In a separate PowerShell window, start the Watcher:

```powershell
$env:PATCHWARDEN_CONFIG = (Resolve-Path .\patchwarden.config.json)
npm.cmd run watch
```

If OpenCode sees the MCP tools but tasks remain queued, check the Watcher
before repeatedly deleting and recreating the MCP entry.

## Connect Codex

Edit:

```text
%USERPROFILE%\.codex\config.toml
```

Pinned npm configuration:

```toml
[mcp_servers.patchwarden]
command = "npx.cmd"
args = ["-y", "patchwarden@0.6.4"]

[mcp_servers.patchwarden.env]
PATCHWARDEN_CONFIG = "D:\\path\\to\\patchwarden.config.json"
PATCHWARDEN_TOOL_PROFILE = "full"
```

Local source configuration:

```toml
[mcp_servers.patchwarden]
command = "node"
args = ["D:\\path\\to\\PatchWarden\\dist\\index.js"]

[mcp_servers.patchwarden.env]
PATCHWARDEN_CONFIG = "D:\\path\\to\\PatchWarden\\patchwarden.config.json"
PATCHWARDEN_TOOL_PROFILE = "full"
```

Fully exit and reopen Codex Desktop after editing the configuration, then
start a new conversation. Existing conversations may retain the old MCP tool
catalog.

Codex as an **MCP client** and the Codex CLI as an **execution agent** are
different roles. A successful MCP connection does not prove that the CLI
configured under `agents` is available.

## Connect ChatGPT

Recommended Windows path:

```text
ChatGPT Web
→ ChatGPT Connector
→ OpenAI Secure MCP Tunnel
→ PatchWarden stdio MCP
→ Watcher
→ local agent
```

### One-click launcher

Prepare:

- A built PatchWarden source checkout
- A valid `patchwarden.config.json`
- `tunnel-client.exe`
- A Tunnel ID
- A tunnel runtime API key
- A working HTTP proxy with a supported exit region

Configure the proxy first, then run:

```text
PatchWarden.cmd start core
```

The launcher:

- Builds `dist/index.js` if it is missing.
- Verifies v0.6.4, the fixed 17-tool `chatgpt_core` catalog, and its schema
  manifest.
- Reads or prompts for the Tunnel ID.
- Reads or prompts for the runtime API key.
- Stores credentials with Windows DPAPI under `%APPDATA%\patchwarden`.
- Starts and supervises only the Watcher it owns.
- Runs `tunnel-client doctor` and readiness checks.
- Applies capped retries to recoverable disconnects.

Runtime status is stored under:

```text
%LOCALAPPDATA%\patchwarden\runtime
```

This directory contains PIDs, health state, and redacted diagnostics. It must
not contain the API key or Tunnel ID.

When creating the ChatGPT Connector:

- Select the tunnel **Channel**.
- Choose **None** for authentication unless you implemented OAuth.
- Do not use the local `127.0.0.1` address as a public Server URL.
- Reconnect the Connector and open a new ChatGPT conversation after changes.
- Disable browser translation extensions if the Platform page behaves
  unexpectedly.

See [examples/openai-tunnel/README.md](examples/openai-tunnel/README.md) for
the expanded tunnel examples.

## Proxy configuration: read this first

### Launcher default

`scripts/control/start-patchwarden-tunnel.ps1` first reads `HTTPS_PROXY` from the
current process. If it is absent, the launcher defaults to:

```text
http://127.0.0.1:7892
```

**Port 7892 is not universal.** Clash, Mihomo, V2Ray, sing-box, and other proxy
applications may use 7890, 7897, 10809, or a custom port. Check the actual
HTTP/Mixed listening port in your proxy application instead of copying the
example.

Test the port:

```powershell
Test-NetConnection 127.0.0.1 -Port 7892
```

If `TcpTestSucceeded` is `False`, no proxy service is listening on that port.

### Recommended environment

These variables affect only the current PowerShell process and its children.
They do not modify system-wide environment variables:

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:YOUR_HTTP_OR_MIXED_PORT"
$env:HTTP_PROXY  = $env:HTTPS_PROXY
$env:ALL_PROXY   = $env:HTTPS_PROXY
$env:NO_PROXY    = "localhost,127.0.0.1,::1"
.\PatchWarden.cmd start core
```

Example for a Mixed port of 7890:

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:HTTP_PROXY  = $env:HTTPS_PROXY
$env:ALL_PROXY   = $env:HTTPS_PROXY
$env:NO_PROXY    = "localhost,127.0.0.1,::1"
.\PatchWarden.cmd start core
```

Using `HTTPS_PROXY=http://...` is expected: the variable identifies HTTPS
requests that should use a proxy, while the `http://` scheme describes the
local HTTP proxy endpoint. Do not enter a SOCKS-only port into the current
`--http-proxy` setting.

### Three separate network paths

| Network path | Proxy? | Notes |
| --- | --- | --- |
| Tunnel → OpenAI control plane | Usually | The launcher passes `HTTPS_PROXY` to tunnel-client. |
| PatchWarden → `127.0.0.1` | No | Keep `NO_PROXY=localhost,127.0.0.1,::1`. |
| Local agent → model provider API | Agent-specific | The Watcher and child agent may inherit terminal proxy variables. |
| npm / GitHub | Network-specific | Their connectivity is separate from tunnel health. |

If you start the Watcher manually and want its child agent to use the same
proxy, set the proxy variables in the PowerShell window that launches the
Watcher.

### Region errors are not code errors

If logs show:

```text
unsupported_country_region_territory
403 Forbidden
```

the proxy exit region is not accepted by the current OpenAI control plane.
Reinstalling dependencies, rebuilding `dist`, or repeatedly logging in will
usually not address this condition. Switch to a supported exit region and
restart the tunnel. Support can change, so this project does not hard-code a
country list.

### Proxy troubleshooting order

1. Confirm the proxy application is running.
2. Use its actual HTTP/Mixed port, not a copied example.
3. Confirm `Test-NetConnection` succeeds.
4. Set `HTTPS_PROXY` in the same terminal that starts the tunnel.
5. Keep local addresses in `NO_PROXY`.
6. Check whether the exit region is accepted.
7. Then run `PatchWarden.cmd health` and tunnel-client doctor.

## Recommended task workflow

Use this sequence:

1. `health_check` — verify version, workspace, Watcher, and tool catalog.
2. `list_agents` — confirm the local execution agent is available.
3. `list_workspace` — identify the correct `repo_path`.
4. `save_plan`, or provide an `inline_plan` when creating the task.
5. `create_task` — specify the agent, repository, and verification commands.
6. Use `wait_for_task(timeout_seconds: 25)` for short tasks; poll long tasks with `list_tasks` and `get_task_status`.
7. `get_task_summary(view: "compact")` — inspect bounded structured evidence first.
8. `get_result_json`, `get_diff`, and `get_test_log` — inspect detail as needed.
9. `audit_task` — independently verify the result.
10. Let a human decide whether to accept, commit, or publish.

Example `create_task` payload:

```json
{
  "agent": "opencode",
  "repo_path": "my-project",
  "inline_plan": "Fix form validation on the login page, avoid unrelated files, and add regression coverage.",
  "verify_commands": [
    "npm run build",
    "npm test"
  ],
  "timeout_seconds": 900
}
```

Rules:

- `repo_path` must stay inside `workspaceRoot`.
- Every `verify_commands` entry must exactly match the global or current
  repository's trusted command allowlist.
- Select exactly one plan source: `plan_id`, `inline_plan`, or `template`.
- When `wait_for_task` returns `continuation_required: true`, call it again.
- `terminal: true` means the task reached a terminal state, not that the work
  is correct.

Built-in templates:

- `inspect_only`
- `feature_small`
- `fix_tests`
- `release_check`
- `rollback_scope_violation`

ChatGPT tasks should prefer the first three guarded templates: use
`inspect_only` for read-only diagnosis, `feature_small` for a narrowly scoped
change, and `fix_tests` for a known verification failure. Use `inline_plan` or
a saved long plan only when these templates cannot express the goal. Prefer an
`execution_mode: "assess_only"` call followed by the returned `next_tool_call`;
do not resend the goal, plan, repository, agent, or verification arguments in
the execute call.

`inspect_only` and rollback-review tasks fail with
`failed_policy_violation` if they modify files. Rollback review only writes a
plan; it never automatically reverts user changes.

`audit_task` places evidence-backed failures in `confirmed_failures` and lists
heuristic warnings separately in `possible_false_positives` and
`manual_verification_items`. A `warn` verdict therefore does not automatically
mean the task is wrong.

### Task artifacts

| File | Purpose |
| --- | --- |
| `status.json` | Current status, phase, heartbeat, and error details. |
| `progress.md` | Progress reported by the agent. |
| `result.md` | Human-readable execution report. |
| `result.json` | Structured result, paths, changes, warnings, and next steps. |
| `diff.patch` | Complete task change evidence. |
| `artifact_manifest.json` | Generated artifact paths, types, sizes, and SHA-256 hashes. |
| `file-stats.json` | Per-file addition and deletion statistics. |
| `verify.json` | Structured record for every independent verification command. |
| `verify.log` | Human-readable independent verification output. |
| `test.log` | Test output captured during agent execution. |

An agent saying “published” or “pushed” is not reliable remote evidence.
Verify GitHub, npm, tags, and releases against the live platform state.

## HTTP MCP mode

The HTTP server binds only to `127.0.0.1`. The default port is 7331 and it is
not directly exposed to the LAN.

Terminal 1 — start the Watcher:

```powershell
$env:PATCHWARDEN_CONFIG = (Resolve-Path .\patchwarden.config.json)
npm.cmd run watch
```

Terminal 2 — start HTTP MCP:

```powershell
$env:PATCHWARDEN_CONFIG = (Resolve-Path .\patchwarden.config.json)
npm.cmd run start:http
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:7331/healthz
```

MCP endpoint:

```text
http://127.0.0.1:7331/mcp
```

Optional token configuration:

```json
{
  "httpPort": 7331,
  "http": {
    "ownerTokenEnv": "PATCHWARDEN_OWNER_TOKEN"
  }
}
```

Set the token in the PowerShell process that starts the server:

```powershell
$env:PATCHWARDEN_OWNER_TOKEN = "use-a-random-local-only-value"
```

Clients can send `Authorization: Bearer ...` or `x-patchwarden-token`. Never
write the token into configuration, documentation, logs, or Git.

> [!CAUTION]
> Do not expose local port 7331 through router port forwarding, a
> `0.0.0.0` relay, or an ordinary reverse proxy. Use an authenticated secure
> tunnel for remote access.

## Diagnostics and health checks

Project diagnostics:

```powershell
npm.cmd run doctor
```

Doctor checks Node, npm, Git, configuration, workspace containment, sensitive
path protection, agent commands, the tool manifest, HTTP port, task
directories, and build output.

### Unified Windows control entry point

Double-click `PatchWarden.cmd` for one menu that starts, stops, restarts, and
checks Core Agent and Direct independently or together. The same operations are
available from PowerShell:

```powershell
.\PatchWarden.cmd start core
.\PatchWarden.cmd start direct
.\PatchWarden.cmd stop all
.\PatchWarden.cmd restart all
.\PatchWarden.cmd status all
.\PatchWarden.cmd kill all
.\Stop-PatchWarden.cmd
```

For daily desktop use, start with `PatchWarden-Desktop.cmd`; it starts the tray and keeps Control Center available without opening extra browser windows. Use `PatchWarden-Control-Tray.cmd --foreground` only for tray debugging, `PatchWarden-Control.cmd` for the full local Web dashboard, and `Stop-PatchWarden.cmd` for one-click shutdown of Core/Direct, Control Center, and the tray.

The old single-purpose launchers remain under `scripts/launchers/` as a
compatibility layer. Personal launchers live under `.local/launchers/` and
remain excluded from Git and release packages. `stop` and `restart` correlate
runtime state with the exact Tunnel profile, project launcher, and process tree,
so they can clean up an orphaned `tunnel-client.exe` for that profile without
terminating unrelated processes. `kill` is an explicit force-clean command but
keeps the same profile and project-path restrictions. If an unrelated process
owns port 8080 or 8081, the operation stops and reports its PID.

`status` cross-checks runtime JSON, the health URL file, the fixed `/readyz` and
`/healthz` endpoints, and the real process list. A ready endpoint therefore wins
over a stale stopped status file. Supervisor output is written to:

```text
%LOCALAPPDATA%\patchwarden\runtime\tunnel-client.stdout.log
%LOCALAPPDATA%\patchwarden\runtime\tunnel-client.stderr.log
%LOCALAPPDATA%\patchwarden\runtime-direct\tunnel-client.stdout.log
%LOCALAPPDATA%\patchwarden\runtime-direct\tunnel-client.stderr.log
```

On a non-zero exit, the launcher displays the last 30 stderr lines and records
the exit code, redacted stdout/stderr tails, and log paths in
`tunnel-status.json`. It never prints the API key value.

Detailed Windows tunnel health:

```text
PatchWarden.cmd health
```

It reports:

- Source and `dist` versions
- The real MCP process source
- Tool profile, count, names, and schema hash
- Workspace and task-directory access
- Watcher heartbeat
- Tunnel readiness
- Mixed-version process warnings

The check is read-only and does not terminate processes.

For expanded MCP diagnostics, call `health_check` with:

```json
{
  "detail": "self_diagnostic"
}
```

This includes configured agents, allowlist counts, recent failures, and tool
catalog consistency.

After a configuration or version change, use:

```text
PatchWarden.cmd restart all
```

It stops only this project's launchers and Watcher plus `tunnel-client.exe`
processes that exactly match the selected profile. It does not globally
terminate unrelated PatchWarden, OpenCode, or Codex instances.

## Lessons learned and troubleshooting

### Quick reference

| Symptom | Most likely cause | Fix |
| --- | --- | --- |
| Tunnel connection keeps timing out | No proxy is listening on default port 7892 | Find the real HTTP/Mixed port, set `HTTPS_PROXY`, and start from the same terminal. |
| Logs show 403 and `unsupported_country_region_territory` | Unsupported proxy exit region | Switch exit region and restart the tunnel. |
| `list_workspace` only shows `tunnel-client.exe` | MCP started in the wrong directory or did not receive the config path | Use `scripts/mcp/patchwarden-mcp-stdio.cmd`. |
| MCP is connected, but tasks do not run | Watcher is missing or stale | Start `npm.cmd run watch` and inspect `health_check`. |
| `Agent command not found` | Agent is not on PATH, or Codex Desktop was mistaken for the CLI | Run `where.exe` and use the real CLI path in `agents.command`. |
| Verification command is rejected | It does not exactly match the allowlist | Add the exact command to `allowedTestCommands`. |
| ChatGPT still shows old tools | Connector or conversation cached the old catalog | Reconnect and open a new ChatGPT conversation. |
| ChatGPT stops after `create_task` | The same turn did not continue with `wait_for_task` | Loop while `continuation_required` is true. |
| HTTP reports `EADDRINUSE` | Port 7331 is already in use | Check the existing instance or change `httpPort`. |
| DPAPI credential cannot be decrypted | Windows user/machine changed or the cache is damaged | Run `PatchWarden.cmd reset-key` and enter it again. |
| Code changed but runtime behavior did not | Old `dist` or process is still active | Build, compare the manifest, and restart owned processes. |
| The supervisor shows only exit code 1 | The real tunnel-client failure is in child-process stderr | Read the mode's `tunnel-client.stderr.log` or `tunnel-status.json.stderr_tail`. |
| Core looks for its profile under `opencode-config\tunnel-client` | An older launcher leaked the Watcher's `XDG_CONFIG_HOME` into tunnel-client | Upgrade to v0.6.0 and run `PatchWarden.cmd restart core`; v0.6.0 isolates Watcher-only environment variables. |
| npm MCP initializes, but tasks remain queued | npm launched only the MCP Server | Start `dist/runner/watch.js` in the local installation. |
| Config exists but is not found | Variable was set in another terminal or path escaping is wrong | Use an absolute path and set `PATCHWARDEN_CONFIG` in the launching terminal. |
| Legacy environment names are ignored | v0.4.0 intentionally broke old names | Use `PATCHWARDEN_*` everywhere. |

### Lesson 1: connected is not end-to-end readiness

An MCP connection proves only that the client started PatchWarden. Also check:

1. `health_check` sees the intended workspace.
2. `list_agents` finds the execution agent.
3. The Watcher heartbeat is fresh.
4. A task moves from queued to running.

### Lesson 2: do not copy proxy port 7892 blindly

Port 7892 is a launcher default, not a standard shared by all proxy clients.
Check the proxy application and run `Test-NetConnection` before reinstalling
Node or PatchWarden.

### Lesson 3: do not proxy localhost

HTTP MCP, health endpoints, and the tunnel-client UI use loopback addresses.
Keep:

```powershell
$env:NO_PROXY = "localhost,127.0.0.1,::1"
```

### Lesson 4: old sessions can keep old schemas

Connectors and MCP clients may cache tool catalogs when a session opens.
Compare `server_version`, `schema_epoch`, and
`tool_manifest_sha256`, then reconnect and create a new session.

### Lesson 5: stale Watchers and unsafe process killing

PatchWarden uses heartbeat age to determine Watcher health. The launcher
supervises only the Watcher it created, and restart scripts touch only owned
processes. Do not use broad commands such as `taskkill /IM node.exe`; they can
terminate unrelated Node, Codex, or OpenCode work.

### Lesson 6: oversized workspace roots

Using a drive, home directory, or mixed workspace as `workspaceRoot` expands
scan scope, privacy risk, and accidental unrelated changes. Use a dedicated
code directory and point each task at a specific relative `repo_path`.

### Lesson 7: execution finished is not acceptance

`done` only means the agent process finished. Still verify:

- Whether `failed_scope_violation` occurred
- Whether every record in `verify.json` passed
- Whether `diff.patch` contains only intended changes
- Whether `audit_task` found inconsistent claims
- Whether claimed npm, GitHub, tag, or release state exists remotely

### Lesson 8: rename migration does not read old state

PatchWarden v0.4.0 does not automatically read legacy CLI names, environment
variables, headers, task directories, or DPAPI credentials. Preserve old data
as a backup if needed, but configure all new runs with PatchWarden paths and
names.

## MCP tools and profiles

`chatgpt_core` is the fixed 17-tool profile used by the ChatGPT tunnel:

`health_check`, `list_agents`, `list_workspace`,
`read_workspace_file`, `save_plan`, `create_task`,
`wait_for_task`, `get_task_summary`, `get_diff`, `get_result`,
`get_result_json`, `get_test_log`, `get_task_status`, `list_tasks`,
`cancel_task`, `audit_task`, and `safe_status`.

`get_task_summary` keeps the backward-compatible `standard` view by default.
ChatGPT should request `view: "compact"` first; terminal `wait_for_task`
responses also embed compact acceptance evidence only.

`full` additionally provides:

- `get_plan`
- `kill_task`
- `retry_task`
- `get_task_progress`
- `get_task_stdout_tail`
- `get_task_log_tail`

The tunnel wrapper forces `chatgpt_core`. Ordinary local development defaults
to `full`.

### ChatGPT Direct mode

Direct mode exposes ten guarded tools so ChatGPT can create an editing
session, read and search source files, apply hash-bound JSON patches, run
exactly allowlisted verification commands, finalize the evidence, and audit
the result without a local execution agent.

Enable it in the trusted local configuration while keeping the ordinary Core
profile unchanged:

```json
{
  "enableDirectProfile": true
}
```

Start the separate Direct tunnel entrypoint:

```text
PatchWarden.cmd start direct
```

On first use, provide the `tunnel-client.exe` path and a Tunnel ID dedicated
to the Direct Connector. The launcher uses the `patchwarden-direct` profile,
stores runtime state under `%LOCALAPPDATA%\patchwarden\runtime-direct`, skips
the Watcher, and retains the existing DPAPI credential handling. In a fresh
ChatGPT conversation, `health_check` should report `chatgpt_direct`, ten
tools, and `direct_profile_enabled=true`.

## Security boundaries and local data

Primary protections:

- MCP tools do not expose a general shell.
- Agent commands and argument templates must be configured in advance.
- Verification commands must exactly match the allowlist.
- File access is contained to `workspaceRoot`.
- Sensitive filenames and obvious credential-read plans are blocked.
- Secret-like values in task artifacts are redacted.
- HTTP mode binds only to `127.0.0.1`.
- The Runner does not automatically commit, push, publish, or reset.

Protect these local paths:

| Path | Content | Commit? |
| --- | --- | --- |
| `patchwarden.config.json` | Private paths, agents, command allowlist | No |
| `.patchwarden/` | Plans, tasks, diffs, and logs | No |
| `%APPDATA%\patchwarden` | DPAPI-encrypted tunnel credential | No |
| `%LOCALAPPDATA%\patchwarden` | Runtime status and isolated configuration | No |

Never commit API keys, tokens, Tunnel IDs, ChatGPT Workspace IDs, cookies,
`.env` files, private project paths, or real task logs.

PatchWarden reduces accidental exposure, but it does not replace human review.
Start with a dedicated test workspace and a repository you can recover.

## Upgrading and migration

Upgrade a pinned npm installation:

```powershell
npm.cmd install patchwarden@0.6.4
```

Upgrade a source checkout:

```powershell
git pull --ff-only
npm.cmd ci
npm.cmd run build
npm.cmd test
```

After upgrading:

1. Run `npm.cmd run doctor`.
2. Run `PatchWarden.cmd health`.
3. Compare version, schema epoch, and manifest hash.
4. Restart owned processes with `PatchWarden.cmd restart all`.
5. Reconnect the MCP client or Connector.
6. Validate in a new session instead of relying on an old conversation.

When migrating from Safe-Bifrost, manually update:

- npm package and CLIs include `patchwarden`, `patchwarden-runner`, and the
  local-only medium-risk ticket confirmation command `patchwarden-confirm`
- Configuration filename to `patchwarden.config.json`
- Environment variables to `PATCHWARDEN_*`
- Task directory to `.patchwarden/`
- HTTP header to `x-patchwarden-token`
- AppData directory to `patchwarden`

Old data is not deleted and is not read as an automatic fallback. See the
[migration guide](docs/migration-from-safe-bifrost.md).

## Development and release verification

Windows PowerShell:

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor
npm.cmd run check:tool-manifest
npm.cmd run check:brand
npm.cmd run test:tunnel-supervisor
npm.cmd run test:watcher-supervisor
npm.cmd run pack:clean
npm.cmd run verify:package
```

Package checks exclude:

- `node_modules/`
- `.patchwarden/`
- `*.log`
- `.env`
- `patchwarden.config.json`
- Local credentials and runtime state

Before publishing, verify npm Registry state, remote tags, the GitHub Release,
and release-asset checksums independently.

## Related documentation

- [v0.6.4 release notes](docs/release-v0.6.4.md)
- [v0.6.1 release notes](docs/release-v0.6.1.md)
- [v0.6.0 release notes](docs/release-v0.6.0.md)
- [ChatGPT usage guide](docs/chatgpt-usage.md)
- [Migration guide](docs/migration-from-safe-bifrost.md)
- [ChatGPT Connector demo](docs/demo.md)
- [OpenAI tunnel examples](examples/openai-tunnel/README.md)
- [ChatGPT test prompt](examples/openai-tunnel/chatgpt-test-prompt.md)

## Roadmap

- [x] stdio MCP Server
- [x] Plan and Task lifecycle
- [x] Runner and Watcher
- [x] HTTP MCP Server
- [x] ChatGPT Connector / tunnel
- [x] Doctor and runtime health checks
- [x] Tool manifest and schema-drift detection
- [ ] Worktree isolation
- [ ] Multi-agent task queue
- [ ] Local dashboard

## License

[MIT](LICENSE)
