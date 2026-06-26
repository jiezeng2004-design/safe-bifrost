@echo off
setlocal
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0scripts\control\stop-patchwarden.ps1" %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo PatchWarden stop exited with code %EXITCODE%.
  pause
)
endlocal & exit /b %EXITCODE%
