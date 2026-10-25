[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$patterns = @(
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    "sk-[A-Za-z0-9]{20,}",
    "AKIA[0-9A-Z]{16}",
    "(?i)(password|passwd|secret|api[_-]?key)\s*[:=]\s*['""][^'""<]{8,}['""]",
    "192\.168\.[0-9]{1,3}\.[0-9]{1,3}",
    "(?i)furina|芙宁娜"
)

$files = @(Get-ChildItem -LiteralPath $repoRoot -Recurse -File | Where-Object {
    $_.FullName -notmatch "[\\/](\.git|node_modules|\.venv|__pycache__)[\\/]" -and
    $_.FullName -ne (Join-Path $repoRoot "scripts\check-secrets.ps1") -and
    $_.Extension -notin @(".wav", ".mp3", ".flac", ".ckpt", ".pth", ".pt", ".onnx")
})

$findings = @()
foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($repoRoot, $file.FullName)
    $lineNumber = 0
    foreach ($line in Get-Content -LiteralPath $file.FullName -Encoding UTF8) {
        $lineNumber += 1
        foreach ($pattern in $patterns) {
            if ($line -match $pattern) {
                $findings += "${relative}:${lineNumber}: matched $pattern"
            }
        }
    }
}

if ($findings.Count -gt 0) {
    $findings | ForEach-Object { Write-Error $_ }
    exit 1
}
Write-Host "Secret scan passed: no keys, private-network addresses, or restricted voice names found."
