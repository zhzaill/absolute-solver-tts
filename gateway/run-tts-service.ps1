# TTS Service 启动器：带自动重启（退出码 75 = 配置界面请求重启）
#
# 服务器上由计划任务 Absolute-Solver-TTS 调用（见 run-tts-service.cmd）。
# 停止方式：结束计划任务，或在本窗口按 Ctrl+C（不会触发重启）。

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$install = "E:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50"
$python = Join-Path $install "runtime\python.exe"
if (-not (Test-Path $python)) { $python = "python" }

$env:GPTSOVITS_HOME = $install
$env:TTS_CONFIG = Join-Path $here "config.json"
# 日志统一 UTF-8，避免中文在重定向文件里半途换编码
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

Set-Location $here
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-Host "=== TTS Service launcher started $stamp ==="
Write-Host "python : $python"
Write-Host "config : $env:TTS_CONFIG"

while ($true) {
    & $python gateway.py
    $code = $LASTEXITCODE
    if ($code -ne 75) {
        Write-Host "=== service exited with code $code; not restarting ==="
        break
    }
    Write-Host "=== restart requested (code 75); restarting in 1s ==="
    Start-Sleep -Seconds 1
}
