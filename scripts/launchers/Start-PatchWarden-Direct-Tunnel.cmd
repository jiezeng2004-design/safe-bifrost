@echo off
setlocal
cd /d "%~dp0..\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\control\start-patchwarden-tunnel.ps1" -ToolProfile chatgpt_direct -Profile patchwarden-direct -HealthListenAddr 127.0.0.1:8081 -SkipWatcher
echo.
echo PatchWarden Direct tunnel launcher exited.
pause
