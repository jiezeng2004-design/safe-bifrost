#Requires -Version 5.1
<#
.SYNOPSIS
  Lightweight PatchWarden Control Center system tray entry.
.DESCRIPTION
  Builds a Windows NotifyIcon (no Electron, no extra dependencies) whose menu
  drives the Control Center via its HTTP API with the control token. If the
  Control Center is not running when the tray starts, it is launched in the
  background first.

  Menu:
    - Open Dashboard           (opens the dashboard in the default browser)
    - Status                   (shows a compact Core/Direct/Watcher summary)
    - Start All                (POST /api/start-all)
    - Stop All                 (POST /api/stop-all)
    - Restart All              (POST /api/restart-all)
    - Open Logs                (POST /api/open-logs-folder)
    - Quit Tray                (disposes the tray and exits)
#>
param(
  [int]$Port = 8090,
  [switch]$NoStartupBalloon
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$BaseUrl = "http://127.0.0.1:$Port/"
$RuntimeDirectory = Join-Path $env:LOCALAPPDATA "patchwarden\control-center"
$StatusFile = Join-Path $RuntimeDirectory "control-center-status.json"
$MutexName = "Local\PatchWarden-Control-Tray-" + ([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($ProjectRoot)) -replace "[^A-Za-z0-9]", "").Substring(0, 16)

# ── Load WinForms + Drawing ──────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$createdMutex = $false
$trayMutex = New-Object System.Threading.Mutex($true, $MutexName, [ref]$createdMutex)
if (-not $createdMutex) {
  $trayMutex.Dispose()
  exit 0
}

# ── Helpers ──────────────────────────────────────────────────────

function Invoke-ControlApi {
  param([Parameter(Mandatory = $true)][string]$Path, [string]$Method = "POST")
  $url = $BaseUrl.TrimEnd("/") + $Path
  # Fetch the control token (in-memory, per server run).
  $token = $null
  try {
    $tokenResp = Invoke-WebRequest -Uri ($BaseUrl.TrimEnd("/") + "/control-token.json") -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    $token = ($tokenResp.Content | ConvertFrom-Json).token
  } catch {
    [System.Windows.Forms.MessageBox]::Show(
      "Could not reach the Control Center at $BaseUrl.`n`nError: $($_.Exception.Message)",
      "PatchWarden Tray",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
    return $null
  }
  $headers = @{ "X-PatchWarden-Control-Token" = $token }
  try {
    $resp = Invoke-WebRequest -Uri $url -Method $Method -Headers $headers -UseBasicParsing -TimeoutSec 60 -ErrorAction Stop
    return $resp.Content | ConvertFrom-Json
  } catch {
    [System.Windows.Forms.MessageBox]::Show(
      "API call failed: $Path`n`nError: $($_.Exception.Message)",
      "PatchWarden Tray",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
    return $null
  }
}

function New-PatchWardenTrayIcon {
  $bitmap = New-Object System.Drawing.Bitmap 32, 32
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $background = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 10, 14, 20))
  $accent = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 45, 212, 168))
  $darkPen = New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::FromArgb(255, 5, 9, 14)), 1.5

  $graphics.FillEllipse($background, 1, 1, 30, 30)
  $points = [System.Drawing.Point[]]@(
    [System.Drawing.Point]::new(16, 5),
    [System.Drawing.Point]::new(25, 9),
    [System.Drawing.Point]::new(24, 17),
    [System.Drawing.Point]::new(16, 27),
    [System.Drawing.Point]::new(8, 17),
    [System.Drawing.Point]::new(7, 9)
  )
  $graphics.FillPolygon($accent, $points)
  $graphics.DrawPolygon($darkPen, $points)
  $graphics.DrawLine($darkPen, 16, 8, 16, 23)
  $graphics.DrawLine($darkPen, 11, 15, 21, 15)

  $handle = $bitmap.GetHicon()
  try {
    return [System.Drawing.Icon]::FromHandle($handle)
  } finally {
    $graphics.Dispose()
    $background.Dispose()
    $accent.Dispose()
    $darkPen.Dispose()
  }
}

function Show-TrayBalloon {
  param([string]$Title, [string]$Text, [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info)
  if ($null -eq $script:notifyIcon) { return }
  $script:notifyIcon.BalloonTipTitle = $Title
  $script:notifyIcon.BalloonTipText = $Text
  $script:notifyIcon.BalloonTipIcon = $Icon
  $script:notifyIcon.ShowBalloonTip(2200)
}

function Invoke-TrayControlAction {
  param([string]$Path, [string]$SuccessText)
  $result = Invoke-ControlApi -Path $Path
  if ($null -eq $result) { return }
  if ($result.ok -eq $false) {
    Show-TrayBalloon -Title "PatchWarden needs attention" -Text "Open Dashboard for details." -Icon ([System.Windows.Forms.ToolTipIcon]::Warning)
    return
  }
  Show-TrayBalloon -Title "PatchWarden" -Text $SuccessText
}

function Test-ControlCenterRunning {
  # Probe the status endpoint to confirm the server is live and is ours.
  try {
    $resp = Invoke-WebRequest -Uri ($BaseUrl.TrimEnd("/") + "/api/control-center-status") -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($resp.StatusCode -eq 200) {
      $body = $resp.Content | ConvertFrom-Json
      return [bool]$body.running
    }
  } catch {}
  return $false
}

function Ensure-ControlCenterRunning {
  if (Test-ControlCenterRunning) { return $true }
  Write-Host "[tray] Preparing PatchWarden Control Center..."
  $startScript = Join-Path $PSScriptRoot "start-control-center.ps1"
  if (-not (Test-Path -LiteralPath $startScript)) {
    [System.Windows.Forms.MessageBox]::Show(
      "start-control-center.ps1 not found at:`n$startScript",
      "PatchWarden Tray",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    return $false
  }
  try {
    Start-Process -FilePath "powershell.exe" `
      -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $startScript, "-NoBrowser") `
      -WindowStyle Hidden -Wait -ErrorAction Stop
  } catch {
    [System.Windows.Forms.MessageBox]::Show(
      "Failed to start the Control Center:`n$($_.Exception.Message)",
      "PatchWarden Tray",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    return $false
  }
  # Wait up to 20s for readiness.
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    if (Test-ControlCenterRunning) { return $true }
  }
  return $false
}

function Show-CompactStatus {
  $data = Invoke-ControlApi -Path "/api/status" -Method "GET"
  if ($null -eq $data) { return }

  $core = if ($data.core.available) { "available" } else { "stopped" }
  $direct = if ($data.direct.available) { "available" } else { "stopped" }
  $watcher = if ($data.watcher.status) { [string]$data.watcher.status } else { "unknown" }
  $workspace = if ($data.workspace_root) { [string]$data.workspace_root } else { "not configured" }

  $message = @(
    "Core: $core"
    "Direct: $direct"
    "Watcher: $watcher"
    ""
    "Workspace:"
    $workspace
    ""
    "Open Dashboard for tasks, audit logs, Direct sessions, and setup details."
  ) -join "`n"

  [System.Windows.Forms.MessageBox]::Show(
    $message,
    "PatchWarden Status",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  ) | Out-Null
}

# ── Ensure the control center is up before showing the tray ──────
[void](Ensure-ControlCenterRunning)

# ── Build the tray icon ──────────────────────────────────────────
$script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon = $script:notifyIcon
try {
  $notifyIcon.Icon = New-PatchWardenTrayIcon
} catch {
  $notifyIcon.Icon = [System.Drawing.SystemIcons]::Shield
}
$notifyIcon.Text = "PatchWarden: local control"
$notifyIcon.Visible = $true

# Double-click opens the dashboard.
$notifyIcon.Add_DoubleClick({
  Start-Process -FilePath $BaseUrl
})

# ── Context menu ─────────────────────────────────────────────────
$menu = New-Object System.Windows.Forms.ContextMenuStrip

[void]$menu.Items.Add("Open Dashboard", $null, {
  Start-Process -FilePath $BaseUrl
})

[void]$menu.Items.Add("Status", $null, {
  Show-CompactStatus
})

[void]$menu.Items.Add("-")  # separator

[void]$menu.Items.Add("Start All", $null, {
  Invoke-TrayControlAction -Path "/api/start-all" -SuccessText "Core and Direct are starting in the background."
})

[void]$menu.Items.Add("Stop All", $null, {
  Invoke-TrayControlAction -Path "/api/stop-all" -SuccessText "Core and Direct were asked to stop. Tray and dashboard stay available."
})

[void]$menu.Items.Add("Restart All", $null, {
  Invoke-TrayControlAction -Path "/api/restart-all" -SuccessText "Core and Direct are restarting in the background."
})

[void]$menu.Items.Add("-")  # separator

[void]$menu.Items.Add("Open Logs", $null, {
  Invoke-TrayControlAction -Path "/api/open-logs-folder" -SuccessText "Opening PatchWarden runtime logs."
})

[void]$menu.Items.Add("-")  # separator

[void]$menu.Items.Add("Quit Tray", $null, {
  $notifyIcon.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.ContextMenuStrip = $menu

# Show a brief balloon on launch.
if (-not $NoStartupBalloon) {
  Show-TrayBalloon -Title "PatchWarden is ready" -Text "Right-click for quick controls. Open Dashboard for the full console."
}

Write-Host "[tray] PatchWarden Control Center tray is active. Right-click the icon for actions."

# Run the application loop. Without this the script exits immediately and the
# tray disappears. The loop exits when Application::Exit() is called from the
# Exit menu item.
[System.Windows.Forms.Application]::Run()

# Cleanup on exit.
$notifyIcon.Visible = $false
$notifyIcon.Dispose()
if ($trayMutex) { $trayMutex.ReleaseMutex(); $trayMutex.Dispose() }
Write-Host "[tray] Exited."
