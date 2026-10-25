[CmdletBinding()]
param(
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$venvDir = Join-Path $repoRoot ".venv"
$requirements = Join-Path $repoRoot "gateway\requirements.txt"

if (-not (Test-Path -LiteralPath $requirements)) {
    throw "Missing requirements file: $requirements"
}

if (-not (Test-Path -LiteralPath $venvDir)) {
    & $Python -m venv $venvDir
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create virtual environment with $Python"
    }
}

$venvPython = if ($IsWindows -or $env:OS -eq "Windows_NT") {
    Join-Path $venvDir "Scripts\python.exe"
} else {
    Join-Path $venvDir "bin\python"
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    throw "Virtual environment Python not found: $venvPython"
}

& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) {
    throw "Failed to upgrade pip"
}

& $venvPython -m pip install -r $requirements
if ($LASTEXITCODE -ne 0) {
    throw "Failed to install gateway dependencies"
}

Write-Host "Gateway environment ready: $venvDir"
Write-Host "Next: set GPTSOVITS_HOME and GATEWAY_API_KEY, then run scripts\start-gateway.ps1"
