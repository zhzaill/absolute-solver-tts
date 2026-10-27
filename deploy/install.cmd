@echo off
REM One-click install / upgrade for TTS Service. Runs install.ps1 beside this file.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\install.ps1" %*
if errorlevel 1 (
  echo.
  echo Install failed. Read the messages above.
  pause
  exit /b 1
)
echo.
echo Done. Console: http://127.0.0.1:18080/admin
pause
