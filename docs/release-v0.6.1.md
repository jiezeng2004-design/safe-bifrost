# PatchWarden v0.6.1 Release Notes

**Release Date**: 2026-06-25

## Overview

PatchWarden v0.6.1 is a stability and observability release. It addresses watcher heartbeat false positives, adds Chinese path reliability, introduces two new tools (`safe_status` and `sync_file`), and adds comprehensive security guard unit tests.

## New Features

### safe_status Tool

A minimal task lifecycle status tool that returns task state without exposing diff, log content, or file contents. Useful when upper-layer security policies block content-bearing tools.

```json
{
  "task_id": "task-001",
  "status": "running",
  "phase": "executing_agent",
  "last_heartbeat_at": "2026-06-24T10:00:12Z",
  "current_command": "codex exec",
  "watcher_state": "healthy"
}
```

### sync_file Tool

Copy a file from source to target within a Direct session repo. Both paths must be inside the session's `repo_path`. Supports optional sha256 verification for both source and target.

### Android Build Doctor

When a managed project contains an `android_app` directory, the health check now includes Android build environment diagnostics: Java version, JAVA_HOME, ANDROID_HOME, SDK platform, build-tools, Gradle wrapper, and APK output path.

## Bug Fixes

- **Watcher stale false positive**: Long-running tasks no longer cause the watcher to be incorrectly reported as stale. The watcher status now falls back to checking running task heartbeats.
- **Chinese path encoding**: All file I/O operations verified to use UTF-8 encoding. Health check now reports `path_encoding` status.
- **Tracked external dirty detection**: `captureRepoSnapshot` now correctly identifies tracked-but-modified external files via `dirty_paths` field parsed from `git status --porcelain`. The regex now includes `R` (rename) status, fixing dead code that previously never executed for renamed files.
- **Release zip path separators**: The packaging script (`pack-clean.js`) now creates zip archives with POSIX `/` path separators instead of Windows backslashes. Linux `unzip` no longer reports `warning: appears to use backslashes as path separators`.

## Security

- 136 unit tests covering all security guards (path guard, sensitive guard, command guard, direct guards)
- Tests use Node's built-in `node:test` — zero new dependencies

## Observability

- Structured JSON logging to stderr (never stdout, to avoid polluting MCP JSON-RPC)
- Tool call audit logs with duration tracking
- Global `unhandledRejection` and `uncaughtException` handlers

## Tool Profile Changes

| Profile | v0.6.0 | v0.6.1 |
|---------|--------|--------|
| full | 28 | 30 |
| chatgpt_core | 16 | 17 |
| chatgpt_direct | 9 | 10 |

## Migration

No breaking changes. All new fields are optional. New tools are additive and do not affect existing tools.

## Verification

- TypeScript compilation: PASS
- Unit tests: 136 pass, 0 fail, 1 skipped (Windows symlink)
- Smoke tests: 139 pass, 0 fail
- Lifecycle tests: 22 pass, 0 fail (includes tracked external file rename regression test)
- Doctor CI: PASS (81 OK, 0 WARN, 0 FAIL on the release check host)
- Tool manifest check: PASS
- Package manifest check: PASS (260 files)
- Brand check: PASS (128 tracked files)
- MCP HTTP tests: 13 pass, 0 fail
- Release zip: POSIX path separators verified (261 entries, no backslashes)
