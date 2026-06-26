#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("ok - watcher supervisor smoke skipped outside Windows");
  process.exit(0);
}

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "patchwarden-watcher-supervisor-"));
const children = [];

try {
  await runScenario("owned watcher exit triggers a controlled restart", "exit_once", 1, 9_000, (state) => {
    if (state.attempts < 2 || state.status.restart_attempts !== 1) {
      throw new Error(`Expected one owned restart: ${JSON.stringify(state)}`);
    }
  });

  await runScenario("frozen owned heartbeat reaches the restart limit", "freeze", 1, 22_000, (state) => {
    if (state.status.status !== "restart_limit_reached" || state.status.restart_attempts !== 2) {
      throw new Error(`Expected restart_limit_reached: ${JSON.stringify(state)}`);
    }
  });

  await runExternalScenario();
  console.log("ok - watcher supervisor isolates environment and handles exit, stale heartbeat, retry limit, and external ownership");
} finally {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  rmSync(temp, { recursive: true, force: true });
}

async function runScenario(label, mode, maxRestarts, lifetimeMs, assertState) {
  const fixture = createFixture(label.replace(/[^a-z0-9]+/gi, "-"));
  const result = runLauncher(fixture, mode, maxRestarts, lifetimeMs);
  if (result.error && result.error.code === "ETIMEDOUT") throw result.error;
  if (!existsSync(fixture.watcherStatusPath)) {
    throw new Error(`Watcher status was not created. exit=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
  }
  const status = readJson(fixture.watcherStatusPath);
  const attempts = Number(readFileSync(fixture.watcherAttemptPath, "utf-8")) || 0;
  assertState({ status, attempts, stdout: result.stdout, stderr: result.stderr });
}

async function runExternalScenario() {
  const fixture = createFixture("external");
  const env = fixtureEnv(fixture, "healthy", 7_000);
  const external = spawn(process.execPath, [fixture.watcherPath], {
    cwd: fixture.project,
    env: {
      ...env,
      PATCHWARDEN_CONFIG: fixture.configPath,
      PATCHWARDEN_WATCHER_INSTANCE_ID: "external-fixture",
      PATCHWARDEN_WATCHER_LAUNCHER_PID: "999999",
      XDG_CONFIG_HOME: join(fixture.localAppData, "patchwarden", "opencode-config"),
    },
    stdio: "ignore",
  });
  children.push(external);
  for (let attempt = 0; attempt < 40 && !existsSync(fixture.heartbeatPath); attempt++) await sleep(100);
  if (!existsSync(fixture.heartbeatPath)) throw new Error("External watcher heartbeat was not created");

  const result = runLauncher(fixture, "healthy", 1, 7_000);
  if (result.error && result.error.code === "ETIMEDOUT") throw result.error;
  if (external.exitCode !== null) throw new Error("Launcher stopped an external watcher");
  const status = readJson(fixture.watcherStatusPath);
  if (status.managed !== false || status.status !== "external_healthy") {
    throw new Error(`External watcher ownership mismatch: ${JSON.stringify(status)}`);
  }
}

function createFixture(name) {
  const project = join(temp, name, "patchwarden-fixture");
  const scripts = join(project, "scripts");
  const controlScripts = join(scripts, "control");
  const mcpScripts = join(scripts, "mcp");
  const checkScripts = join(scripts, "checks");
  const runner = join(project, "dist", "runner");
  const workspace = join(project, "workspace");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(controlScripts, { recursive: true });
  mkdirSync(mcpScripts, { recursive: true });
  mkdirSync(checkScripts, { recursive: true });
  mkdirSync(runner, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  cpSync(join(root, "scripts", "control", "start-patchwarden-tunnel.ps1"), join(controlScripts, "start-patchwarden-tunnel.ps1"));
  writeFileSync(join(mcpScripts, "patchwarden-mcp-stdio.cmd"), "@echo off\r\nexit /b 0\r\n", "utf-8");
  const manifestFixture = JSON.stringify({
    ok: true,
    server_version: "0.6.0",
    schema_epoch: "2026-06-22-v6",
    tool_profile: "chatgpt_core",
    tool_count: 16,
    tool_names: [],
    tool_manifest_sha256: "a".repeat(64),
  });
  writeFileSync(join(checkScripts, "mcp-manifest-check.js"), `process.stdout.write(${JSON.stringify(manifestFixture)});\n`, "utf-8");
  writeFileSync(join(project, "dist", "index.js"), "", "utf-8");
  const watcherAttemptPath = join(project, "watcher-attempt.txt");
  const watcherPath = join(runner, "watch.js");
  writeFileSync(watcherPath, watcherFixtureSource(watcherAttemptPath), "utf-8");
  const configPath = join(project, "patchwarden.config.json");
  writeFileSync(configPath, JSON.stringify({
    workspaceRoot: workspace,
    plansDir: ".patchwarden/plans",
    tasksDir: ".patchwarden/tasks",
    watcherStaleSeconds: 5,
    agents: {},
    allowedTestCommands: [],
    maxReadFileBytes: 200000,
    defaultTaskTimeoutSeconds: 30,
    maxTaskTimeoutSeconds: 60,
  }, null, 2), "utf-8");
  const mockJs = join(project, "mock-tunnel-client.js");
  const mockCmd = join(project, "mock-tunnel-client.cmd");
  writeFileSync(mockCmd, `@echo off\r\nnode "${mockJs}" %*\r\n`, "utf-8");
  writeFileSync(mockJs, tunnelFixtureSource(), "utf-8");
  const localAppData = join(project, "localappdata");
  return {
    project,
    configPath,
    watcherPath,
    watcherAttemptPath,
    heartbeatPath: join(workspace, ".patchwarden", "watcher-heartbeat.json"),
    watcherStatusPath: join(localAppData, "patchwarden", "runtime", "watcher-status.json"),
    mockCmd,
    localAppData,
    appData: join(project, "appdata"),
  };
}

function runLauncher(fixture, mode, maxRestarts, lifetimeMs) {
  return spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(fixture.project, "scripts", "control", "start-patchwarden-tunnel.ps1"),
    "-TunnelId", "tunnel_watcher_fixture",
    "-TunnelClientExe", fixture.mockCmd,
    "-ProxyUrl", "http://127.0.0.1:1",
    "-MaxReconnectAttempts", "1",
    "-HealthListenAddr", "127.0.0.1:8080",
    "-WatcherMaxRestartAttempts", String(maxRestarts),
    "-WatcherHealthyResetSeconds", "60",
  ], {
    cwd: fixture.project,
    env: fixtureEnv(fixture, mode, lifetimeMs),
    encoding: "utf-8",
    timeout: lifetimeMs + 20_000,
  });
}

function fixtureEnv(fixture, mode, lifetimeMs) {
  return {
    ...process.env,
    APPDATA: fixture.appData,
    LOCALAPPDATA: fixture.localAppData,
    CONTROL_PLANE_API_KEY: "watcher-supervisor-smoke-secret",
    WATCHER_FIXTURE_MODE: mode,
    TUNNEL_FIXTURE_LIFETIME_MS: String(lifetimeMs),
  };
}

function watcherFixtureSource(attemptPath) {
  return `
const fs=require('fs');const path=require('path');
if(!process.env.XDG_CONFIG_HOME){console.error('watcher did not receive XDG_CONFIG_HOME');process.exit(12)}
let attempt=0;try{attempt=Number(fs.readFileSync(${JSON.stringify(attemptPath)},'utf8'))||0}catch{}
attempt++;fs.writeFileSync(${JSON.stringify(attemptPath)},String(attempt));
const cfg=JSON.parse(fs.readFileSync(process.env.PATCHWARDEN_CONFIG,'utf8'));
const heartbeat=path.join(cfg.workspaceRoot,'.patchwarden','watcher-heartbeat.json');fs.mkdirSync(path.dirname(heartbeat),{recursive:true});
const write=()=>{const temp=heartbeat+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify({status:'running',pid:process.pid,instance_id:process.env.PATCHWARDEN_WATCHER_INSTANCE_ID,launcher_pid:Number(process.env.PATCHWARDEN_WATCHER_LAUNCHER_PID),started_at:new Date().toISOString(),last_heartbeat_at:new Date().toISOString()}));fs.renameSync(temp,heartbeat)};
write();const mode=process.env.WATCHER_FIXTURE_MODE;
if(mode==='exit_once'&&attempt===1)setTimeout(()=>process.exit(7),100);
else if(mode==='freeze')setInterval(()=>{},1000);
else setInterval(write,250);
`;
}

function tunnelFixtureSource() {
  return `
const fs=require('fs');const path=require('path');const args=process.argv.slice(2);const command=args[0]||'';
const flag=(name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:''};
if(command==='init'){const profile=flag('--profile')||'patchwarden';const mcpCommand=flag('--mcp-command')||'';const yamlDir=path.join(process.env.APPDATA,'tunnel-client');const yamlPath=path.join(yamlDir,profile+'.yaml');fs.mkdirSync(yamlDir,{recursive:true});fs.writeFileSync(yamlPath,'mcp:\\n  commands:\\n    - channel: main\\n      command: \"'+mcpCommand.replace(/\\\\/g,'/')+'\"\\n\\nhealth:\\n  listen_addr: \"127.0.0.1:8080\"\\n');console.log('{}');process.exit(0)}
if(command==='doctor'){console.log('{}');process.exit(0)}
if(command==='health'){console.log(JSON.stringify({healthz:{ok:true},readyz:{ok:true}}));process.exit(0)}
if(command==='run'){if(process.env.XDG_CONFIG_HOME){console.error('watcher XDG_CONFIG_HOME leaked into tunnel-client');process.exit(21)}const url=flag('--health.url-file'),pid=flag('--pid.file');fs.mkdirSync(path.dirname(url),{recursive:true});fs.writeFileSync(url,'http://127.0.0.1:18889');fs.writeFileSync(pid,String(process.pid));setTimeout(()=>process.exit(9),Number(process.env.TUNNEL_FIXTURE_LIFETIME_MS)||9000)}
`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
}
