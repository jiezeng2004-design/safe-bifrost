# PatchWarden Control Center

PatchWarden has three control layers:

1. Web dashboard: the daily management surface for status, setup checks, tasks,
   stale-task actions, Direct sessions, audit logs, and long logs.
2. Tray entry: a lightweight quick-control surface for opening the dashboard,
   checking compact status, Start/Stop/Restart, opening logs, and quitting the
   tray.
3. CLI/scripts: the lower-level fallback for automation, smoke tests, package
   checks, and troubleshooting.

## User Entrypoints

From the repository root:

```powershell
.\PatchWarden-Desktop.cmd
.\PatchWarden-Control.cmd
.\PatchWarden-Control-Tray.cmd --foreground
.\PatchWarden.cmd status all
```

Use `PatchWarden-Control.cmd` for normal desktop use. Use the tray when you only
need quick controls. Use `PatchWarden.cmd` when you need explicit CLI output or
automation-friendly commands.

## Design Notes

- `control-center-mvp.md`: first Web dashboard scope.
- `control-center-phase2.md`: follow-up management and diagnostics scope.
- `control-center-daily-driver.md`: current daily-use contract.

