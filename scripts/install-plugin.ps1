[CmdletBinding()]
param(
    [string]$ProfileDirectory = (Join-Path $HOME ".dsh\profiles\desktop"),
    [string]$BaseUrl = "http://127.0.0.1:18080/v1",
    [string]$PublicBaseUrl = "http://127.0.0.1:19387",
    [string]$Voice = "local_voice",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginDir = Join-Path $repoRoot "plugin"
$browserDir = Join-Path $repoRoot "browser"
$profile = [IO.Path]::GetFullPath($ProfileDirectory)
$profilePackage = Join-Path $profile "package.json"
$profileLock = Join-Path $profile "pnpm-lock.yaml"

if (-not (Test-Path -LiteralPath $profilePackage)) {
    throw "DSH profile package.json not found: $profilePackage"
}

function Get-PackedTarball {
    param([Parameter(Mandatory)][string]$Directory)

    Push-Location $Directory
    try {
        $packJson = npm pack --json
        if ($LASTEXITCODE -ne 0) {
            throw "npm pack failed in $Directory"
        }
        $pack = $packJson | ConvertFrom-Json
        $filename = @($pack)[0].filename
        if (-not $filename) {
            throw "npm pack did not report a tarball filename in $Directory"
        }
        $result = Join-Path $Directory $filename
        if (-not (Test-Path -LiteralPath $result)) {
            throw "Packed bundle not found: $result"
        }
        return $result
    } finally {
        Pop-Location
    }
}

$pluginTarball = Get-PackedTarball $pluginDir
$browserTarball = Get-PackedTarball $browserDir

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item -LiteralPath $profilePackage -Destination "$profilePackage.bak-$stamp"
if (Test-Path -LiteralPath $profileLock) {
    Copy-Item -LiteralPath $profileLock -Destination "$profileLock.bak-$stamp"
}

$document = Get-Content -LiteralPath $profilePackage -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $document.dependencies) {
    $document | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
$pluginSpec = "file:" + ($pluginTarball -replace "\\", "/")
$browserSpec = "file:" + ($browserTarball -replace "\\", "/")
$document.dependencies | Add-Member -NotePropertyName "dsh-tts" -NotePropertyValue $pluginSpec -Force
$document.dependencies | Add-Member -NotePropertyName "dsh-tts-browser" -NotePropertyValue $browserSpec -Force
if ($document.dependencies.PSObject.Properties.Name -contains "dsh-tts-player") {
    $document.dependencies.PSObject.Properties.Remove("dsh-tts-player")
}

if ($null -eq $document.dsh) {
    $document | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $document.dsh.profile) {
    $document.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
}
$bundles = [Collections.Generic.List[string]]::new()
foreach ($bundle in @($document.dsh.profile.bundles)) {
    if ($bundle -and $bundle -notin @("dsh-tts", "dsh-tts-browser", "dsh-tts-player")) {
        $bundles.Add([string]$bundle)
    }
}
$bundles.Add("dsh-tts")
$bundles.Add("dsh-tts-browser")
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
$installedBrowser = Join-Path $profile "node_modules\dsh-tts-browser\package.json"
if (-not $SkipInstall -and -not (Test-Path -LiteralPath $installedBrowser)) {
    throw "dsh-tts-browser was not installed under $profile\node_modules"
}
if (-not $SkipInstall) {
    $installedPatch = Join-Path $profile "node_modules\dsh-tts\cordis.patch.yml"
    $patchText = Get-Content -LiteralPath $installedPatch -Raw -Encoding UTF8
    $patchText = [regex]::Replace($patchText, '(?m)^(\s*)baseUrl:\s*.*$', {
        param($match)
        $value = $BaseUrl.Replace('\', '\\').Replace('"', '\"')
        return "$($match.Groups[1].Value)baseUrl: `"$value`""
    })
    $patchText = [regex]::Replace($patchText, '(?m)^(\s*)publicBaseUrl:\s*.*$', {
        param($match)
        $value = $PublicBaseUrl.Replace('\', '\\').Replace('"', '\"')
        return "$($match.Groups[1].Value)publicBaseUrl: `"$value`""
    })
    $patchText = [regex]::Replace($patchText, '(?m)^(\s*)voice:\s*.*$', {
        param($match)
        $value = $Voice.Replace('\', '\\').Replace('"', '\"')
        return "$($match.Groups[1].Value)voice: `"$value`""
    })
    [IO.File]::WriteAllText($installedPatch, $patchText, [Text.UTF8Encoding]::new($false))
}

Write-Host "Installed bundle: $pluginTarball"
Write-Host "Installed bundle: $browserTarball"
Write-Host "Profile: $profile"
Write-Host "Backups use suffix: .bak-$stamp"
Write-Host "Restart DSH, then create a conversation with the voice preset."
