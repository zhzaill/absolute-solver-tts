[CmdletBinding()]
param(
    [string]$GptSovitsHome = $env:GPTSOVITS_HOME,
    [string]$BindHost = $(if ($env:GATEWAY_HOST) { $env:GATEWAY_HOST } else { "127.0.0.1" }),
    [int]$Port = $(if ($env:GATEWAY_PORT) { [int]$env:GATEWAY_PORT } else { 18080 }),
    [switch]$Background
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$gatewayScript = Join-Path $repoRoot "gateway\gateway.py"
$venvDir = Join-Path $repoRoot ".venv"
$venvPython = if ($IsWindows -or $env:OS -eq "Windows_NT") {
    Join-Path $venvDir "Scripts\python.exe"
} else {
    Join-Path $venvDir "bin\python"
}

if (-not $GptSovitsHome) {
    throw "Set GPTSOVITS_HOME or pass -GptSovitsHome."
}
if (-not (Test-Path -LiteralPath (Join-Path $GptSovitsHome "api_v2.py"))) {
    throw "GPT-SoVITS api_v2.py not found under: $GptSovitsHome"
}
if (-not (Test-Path -LiteralPath $gatewayScript)) {
    throw "Missing gateway script: $gatewayScript"
}
if (-not (Test-Path -LiteralPath $venvPython)) {
    throw "Run scripts\setup-gateway.ps1 first."
}

$env:GPTSOVITS_HOME = (Resolve-Path -LiteralPath $GptSovitsHome).Path
$env:GATEWAY_HOST = $BindHost
$env:GATEWAY_PORT = [string]$Port

if ($Background) {
    $logDir = Join-Path $repoRoot ".run"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $stdout = Join-Path $logDir "gateway.out.log"
    $stderr = Join-Path $logDir "gateway.err.log"
    $process = Start-Process `
        -FilePath $venvPython `
        -ArgumentList @($gatewayScript) `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru
    Write-Host "Gateway started in background: pid=$($process.Id)"
    Write-Host "Logs: $stdout ; $stderr"
    exit 0
}

Push-Location $repoRoot
try {
    & $venvPython $gatewayScript
} finally {
    Pop-Location
}
