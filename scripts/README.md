# PatchWarden Scripts

This directory keeps implementation scripts out of the root folder. Normal
desktop use should start from the root entrypoints:

```powershell
.\PatchWarden-Desktop.cmd
.\PatchWarden-Control.cmd
.\PatchWarden-Control-Tray.cmd --foreground
.\Stop-PatchWarden.cmd
.\PatchWarden.cmd status all
```

## Control Scripts

- `control/manage-patchwarden.ps1`: backing implementation for `PatchWarden.cmd`.
- `control/start-control-center.ps1`: starts the local Web dashboard.
- `control/restart-control-center.ps1`: restarts the local Web dashboard.
- `control/control-center-tray.ps1`: Windows tray quick controls.
- `control/stop-patchwarden.ps1`: one-click shutdown for Core/Direct,
  Control Center, and tray.
- `control/start-patchwarden-tunnel.ps1`: starts Core or Direct tunnel supervision.
- `control/restart-patchwarden.ps1`: compatibility restart helper.

## MCP Entrypoints

- `mcp/patchwarden-mcp-stdio.cmd`: Core stdio MCP launcher.
- `mcp/patchwarden-mcp-direct.cmd`: Direct stdio MCP launcher.

## Smoke Tests And Checks

- `checks/*-smoke.js`: targeted smoke tests.
- `checks/unit-tests.js`: Node unit test entry.
- `checks/mcp-manifest-check.js`: validates MCP manifest expectations.
- `brand-check.js`: checks public brand strings.
- `checks/package-manifest-check.js`: verifies package contents.

## Release Helpers

- `release/pack-clean.js`: rebuilds `release/`, `patchwarden-release.tar.gz`, and the
  versioned `PatchWarden-v*.zip` artifact.

## Compatibility Launchers

Compatibility `.cmd` files live under `scripts/launchers/`. User-private local
launchers belong under `.local/` and must stay out of Git and release packages.

