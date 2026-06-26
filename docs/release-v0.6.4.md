# PatchWarden v0.6.4 Release Notes

**Release Date**: 2026-06-26

## Overview

PatchWarden v0.6.4 is a desktop experience release. It keeps the existing CLI and script surface, but makes the normal Windows workflow feel like a lightweight local application: start one desktop entry, control Core/Direct from the tray or Web dashboard, and shut everything down from one stop command.

## Desktop Entry

- Added `PatchWarden-Desktop.cmd` as the recommended daily entry point.
- The desktop entry starts the tray in a hidden PowerShell host and ensures the local Control Center is available.
- It does not automatically open a browser window. Use **Open Dashboard** from the tray or `PatchWarden-Control.cmd` when you want the full Web console.
- `PatchWarden-Control-Tray.cmd --foreground` remains available for tray debugging.

## Tray Improvements

- Added single-instance protection for the tray process.
- Replaced the generic system icon path with a small PatchWarden-styled shield icon drawn through WinForms/System.Drawing.
- Kept the tray as a lightweight switch layer: Open Dashboard, Status, Start All, Stop All, Restart All, Open Logs, and Quit Tray.
- Added clearer balloon/status feedback for startup and lifecycle actions.
- Clarified action semantics: **Stop All** stops Core/Direct and leaves tray/dashboard available; **Quit Tray** exits only the tray; `Stop-PatchWarden.cmd` performs full shutdown.

## Background Lifecycle

- Control Center now invokes `manage-patchwarden.ps1` with `-Background` and `windowsHide: true` for lifecycle API calls.
- The manager starts Core/Direct supervisors hidden for desktop/Web flows, while preserving visible launcher windows for explicit CLI/debug usage.
- Added `-NoTunnelWebUi` to `start-patchwarden-tunnel.ps1` so background starts do not open tunnel-client Web UI tabs.

## Verification

- TypeScript build: PASS
- Control smoke: PASS
- Control Center smoke: PASS (23 passed, 0 failed)
- Package manifest check: PASS
- PowerShell control script parse check: PASS
- Manual desktop-flow evidence: desktop entry starts only tray + Control Center; Start/Restart uses hidden supervisors; Stop-PatchWarden closes Core/Direct, Control Center, and tray.

## Migration

No breaking changes. Existing CLI commands and compatibility launchers remain available. For daily Windows use, prefer:

```powershell
.\PatchWarden-Desktop.cmd
```
