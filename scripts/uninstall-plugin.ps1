[CmdletBinding()]
param(
    [string]$ProfileDirectory = (Join-Path $HOME ".dsh\profiles\desktop"),
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$profile = [IO.Path]::GetFullPath($ProfileDirectory)
$profilePackage = Join-Path $profile "package.json"
if (-not (Test-Path -LiteralPath $profilePackage)) {
    throw "DSH profile package.json not found: $profilePackage"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item -LiteralPath $profilePackage -Destination "$profilePackage.bak-$stamp"
$document = Get-Content -LiteralPath $profilePackage -Raw -Encoding UTF8 | ConvertFrom-Json

if ($document.dependencies -and $document.dependencies.PSObject.Properties.Name -contains "dsh-tts") {
    $document.dependencies.PSObject.Properties.Remove("dsh-tts")
}
if ($document.dsh -and $document.dsh.profile) {
    $remaining = @($document.dsh.profile.bundles | Where-Object { $_ -ne "dsh-tts" })
    $document.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $remaining -Force
}

$json = $document | ConvertTo-Json -Depth 30
[IO.File]::WriteAllText($profilePackage, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

if (-not $SkipInstall) {
    Push-Location $profile
    try {
        pnpm install
        if ($LASTEXITCODE -ne 0) {
            throw "pnpm install failed in $profile"
        }
    } finally {
        Pop-Location
    }
}

Write-Host "Removed dsh-tts from $profile. Restart DSH."
