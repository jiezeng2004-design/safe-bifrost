@echo off
setlocal
cd /d "%~dp0"
if /i "%~1"=="--foreground" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\control\control-center-tray.ps1" %*
  set EXITCODE=%ERRORLEVEL%
  endlocal & exit /b %EXITCODE%
)

start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\control\control-center-tray.ps1" %*
endlocal & exit /b 0
