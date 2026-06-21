# PatchWarden agent rules

PatchWarden is a security-focused local MCP bridge. Preserve workspace confinement, command allow-lists, sensitive-file blocking, explicit agent registration, and auditable task artifacts.

## Commands

Run from this repository in Windows PowerShell with `npm.cmd`:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd test
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor:ci
npm.cmd run pack:clean
npm.cmd run verify:package
```

Use the narrowest relevant smoke test during iteration, then run the full chain before release or security-sensitive changes.
Use `npm.cmd run doctor` instead of `doctor:ci` when validating a configured local runtime.

## Safety contracts

- Do not expose a general-purpose remote shell or weaken exact command matching.
- Keep all repo paths under configured `workspaceRoot`; block sensitive names and out-of-workspace changes.
- Do not read or persist tokens, cookies, browser state, `.env`, SSH keys, or credential files.
- Do not blanket-kill watchers or tunnels. Only launcher-owned processes may be supervised.
- Keep live tunnel/watcher cutover separate from local code verification; do not restart live services unless explicitly requested.
- Preserve structured task evidence, heartbeat state, before/after Git snapshots, changed-file records, and redaction.

## Changes and release

- Add or update smoke coverage for changed behavior.
- Keep README, examples, tool manifests, package metadata, and migration docs aligned.
- Use branch -> PR -> CI -> merge. Publishing is manual and must separately verify GitHub Release, `patchwarden` on npm, and `dist-tags.latest`.
- The pre-rename npm package is frozen; do not publish new versions under the legacy name.
