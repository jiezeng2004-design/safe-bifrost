#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("ok - PatchWarden control smoke skipped outside Windows");
  process.exit(0);
}

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const root = resolve(scriptDir, "..", "..");
const manager = join(root, "scripts", "control", "manage-patchwarden.ps1");
const temp = mkdtempSync(join(tmpdir(), "patchwarden-control-smoke-"));
const mockConfig = join(temp, "patchwarden.config.json");
writeFileSync(mockConfig, JSON.stringify({
  workspaceRoot: temp,
  plansDir: ".patchwarden/plans",
  tasksDir: ".patchwarden/tasks",
}), "utf8");
const env = {
  ...process.env,
  LOCALAPPDATA: join(temp, "LocalAppData"),
  APPDATA: join(temp, "AppData"),
  TEMP: join(temp, "Temp"),
  TMP: join(temp, "Temp"),
  PATCHWARDEN_CONFIG: mockConfig,
};
let fakeTunnel = null;
let fakeWatcher = null;
let healthServer = null;

try {
  const statusOutput = run(["status", "all", "-Json"]);
  const statuses = JSON.parse(statusOutput);
  if (!Array.isArray(statuses) || statuses.length !== 2) {
    throw new Error(`expected two status rows, got: ${statusOutput}`);
  }
  const byMode = new Map(statuses.map((entry) => [entry.mode, entry]));
  if (byMode.get("core")?.tool_profile !== "chatgpt_core") {
    throw new Error("Core status did not report chatgpt_core");
  }
  if (byMode.get("direct")?.tool_profile !== "chatgpt_direct") {
    throw new Error("Direct status did not report chatgpt_direct");
  }

  const startPlan = run(["start", "all", "-WhatIf"]);
  requireText(startPlan, "start:core");
  requireText(startPlan, "start:direct");

  const restartPlan = run(["restart", "direct", "-WhatIf", "-SkipBuild"]);
  requireText(restartPlan, "stop:direct");
  requireText(restartPlan, "start:direct");

  const fakeDirectory = join(temp, "fake-tunnel");
  const fakeExecutable = join(fakeDirectory, "tunnel-client.exe");
  const fakeScript = join(fakeDirectory, "sleep.ps1");
  const systemPowerShell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  mkdirSync(fakeDirectory, { recursive: true });
  copyFileSync(systemPowerShell, fakeExecutable);
  writeFileSync(fakeScript, "Start-Sleep -Seconds 120\r\n", "utf8");
  fakeTunnel = spawn(
    fakeExecutable,
    ["-NoProfile", "-File", fakeScript, "run", "--profile", "patchwarden-direct"],
    { stdio: "ignore", windowsHide: true }
  );
  await delay(500);
  if (fakeTunnel.exitCode !== null) throw new Error("fake Tunnel process exited before stop test");
  const directRuntime = join(env.LOCALAPPDATA, "patchwarden", "runtime-direct");
  mkdirSync(directRuntime, { recursive: true });
  mkdirSync(env.TEMP, { recursive: true });
  writeFileSync(join(directRuntime, "tunnel-status.json"), JSON.stringify({
    status: "stopped",
    ready: false,
    pid: null,
    tool_profile: "chatgpt_direct",
    tool_count: 13,
    tools_ready: true,
  }), "utf8");
  writeFileSync(join(directRuntime, "tunnel-client.pid"), String(fakeTunnel.pid), "utf8");
  writeFileSync(join(directRuntime, "tunnel-health-url.txt"), "http://127.0.0.1:8081", "utf8");
  const legacyDirectPid = join(env.TEMP, "patchwarden-direct.pid");
  const legacyDirectUrl = join(env.TEMP, "patchwarden-direct-health.url");
  writeFileSync(legacyDirectPid, String(fakeTunnel.pid), "utf8");
  writeFileSync(legacyDirectUrl, "http://127.0.0.1:8081", "utf8");
  const stopOutput = run(["stop", "direct"]);
  requireText(stopOutput, `Stopped PID ${fakeTunnel.pid}`);
  await waitForExit(fakeTunnel, 5000);
  if (fakeTunnel.exitCode === null) throw new Error("manager did not stop the owned Direct fixture process");
  for (const stalePath of [join(directRuntime, "tunnel-client.pid"), join(directRuntime, "tunnel-health-url.txt"), legacyDirectPid, legacyDirectUrl]) {
    if (existsSync(stalePath)) throw new Error(`manager did not clean stale runtime file: ${stalePath}`);
  }

  fakeWatcher = spawn(
    process.execPath,
    ["-e", "setTimeout(()=>{},120000)", join(root, "dist", "runner", "watch.js")],
    { stdio: "ignore", windowsHide: true }
  );
  await delay(500);
  if (fakeWatcher.exitCode !== null) throw new Error("fake watcher exited before kill test");
  const killOutput = run(["kill", "core"]);
  requireText(killOutput, `Stopped PID ${fakeWatcher.pid}`);
  await waitForExit(fakeWatcher, 5000);
  if (fakeWatcher.exitCode === null) throw new Error("kill core did not stop the project-scoped watcher fixture");

  const coreRuntime = join(env.LOCALAPPDATA, "patchwarden", "runtime");
  mkdirSync(coreRuntime, { recursive: true });
  writeFileSync(join(coreRuntime, "tunnel-status.json"), JSON.stringify({
    status: "stopped",
    ready: false,
    pid: null,
    reason_code: "stale_fixture",
    last_error: "stale failure",
    tool_profile: "chatgpt_core",
    tool_count: 21,
    tools_ready: true,
  }), "utf8");
  healthServer = spawn(
    process.execPath,
    ["-e", "require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}))}).listen(8080,'127.0.0.1')"],
    { stdio: "ignore", windowsHide: true }
  );
  await delay(750);
  if (healthServer.exitCode !== null) throw new Error("health fallback fixture could not listen on 127.0.0.1:8080");
  const coreStatusRaw = run(["status", "core", "-Json"]);
  const coreStatusValue = JSON.parse(coreStatusRaw);
  const coreStatus = Array.isArray(coreStatusValue) ? coreStatusValue[0] : coreStatusValue;
  if (coreStatus.status !== "running" || coreStatus.ready !== true || coreStatus.health_alive !== true || coreStatus.reason_code !== "health_endpoint_ready") {
    throw new Error(`health fallback did not override stale runtime JSON: ${coreStatusRaw}`);
  }
  const conflict = runFailure(["restart", "core", "-WhatIf", "-SkipBuild"]);
  requireText(`${conflict.stdout}\n${conflict.stderr}`, "Unsafe health-port conflict");
  if (healthServer.exitCode !== null) throw new Error("manager killed an unrelated health-port owner");
  const scopedKill = run(["kill", "core"]);
  requireText(scopedKill, "No matching Core Agent process");
  if (healthServer.exitCode !== null) throw new Error("kill core terminated an unrelated process");

  const expectedFiles = [
    "PatchWarden.cmd",
    "PatchWarden-Control.cmd",
    "PatchWarden-Control-Tray.cmd",
    "PatchWarden-Desktop.cmd",
    "Restart-PatchWarden-Control.cmd",
    "Stop-PatchWarden.cmd",
    "scripts/control/manage-patchwarden.ps1",
    "scripts/control/stop-patchwarden.ps1",
    "scripts/launchers/Start-PatchWarden-Tunnel.cmd",
    "scripts/launchers/Start-PatchWarden-Direct-Tunnel.cmd",
  ];
  for (const relativePath of expectedFiles) {
    if (!existsSync(join(root, relativePath))) {
      throw new Error(`missing consolidated control file: ${relativePath}`);
    }
  }
  const rootEntry = readFileSync(join(root, "PatchWarden.cmd"), "utf8");
  if (!rootEntry.includes("manage-patchwarden.ps1")) {
    throw new Error("PatchWarden.cmd does not invoke the consolidated manager");
  }
  const stopEntry = readFileSync(join(root, "Stop-PatchWarden.cmd"), "utf8");
  if (!stopEntry.includes("scripts\\control\\stop-patchwarden.ps1")) {
    throw new Error("Stop-PatchWarden.cmd does not invoke the one-click shutdown script");
  }
  const desktopEntry = readFileSync(join(root, "PatchWarden-Desktop.cmd"), "utf8");
  if (!desktopEntry.includes("control-center-tray.ps1") || !desktopEntry.includes("WindowStyle Hidden")) {
    throw new Error("PatchWarden-Desktop.cmd must launch the tray hidden as the daily desktop entry");
  }
  console.log("ok - control handles orphan cleanup, scoped kill, port conflicts, health fallback, and Core/Direct lifecycle actions");
} finally {
  if (fakeTunnel?.exitCode === null) fakeTunnel.kill();
  if (fakeWatcher?.exitCode === null) fakeWatcher.kill();
  if (healthServer?.exitCode === null) healthServer.kill();
  rmSync(temp, { recursive: true, force: true });
}

function run(args) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", manager, ...args],
    { cwd: root, env, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`manager failed (${args.join(" ")}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function runFailure(args) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", manager, ...args],
    { cwd: root, env, encoding: "utf8" }
  );
  if (result.status === 0) {
    throw new Error(`manager unexpectedly succeeded (${args.join(" ")}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function requireText(value, expected) {
  if (!value.toLowerCase().includes(expected.toLowerCase())) {
    throw new Error(`expected ${JSON.stringify(expected)} in output:\n${value}`);
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("timed out waiting for fixture process to exit")), timeoutMilliseconds);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}
