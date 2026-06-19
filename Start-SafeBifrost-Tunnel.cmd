@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-safe-bifrost-tunnel.ps1"
echo.
echo Safe-Bifrost tunnel launcher exited.
pause
