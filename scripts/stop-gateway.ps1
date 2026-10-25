[CmdletBinding()]
param(
    [int]$Port = 18080
)

$ErrorActionPreference = "Stop"
$connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($connections.Count -eq 0) {
    Write-Host "No gateway listener on port $Port"
    exit 0
}

$pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
$stopped = @()
foreach ($processId in $pids) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
    if ($null -eq $process) {
        continue
    }
    if ($process.CommandLine -notmatch "gateway[\\/]gateway\.py") {
        throw "Refusing to stop pid ${processId}: command line does not identify gateway.py"
    }
    Stop-Process -Id $processId -Force
    $stopped += $processId
}

Start-Sleep -Milliseconds 500
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is still listening after stop"
}
Write-Host "Stopped gateway process(es): $($stopped -join ', ')"
