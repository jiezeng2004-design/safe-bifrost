## Summary

- What changed and why?

## Safety

- [ ] Workspace, command, and sensitive-file guards remain intact.
- [ ] No credentials, local data, logs, or private task artifacts are included.
- [ ] Live tunnel/watcher cutover was not performed, or was separately approved.

## Verification

- [ ] `npm.cmd test`
- [ ] `npm.cmd run test:mcp`
- [ ] `npm.cmd run test:http-mcp`
- [ ] `npm.cmd run pack:clean`
- [ ] `npm.cmd run verify:package`
