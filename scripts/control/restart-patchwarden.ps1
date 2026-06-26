param(
  [switch]$SkipBuild,
  [switch]$SkipWatcher,
  [switch]$WhatIf,
  [int]$KillTimeoutSeconds = 10
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ConfigPath = Join-Path $ProjectRoot "patchwarden.config.json"
$RuntimeDirectory = Join-Path $env:LOCALAPPDATA "patchwarden\runtime"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " PatchWarden One-Click Restart" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# -- 1. Find PatchWarden processes ----------------------------------

Write-Host "[1/4] Scanning for PatchWarden processes..." -ForegroundColor Yellow

$processesToKill = @()
try {
  $allProcesses = Get-CimInstance Win32_Process
  $byPid = @{}
  foreach ($process in $allProcesses) { $byPid[[int]$process.ProcessId] = $process }
  $seedIds = New-Object System.Collections.Generic.HashSet[int]
  $tunnelStatusPath = Join-Path $RuntimeDirectory "tunnel-status.json"
  $watcherStatusPath = Join-Path $RuntimeDirectory "watcher-status.json"
  if (Test-Path -LiteralPath $tunnelStatusPath) {
    $state = Get-Content -LiteralPath $tunnelStatusPath -Raw | ConvertFrom-Json
    $candidate = $byPid[[int]$state.pid]
    if ($candidate -and [string]$candidate.CommandLine -match '(?i)tunnel-client\.exe.*run.*patchwarden') {
      [void]$seedIds.Add([int]$candidate.ProcessId)
    }
  }
  if (Test-Path -LiteralPath $watcherStatusPath) {
    $state = Get-Content -LiteralPath $watcherStatusPath -Raw | ConvertFrom-Json
    $watcherCandidate = $byPid[[int]$state.pid]
    if ($watcherCandidate -and [string]$watcherCandidate.CommandLine -like "*$ProjectRoot*dist*runner*watch.js*") {
      [void]$seedIds.Add([int]$watcherCandidate.ProcessId)
    }
    $launcherCandidate = $byPid[[int]$state.launcher_pid]
    if ($launcherCandidate -and [string]$launcherCandidate.CommandLine -like "*$ProjectRoot*start-patchwarden-tunnel.ps1*") {
      [void]$seedIds.Add([int]$launcherCandidate.ProcessId)
    }
  }
  foreach ($seed in @($seedIds)) {
    $current = $byPid[$seed]
    while ($current -and [int]$current.ParentProcessId -gt 0) {
      $parent = $byPid[[int]$current.ParentProcessId]
      if (-not $parent) { break }
      if ([string]$parent.CommandLine -like "*$ProjectRoot*start-patchwarden-tunnel.ps1*") {
        [void]$seedIds.Add([int]$parent.ProcessId)
      }
      $current = $parent
    }
  }
  $ownedIds = New-Object System.Collections.Generic.HashSet[int]
  foreach ($seed in $seedIds) { [void]$ownedIds.Add($seed) }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $allProcesses) {
      if ($ownedIds.Contains([int]$process.ParentProcessId) -and -not $ownedIds.Contains([int]$process.ProcessId)) {
        [void]$ownedIds.Add([int]$process.ProcessId)
        $changed = $true
      }
    }
  }
  foreach ($ownedId in $ownedIds) {
    $process = $byPid[$ownedId]
    if (-not $process -or $process.ProcessId -eq $PID) { continue }
    $commandLine = [string]$process.CommandLine
    $processesToKill += [ordered]@{
      pid = $process.ProcessId
      name = $process.Name
      label = if ($seedIds.Contains([int]$process.ProcessId)) { "owned runtime" } else { "owned child" }
      command = $commandLine.Substring(0, [Math]::Min(200, $commandLine.Length))
    }
  }
} catch {
  Write-Warning "Could not enumerate processes: $_"
}

if ($processesToKill.Count -eq 0) {
  Write-Host "  No PatchWarden processes found." -ForegroundColor Green
} else {
  Write-Host "  Found $($processesToKill.Count) PatchWarden process(es):" -ForegroundColor White
  foreach ($proc in $processesToKill) {
    Write-Host "    PID $($proc.pid) - $($proc.label) ($($proc.name))" -ForegroundColor Gray
  }
}

# -- 2. Kill processes -----------------------------------------------

if ($processesToKill.Count -gt 0) {
  Write-Host ""
  Write-Host "[2/4] Stopping PatchWarden processes..." -ForegroundColor Yellow

  if ($WhatIf) {
    Write-Host "  WHAT-IF: Would stop $($processesToKill.Count) process(es)." -ForegroundColor Magenta
  } else {
    foreach ($proc in $processesToKill) {
      try {
        $process = Get-Process -Id $proc.pid -ErrorAction Stop
        Write-Host "  Stopping PID $($proc.pid) ($($proc.label))..." -ForegroundColor Gray
        $process.Kill()
        $exited = $process.WaitForExit($KillTimeoutSeconds * 1000)
        if ($exited) {
          Write-Host "    Stopped." -ForegroundColor Green
        } else {
          Write-Host "    Kill sent but process did not exit within ${KillTimeoutSeconds}s." -ForegroundColor Yellow
        }
      } catch {
        Write-Host "  PID $($proc.pid) already exited or inaccessible - skipped." -ForegroundColor DarkGray
      }
    }

  }
}

# -- 3. Rebuild ------------------------------------------------------

Write-Host ""
if ($SkipBuild) {
  Write-Host "[3/4] Skipping build (--SkipBuild)." -ForegroundColor DarkYellow
} else {
  Write-Host "[3/4] Rebuilding PatchWarden..." -ForegroundColor Yellow
  
  if ($WhatIf) {
    Write-Host "  WHAT-IF: Would run npm.cmd run build." -ForegroundColor Magenta
  } else {
    Push-Location $ProjectRoot
    try {
      $buildResult = npm.cmd run build 2>&1
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "Build completed with warnings (exit code $LASTEXITCODE)."
        Write-Host ($buildResult -join "`n") -ForegroundColor DarkGray
      } else {
        Write-Host "  Build successful." -ForegroundColor Green
      }
    } catch {
      Write-Warning "Build failed: $_"
      Write-Host "  Continuing anyway - dist may be stale." -ForegroundColor DarkRed
    } finally {
      Pop-Location
    }
  }
}

# -- Clear stale runtime state ----------------------------------------

if (-not $WhatIf) {
  # LOCALAPPDATA runtime files (launcher-managed supervision state)
  if (Test-Path -LiteralPath $RuntimeDirectory) {
    try {
      $staleFiles = @(
        Join-Path $RuntimeDirectory "tunnel-health-url.txt",
        Join-Path $RuntimeDirectory "tunnel-client.pid",
        Join-Path $RuntimeDirectory "watcher-status.json",
        Join-Path $RuntimeDirectory "tunnel-status.json"
      )
      foreach ($file in $staleFiles) {
        if (Test-Path -LiteralPath $file) {
          Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        }
      }
    } catch {}
  }

  # Workspace watcher heartbeat - CRITICAL: the killed watcher stops
  # writing this file, but the stale record can fool a fresh launcher
  # into treating it as an "external_healthy" watcher (age < stale
  # threshold right after kill), which prevents the launcher from
  # starting its own watcher. Removing it forces a clean start.
  try {
    if (Test-Path -LiteralPath $ConfigPath) {
      $cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
      $tasksDir = Join-Path $cfg.workspaceRoot $cfg.tasksDir
      $heartbeatFile = Join-Path (Split-Path -Parent $tasksDir) "watcher-heartbeat.json"
      if (Test-Path -LiteralPath $heartbeatFile) {
        Remove-Item -LiteralPath $heartbeatFile -Force -ErrorAction SilentlyContinue
        Write-Host "  Cleared stale watcher heartbeat." -ForegroundColor Green
      }
    }
  } catch {}
}

# -- 4. Relaunch tunnel ----------------------------------------------

Write-Host ""
Write-Host "[4/4] Launching PatchWarden tunnel..." -ForegroundColor Yellow

if ($WhatIf) {
  Write-Host "  WHAT-IF: Would launch the Core compatibility launcher." -ForegroundColor Magenta
  Write-Host ""
  Write-Host "========================================" -ForegroundColor Cyan
  Write-Host " Restart plan complete (--WhatIf)." -ForegroundColor Cyan
  Write-Host "========================================" -ForegroundColor Cyan
  Write-Host ""
  exit 0
}

# Relaunch the tunnel in a new PowerShell window.
# Prefer Start-PatchWarden-Tunnel.local.cmd (your saved config) over the generic launcher.
$launcherDirectory = Join-Path $ProjectRoot "scripts\launchers"
$localLauncher = Join-Path $launcherDirectory "Start-PatchWarden-Tunnel.local.cmd"
$genericLauncher = Join-Path $launcherDirectory "Start-PatchWarden-Tunnel.cmd"
$launcherPath = if (Test-Path -LiteralPath $localLauncher) { $localLauncher } else { $genericLauncher }

if (-not (Test-Path -LiteralPath $launcherPath)) {
  Write-Error "Launcher not found: $launcherPath"
  exit 1
}

$launcherName = Split-Path -Leaf $launcherPath
Write-Host "  Using launcher: $launcherName" -ForegroundColor White
if ($launcherPath -eq $localLauncher) {
  Write-Host "  (local config with pre-set TUNNEL_ID / TUNNEL_CLIENT_EXE)" -ForegroundColor DarkGray
}
Write-Host ""

$args = @(
  "-NoProfile",
  "-NoExit",
  "-Command",
  "Set-Location '$ProjectRoot'; & '$launcherPath'"
)
if ($SkipWatcher) {
  $args[3] = "Set-Location '$ProjectRoot'; `$env:PATCHWARDEN_SKIP_WATCHER='1'; & '$launcherPath'"
}

Start-Process powershell.exe -ArgumentList $args

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Restart complete. Tunnel launcher window opened." -ForegroundColor Cyan
Write-Host " Use PatchWarden.cmd status all to verify." -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
