# Contributing

Use a focused branch and pull request. Keep changes small, preserve the security model, and add regression coverage for changed behavior.

## Local verification

Run in Windows PowerShell:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor
npm.cmd run pack:clean
npm.cmd run verify:package
```

Never include real credentials, browser state, `.env` files, generated task data, or local logs. Do not weaken workspace containment, sensitive-path blocking, exact test-command matching, or launcher ownership checks.
