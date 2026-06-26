[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("menu", "start", "stop", "restart", "status", "health", "reset-key", "kill")]
  [string]$Action = "menu",

  [Parameter(Position = 1)]
  [ValidateSet("core", "direct", "all")]
  [string]$Mode = "all",

  [switch]$SkipBuild,
  [switch]$WhatIf,
  [switch]$Json,
  [switch]$Background,
  [int]$KillTimeoutSeconds = 10
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$LauncherDirectory = Join-Path $ProjectRoot "scripts\launchers"
$LocalLauncherDirectory = Join-Path $ProjectRoot ".local\launchers"
$PatchWardenRuntimeRoot = Join-Path $env:LOCALAPPDATA "patchwarden"

$ModeDefinitions = [ordered]@{
  core = [pscustomobject]@{
    Key = "core"
    Label = "Core Agent"
    Profile = "patchwarden"
    ToolProfile = "chatgpt_core"
    RuntimeDirectory = Join-Path $PatchWardenRuntimeRoot "runtime"
    HealthBaseUrl = "http://127.0.0.1:8080"
    LegacyPidFile = Join-Path $env:TEMP "patchwarden-core.pid"
    LegacyHealthUrlFile = Join-Path $env:TEMP "patchwarden-core-health.url"
    GenericLauncher = Join-Path $LauncherDirectory "Start-PatchWarden-Tunnel.cmd"
    LocalLauncher = Join-Path $LocalLauncherDirectory "Start-PatchWarden-Tunnel.local.cmd"
    HasWatcher = $true
  }
  direct = [pscustomobject]@{
    Key = "direct"
    Label = "Direct"
    Profile = "patchwarden-direct"
    ToolProfile = "chatgpt_direct"
    RuntimeDirectory = Join-Path $PatchWardenRuntimeRoot "runtime-direct"
    HealthBaseUrl = "http://127.0.0.1:8081"
    LegacyPidFile = Join-Path $env:TEMP "patchwarden-direct.pid"
    LegacyHealthUrlFile = Join-Path $env:TEMP "patchwarden-direct-health.url"
    GenericLauncher = Join-Path $LauncherDirectory "Start-PatchWarden-Direct-Tunnel.cmd"
    LocalLauncher = Join-Path $LocalLauncherDirectory "Start-PatchWarden-Direct-Tunnel.local.cmd"
    HasWatcher = $false
  }
}

function Get-SelectedModes {
  param([string]$SelectedMode)
  if ($SelectedMode -eq "all") {
    return @($ModeDefinitions.core, $ModeDefinitions.direct)
  }
  return @($ModeDefinitions[$SelectedMode])
}

function Get-ProcessByIdSafe {
  param([Nullable[int]]$ProcessId)
  if (-not $ProcessId -or $ProcessId -le 0) { return $null }
  try {
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  } catch {
    return $null
  }
}

function Read-JsonFileSafe {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Read-FileLineSafe {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8).Trim()
  } catch {
    return $null
  }
}

function Test-TunnelHealthEndpoint {
  param([string]$HealthUrl)
  if (-not $HealthUrl) { return $null }
  if ($HealthUrl -notmatch '^http://127\.0\.0\.1:\d+$') { return $null }
  $result = [pscustomobject]@{ reachable = $false; healthz = $false; readyz = $false; error = $null }
  try {
    $healthzResponse = Invoke-WebRequest -Uri "$HealthUrl/healthz" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    $result.healthz = $healthzResponse.StatusCode -eq 200
    $result.reachable = $true
  } catch {
    $result.error = "Health endpoint unreachable: $($_.Exception.Message)"
    return $result
  }
  try {
    $readyzResponse = Invoke-WebRequest -Uri "$HealthUrl/readyz" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    $result.readyz = $readyzResponse.StatusCode -eq 200
  } catch {
    $result.error = "readyz probe failed: $($_.Exception.Message)"
  }
  return $result
}

function Get-PidFromFile {
  param([string]$PidFilePath)
  $raw = Read-FileLineSafe -Path $PidFilePath
  if (-not $raw) { return $null }
  $parsed = 0
  if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
  return $null
}

function Test-TunnelProcessForMode {
  param($Process, $Definition)
  if (-not $Process -or [string]$Process.Name -ine "tunnel-client.exe") { return $false }
  $commandLine = [string]$Process.CommandLine
  $profilePattern = '(?i)"?--profile"?\s+"?' + [Regex]::Escape($Definition.Profile) + '(?:"|\s|$)'
  $profileEqualsPattern = '(?i)"?--profile"?="?' + [Regex]::Escape($Definition.Profile) + '(?:"|\s|$)'
  $profilePath = Join-Path $env:APPDATA "tunnel-client\$($Definition.Profile).yaml"
  $normalizedCommand = $commandLine -replace '\\', '/'
  $normalizedProfilePath = $profilePath -replace '\\', '/'
  return $commandLine -match '(?i)\brun\b' -and (
    $commandLine -match $profilePattern -or
    $commandLine -match $profileEqualsPattern -or
    $normalizedCommand.IndexOf($normalizedProfilePath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  )
}

function Get-MatchingTunnelProcesses {
  param($Definition)
  return @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { Test-TunnelProcessForMode -Process $_ -Definition $Definition }
  )
}

function Get-ModeStatus {
  param($Definition)
  $statusPath = Join-Path $Definition.RuntimeDirectory "tunnel-status.json"
  $healthUrlFile = Join-Path $Definition.RuntimeDirectory "tunnel-health-url.txt"
  $pidFilePath = Join-Path $Definition.RuntimeDirectory "tunnel-client.pid"
  $state = Read-JsonFileSafe -Path $statusPath

  # Tier 1: Health endpoint probe (highest priority)
  $healthUrl = Read-FileLineSafe -Path $healthUrlFile
  $healthProbe = $null
  foreach ($candidateUrl in @($healthUrl, $Definition.HealthBaseUrl) | Select-Object -Unique) {
    if (-not $candidateUrl) { continue }
    $candidateProbe = Test-TunnelHealthEndpoint -HealthUrl $candidateUrl
    if ($candidateProbe -and $candidateProbe.reachable) {
      $healthProbe = $candidateProbe
      break
    }
  }
  $healthAlive = [bool]($healthProbe -and $healthProbe.reachable -and $healthProbe.healthz)
  $healthReady = [bool]($healthProbe -and $healthProbe.readyz)

  # Tier 2: PID file to process check
  $pidFromFile = Get-PidFromFile -PidFilePath $pidFilePath
  $pidProcess = if ($pidFromFile) { Get-ProcessByIdSafe -ProcessId $pidFromFile } else { $null }
  $pidProcessAlive = Test-TunnelProcessForMode -Process $pidProcess -Definition $Definition

  # Tier 3: JSON PID to process check (existing)
  $jsonPid = if ($state -and $state.pid) { [int]$state.pid } else { $null }
  $jsonProcess = if ($jsonPid) { Get-ProcessByIdSafe -ProcessId $jsonPid } else { $null }
  $jsonProcessAlive = Test-TunnelProcessForMode -Process $jsonProcess -Definition $Definition

  # Tier 4: Exact process scan for orphaned profile runs
  $matchingProcesses = @(Get-MatchingTunnelProcesses -Definition $Definition)
  $scannedProcess = $matchingProcesses | Select-Object -First 1
  $scannedProcessAlive = [bool]$scannedProcess

  # Best-effort PID
  $bestPid = if ($pidProcessAlive) { $pidFromFile } elseif ($jsonProcessAlive) { $jsonPid } elseif ($scannedProcessAlive) { [int]$scannedProcess.ProcessId } else { $null }
  $bestProcessAlive = $pidProcessAlive -or $jsonProcessAlive -or $scannedProcessAlive

  # Resolve status and readiness
  $reportedStatus = if ($state -and $state.status) { [string]$state.status } else { "not_started" }

  if ($healthAlive) {
    # Health endpoint wins: override any stale JSON
    $effectiveStatus = "running"
    $effectiveReady = $healthReady
    $effectiveReasonCode = if ($healthReady) { "health_endpoint_ready" } else { "health_endpoint_alive" }
    $effectiveLastError = $null
  } elseif ($bestProcessAlive) {
    # Process is alive but health endpoint is not reachable
    $effectiveStatus = if ($reportedStatus -eq "not_started") { "running" } else { $reportedStatus }
    $effectiveReady = [bool]($state -and $state.ready)
    $effectiveReasonCode = if ($state) { $state.reason_code } else { "profile_process_found" }
    $effectiveLastError = if ($state) { $state.last_error } else { $null }
  } elseif ($reportedStatus -eq "not_started") {
    $effectiveStatus = "not_started"
    $effectiveReady = $false
    $effectiveReasonCode = if ($state) { $state.reason_code } else { $null }
    $effectiveLastError = if ($state) { $state.last_error } else { $null }
  } else {
    $effectiveStatus = "stopped"
    $effectiveReady = $false
    $effectiveReasonCode = if ($state) { $state.reason_code } else { $null }
    $effectiveLastError = if ($state) { $state.last_error } else { $null }
  }

  return [pscustomobject]@{
    mode = $Definition.Key
    label = $Definition.Label
    status = $effectiveStatus
    ready = $effectiveReady
    process_alive = [bool]$bestProcessAlive
    health_alive = $healthAlive
    health_ready = $healthReady
    pid = $bestPid
    tool_profile = if ($state) { $state.tool_profile } else { $Definition.ToolProfile }
    tool_count = if ($state) { $state.tool_count } else { $null }
    tools_ready = [bool](($bestProcessAlive -or $healthReady) -and $state -and $state.tools_ready)
    reason_code = $effectiveReasonCode
    last_error = $effectiveLastError
    checked_at = if ($state) { $state.checked_at } else { $null }
    runtime_directory = $Definition.RuntimeDirectory
  }
}

function Show-Status {
  param([string]$SelectedMode)
  $rows = @(Get-SelectedModes -SelectedMode $SelectedMode | ForEach-Object { Get-ModeStatus -Definition $_ })
  if ($Json) {
    $rows | ConvertTo-Json -Depth 4
    return
  }

  Write-Host ""
  Write-Host "PatchWarden runtime status" -ForegroundColor Cyan
  $rows | Select-Object mode, status, ready, health_alive, process_alive, tool_profile, tool_count, tools_ready | Format-Table -AutoSize
  foreach ($row in $rows) {
    if ($row.last_error) {
      Write-Host "[$($row.mode)] $($row.last_error)" -ForegroundColor Yellow
    }
    if ($row.ready -and $row.health_alive -and -not $row.process_alive) {
      Write-Host "[$($row.mode)] Health endpoint ready; tunnel is alive but PID tracking may be stale." -ForegroundColor DarkCyan
    }
  }
}

function Test-ProjectCommandLine {
  param([string]$CommandLine)
  if (-not $CommandLine) { return $false }
  return $CommandLine.IndexOf($ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-OwnedProcesses {
  param($Definition)

  $allProcesses = @(Get-CimInstance Win32_Process)
  $byPid = @{}
  foreach ($process in $allProcesses) { $byPid[[int]$process.ProcessId] = $process }

  $seedIds = [System.Collections.Generic.HashSet[int]]::new()
  $status = Read-JsonFileSafe -Path (Join-Path $Definition.RuntimeDirectory "tunnel-status.json")
  if ($status -and $status.pid) {
    $candidate = $byPid[[int]$status.pid]
    if (Test-TunnelProcessForMode -Process $candidate -Definition $Definition) {
      [void]$seedIds.Add([int]$candidate.ProcessId)
    }
  }

  if ($Definition.HasWatcher) {
    $watcherState = Read-JsonFileSafe -Path (Join-Path $Definition.RuntimeDirectory "watcher-status.json")
    if ($watcherState -and $watcherState.pid) {
      $watcher = $byPid[[int]$watcherState.pid]
      if ($watcher -and (Test-ProjectCommandLine -CommandLine ([string]$watcher.CommandLine)) -and [string]$watcher.CommandLine -match '(?i)dist[\\/]runner[\\/]watch\.js') {
        [void]$seedIds.Add([int]$watcher.ProcessId)
      }
    }
    if ($watcherState -and $watcherState.launcher_pid) {
      $launcher = $byPid[[int]$watcherState.launcher_pid]
      if ($launcher -and (Test-ProjectCommandLine -CommandLine ([string]$launcher.CommandLine)) -and [string]$launcher.CommandLine -match '(?i)start-patchwarden-tunnel\.ps1') {
        [void]$seedIds.Add([int]$launcher.ProcessId)
      }
    }
  }

  $ownedIds = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($seedId in $seedIds) {
    [void]$ownedIds.Add($seedId)
    $current = $byPid[$seedId]
    while ($current -and [int]$current.ParentProcessId -gt 0) {
      $parent = $byPid[[int]$current.ParentProcessId]
      if (-not $parent) { break }
      $parentCommand = [string]$parent.CommandLine
      if ((Test-ProjectCommandLine -CommandLine $parentCommand) -and $parentCommand -match '(?i)(start-patchwarden-tunnel\.ps1|Start-PatchWarden(?:-Direct)?-Tunnel(?:\.local)?\.cmd)') {
        [void]$ownedIds.Add([int]$parent.ProcessId)
        $current = $parent
        continue
      }
      break
    }
  }

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

  $owned = @()
  foreach ($ownedId in $ownedIds) {
    if ($ownedId -eq $PID) { continue }
    $process = $byPid[$ownedId]
    if (-not $process) { continue }
    $owned += [pscustomobject]@{
      pid = [int]$process.ProcessId
      parent_pid = [int]$process.ParentProcessId
      name = [string]$process.Name
      command = [string]$process.CommandLine
    }
  }
  return $owned
}

function Convert-ToProcessEntry {
  param($Process)
  return [pscustomobject]@{
    pid = [int]$Process.ProcessId
    parent_pid = [int]$Process.ParentProcessId
    name = [string]$Process.Name
    command = [string]$Process.CommandLine
  }
}

function Get-ModeProcesses {
  param($Definition, [switch]$IncludeLaunchers)
  $entries = @()
  $entries += @(Get-OwnedProcesses -Definition $Definition)
  $entries += @(Get-MatchingTunnelProcesses -Definition $Definition | ForEach-Object { Convert-ToProcessEntry -Process $_ })

  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  foreach ($process in $allProcesses) {
    if ([int]$process.ProcessId -eq $PID) { continue }
    $commandLine = [string]$process.CommandLine
    if (-not (Test-ProjectCommandLine -CommandLine $commandLine)) { continue }
    $isWatcher = $IncludeLaunchers -and $Definition.HasWatcher -and $commandLine -match '(?i)dist[\\/]runner[\\/]watch\.js'
    $isDirectLauncher = $commandLine -match '(?i)(patchwarden-direct|chatgpt_direct|Start-PatchWarden-Direct-Tunnel)'
    $isTunnelLauncher = $commandLine -match '(?i)(start-patchwarden-tunnel\.ps1|Start-PatchWarden(?:-Direct)?-Tunnel(?:\.local)?\.cmd)'
    $isModeLauncher = $isTunnelLauncher -and (
      ($Definition.Key -eq "direct" -and $isDirectLauncher) -or
      ($Definition.Key -eq "core" -and -not $isDirectLauncher)
    )
    if ($isWatcher -or $isModeLauncher) {
      $entries += Convert-ToProcessEntry -Process $process
    }
  }

  $uniqueByPid = @{}
  foreach ($entry in $entries) {
    if ($entry.pid -ne $PID) { $uniqueByPid[[int]$entry.pid] = $entry }
  }
  return @($uniqueByPid.Values | Sort-Object pid)
}

function Get-PortOwners {
  param($Definition)
  $port = ([Uri]$Definition.HealthBaseUrl).Port
  $connections = @(
    Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
      Sort-Object OwningProcess -Unique
  )
  return @(
    foreach ($connection in $connections) {
      $process = Get-ProcessByIdSafe -ProcessId ([int]$connection.OwningProcess)
      [pscustomobject]@{
        address = "127.0.0.1:$port"
        pid = [int]$connection.OwningProcess
        name = if ($process) { [string]$process.Name } else { "unknown" }
        process = $process
        patchwarden_tunnel = [bool]($process -and (Test-TunnelProcessForMode -Process $process -Definition $Definition))
      }
    }
  )
}

function Assert-NoUnsafePortConflicts {
  param([object[]]$Definitions)
  $conflicts = @()
  foreach ($definition in $Definitions) {
    $conflicts += @(Get-PortOwners -Definition $definition | Where-Object { -not $_.patchwarden_tunnel })
  }
  if ($conflicts.Count -eq 0) { return }
  foreach ($conflict in $conflicts) {
    Write-Host "[conflict] $($conflict.address) is occupied by PID $($conflict.pid) process $($conflict.name)." -ForegroundColor Red
    Write-Host "           Please close it or choose another HealthListenAddr." -ForegroundColor Red
  }
  throw "Unsafe health-port conflict detected; no PatchWarden process was stopped or restarted."
}

function Set-StoppedRuntimeState {
  param($Definition)
  if ($WhatIf) { return }

  New-Item -ItemType Directory -Path $Definition.RuntimeDirectory -Force | Out-Null
  $statusPath = Join-Path $Definition.RuntimeDirectory "tunnel-status.json"
  $state = Read-JsonFileSafe -Path $statusPath
  if (-not $state) { $state = [pscustomobject]@{} }
  $state | Add-Member -NotePropertyName status -NotePropertyValue "stopped" -Force
  $state | Add-Member -NotePropertyName reason_code -NotePropertyValue "stopped_by_manager" -Force
  $state | Add-Member -NotePropertyName ready -NotePropertyValue $false -Force
  $state | Add-Member -NotePropertyName pid -NotePropertyValue $null -Force
  $state | Add-Member -NotePropertyName checked_at -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o")) -Force
  $state | Add-Member -NotePropertyName next_retry_at -NotePropertyValue $null -Force
  $state | Add-Member -NotePropertyName last_error -NotePropertyValue $null -Force
  $state | Add-Member -NotePropertyName last_exit_code -NotePropertyValue $null -Force
  $state | Add-Member -NotePropertyName stdout_tail -NotePropertyValue @() -Force
  $state | Add-Member -NotePropertyName stderr_tail -NotePropertyValue @() -Force
  $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statusPath -Encoding UTF8

  foreach ($name in @("tunnel-health-url.txt", "tunnel-client.pid", "watcher-status.json")) {
    $path = Join-Path $Definition.RuntimeDirectory $name
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  }
  foreach ($path in @($Definition.LegacyPidFile, $Definition.LegacyHealthUrlFile)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      Write-Host "  Removed stale runtime file: $path" -ForegroundColor DarkGray
    }
  }

  if ($Definition.HasWatcher) {
    try {
      $configPath = if ($env:PATCHWARDEN_CONFIG) { $env:PATCHWARDEN_CONFIG } else { Join-Path $ProjectRoot "patchwarden.config.json" }
      if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $tasksDirectory = Join-Path $config.workspaceRoot $config.tasksDir
        $heartbeatPath = Join-Path (Split-Path -Parent $tasksDirectory) "watcher-heartbeat.json"
        if (Test-Path -LiteralPath $heartbeatPath) {
          Remove-Item -LiteralPath $heartbeatPath -Force -ErrorAction SilentlyContinue
        }
      }
    } catch {
      Write-Warning "Could not clear the Core watcher heartbeat: $($_.Exception.Message)"
    }
  }
}

function Stop-Mode {
  param($Definition, [switch]$ForceCleanup)
  $verb = if ($ForceCleanup) { "kill" } else { "stop" }
  Write-Host "[$verb`:$($Definition.Key)] Looking for PatchWarden-scoped processes..." -ForegroundColor Yellow
  $owned = @(Get-ModeProcesses -Definition $Definition -IncludeLaunchers:$ForceCleanup)
  if ($owned.Count -eq 0) {
    Write-Host "  No matching $($Definition.Label) process is running." -ForegroundColor Green
    Set-StoppedRuntimeState -Definition $Definition
    return
  }

  $ownedIds = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($process in $owned) { [void]$ownedIds.Add([int]$process.pid) }
  $ordered = @($owned | Sort-Object @{ Expression = { if ($ownedIds.Contains([int]$_.parent_pid)) { 1 } else { 0 } }; Descending = $true }, pid)
  foreach ($entry in $ordered) {
    if ($WhatIf) {
      Write-Host "  WHAT-IF: stop PID $($entry.pid) ($($entry.name))" -ForegroundColor Magenta
      continue
    }
    try {
      $process = Get-Process -Id $entry.pid -ErrorAction Stop
      $process.Kill()
      [void]$process.WaitForExit($KillTimeoutSeconds * 1000)
      Write-Host "  Stopped PID $($entry.pid) ($($entry.name))." -ForegroundColor Green
    } catch {
      Write-Host "  PID $($entry.pid) already exited or is inaccessible." -ForegroundColor DarkGray
    }
  }
  Set-StoppedRuntimeState -Definition $Definition
}

function Invoke-Build {
  if ($SkipBuild) {
    Write-Host "[build] Skipped." -ForegroundColor DarkYellow
    return
  }
  if ($WhatIf) {
    Write-Host "[build] WHAT-IF: npm.cmd run build" -ForegroundColor Magenta
    return
  }
  Write-Host "[build] Building PatchWarden..." -ForegroundColor Yellow
  Push-Location $ProjectRoot
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm.cmd run build exited with code $LASTEXITCODE" }
    Write-Host "[build] Build passed." -ForegroundColor Green
  } finally {
    Pop-Location
  }
}

function Start-Mode {
  param($Definition)
  $current = Get-ModeStatus -Definition $Definition
  if ($current.health_alive -and $current.ready) {
    $pidSuffix = if ($current.pid) { " (PID $($current.pid))" } else { "" }
    Write-Host "[start:$($Definition.Key)] Already running and ready$pidSuffix." -ForegroundColor Green
    return
  }
  if ($current.process_alive) {
    throw "[conflict] Profile $($Definition.Profile) already has PID $($current.pid), but it is not ready. Use restart $($Definition.Key) or kill $($Definition.Key)."
  }
  Assert-NoUnsafePortConflicts -Definitions @($Definition)

  if ($Background) {
    $launcherScript = Join-Path $PSScriptRoot "start-patchwarden-tunnel.ps1"
    if (-not (Test-Path -LiteralPath $launcherScript)) { throw "Launcher script not found: $launcherScript" }
    $healthListenAddr = ([Uri]$Definition.HealthBaseUrl).Authority
    $arguments = @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcherScript,
      "-ToolProfile", $Definition.ToolProfile,
      "-Profile", $Definition.Profile,
      "-HealthListenAddr", $healthListenAddr,
      "-NoTunnelWebUi"
    )
    if (-not $Definition.HasWatcher) { $arguments += "-SkipWatcher" }
    if ($WhatIf) {
      Write-Host "[start:$($Definition.Key)] WHAT-IF: start hidden supervisor for $($Definition.Profile)" -ForegroundColor Magenta
      return
    }
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WorkingDirectory $ProjectRoot -PassThru -WindowStyle Hidden
    Write-Host "[start:$($Definition.Key)] Started hidden supervisor PID $($process.Id). Logs: $($Definition.RuntimeDirectory)" -ForegroundColor Green
    return
  }

  # Prefer the project's built-in launcher (scripts\launchers\*.cmd) over
  # .local\launchers\*.local.cmd. A .local launcher, if present, MUST call
  # the project root scripts\launchers\*.cmd via relative path (..\..\scripts\launchers\*),
  # NOT assume its own directory contains the target script.
  $launcher = if (Test-Path -LiteralPath $Definition.GenericLauncher) { $Definition.GenericLauncher } else { $Definition.LocalLauncher }
  if (-not (Test-Path -LiteralPath $launcher)) { throw "Launcher not found: $launcher" }
  $launcherName = Split-Path -Leaf $launcher
  if ($WhatIf) {
    Write-Host "[start:$($Definition.Key)] WHAT-IF: open $launcherName" -ForegroundColor Magenta
    return
  }

  $escapedRoot = $ProjectRoot.Replace("'", "''")
  $escapedLauncher = $launcher.Replace("'", "''")
  $command = "Set-Location '$escapedRoot'; & '$escapedLauncher'"
  Start-Process powershell.exe -ArgumentList @("-NoProfile", "-NoExit", "-Command", $command)
  Write-Host "[start:$($Definition.Key)] Opened $launcherName in a separate window." -ForegroundColor Green
}

function Invoke-DeepHealth {
  $healthScript = Join-Path $PSScriptRoot "get-patchwarden-health.ps1"
  if (-not (Test-Path -LiteralPath $healthScript)) { throw "Health script not found: $healthScript" }
  if ($WhatIf) {
    Write-Host "[health] WHAT-IF: run the detailed health check." -ForegroundColor Magenta
    return
  }
  & $healthScript
  Show-Status -SelectedMode "all"
}

function Reset-TunnelKey {
  $launcherScript = Join-Path $PSScriptRoot "start-patchwarden-tunnel.ps1"
  if ($WhatIf) {
    Write-Host "[reset-key] WHAT-IF: remove the DPAPI-encrypted Tunnel runtime credential." -ForegroundColor Magenta
    return
  }
  & $launcherScript -ForgetSavedApiKey
}

function Invoke-ControlAction {
  param([string]$SelectedAction, [string]$SelectedMode)
  $definitions = @(Get-SelectedModes -SelectedMode $SelectedMode)
  switch ($SelectedAction) {
    "status" { Show-Status -SelectedMode $SelectedMode }
    "health" { Invoke-DeepHealth }
    "reset-key" { Reset-TunnelKey }
    "start" {
      Assert-NoUnsafePortConflicts -Definitions $definitions
      foreach ($definition in $definitions) { Start-Mode -Definition $definition }
    }
    "stop" { foreach ($definition in $definitions) { Stop-Mode -Definition $definition } }
    "kill" { foreach ($definition in $definitions) { Stop-Mode -Definition $definition -ForceCleanup } }
    "restart" {
      Assert-NoUnsafePortConflicts -Definitions $definitions
      foreach ($definition in $definitions) { Stop-Mode -Definition $definition }
      Invoke-Build
      foreach ($definition in $definitions) { Start-Mode -Definition $definition }
    }
    default { throw "Unsupported action: $SelectedAction" }
  }
}

function Show-Menu {
  while ($true) {
    Clear-Host
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host " PatchWarden Control" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Show-Status -SelectedMode "all"
    Write-Host ""
    Write-Host "  1. Start Core Agent"
    Write-Host "  2. Start Direct"
    Write-Host "  3. Start both"
    Write-Host "  4. Restart Core Agent"
    Write-Host "  5. Restart Direct"
    Write-Host "  6. Restart both"
    Write-Host "  7. Stop Core Agent"
    Write-Host "  8. Stop Direct"
    Write-Host "  9. Stop both"
    Write-Host " 10. Refresh status"
    Write-Host " 11. Detailed health check"
    Write-Host " 12. Reset saved Tunnel API key"
    Write-Host " 13. Force-clean PatchWarden tunnels and watchers"
    Write-Host "  0. Exit"
    Write-Host ""
    $choice = Read-Host "Choose"
    if ($choice -eq "0") { return }
    $selection = switch ($choice) {
      "1" { @("start", "core") }
      "2" { @("start", "direct") }
      "3" { @("start", "all") }
      "4" { @("restart", "core") }
      "5" { @("restart", "direct") }
      "6" { @("restart", "all") }
      "7" { @("stop", "core") }
      "8" { @("stop", "direct") }
      "9" { @("stop", "all") }
      "10" { @("status", "all") }
      "11" { @("health", "all") }
      "12" { @("reset-key", "all") }
      "13" { @("kill", "all") }
      default { $null }
    }
    if (-not $selection) {
      Write-Host "Unknown choice." -ForegroundColor Yellow
      Start-Sleep -Seconds 1
      continue
    }
    try {
      Invoke-ControlAction -SelectedAction $selection[0] -SelectedMode $selection[1]
    } catch {
      Write-Host "Operation failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    Write-Host ""
    Read-Host "Press Enter to return to the menu" | Out-Null
  }
}

if ($Action -eq "menu") {
  Show-Menu
} else {
  Invoke-ControlAction -SelectedAction $Action -SelectedMode $Mode
}
