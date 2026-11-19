# Plays one WAV at a time, in order, then reads the next command.
#
# Protocol: stdin has one JSON object per line: {"id": "<id>", "path": "<wav>"}.
# stdout gets one JSON object per line: {"id": "<id>", "done": true, "ms": 123}
# or {"id": "<id>", "error": "<reason>"}.
#
# System.Media.SoundPlayer plays 16-bit PCM WAV synchronously (PlaySync), which is
# exactly the "one segment after another, never in parallel" behaviour we need,
# and it needs no WPF message loop. System-wide volume applies; there is no
# per-stream gain with this API.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $id = ''
    try {
        $cmd = $line | ConvertFrom-Json
        $id = [string]$cmd.id
        $path = [string]$cmd.path
        if (-not (Test-Path -LiteralPath $path)) { throw "missing audio file: $path" }
        $player = New-Object System.Media.SoundPlayer $path
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $player.PlaySync()
        $player.Dispose()
        $watch.Stop()
        $out = @{ id = $id; done = $true; ms = [int]$watch.ElapsedMilliseconds }
    } catch {
        $out = @{ id = $id; error = [string]$_.Exception.Message }
    }
    [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}
