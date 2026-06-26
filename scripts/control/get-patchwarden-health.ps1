$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ConfigPath = Join-Path $ProjectRoot "patchwarden.config.json"
$RuntimeDirectory = Join-Path $env:LOCALAPPDATA "patchwarden\runtime"
$HealthUrlFile = Join-Path $RuntimeDirectory "tunnel-health-url.txt"

$env:PATCHWARDEN_CONFIG = $ConfigPath
$healthJson = node --input-type=module -e "Promise.all([import('./dist/tools/healthCheck.js'),import('./dist/tools/registry.js')]).then(([h,r])=>console.log(JSON.stringify(h.healthCheck(r.getToolCatalogSnapshot()))))" 2>$null
if ($LASTEXITCODE -ne 0 -or -not $healthJson) {
  throw "Could not load PatchWarden health information. Run npm.cmd run build first."
}
$health = $healthJson | ConvertFrom-Json
$packageVersion = [string](Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json).version

$configuredTunnelManifest = $null
try {
  $manifestJson = node (Join-Path $ProjectRoot "scripts\checks\mcp-manifest-check.js") 2>$null
  if ($LASTEXITCODE -eq 0 -and $manifestJson) {
    $configuredTunnelManifest = $manifestJson | ConvertFrom-Json
  }
} catch {}

$safeProcesses = @()
try {
  $allProcesses = Get-CimInstance Win32_Process
  foreach ($process in $allProcesses) {
    $commandLine = [string]$process.CommandLine
    if (-not $commandLine -or $commandLine -notmatch '(?i)patchwarden') { continue }
    if ($process.ProcessId -eq $PID -or $commandLine -match 'get-patchwarden-health\.ps1') { continue }
    $detectedVersion = "unknown"
    $origin = "unknown"
    if ($commandLine -match '(?i)patchwarden@([0-9]+(?:\.[0-9]+){1,2})') {
      $detectedVersion = $matches[1]
      $origin = "npm_package"
    } elseif ($commandLine -like "*$ProjectRoot*") {
      $detectedVersion = [string]$health.server_version
      $origin = "current_workspace"
    }
    $safeCommand = $commandLine `
      -replace '(?i)(CONTROL_PLANE_API_KEY\s*=\s*)\S+', '$1[REDACTED]' `
      -replace '(?i)tunnel_[a-z0-9_-]{12,}', '[REDACTED_TUNNEL_ID]'
    $safeProcesses += [ordered]@{
      pid = $process.ProcessId
      parent_pid = $process.ParentProcessId
      name = $process.Name
      detected_version = $detectedVersion
      origin = $origin
      command_line = $safeCommand.Substring(0, [Math]::Min(500, $safeCommand.Length))
      version_conflict = $detectedVersion -ne "unknown" -and $detectedVersion -ne [string]$health.server_version
    }
  }
} catch {}

$liveTunnel = [ordered]@{ observed = $false; healthz = $false; readyz = $false; error = $null }
if (Test-Path -LiteralPath $HealthUrlFile) {
  try {
    $baseUrl = (Get-Content -LiteralPath $HealthUrlFile -Raw).Trim().TrimEnd('/')
    if ($baseUrl -notmatch '^http://127\.0\.0\.1:\d+$') { throw "Health URL is not loopback-only." }
    $healthz = Invoke-WebRequest -Uri "$baseUrl/healthz" -UseBasicParsing -TimeoutSec 3
    $readyz = Invoke-WebRequest -Uri "$baseUrl/readyz" -UseBasicParsing -TimeoutSec 3
    $liveTunnel.observed = $true
    $liveTunnel.healthz = $healthz.StatusCode -eq 200
    $liveTunnel.readyz = $readyz.StatusCode -eq 200
  } catch {
    $liveTunnel.observed = $true
    $liveTunnel.error = "Tunnel local health endpoint is unavailable."
  }
}

$tunnelProcesses = @($safeProcesses | Where-Object { $_.name -eq "tunnel-client.exe" })
$mcpChildProcesses = @($safeProcesses | Where-Object {
  $_.command_line -match '(?i)patchwarden-mcp-stdio\.cmd|patchwarden\\dist\\index\.js|patchwarden/scripts/mcp/../../dist/index.js'
})
$deploymentConsistent = [bool](
  $configuredTunnelManifest -and
  $health.tunnel.tool_manifest_sha256 -and
  [string]$configuredTunnelManifest.tool_manifest_sha256 -eq [string]$health.tunnel.tool_manifest_sha256
)

[ordered]@{
  checked_at = (Get-Date).ToUniversalTime().ToString("o")
  overall_status = $health.status
  source_version = $packageVersion
  dist_version = $health.server_version
  schema_epoch = $health.schema_epoch
  local_server_catalog = [ordered]@{
    tool_profile = $health.tool_profile
    tool_count = $health.tool_count
    tool_names = $health.tool_names
    tool_manifest_sha256 = $health.tool_manifest_sha256
    catalog_consistent = $health.catalog_consistent
    mismatch_report = $health.mismatch_report
    tunnel_catalog_comparison = $health.tunnel_catalog_comparison
  }
  configured_tunnel_manifest = $configuredTunnelManifest
  deployment_consistency = [ordered]@{
    consistent = $deploymentConsistent
    reason = if ($deploymentConsistent) { $null } else { "Configured tunnel manifest differs from the running tunnel state. Restart the owned tunnel, then refresh the Connector and use a new conversation." }
  }
  connector_visibility = $health.connector_visibility
  mcp_server = $health.mcp_server
  workspace_root = $health.workspace_root
  tasks_dir = $health.tasks_dir
  watcher = $health.watcher
  agents = $health.agents
  tunnel_state = $health.tunnel
  tunnel_live_probe = $liveTunnel
  tunnel_processes = $tunnelProcesses
  mcp_child_processes = $mcpChildProcesses
  patchwarden_processes = $safeProcesses
  version_conflicts = @($safeProcesses | Where-Object { $_.version_conflict })
  last_error = $health.last_error
} | ConvertTo-Json -Depth 8
