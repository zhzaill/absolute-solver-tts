[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Manifest,
    [string]$GatewayBaseUrl = "http://127.0.0.1:18080",
    [string]$AdminToken = $env:TTS_ADMIN_TOKEN
)

$ErrorActionPreference = "Stop"
$manifestPath = (Resolve-Path -LiteralPath $Manifest).Path
$document = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $document.voices) {
    throw "Manifest must contain a voices object."
}

if (-not $AdminToken) {
    throw "Pass -AdminToken or set TTS_ADMIN_TOKEN to a gateway administrator session token."
}
$headers = @{ 'X-Admin-Token' = $AdminToken }

function Invoke-GatewayJson {
    param(
        [string]$Method,
        [string]$Path,
        [object]$Payload
    )

    $json = $Payload | ConvertTo-Json -Depth 20 -Compress
    $parameters = @{
        Uri = "$($GatewayBaseUrl.TrimEnd('/'))$Path"
        Method = $Method
        Headers = $headers
        ContentType = "application/json; charset=utf-8"
        Body = [Text.Encoding]::UTF8.GetBytes($json)
    }
    return Invoke-RestMethod @parameters
}

$registered = @()
foreach ($property in $document.voices.PSObject.Properties) {
    $voiceId = $property.Name
    $voice = $property.Value
    $payload = @{
        id = $voiceId
        gpt = $voice.gpt
        sovits = $voice.sovits
        ref_audio = $voice.ref_audio
        ref_text = $voice.ref_text
        ref_lang = $(if ($voice.ref_lang) { $voice.ref_lang } else { "zh" })
        text_lang = $(if ($voice.text_lang) { $voice.text_lang } else { $voice.ref_lang })
        speed = $(if ($null -ne $voice.speed) { [double]$voice.speed } else { 1.0 })
    }
    if ($null -ne $voice.auto_text_lang) { $payload.auto_text_lang = [bool]$voice.auto_text_lang }
    Invoke-GatewayJson -Method "POST" -Path "/admin/api/voices" -Payload $payload | Out-Null
    $registered += $voiceId
}

if ($document.default) {
    Invoke-GatewayJson `
        -Method "POST" `
        -Path "/admin/api/voices/default" `
        -Payload @{ id = [string]$document.default } | Out-Null
}

Write-Host "Registered voices: $($registered -join ', ')"
if ($document.default) {
    Write-Host "Default voice: $($document.default)"
}
