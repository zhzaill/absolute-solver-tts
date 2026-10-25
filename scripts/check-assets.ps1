[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Manifest,
    [string]$GptSovitsHome = $env:GPTSOVITS_HOME
)

$ErrorActionPreference = "Stop"
if (-not $GptSovitsHome) {
    throw "Set GPTSOVITS_HOME or pass -GptSovitsHome."
}

$installRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $GptSovitsHome).Path)
$manifestPath = (Resolve-Path -LiteralPath $Manifest).Path
$document = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$errors = [Collections.Generic.List[string]]::new()

function Resolve-AssetPath {
    param(
        [string]$RelativePath,
        [string]$Label
    )

    if (-not $RelativePath) {
        return $null
    }
    $candidate = [IO.Path]::GetFullPath((Join-Path $installRoot $RelativePath))
    $prefix = $installRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        $errors.Add("$Label escapes GPT-SoVITS home: $RelativePath")
        return $null
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $errors.Add("$Label not found: $RelativePath")
        return $null
    }
    return $candidate
}

function Test-WavHeader {
    param([string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    try {
        if ($stream.Length -lt 12) {
            return $false
        }
        $reader = [IO.BinaryReader]::new($stream)
        try {
            $riff = [Text.Encoding]::ASCII.GetString($reader.ReadBytes(4))
            $null = $reader.ReadBytes(4)
            $wave = [Text.Encoding]::ASCII.GetString($reader.ReadBytes(4))
            return $riff -eq "RIFF" -and $wave -eq "WAVE"
        } finally {
            $reader.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

foreach ($property in $document.voices.PSObject.Properties) {
    $voiceId = $property.Name
    $voice = $property.Value
    if (-not $voice.ref_text) {
        $errors.Add("${voiceId}: ref_text is required")
    }
    if (($voice.gpt -and -not $voice.sovits) -or ($voice.sovits -and -not $voice.gpt)) {
        $errors.Add("${voiceId}: gpt and sovits should be provided together")
    }

    if ($voice.gpt) {
        $gpt = Resolve-AssetPath -RelativePath $voice.gpt -Label "$voiceId GPT"
        if ($gpt -and [IO.Path]::GetExtension($gpt) -ne ".ckpt") {
            $errors.Add("${voiceId}: GPT weight must end in .ckpt")
        }
    }
    if ($voice.sovits) {
        $sovits = Resolve-AssetPath -RelativePath $voice.sovits -Label "$voiceId SoVITS"
        if ($sovits -and [IO.Path]::GetExtension($sovits) -ne ".pth") {
            $errors.Add("${voiceId}: SoVITS weight must end in .pth")
        }
    }

    $reference = Resolve-AssetPath -RelativePath $voice.ref_audio -Label "$voiceId reference"
    if ($reference) {
        $extension = [IO.Path]::GetExtension($reference).ToLowerInvariant()
        if ($extension -eq ".wav" -and -not (Test-WavHeader -Path $reference)) {
            $errors.Add("${voiceId}: reference file has no valid RIFF/WAVE header")
        }
        $hash = (Get-FileHash -LiteralPath $reference -Algorithm SHA256).Hash
        Write-Host ("{0}: {1} sha256={2}" -f $voiceId, $voice.ref_audio, $hash)
    }
}

if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error $_ }
    exit 1
}
Write-Host "Asset manifest is valid. No asset was copied or uploaded."
