@echo off
REM TTS Service（局域网 OpenAI 兼容 TTS）启动入口。
REM 计划任务 Absolute-Solver-TTS 调用本文件；日志追加到 tts-service.log。
cd /d E:\GPT-SoVITS\gateway
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\GPT-SoVITS\gateway\run-tts-service.ps1" >> "E:\GPT-SoVITS\gateway\tts-service.log" 2>&1
