[CmdletBinding()]
param(
    [switch]$Live
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    python -m compileall -q gateway tests
    if ($LASTEXITCODE -ne 0) {
        throw "Python compile failed"
    }

    python -m unittest discover -s tests -v
    if ($LASTEXITCODE -ne 0) {
        throw "Python tests failed"
    }

    $javascriptFiles = @(Get-ChildItem -Path "plugin\bin", "plugin\lib", "plugin\tools" -Filter "*.mjs" -File)
    foreach ($file in $javascriptFiles) {
        node --check $file.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "node --check failed: $($file.FullName)"
        }
    }

    node plugin\tools\verify-schemas.mjs
    if ($LASTEXITCODE -ne 0) {
        throw "Schema verification failed"
    }
    node plugin\tools\verify-connection.mjs
    if ($LASTEXITCODE -ne 0) {
        throw "Connection verification failed"
    }
    node plugin\tools\verify-install.mjs plugin
    if ($LASTEXITCODE -ne 0) {
        throw "Install verification failed"
    }

    if ($Live) {
        node plugin\tools\verify-mount.mjs
        if ($LASTEXITCODE -ne 0) {
            throw "Live mount verification failed"
        }
        node plugin\tools\selftest.mjs
        if ($LASTEXITCODE -ne 0) {
            throw "Live self-test failed"
        }
    } else {
        $oldEndpoint = $env:DSH_TTS_TEST_BASE_URL
        $env:DSH_TTS_TEST_BASE_URL = "http://127.0.0.1:9/v1"
        try {
            node plugin\tools\selftest.mjs
            if ($LASTEXITCODE -ne 0) {
                throw "Offline self-test failed"
            }
        } finally {
            $env:DSH_TTS_TEST_BASE_URL = $oldEndpoint
        }
    }

    Write-Host "All offline checks passed."
} finally {
    Pop-Location
}
