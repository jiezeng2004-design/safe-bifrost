# PatchWarden CHANGELOG

## v0.6.4 (2026-06-26)

### Desktop Experience

- Added `PatchWarden-Desktop.cmd` as the daily desktop entry. It starts the tray and ensures Control Center is available without opening extra browser windows.
- Updated `PatchWarden-Control-Tray.cmd` so normal launches hide the PowerShell host, while `--foreground` remains available for debugging.
- Refined the WinForms tray layer with a PatchWarden-styled shield icon, single-instance protection, clearer startup/status balloons, and quick actions for Open Dashboard, Start All, Stop All, Restart All, Open Logs, and Quit Tray.

### Control Center Lifecycle

- Control Center lifecycle actions now call the Windows manager with `-Background` and `windowsHide: true`, so Start All and Restart All launch Core/Direct supervisors without long-lived visible terminal windows.
- Added `-NoTunnelWebUi` to the tunnel launcher and use it from desktop/background flows so tunnel-client does not open extra browser windows unless a user explicitly opens the dashboard.
- Clarified Stop All versus Quit Tray: Stop All stops Core/Direct while keeping tray/dashboard available; `Stop-PatchWarden.cmd` is the one-click shutdown for Core/Direct, Control Center, and tray.

### Verification

- Extended control and Control Center smoke coverage for the new desktop entry, tray contract, background lifecycle, and package manifest.
- Added the desktop entry to npm/package and release archive verification.

## v0.6.1 (2026-06-25)

### Stability & Correctness

- **Watcher stale fix**: `readWatcherStatus` now falls back to checking running task heartbeats when the watcher heartbeat is stale or missing. Long-running tasks no longer cause false "stale watcher" alerts.
- **Chinese path fix**: Verified all `readFileSync`/`writeFileSync` calls use UTF-8 encoding. Added `path_encoding` self-check to `health_check` tool.

### New Tools

- **`safe_status`**: Minimal task lifecycle status tool that returns task state without exposing diff, log content, or file contents. Added to `chatgpt_core` profile.
- **`sync_file`**: Copy a file from source to target within a Direct session repo. Supports sha256 verification. Added to `chatgpt_direct` profile.

### Security

- Added comprehensive unit test suite for all security guards using Node's built-in `node:test`:
  - `path-guard.test.ts`: path traversal, symlink escape, Windows separators, drive letter boundaries
  - `sensitive-guard.test.ts`: case insensitivity, null bytes, Unicode lookalikes, `.patchwarden` safe prefix
  - `command-guard.test.ts`: allowlist enforcement, whitespace handling, prompt sanitization
  - `direct-guards.test.ts`: workspace containment, blocked directories, binary file detection

### Observability

- **Structured logging**: New `src/logging.ts` module with JSON-formatted logs to stderr. Tool call audit logs with duration tracking. Global unhandled error handlers.
- **Tool call audit**: All tool invocations now logged with tool name, success/failure, duration, and optional task ID.

### Change Capture Enhancements

- **External dirty file baseline**: `extractExternalDirtyFiles` and `findNewExternalDirtyFiles` functions to distinguish pre-existing dirty files from new out-of-scope changes.
- **Artifact manifest**: `buildArtifactManifest` function generates `artifact_manifest.json` with sha256, size, and type classification for release artifacts.
- **Changed file grouping**: `groupChangedFiles` classifies changes into source, docs, config, test, release artifacts, and runtime-generated categories.

### Android Build Diagnostics

- New `src/tools/androidDoctor.ts` module that diagnoses Android build environment (Java, SDK, Gradle, APK output) when `android_app` directory exists.

### Tool Count

- Full profile: 30 tools (was 28)
- `chatgpt_core` profile: 17 tools (was 16)
- `chatgpt_direct` profile: 10 tools (was 9)

### Documentation

- Added `docs/performance-notes.md` with future optimization roadmap
- Added `docs/release-v0.6.1.md` release notes

## v0.6.0

- Direct session editing profile
- `apply_patch` tool with sha256 verification
- `run_verification` tool
- `finalize_direct_session` and `audit_session` tools
- Tool profile system (`full`, `chatgpt_core`, `chatgpt_direct`)
