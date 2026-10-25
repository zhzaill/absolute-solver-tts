[CmdletBinding()]
param(
    [string]$ProfileDirectory = (Join-Path $HOME ".dsh\profiles\desktop"),
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginDir = Join-Path $repoRoot "plugin"
$profile = [IO.Path]::GetFullPath($ProfileDirectory)
$profilePackage = Join-Path $profile "package.json"
$profileLock = Join-Path $profile "pnpm-lock.yaml"

if (-not (Test-Path -LiteralPath $profilePackage)) {
    throw "DSH profile package.json not found: $profilePackage"
}

Push-Location $pluginDir
try {
    $packJson = npm pack --json
    if ($LASTEXITCODE -ne 0) {
        throw "npm pack failed"
    }
    $pack = $packJson | ConvertFrom-Json
    $filename = @($pack)[0].filename
    if (-not $filename) {
        throw "npm pack did not report a tarball filename"
    }
} finally {
    Pop-Location
}

$tarball = Join-Path $pluginDir $filename
if (-not (Test-Path -LiteralPath $tarball)) {
    throw "Packed bundle not found: $tarball"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item -LiteralPath $profilePackage -Destination "$profilePackage.bak-$stamp"
if (Test-Path -LiteralPath $profileLock) {
    Copy-Item -LiteralPath $profileLock -Destination "$profileLock.bak-$stamp"
}

$document = Get-Content -LiteralPath $profilePackage -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $document.dependencies) {
    $document | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
$fileSpec = "file:" + ($tarball -replace "\\", "/")
$document.dependencies | Add-Member -NotePropertyName "dsh-tts" -NotePropertyValue $fileSpec -Force

if ($null -eq $document.dsh) {
    $document | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $document.dsh.profile) {
    $document.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
}
$bundles = [Collections.Generic.List[string]]::new()
foreach ($bundle in @($document.dsh.profile.bundles)) {
    if ($bundle -and $bundle -ne "dsh-tts") {
        $bundles.Add([string]$bundle)
    }
}
$bundles.Add("dsh-tts")
$document.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @($bundles) -Force

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

$installedPackage = Join-Path $profile "node_modules\dsh-tts\package.json"
if (-not $SkipInstall -and -not (Test-Path -LiteralPath $installedPackage)) {
    throw "dsh-tts was not installed under $profile\node_modules"
}

Write-Host "Installed bundle: $tarball"
Write-Host "Profile: $profile"
Write-Host "Backups use suffix: .bak-$stamp"
Write-Host "Restart DSH, then create a conversation with the voice preset."
