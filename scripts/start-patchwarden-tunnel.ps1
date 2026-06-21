param(
  [string]$TunnelId = $env:PATCHWARDEN_TUNNEL_ID,
  [string]$Profile = "patchwarden",
  [string]$ProxyUrl = $(if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { "http://127.0.0.1:7892" }),
  [string]$TunnelClientExe = $env:TUNNEL_CLIENT_EXE,
  [string]$OpencodeBin = $env:OPENCODE_BIN_DIR,
  [string]$ConfigPath = $env:PATCHWARDEN_CONFIG,
  [string]$CredentialPath = $(if ($env:PATCHWARDEN_CREDENTIAL_PATH) { $env:PATCHWARDEN_CREDENTIAL_PATH } else { Join-Path $env:APPDATA "patchwarden\control-plane-api-key.dpapi" }),
  [int]$ReconnectBaseSeconds = 5,
  [int]$ReconnectMaxSeconds = 30,
  [int]$UnreadyRestartSeconds = 90,
  [int]$MaxReconnectAttempts = 0,
  [int]$WatcherMaxRestartAttempts = 5,
  [int]$WatcherHealthyResetSeconds = 60,
  [switch]$SkipWatcher,
  [switch]$ForgetSavedApiKey
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ConfigPath) {
  $ConfigPath = Join-Path $ProjectRoot "patchwarden.config.json"
}
$McpStdioLauncher = Join-Path $ProjectRoot "scripts\patchwarden-mcp-stdio.cmd"
$McpStdioLauncherForTunnel = $McpStdioLauncher -replace "\\", "/"
$OpencodeConfigHome = Join-Path $env:LOCALAPPDATA "patchwarden\opencode-config"
$ProfilePath = Join-Path $env:APPDATA "tunnel-client\$Profile.yaml"
$RuntimeDirectory = Join-Path $env:LOCALAPPDATA "patchwarden\runtime"
$StatusFile = Join-Path $RuntimeDirectory "tunnel-status.json"
$HealthUrlFile = Join-Path $RuntimeDirectory "tunnel-health-url.txt"
$PidFile = Join-Path $RuntimeDirectory "tunnel-client.pid"
$WatcherStatusFile = Join-Path $RuntimeDirectory "watcher-status.json"
$script:PendingCredential = $null
$script:TunnelProcess = $null
$script:ToolManifest = $null
$script:WatcherProcess = $null
$script:WatcherInstanceId = $null
$script:WatcherManaged = $false
$script:WatcherRestartAttempts = 0
$script:WatcherHealthySince = $null
$script:WatcherRestartExhausted = $false

function Assert-File {
  param([string]$Path, [string]$Name)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Name not found: $Path"
  }
}

function Set-SecretEnvIfMissing {
  if ($env:CONTROL_PLANE_API_KEY) {
    Write-Host "[ok] CONTROL_PLANE_API_KEY is already set in this PowerShell process."
    return
  }

  if (Test-Path -LiteralPath $CredentialPath) {
    try {
      $encrypted = Get-Content -LiteralPath $CredentialPath -Raw
      $secure = ConvertTo-SecureString $encrypted
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try {
        $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
      } finally {
        if ($bstr -ne [IntPtr]::Zero) {
          [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
      }
      if (-not $env:CONTROL_PLANE_API_KEY) {
        throw "Saved credential decrypted to an empty value."
      }
      Write-Host "[ok] Loaded tunnel runtime API key from Windows DPAPI credential cache."
      return
    } catch {
      throw "Could not decrypt saved tunnel API key at $CredentialPath. Run this script with -ForgetSavedApiKey, then start it again."
    }
  }

  Write-Host "[input] Paste your OpenAI tunnel runtime API key."
  Write-Host "        It will be encrypted with Windows DPAPI for this user and computer."
  $secure = Read-Host "CONTROL_PLANE_API_KEY" -AsSecureString
  $script:PendingCredential = $secure

  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }

  if (-not $env:CONTROL_PLANE_API_KEY) {
    throw "CONTROL_PLANE_API_KEY was empty."
  }
}

function Save-PendingCredential {
  if ($null -eq $script:PendingCredential) {
    return
  }
  $credentialDirectory = Split-Path -Parent $CredentialPath
  New-Item -ItemType Directory -Force -Path $credentialDirectory | Out-Null
  $encrypted = ConvertFrom-SecureString $script:PendingCredential
  Set-Content -LiteralPath $CredentialPath -Value $encrypted -Encoding UTF8 -NoNewline
  $script:PendingCredential = $null
  Write-Host "[saved] Encrypted credential cache: $CredentialPath"
}

function Write-TunnelStatus {
  param(
    [string]$Status,
    [string]$ReasonCode = $null,
    [bool]$Ready = $false,
    [int]$Attempt = 0,
    [Nullable[int]]$ProcessId = $null,
    [string]$LastError = $null,
    [string]$NextRetryAt = $null
  )
  New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
  $safeError = if ($LastError) { ($LastError -replace '[\r\n]+', ' ').Substring(0, [Math]::Min(500, ($LastError -replace '[\r\n]+', ' ').Length)) } else { $null }
  $payload = [ordered]@{
    status = $Status
    reason_code = $ReasonCode
    ready = $Ready
    attempt = $Attempt
    pid = $ProcessId
    checked_at = (Get-Date).ToUniversalTime().ToString("o")
    next_retry_at = $NextRetryAt
    last_error = $safeError
    server_version = if ($script:ToolManifest) { $script:ToolManifest.server_version } else { $null }
    schema_epoch = if ($script:ToolManifest) { $script:ToolManifest.schema_epoch } else { $null }
    tool_profile = if ($script:ToolManifest) { $script:ToolManifest.tool_profile } else { $null }
    tool_count = if ($script:ToolManifest) { $script:ToolManifest.tool_count } else { $null }
    tool_names = if ($script:ToolManifest) { $script:ToolManifest.tool_names } else { @() }
    tool_manifest_sha256 = if ($script:ToolManifest) { $script:ToolManifest.tool_manifest_sha256 } else { $null }
    core_tools_ready = [bool]($script:ToolManifest -and $script:ToolManifest.ok)
  }
  $temporary = "$StatusFile.tmp"
  $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $StatusFile -Force
}

function Get-DiagnosticCode {
  param([string]$Text)
  if ($Text -match '(?i)unsupported_country_region_territory|unsupported.{0,20}(country|region|territory)') { return "unsupported_region" }
  if ($Text -match '(?i)401|403|unauthori[sz]ed|invalid.{0,20}(api.?key|credential)|api.?key.{0,20}(invalid|missing)') { return "auth_failed" }
  if ($Text -match '(?i)404|not found') { return "control_plane_not_found" }
  if ($Text -match '(?i)profile.{0,30}(missing|invalid)|config.{0,30}(missing|invalid)|mcp.{0,30}command.{0,30}(missing|not found)') { return "config_error" }
  return "transient_connection_failure"
}

function Invoke-TunnelDoctor {
  $output = (& $TunnelClientExe doctor --profile $Profile --explain --json --http-proxy env:HTTPS_PROXY 2>&1 | Out-String)
  return [pscustomobject]@{
    ExitCode = $LASTEXITCODE
    Output = $output
    ReasonCode = Get-DiagnosticCode $output
  }
}

function Get-WatcherSettings {
  $cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $tasks = Join-Path $cfg.workspaceRoot $cfg.tasksDir
  return [pscustomobject]@{
    HeartbeatPath = Join-Path (Split-Path -Parent $tasks) "watcher-heartbeat.json"
    StaleSeconds = if ($cfg.watcherStaleSeconds) { [int]$cfg.watcherStaleSeconds } else { 30 }
  }
}

function Get-WatcherHeartbeatState {
  param([string]$ExpectedInstanceId = $null)
  try {
    $settings = Get-WatcherSettings
    if (-not (Test-Path -LiteralPath $settings.HeartbeatPath)) {
      return [pscustomobject]@{ Fresh = $false; Status = "missing"; AgeSeconds = $null; Data = $null }
    }
    $data = Get-Content -LiteralPath $settings.HeartbeatPath -Raw | ConvertFrom-Json
    $age = (Get-Date).ToUniversalTime() - ([DateTime]::Parse($data.last_heartbeat_at).ToUniversalTime())
    $instanceMatches = -not $ExpectedInstanceId -or [string]$data.instance_id -eq $ExpectedInstanceId
    $fresh = $age.TotalSeconds -lt $settings.StaleSeconds -and $instanceMatches
    return [pscustomobject]@{
      Fresh = $fresh
      Status = if (-not $instanceMatches) { "instance_mismatch" } elseif ($fresh) { "healthy" } else { "stale" }
      AgeSeconds = [Math]::Max(0, [Math]::Round($age.TotalSeconds))
      Data = $data
    }
  } catch {
    return [pscustomobject]@{ Fresh = $false; Status = "unreadable"; AgeSeconds = $null; Data = $null }
  }
}

function Write-WatcherStatus {
  param([string]$Status, [string]$LastError = $null)
  New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
  $payload = [ordered]@{
    managed = $script:WatcherManaged
    status = $Status
    pid = if ($script:WatcherProcess -and -not $script:WatcherProcess.HasExited) { $script:WatcherProcess.Id } else { $null }
    instance_id = $script:WatcherInstanceId
    launcher_pid = $PID
    restart_attempts = $script:WatcherRestartAttempts
    checked_at = (Get-Date).ToUniversalTime().ToString("o")
    last_error = if ($LastError) { ($LastError -replace '[\r\n]+', ' ').Substring(0, [Math]::Min(500, ($LastError -replace '[\r\n]+', ' ').Length)) } else { $null }
  }
  $temporary = "$WatcherStatusFile.tmp"
  $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $WatcherStatusFile -Force
}

function Stop-OwnedWatcherProcess {
  if ($script:WatcherManaged -and $script:WatcherProcess -and -not $script:WatcherProcess.HasExited) {
    Stop-Process -Id $script:WatcherProcess.Id -ErrorAction SilentlyContinue
    try { $script:WatcherProcess.WaitForExit(5000) | Out-Null } catch {}
  }
}

function Start-OwnedWatcherProcess {
  $script:WatcherInstanceId = [Guid]::NewGuid().ToString("n")
  $env:PATCHWARDEN_CONFIG = $ConfigPath
  $env:PATCHWARDEN_WATCHER_INSTANCE_ID = $script:WatcherInstanceId
  $env:PATCHWARDEN_WATCHER_LAUNCHER_PID = [string]$PID
  $env:XDG_CONFIG_HOME = $OpencodeConfigHome
  if ($OpencodeBin) { $env:PATH = "$OpencodeBin;$env:PATH" }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $stdout = Join-Path $RuntimeDirectory "watcher-$($script:WatcherInstanceId).stdout.log"
  $stderr = Join-Path $RuntimeDirectory "watcher-$($script:WatcherInstanceId).stderr.log"
  $script:WatcherManaged = $true
  $script:WatcherHealthySince = $null
  $script:WatcherProcess = Start-Process -FilePath $node `
    -ArgumentList @((Join-Path $ProjectRoot "dist\runner\watch.js")) `
    -WorkingDirectory $ProjectRoot -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Write-WatcherStatus -Status "starting"
  Write-Host "[watch] Started owned watcher PID $($script:WatcherProcess.Id), instance $($script:WatcherInstanceId)."
}

function Start-PatchWardenWatcher {
  $existing = Get-WatcherHeartbeatState
  if ($existing.Fresh) {
    $script:WatcherManaged = $false
    Write-WatcherStatus -Status "external_healthy"
    Write-Host "[watch] Existing watcher heartbeat is fresh; it remains external and will not be managed."
    return
  }
  Start-OwnedWatcherProcess
}

function Invoke-WatcherSupervisorTick {
  if (-not $script:WatcherManaged -or $script:WatcherRestartExhausted) { return }
  $heartbeat = Get-WatcherHeartbeatState -ExpectedInstanceId $script:WatcherInstanceId
  $processAlive = $script:WatcherProcess -and -not $script:WatcherProcess.HasExited
  if ($processAlive -and $heartbeat.Fresh) {
    if (-not $script:WatcherHealthySince) { $script:WatcherHealthySince = Get-Date }
    if (((Get-Date) - $script:WatcherHealthySince).TotalSeconds -ge $WatcherHealthyResetSeconds) {
      $script:WatcherRestartAttempts = 0
    }
    Write-WatcherStatus -Status "healthy"
    return
  }

  $failure = if (-not $processAlive) { "Owned watcher process exited." } else { "Owned watcher heartbeat is $($heartbeat.Status)." }
  Stop-OwnedWatcherProcess
  $script:WatcherRestartAttempts++
  if ($script:WatcherRestartAttempts -gt $WatcherMaxRestartAttempts) {
    $script:WatcherRestartExhausted = $true
    Write-WatcherStatus -Status "restart_limit_reached" -LastError $failure
    Write-Host "[watch] Restart limit reached; tunnel stays running but watcher is degraded."
    return
  }
  $delays = @(2, 5, 10, 20, 30)
  $delay = $delays[[Math]::Min($script:WatcherRestartAttempts - 1, $delays.Count - 1)]
  Write-WatcherStatus -Status "restarting" -LastError $failure
  Write-Host "[watch] $failure Restarting owned watcher in $delay seconds (attempt $($script:WatcherRestartAttempts)/$WatcherMaxRestartAttempts)."
  Start-Sleep -Seconds $delay
  Start-OwnedWatcherProcess
}

function Get-TunnelHealth {
  if (-not (Test-Path -LiteralPath $HealthUrlFile) -or -not (Test-Path -LiteralPath $PidFile)) { return $null }
  $output = (& $TunnelClientExe health --json --url-file $HealthUrlFile --pid-file $PidFile 2>&1 | Out-String)
  try { return $output | ConvertFrom-Json } catch { return $null }
}

function Stop-OwnedTunnelProcess {
  if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
    Stop-Process -Id $script:TunnelProcess.Id -ErrorAction SilentlyContinue
    try { $script:TunnelProcess.WaitForExit(5000) | Out-Null } catch {}
  }
}

function Quote-ProcessArgument {
  param([string]$Value)
  return '"' + ($Value -replace '"', '\"') + '"'
}

if ($ForgetSavedApiKey) {
  if (Test-Path -LiteralPath $CredentialPath) {
    Remove-Item -LiteralPath $CredentialPath -Force
    Write-Host "[ok] Removed saved PatchWarden tunnel API key."
  } else {
    Write-Host "[ok] No saved PatchWarden tunnel API key was found."
  }
  exit 0
}

if (-not $TunnelClientExe) {
  $cmd = Get-Command "tunnel-client.exe" -ErrorAction SilentlyContinue
  if ($cmd) {
    $TunnelClientExe = $cmd.Source
  }
}

if (-not $TunnelClientExe) {
  $TunnelClientExe = Read-Host "Path to tunnel-client.exe"
}

if (-not $OpencodeBin) {
  $candidateOpencodeBin = Join-Path $env:APPDATA "npm\node_modules\opencode-ai\bin"
  if (Test-Path -LiteralPath $candidateOpencodeBin) {
    $OpencodeBin = $candidateOpencodeBin
  }
}

if (-not $OpencodeBin) {
  Write-Host "[warn] OPENCODE_BIN_DIR is not set and opencode-ai bin was not found under APPDATA."
  Write-Host "       Watcher will still start, but opencode tasks may fail unless opencode is on PATH."
}

Assert-File -Path $TunnelClientExe -Name "tunnel-client.exe"
Assert-File -Path $ConfigPath -Name "patchwarden.config.json"
Assert-File -Path $McpStdioLauncher -Name "patchwarden-mcp-stdio.cmd"

if (-not $TunnelId) {
  $TunnelId = Read-Host "Tunnel ID"
}
if (-not $TunnelId) {
  throw "Tunnel ID was empty."
}

Set-Location -LiteralPath $ProjectRoot

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "dist\index.js"))) {
  Write-Host "[build] dist/index.js not found. Running npm.cmd run build..."
  npm.cmd run build
}

New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
$env:PATCHWARDEN_CONFIG = $ConfigPath
Write-Host "[manifest] Verifying the exact tunnel stdio MCP tool catalog..."
$manifestOutput = (& node (Join-Path $ProjectRoot "scripts\mcp-manifest-check.js") --json 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  Write-TunnelStatus -Status "stopped" -ReasonCode "tool_manifest_check_failed" -LastError "The tunnel MCP tool manifest preflight failed."
  throw "Tool manifest preflight failed: $manifestOutput"
}
try {
  $script:ToolManifest = $manifestOutput | ConvertFrom-Json
} catch {
  Write-TunnelStatus -Status "stopped" -ReasonCode "tool_manifest_invalid" -LastError "The tool manifest preflight returned invalid JSON."
  throw "Tool manifest preflight returned invalid JSON."
}
$manifestFile = Join-Path $RuntimeDirectory "tool-manifest.json"
$manifestOutput | Set-Content -LiteralPath $manifestFile -Encoding UTF8
Write-Host "[manifest] $($script:ToolManifest.server_version) profile=$($script:ToolManifest.tool_profile) tools=$($script:ToolManifest.tool_count) hash=$($script:ToolManifest.tool_manifest_sha256)"

Set-SecretEnvIfMissing

$env:PATCHWARDEN_CONFIG = $ConfigPath
$env:HTTP_PROXY = $ProxyUrl
$env:HTTPS_PROXY = $ProxyUrl
$env:ALL_PROXY = $ProxyUrl
$env:NO_PROXY = "localhost,127.0.0.1,::1"

$profileNeedsInit = $true
if (Test-Path -LiteralPath $ProfilePath) {
  $profileText = Get-Content -LiteralPath $ProfilePath -Raw
  $profileNeedsInit = -not $profileText.Contains($McpStdioLauncherForTunnel)
}

if ($profileNeedsInit) {
  Write-Host "[init] Creating tunnel-client profile: $Profile"
  & $TunnelClientExe init `
    --sample sample_mcp_stdio_local `
    --profile $Profile `
    --tunnel-id $TunnelId `
    --mcp-command $McpStdioLauncherForTunnel `
    --force
}

$env:PATCHWARDEN_TUNNEL_STATUS_FILE = $StatusFile
if (-not $SkipWatcher) { Start-PatchWardenWatcher }

Write-Host "[doctor] Checking tunnel-client profile through the configured proxy..."
$preflightAttempt = 0
$preflightMaxRetries = 3
$doctor = Invoke-TunnelDoctor
while ($doctor.ExitCode -ne 0 -and $doctor.ReasonCode -eq "transient_connection_failure" -and $preflightAttempt -lt $preflightMaxRetries) {
  $preflightAttempt++
  $backoff = [Math]::Min($ReconnectBaseSeconds * $preflightAttempt, $ReconnectMaxSeconds)
  Write-Host "[doctor] Transient connection failure; retrying in ${backoff}s (attempt $preflightAttempt/$preflightMaxRetries)..." -ForegroundColor Yellow
  Start-Sleep -Seconds $backoff
  $doctor = Invoke-TunnelDoctor
}
if ($doctor.ExitCode -ne 0) {
  if ($doctor.ReasonCode -eq "transient_connection_failure") {
    Write-Host "[doctor] Transient connection failure persists after $preflightAttempt retries; starting tunnel anyway (supervisor will retry during runtime)." -ForegroundColor Yellow
    Write-TunnelStatus -Status "degraded" -ReasonCode $doctor.ReasonCode -Ready $false -LastError "Preflight doctor reported transient connection failure; proceeding with supervisor-managed recovery."
  } else {
    Write-TunnelStatus -Status "stopped" -ReasonCode $doctor.ReasonCode -LastError "tunnel-client doctor failed; review the launcher output."
    Write-Host "[doctor] Non-retryable diagnostic: $($doctor.ReasonCode)" -ForegroundColor Red
    if ($null -ne $script:PendingCredential) {
      throw "tunnel-client doctor failed ($($doctor.ReasonCode)). The newly entered API key was not saved."
    } else {
      throw "tunnel-client doctor failed ($($doctor.ReasonCode)). The saved API key is unchanged; review proxy/region settings and retry."
    }
  }
}
Save-PendingCredential

Write-Host ""
Write-Host "[run] Starting supervised tunnel-client. Keep this window open."
Write-Host "[health] Run Check-PatchWarden-Health.cmd if ChatGPT cannot reach the MCP."
Write-Host ""

$attempt = 0
$openUi = $true
try {
  while ($true) {
    $attempt++
    Remove-Item -LiteralPath $HealthUrlFile, $PidFile -Force -ErrorAction SilentlyContinue
    Write-TunnelStatus -Status "starting" -ReasonCode $null -Ready $false -Attempt $attempt
    $runArguments = @(
      "run", "--profile", $Profile,
      "--http-proxy", "env:HTTPS_PROXY",
      "--health.url-file", $HealthUrlFile,
      "--pid.file", $PidFile,
      "--log.format", "json"
    )
    if ($openUi) { $runArguments += "--open-web-ui"; $openUi = $false }
    $argumentLine = ($runArguments | ForEach-Object { Quote-ProcessArgument $_ }) -join " "
    $script:TunnelProcess = Start-Process -FilePath $TunnelClientExe -ArgumentList $argumentLine -PassThru -WindowStyle Hidden
    Write-TunnelStatus -Status "connecting" -ReasonCode $null -Ready $false -Attempt $attempt -ProcessId $script:TunnelProcess.Id
    Write-Host "[run] tunnel-client PID $($script:TunnelProcess.Id), attempt $attempt"

    $unreadySince = $null
    $restartForHealth = $false
    while (-not $script:TunnelProcess.HasExited) {
      Start-Sleep -Seconds 5
      if (-not $SkipWatcher) { Invoke-WatcherSupervisorTick }
      $health = Get-TunnelHealth
      if ($health -and $health.healthz.ok -and $health.readyz.ok) {
        $unreadySince = $null
        Write-TunnelStatus -Status "ready" -ReasonCode $null -Ready $true -Attempt $attempt -ProcessId $script:TunnelProcess.Id
        continue
      }
      if (-not $unreadySince) { $unreadySince = Get-Date }
      Write-TunnelStatus -Status "degraded" -ReasonCode "tunnel_not_ready" -Ready $false -Attempt $attempt -ProcessId $script:TunnelProcess.Id -LastError "Tunnel process is running but /readyz is not ready."
      if (((Get-Date) - $unreadySince).TotalSeconds -ge $UnreadyRestartSeconds) {
        $doctor = Invoke-TunnelDoctor
        if ($doctor.ExitCode -ne 0 -and $doctor.ReasonCode -ne "transient_connection_failure") {
          Stop-OwnedTunnelProcess
          Write-TunnelStatus -Status "stopped" -ReasonCode $doctor.ReasonCode -Ready $false -Attempt $attempt -LastError "Tunnel readiness failed and doctor reported a non-retryable error."
          Write-Host "[doctor] Non-retryable diagnostic: $($doctor.ReasonCode)"
          throw "Tunnel stopped after non-retryable readiness failure: $($doctor.ReasonCode)"
        }
        Write-Host "[recover] Tunnel stayed unready for $UnreadyRestartSeconds seconds; restarting the owned process."
        $restartForHealth = $true
        Stop-OwnedTunnelProcess
      }
    }

    $exitCode = $script:TunnelProcess.ExitCode
    $doctor = Invoke-TunnelDoctor
    if ($doctor.ExitCode -ne 0 -and $doctor.ReasonCode -ne "transient_connection_failure") {
      Write-TunnelStatus -Status "stopped" -ReasonCode $doctor.ReasonCode -Ready $false -Attempt $attempt -LastError "Tunnel exited and doctor reported a non-retryable error."
      Write-Host "[doctor] Non-retryable diagnostic: $($doctor.ReasonCode)"
      throw "Tunnel stopped after non-retryable error: $($doctor.ReasonCode)"
    }
    if ($MaxReconnectAttempts -gt 0 -and $attempt -ge $MaxReconnectAttempts) {
      Write-TunnelStatus -Status "stopped" -ReasonCode "retry_limit_reached" -Ready $false -Attempt $attempt -LastError "Reconnect attempt limit reached."
      throw "Tunnel reconnect attempt limit reached."
    }
    $delay = [Math]::Min($ReconnectMaxSeconds, $ReconnectBaseSeconds * [Math]::Pow(2, [Math]::Min(3, $attempt - 1)))
    $nextRetry = (Get-Date).AddSeconds($delay).ToUniversalTime().ToString("o")
    $reason = if ($restartForHealth) { "tunnel_not_ready" } else { "tunnel_process_exited" }
    Write-TunnelStatus -Status "reconnecting" -ReasonCode $reason -Ready $false -Attempt $attempt -LastError "Tunnel process exited with code $exitCode; retrying." -NextRetryAt $nextRetry
    Write-Host "[retry] tunnel-client exited with code $exitCode; retrying in $delay seconds."
    Start-Sleep -Seconds $delay
  }
} finally {
  Stop-OwnedTunnelProcess
  Stop-OwnedWatcherProcess
  if ($script:WatcherManaged -and -not $script:WatcherRestartExhausted) {
    Write-WatcherStatus -Status "stopped" -LastError "Tunnel launcher stopped its owned watcher."
  }
  $alreadyStopped = $false
  try {
    if (Test-Path -LiteralPath $StatusFile) {
      $existingStatus = Get-Content -LiteralPath $StatusFile -Raw | ConvertFrom-Json
      $alreadyStopped = $existingStatus.status -eq "stopped"
    }
  } catch {}
  if (-not $alreadyStopped) {
    Write-TunnelStatus -Status "stopped" -ReasonCode "launcher_stopped" -Ready $false -Attempt $attempt -LastError "Tunnel launcher stopped."
  }
}
