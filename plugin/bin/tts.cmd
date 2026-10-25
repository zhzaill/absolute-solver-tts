@echo off
REM tts - terminal front end for the TTS relay. Requires node on PATH.
REM Usage: tts --status ^| tts --check ^| tts "text" [--play]
REM cmd.exe requires CRLF line endings; this file is written with them.
setlocal
chcp 65001 >NUL
node "%~dp0tts.mjs" %*
set "RC=%ERRORLEVEL%"
REM Pause when launched with no arguments, so a double-click shows the usage
REM instead of closing the window before anything can be read.
if "%~1"=="" pause
exit /b %RC%
