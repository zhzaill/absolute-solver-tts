@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-gateway.ps1" %*
exit /b %ERRORLEVEL%
