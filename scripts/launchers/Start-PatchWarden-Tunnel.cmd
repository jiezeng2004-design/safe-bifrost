@echo off
setlocal
cd /d "%~dp0..\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\control\start-patchwarden-tunnel.ps1" -ToolProfile chatgpt_core -Profile patchwarden -HealthListenAddr 127.0.0.1:8080
echo.
echo PatchWarden Core tunnel launcher exited.
pause
