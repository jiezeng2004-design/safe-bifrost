@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "DEFAULT_PROXY=http://127.0.0.1:7892"

if not defined PATCHWARDEN_PROXY_URL (
  if defined HTTPS_PROXY (
    set "PATCHWARDEN_PROXY_URL=%HTTPS_PROXY%"
  ) else if defined HTTP_PROXY (
    set "PATCHWARDEN_PROXY_URL=%HTTP_PROXY%"
  ) else (
    set "PATCHWARDEN_PROXY_URL=%DEFAULT_PROXY%"
  )
)

set "HTTP_PROXY=%PATCHWARDEN_PROXY_URL%"
set "HTTPS_PROXY=%PATCHWARDEN_PROXY_URL%"
set "ALL_PROXY=%PATCHWARDEN_PROXY_URL%"
set "NO_PROXY=localhost,127.0.0.1,::1"

set "SCRIPTS_DIR=%~dp0scripts\control"
set "MANAGER=%SCRIPTS_DIR%\manage-patchwarden.ps1"

if not exist "%MANAGER%" (
  echo [error] manage-patchwarden.ps1 not found:
  echo         %MANAGER%
  echo.
  pause
  exit /b 1
)

echo ========================================
echo  PatchWarden Control
echo ========================================
echo Project: %~dp0
echo Proxy : %PATCHWARDEN_PROXY_URL%
echo NO_PROXY: %NO_PROXY%
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%MANAGER%" %*
set "PATCHWARDEN_EXIT_CODE=%ERRORLEVEL%"

if not "%PATCHWARDEN_EXIT_CODE%"=="0" (
  echo.
  echo PatchWarden control exited with code %PATCHWARDEN_EXIT_CODE%.
  pause
)

exit /b %PATCHWARDEN_EXIT_CODE%
