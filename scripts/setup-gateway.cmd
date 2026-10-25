@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-gateway.ps1" %*
exit /b %ERRORLEVEL%
