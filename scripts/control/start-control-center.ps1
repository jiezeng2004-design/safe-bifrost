#Requires -Version 5.1
param(
  [switch]$NoBrowser,
  [switch]$Foreground,
  [switch]$Background
)

$ErrorActionPreference = "Stop"

# ── Argument reconciliation ──────────────────────────────────────
# -Foreground and -Background are mutually exclusive. When neither is
# supplied, default to -Background (detach node, exit after readiness).
if ($Foreground -and $Background) {
  Write-Host "[error] -Foreground and -Background are mutually exclusive." -ForegroundColor Red
  exit 1
}
if (-not $Foreground -and -not $Background) {
  $Background = $true
}

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ControlCenterEntry = Join-Path $ProjectRoot "dist\controlCenter.js"
$ControlCenterEntryFull = [System.IO.Path]::GetFullPath($ControlCenterEntry)
$ProjectRootFull = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd("\")
$ListenPort = 8090
$ListenUrl = "http://127.0.0.1:$ListenPort/"
$RuntimeDirectory = Join-Path $env:LOCALAPPDATA "patchwarden\control-center"
$StatusFile = Join-Path $RuntimeDirectory "control-center-status.json"
$StdoutLog = Join-Path $RuntimeDirectory "control-center.stdout.log"
$StderrLog = Join-Path $RuntimeDirectory "control-center.stderr.log"
$MaxWaitSeconds = 15
$PollIntervalSeconds = 1

Set-Location -LiteralPath $ProjectRoot

# ── Helpers ──────────────────────────────────────────────────────

function Test-ControlCenterCommandLine {
  param([string]$CommandLine)
  if (-not $CommandLine) { return $false }
  $normalizedCommand = $CommandLine.Replace("/", "\").ToLowerInvariant()
  $normalizedEntry = $ControlCenterEntryFull.ToLowerInvariant()
  $normalizedRoot = $ProjectRootFull.ToLowerInvariant()
  return $normalizedCommand.Contains($normalizedEntry) -or (
    $normalizedCommand.Contains("dist\controlcenter.js") -and
    $normalizedCommand.Contains($normalizedRoot)
  )
}

function Get-ControlCenterProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { Test-ControlCenterCommandLine ([string]$_.CommandLine) }
}

function Read-StatusFile {
  if (-not (Test-Path -LiteralPath $StatusFile)) { return $null }
  try {
    return Get-Content -LiteralPath $StatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-PortOwnedByControlCenter {
  # Returns $true if a process is listening on $ListenPort AND it is our control
  # center node process. Returns $false if nothing is listening. Throws a
  # descriptive message if a foreign process owns the port.
  $listeners = @()
  try {
    $listeners = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop |
      Sort-Object OwningProcess -Unique
  } catch {
    return $false  # nothing listening
  }
  foreach ($listener in $listeners) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $owner) { continue }
    if (Test-ControlCenterCommandLine ([string]$owner.CommandLine)) {
      return $true
    } else {
      Write-Host "[error] Port $ListenPort is already used by a non-PatchWarden process." -ForegroundColor Red
      Write-Host "[error] PID $($owner.ProcessId): $($owner.CommandLine)" -ForegroundColor DarkRed
      Write-Host "[error] Close that process manually, then rerun this script." -ForegroundColor Yellow
      exit 1
    }
  }
  return $false
}

function Get-StderrTail {
  if (-not (Test-Path -LiteralPath $StderrLog)) { return "" }
  try {
    $content = Get-Content -LiteralPath $StderrLog -Raw -Encoding UTF8 -ErrorAction Stop
    if (-not $content) { return "" }
    $trimmed = ($content -replace '[\r\n]+', ' ').Trim()
    if ($trimmed.Length -gt 500) { $trimmed = $trimmed.Substring(0, 500) }
    return $trimmed
  } catch {
    return ""
  }
}

# ── Single-instance detection ────────────────────────────────────
# 1. Read the status file. If it points at a live control center (port
#    responds AND pid is alive AND command line matches), just open the
#    browser and exit — do NOT spawn a second server.
# 2. If the port is occupied by a foreign process, error out.
# 3. Otherwise start a fresh instance.

$existing = Read-StatusFile
if ($existing) {
  $existingPid = 0
  [int]::TryParse([string]$existing.pid, [ref]$existingPid) | Out-Null
  $existingPort = 0
  [int]::TryParse([string]$existing.port, [ref]$existingPort) | Out-Null

  $pidAlive = $false
  if ($existingPid -gt 0) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $existingPid" -ErrorAction SilentlyContinue
    if ($proc -and (Test-ControlCenterCommandLine ([string]$proc.CommandLine))) {
      $pidAlive = $true
    }
  }

  if ($pidAlive -and $existingPort -gt 0) {
    $probeUrl = "http://127.0.0.1:$existingPort/api/control-center-status"
    try {
      $resp = Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      if ($resp.StatusCode -eq 200) {
        $body = $resp.Content | ConvertFrom-Json
        if ($body.running -eq $true) {
          $existingUrl = "http://127.0.0.1:$existingPort/"
          Write-Host "[ok] PatchWarden Control Center is already running (PID $existingPid)." -ForegroundColor Green
          Write-Host "[ok] URL: $existingUrl" -ForegroundColor Green
          if (-not $NoBrowser) {
            Write-Host "[open] Launching browser at $existingUrl"
            Start-Process $existingUrl
          }
          exit 0
        }
      }
    } catch {
      # Status file exists but the probe failed — stale entry. Fall through
      # to a fresh start after cleaning up.
      Write-Host "[warn] Status file exists but the server did not respond; starting a new instance." -ForegroundColor DarkYellow
    }
  } else {
    Write-Host "[warn] Status file references a dead PID; starting a new instance." -ForegroundColor DarkYellow
  }
}

# Detect foreign port occupation before spawning.
Test-PortOwnedByControlCenter | Out-Null
# If we reach here, either nothing is listening or our own (now-dead) process
# was the listener. Clean up any orphaned node processes for this entry point.
$orphans = @(Get-ControlCenterProcesses)
if ($orphans.Count -gt 0) {
  Write-Host "[cleanup] Stopping $($orphans.Count) orphaned Control Center node process(es)." -ForegroundColor DarkYellow
  foreach ($p in $orphans) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
  }
  Start-Sleep -Milliseconds 500
}

# ── Build if needed ──────────────────────────────────────────────

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Host "[error] node.exe was not found on PATH." -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -LiteralPath $ControlCenterEntryFull)) {
  Write-Host "[build] dist/controlCenter.js not found. Running npm.cmd run build..." -ForegroundColor Yellow
  npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[error] npm.cmd run build exited with code $LASTEXITCODE." -ForegroundColor Red
    exit 1
  }
  if (-not (Test-Path -LiteralPath $ControlCenterEntryFull)) {
    Write-Host "[error] Build completed but dist/controlCenter.js is still missing." -ForegroundColor Red
    exit 1
  }
  Write-Host "[build] Build complete." -ForegroundColor Green
}

New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
Remove-Item -LiteralPath $StdoutLog, $StderrLog -Force -ErrorAction SilentlyContinue

# ── Foreground mode: node attached to this console, logs stream live ──
if ($Foreground) {
  Write-Host "[run] Starting PatchWarden Control Center on $ListenUrl (foreground)" -ForegroundColor Cyan
  Write-Host "[run] Press Ctrl+C to stop. Logs stream below."
  # In foreground mode the node process inherits this console; the status file
  # is still written by the server itself on listen().
  & $nodeCommand.Source $ControlCenterEntryFull
  exit $LASTEXITCODE
}

# ── Background mode (default): detached node, this script exits after ready ──
Write-Host "[run] Starting PatchWarden Control Center on $ListenUrl (background)" -ForegroundColor Cyan
$process = Start-Process -FilePath $nodeCommand.Source `
  -ArgumentList @($ControlCenterEntryFull) `
  -WorkingDirectory $ProjectRoot `
  -RedirectStandardOutput $StdoutLog `
  -RedirectStandardError $StderrLog `
  -PassThru -WindowStyle Hidden

Write-Host "[run] node PID $($process.Id)."

# Brief wait to detect truly immediate exits.
Start-Sleep -Milliseconds 500
if ($process.HasExited) {
  $exitCode = $process.ExitCode
  $stderrTail = Get-StderrTail
  Write-Host "[error] node process exited immediately with code $exitCode." -ForegroundColor Red
  if ($stderrTail) {
    Write-Host "[error] stderr: $stderrTail" -ForegroundColor DarkRed
  }
  exit 1
}

# Poll for port readiness.
$ready = $false
for ($attempt = 1; $attempt -le $MaxWaitSeconds; $attempt++) {
  try { $process.Refresh() } catch {}
  if ($process.HasExited) {
    $exitCode = $process.ExitCode
    $stderrTail = Get-StderrTail
    Write-Host "[error] node process exited with code $exitCode before the port became ready." -ForegroundColor Red
    if ($stderrTail) {
      Write-Host "[error] stderr: $stderrTail" -ForegroundColor DarkRed
    }
    exit 1
  }
  try {
    $response = Invoke-WebRequest -Uri $ListenUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
      $ready = $true
      break
    }
  } catch {
    # Not ready yet; keep polling.
  }
  Start-Sleep -Seconds $PollIntervalSeconds
}

if (-not $ready) {
  Write-Host "[error] Control Center did not become ready on $ListenUrl within $MaxWaitSeconds seconds." -ForegroundColor Red
  try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch {}
  exit 1
}

Write-Host "[ok] PatchWarden Control Center is ready at $ListenUrl" -ForegroundColor Green

if (-not $NoBrowser) {
  Write-Host "[open] Launching default browser at $ListenUrl"
  Start-Process $ListenUrl
}

Write-Host "[info] node PID $($process.Id); stdout log: $StdoutLog; stderr log: $StderrLog"
Write-Host "[info] Re-run this script to open the existing instance instead of starting a new one."
Write-Host "[info] Stop with: Stop-Process -Id $($process.Id)"
