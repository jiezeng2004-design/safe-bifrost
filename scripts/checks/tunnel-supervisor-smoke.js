#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("ok - tunnel supervisor smoke skipped outside Windows");
  process.exit(0);
}

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "patchwarden-tunnel-smoke-"));
const mockJs = join(temp, "mock-tunnel-client.js");
const mockCmd = join(temp, "mock-tunnel-client.cmd");
const mockConfig = join(temp, "patchwarden.config.json");
const stateFile = join(temp, "attempt.txt");
const secretMarker = "smoke-secret-must-not-appear";

try {
  writeFileSync(mockConfig, JSON.stringify({
    workspaceRoot: temp,
    plansDir: ".patchwarden/plans",
    tasksDir: ".patchwarden/tasks",
    toolProfile: "chatgpt_core",
    agents: { smoke: { command: process.execPath, args: [] } },
    allowedTestCommands: ["npm test"],
  }, null, 2), "utf-8");
  writeFileSync(mockCmd, `@echo off\r\nnode "%MOCK_TUNNEL_JS%" %*\r\n`, "utf-8");
  writeFileSync(mockJs, `
const fs=require('fs');
const http=require('http');
const args=process.argv.slice(2);
const command=args[0]||'';
const flag=(name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:''};
if(command==='init'||command==='doctor'){console.log(JSON.stringify({result:'ok'}));process.exit(0)}
if(command==='health'){console.log(JSON.stringify({healthz:{ok:true},readyz:{ok:true},result:'ok'}));process.exit(0)}
if(command==='run'){
  let attempt=0;try{attempt=Number(fs.readFileSync(process.env.MOCK_TUNNEL_STATE,'utf8'))||0}catch{}
  attempt++;fs.writeFileSync(process.env.MOCK_TUNNEL_STATE,String(attempt));
  console.log('fixture cwd='+process.cwd());
  if(attempt===1){console.error('fixture first attempt failed');process.exit(7)}
  const urlFile=flag('--health.url-file');const pidFile=flag('--pid.file');
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}))});
  server.listen(18888,'127.0.0.1',()=>{fs.writeFileSync(urlFile,'http://127.0.0.1:18888');fs.writeFileSync(pidFile,String(process.pid))});
  setTimeout(()=>server.close(()=>{for(let i=1;i<=35;i++)console.error('fixture stderr line '+i);console.error('CONTROL_PLANE_API_KEY='+process.env.CONTROL_PLANE_API_KEY);process.exit(9)}),6500);
}
`, "utf-8");

  const env = {
    ...process.env,
    APPDATA: join(temp, "appdata"),
    LOCALAPPDATA: join(temp, "localappdata"),
    CONTROL_PLANE_API_KEY: secretMarker,
    MOCK_TUNNEL_JS: mockJs,
    MOCK_TUNNEL_STATE: stateFile,
  };
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "control", "start-patchwarden-tunnel.ps1"),
    "-TunnelId", "tunnel_smoke_fixture",
    "-TunnelClientExe", mockCmd,
    "-ConfigPath", mockConfig,
    "-ProxyUrl", "http://127.0.0.1:1",
    "-ReconnectBaseSeconds", "1",
    "-ReconnectMaxSeconds", "1",
    "-UnreadyRestartSeconds", "20",
    "-MaxReconnectAttempts", "2",
    "-SkipWatcher",
  ], { cwd: root, env, encoding: "utf-8", timeout: 30_000 });

  if (result.error) throw result.error;
  const launcherOutput = `${result.stdout}\n${result.stderr}`;
  if (!existsSync(stateFile) || readFileSync(stateFile, "utf-8").trim() !== "2") {
    throw new Error(`Expected two supervised attempts. stdout=${result.stdout} stderr=${result.stderr}`);
  }
  const statusPath = join(env.LOCALAPPDATA, "patchwarden", "runtime", "tunnel-status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf-8").replace(/^\uFEFF/, ""));
  if (status.reason_code !== "retry_limit_reached" || status.attempt !== 2) {
    throw new Error(`Unexpected final supervisor status: ${JSON.stringify(status)}`);
  }
  if (status.last_exit_code !== 9 || !Array.isArray(status.stderr_tail) || status.stderr_tail.length !== 30) {
    throw new Error(`Supervisor did not preserve the latest exit diagnostics: ${JSON.stringify(status)}\n${launcherOutput}`);
  }
  if (!status.stdout_log?.endsWith("tunnel-client.stdout.log") || !status.stderr_log?.endsWith("tunnel-client.stderr.log")) {
    throw new Error(`Supervisor log paths are missing: ${JSON.stringify(status)}`);
  }
  if (!existsSync(status.stdout_log) || !existsSync(status.stderr_log)) {
    throw new Error(`Supervisor log files were not created: ${JSON.stringify(status)}`);
  }
  const stdoutLog = readFileSync(status.stdout_log, "utf-8").replace(/^\uFEFF/, "");
  const stderrLog = readFileSync(status.stderr_log, "utf-8").replace(/^\uFEFF/, "");
  if (!stdoutLog.includes(`fixture cwd=${root}`)) {
    throw new Error(`Tunnel child did not inherit the project working directory: ${stdoutLog}`);
  }
  if (!stderrLog.includes("fixture stderr line 35") || !stderrLog.includes("[REDACTED]")) {
    throw new Error(`Supervisor stderr log was not captured and sanitized: ${stderrLog}`);
  }
  const serialized = JSON.stringify(status);
  if (serialized.includes(secretMarker) || launcherOutput.includes(secretMarker) || stdoutLog.includes(secretMarker) || stderrLog.includes(secretMarker) || serialized.includes("tunnel_smoke_fixture")) {
    throw new Error("Supervisor status leaked credential or tunnel identifier material");
  }
  if (!launcherOutput.includes("[error] stderr tail:") || !launcherOutput.includes("fixture stderr line 35")) {
    throw new Error(`Supervisor did not print the stderr tail: ${launcherOutput}`);
  }
  console.log("ok - tunnel supervisor captures logs, redacts tails, fixes cwd, retries, and writes structured status");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
