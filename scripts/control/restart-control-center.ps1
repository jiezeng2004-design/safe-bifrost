#Requires -Version 5.1
param(
  [switch]$NoBrowser,
  [switch]$NoBuild
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ControlCenterEntry = Join-Path $ProjectRoot "dist\controlCenter.js"
$ControlCenterEntryFull = [System.IO.Path]::GetFullPath($ControlCenterEntry)
$ProjectRootFull = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd("\")
$ListenPort = 8090
$ListenUrl = "http://127.0.0.1:$ListenPort/"
$RuntimeDirectory = Join-Path $env:LOCALAPPDATA "patchwarden\control-center"
$StdoutLog = Join-Path $RuntimeDirectory "control-center.stdout.log"
$StderrLog = Join-Path $RuntimeDirectory "control-center.stderr.log"
$MaxWaitSeconds = 15

Set-Location -LiteralPath $ProjectRoot

function Test-ControlCenterProcess {
  param([Parameter(Mandatory = $true)]$ProcessInfo)

  $commandLine = [string]$ProcessInfo.CommandLine
  if (-not $commandLine) { return $false }

  $normalizedCommand = $commandLine.Replace("/", "\").ToLowerInvariant()
  $normalizedEntry = $ControlCenterEntryFull.ToLowerInvariant()
  $normalizedRoot = $ProjectRootFull.ToLowerInvariant()

  return $normalizedCommand.Contains($normalizedEntry) -or (
    $normalizedCommand.Contains("dist\controlcenter.js") -and
    $normalizedCommand.Contains($normalizedRoot)
  )
}

function Get-ControlCenterProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { Test-ControlCenterProcess $_ }
}

function Assert-PortIsNotForeign {
  try {
    $listeners = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop
  } catch {
    return
  }

  foreach ($listener in $listeners) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $owner) { continue }
    if (-not (Test-ControlCenterProcess $owner)) {
      Write-Host "[error] Port $ListenPort is used by a non-PatchWarden Control Center process." -ForegroundColor Red
      Write-Host "[error] PID $($owner.ProcessId): $($owner.CommandLine)" -ForegroundColor DarkRed
      Write-Host "[error] Close that process manually, then rerun this script." -ForegroundColor Yellow
      exit 1
    }
  }
}

function Stop-ControlCenterProcesses {
  $processes = @(Get-ControlCenterProcesses)
  if ($processes.Count -eq 0) {
    Write-Host "[stop] No existing PatchWarden Control Center process found." -ForegroundColor DarkGray
    return
  }

  foreach ($proc in $processes) {
    Write-Host "[stop] Stopping Control Center PID $($proc.ProcessId)." -ForegroundColor Yellow
    Stop-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
  }

  Start-Sleep -Milliseconds 800

  foreach ($proc in $processes) {
    $stillRunning = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
    if ($stillRunning) {
      Write-Host "[stop] PID $($proc.ProcessId) did not exit cleanly; forcing stop." -ForegroundColor Yellow
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-BuildIfNeeded {
  if ($NoBuild) {
    Write-Host "[build] Skipped by -NoBuild." -ForegroundColor DarkGray
    return
  }

  Write-Host "[build] Running npm.cmd run build..." -ForegroundColor Cyan
  npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[error] npm.cmd run build exited with code $LASTEXITCODE." -ForegroundColor Red
    exit $LASTEXITCODE
  }
  if (-not (Test-Path -LiteralPath $ControlCenterEntryFull)) {
    Write-Host "[error] Build completed but dist\controlCenter.js is missing." -ForegroundColor Red
    exit 1
  }
}

function Start-ControlCenter {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    Write-Host "[error] node.exe was not found on PATH." -ForegroundColor Red
    exit 1
  }

  New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
  Remove-Item -LiteralPath $StdoutLog, $StderrLog -Force -ErrorAction SilentlyContinue

  Write-Host "[run] Starting PatchWarden Control Center on $ListenUrl" -ForegroundColor Cyan
  $process = Start-Process -FilePath $nodeCommand.Source `
    -ArgumentList @($ControlCenterEntryFull) `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError $StderrLog `
    -PassThru -WindowStyle Hidden

  Start-Sleep -Milliseconds 500
  if ($process.HasExited) {
    Write-Host "[error] Control Center exited immediately with code $($process.ExitCode)." -ForegroundColor Red
    if (Test-Path -LiteralPath $StderrLog) {
      Get-Content -LiteralPath $StderrLog -Tail 20 -ErrorAction SilentlyContinue
    }
    exit 1
  }

  $ready = $false
  for ($attempt = 1; $attempt -le $MaxWaitSeconds; $attempt++) {
    try {
      $process.Refresh()
      if ($process.HasExited) {
        Write-Host "[error] Control Center exited before readiness with code $($process.ExitCode)." -ForegroundColor Red
        if (Test-Path -LiteralPath $StderrLog) {
          Get-Content -LiteralPath $StderrLog -Tail 20 -ErrorAction SilentlyContinue
        }
        exit 1
      }

      $response = Invoke-WebRequest -Uri $ListenUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        $ready = $true
        break
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }

  if (-not $ready) {
    Write-Host "[error] Control Center did not become ready on $ListenUrl within $MaxWaitSeconds seconds." -ForegroundColor Red
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    exit 1
  }

  Write-Host "[ok] PatchWarden Control Center restarted at $ListenUrl" -ForegroundColor Green
  Write-Host "[info] node PID $($process.Id)" -ForegroundColor DarkGray
  Write-Host "[info] stdout log: $StdoutLog" -ForegroundColor DarkGray
  Write-Host "[info] stderr log: $StderrLog" -ForegroundColor DarkGray

  if (-not $NoBrowser) {
    $cacheBuster = Get-Date -Format "yyyyMMddHHmmss"
    Start-Process "$ListenUrl`?restarted=$cacheBuster"
  }
}

Assert-PortIsNotForeign
Stop-ControlCenterProcesses
Invoke-BuildIfNeeded
Assert-PortIsNotForeign
Start-ControlCenter
