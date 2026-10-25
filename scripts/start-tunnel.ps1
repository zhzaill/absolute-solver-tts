[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ServerHost,
    [Parameter(Mandatory = $true)]
    [string]$UserName,
    [string]$KeyFile,
    [int]$LocalPort = 18080,
    [int]$RemotePort = 18080,
    [switch]$Background
)

$ErrorActionPreference = "Stop"
$ssh = if (Test-Path "C:\Windows\System32\OpenSSH\ssh.exe") {
    "C:\Windows\System32\OpenSSH\ssh.exe"
} else {
    (Get-Command ssh -ErrorAction Stop).Source
}

$arguments = @(
    "-N",
    "-L", "127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new"
)
if ($KeyFile) {
    $resolvedKey = (Resolve-Path -LiteralPath $KeyFile).Path
    $arguments += @("-i", $resolvedKey)
}
$arguments += "$UserName@$ServerHost"

if ($Background) {
    $quoted = $arguments | ForEach-Object {
        if ($_ -match '[\s"]') {
            '"' + ($_ -replace '"', '\"') + '"'
        } else {
            $_
        }
    }
    $process = Start-Process `
        -FilePath $ssh `
        -ArgumentList $quoted `
        -WindowStyle Hidden `
        -PassThru
    Write-Host "SSH tunnel started in background: pid=$($process.Id)"
    exit 0
}

Write-Host "Forwarding 127.0.0.1:$LocalPort -> $ServerHost 127.0.0.1:$RemotePort"
& $ssh @arguments
exit $LASTEXITCODE
