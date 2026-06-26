#Requires -Version 5.1
<#
.SYNOPSIS
  One-click shutdown for PatchWarden desktop use.
.DESCRIPTION
  Stops Core/Direct through the consolidated manager, then closes the local
  Control Center and tray processes that belong to this project path.
#>
param(
  [switch]$KeepControlCenter,
  [switch]$KeepTray
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ProjectRootFull = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd("\")
$Manager = Join-Path $PSScriptRoot "manage-patchwarden.ps1"
$ControlCenterEntry = Join-Path $ProjectRoot "dist\controlCenter.js"
$ControlCenterEntryFull = [System.IO.Path]::GetFullPath($ControlCenterEntry)
$TrayScript = Join-Path $PSScriptRoot "control-center-tray.ps1"
$TrayScriptFull = [System.IO.Path]::GetFullPath($TrayScript)
$RuntimeDirectory = Join-Path $env:LOCALAPPDATA "patchwarden\control-center"
$StatusFile = Join-Path $RuntimeDirectory "control-center-status.json"

Set-Location -LiteralPath $ProjectRoot

function Normalize-CommandLine {
  param([string]$CommandLine)
  if (-not $CommandLine) { return "" }
  return $CommandLine.Replace("/", "\").ToLowerInvariant()
}

function Test-ControlCenterProcess {
  param($ProcessInfo)
  $normalizedCommand = Normalize-CommandLine ([string]$ProcessInfo.CommandLine)
  $normalizedEntry = $ControlCenterEntryFull.ToLowerInvariant()
  $normalizedRoot = $ProjectRootFull.ToLowerInvariant()
  return $normalizedCommand.Contains($normalizedEntry) -or (
    $normalizedCommand.Contains("dist\controlcenter.js") -and
    $normalizedCommand.Contains($normalizedRoot)
  )
}

function Test-TrayProcess {
  param($ProcessInfo)
  $normalizedCommand = Normalize-CommandLine ([string]$ProcessInfo.CommandLine)
  $normalizedTray = $TrayScriptFull.ToLowerInvariant()
  $normalizedRoot = $ProjectRootFull.ToLowerInvariant()
  return $normalizedCommand.Contains($normalizedTray) -or (
    $normalizedCommand.Contains("control-center-tray.ps1") -and
    $normalizedCommand.Contains($normalizedRoot)
  )
}

function Stop-MatchingProcesses {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Predicate
  )

  $processes = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        [int]$_.ProcessId -ne $PID -and (& $Predicate $_)
      }
  )

  if ($processes.Count -eq 0) {
    Write-Host "[stop] No $Label process found." -ForegroundColor DarkGray
    return
  }

  foreach ($proc in $processes) {
    Write-Host "[stop] Closing $Label PID $($proc.ProcessId)." -ForegroundColor Yellow
    try {
      Stop-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
    } catch {
      Write-Host "[stop] PID $($proc.ProcessId) already exited or is inaccessible." -ForegroundColor DarkGray
    }
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

if (-not (Test-Path -LiteralPath $Manager)) {
  throw "Manager script not found: $Manager"
}

Write-Host "[stop] Stopping PatchWarden Core/Direct services..." -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Manager stop all
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if (-not $KeepControlCenter) {
  Stop-MatchingProcesses -Label "Control Center" -Predicate ${function:Test-ControlCenterProcess}
  if (Test-Path -LiteralPath $StatusFile) {
    Remove-Item -LiteralPath $StatusFile -Force -ErrorAction SilentlyContinue
  }
}

if (-not $KeepTray) {
  Stop-MatchingProcesses -Label "tray" -Predicate ${function:Test-TrayProcess}
}

Write-Host "[ok] PatchWarden shutdown complete." -ForegroundColor Green
