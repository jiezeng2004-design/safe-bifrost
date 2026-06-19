param(
  [string]$TunnelId = $env:SAFE_BIFROST_TUNNEL_ID,
  [string]$Profile = "safe-bifrost",
  [string]$ProxyUrl = $(if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { "http://127.0.0.1:7892" }),
  [string]$TunnelClientExe = $env:TUNNEL_CLIENT_EXE,
  [string]$OpencodeBin = $env:OPENCODE_BIN_DIR
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot "safe-bifrost.config.json"
$McpStdioLauncher = Join-Path $ProjectRoot "scripts\safe-bifrost-mcp-stdio.cmd"
$McpStdioLauncherForTunnel = $McpStdioLauncher -replace "\\", "/"
$OpencodeConfigHome = Join-Path $env:LOCALAPPDATA "safe-bifrost\opencode-config"
$ProfilePath = Join-Path $env:APPDATA "tunnel-client\$Profile.yaml"

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

  Write-Host "[input] Paste your OpenAI tunnel runtime API key. It will NOT be saved to disk."
  $secure = Read-Host "CONTROL_PLANE_API_KEY" -AsSecureString
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
Assert-File -Path $ConfigPath -Name "safe-bifrost.config.json"
Assert-File -Path $McpStdioLauncher -Name "safe-bifrost-mcp-stdio.cmd"

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

Set-SecretEnvIfMissing

$env:SAFE_BIFROST_CONFIG = $ConfigPath
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

Write-Host "[watch] Starting Safe-Bifrost watcher in a new PowerShell window..."
$watchPathLine = if ($OpencodeBin) {
  "`$env:PATH = '$OpencodeBin;' + `$env:PATH"
} else {
  "# OPENCODE_BIN_DIR was not configured; using existing PATH."
}
$watchCommand = @"
`$env:SAFE_BIFROST_CONFIG = '$ConfigPath'
`$env:XDG_CONFIG_HOME = '$OpencodeConfigHome'
$watchPathLine
Set-Location -LiteralPath '$ProjectRoot'
npm.cmd run watch
"@

Start-Process powershell.exe -ArgumentList @(
  "-NoExit",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  $watchCommand
)

Write-Host "[doctor] Checking tunnel-client profile through proxy $ProxyUrl..."
& $TunnelClientExe doctor --profile $Profile --explain --http-proxy env:HTTPS_PROXY

Write-Host ""
Write-Host "[run] Starting tunnel-client. Keep this window open."
Write-Host "[ui]  http://127.0.0.1:8080/ui"
Write-Host ""
& $TunnelClientExe run --profile $Profile --open-web-ui --http-proxy env:HTTPS_PROXY
