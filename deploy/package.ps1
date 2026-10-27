# 把仓库里的服务端源码打成一个可直接拷到服务器运行的安装包。
#
#   powershell -ExecutionPolicy Bypass -File deploy\package.ps1
#
# 产物：dist\tts-service-<version>-<yyyyMMdd>.zip
# 包内结构（install.ps1 依赖这个相对布局）：
#   tts-service\
#     install.cmd
#     deploy\install.ps1
#     gateway\gateway.py, provision.py, run-tts-service.*, ui\, README.md

[CmdletBinding()]
param(
    [string]$OutDir = "dist"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$gateway = Join-Path $root "gateway"
if (-not (Test-Path (Join-Path $gateway "gateway.py"))) { throw "找不到 gateway\gateway.py" }

$versionLine = Select-String -Path (Join-Path $gateway "gateway.py") -Pattern '^VERSION = "(.+)"'
$version = if ($versionLine) { $versionLine.Matches[0].Groups[1].Value } else { "dev" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$target = Join-Path $root $OutDir
$stageRoot = Join-Path $target "_stage"
$stage = Join-Path $stageRoot "tts-service"

if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $stage "gateway\ui") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "deploy") -Force | Out-Null

Copy-Item (Join-Path $gateway "gateway.py") (Join-Path $stage "gateway") -Force
Copy-Item (Join-Path $gateway "provision.py") (Join-Path $stage "gateway") -Force
Copy-Item (Join-Path $gateway "run-tts-service.cmd") (Join-Path $stage "gateway") -Force
Copy-Item (Join-Path $gateway "run-tts-service.ps1") (Join-Path $stage "gateway") -Force
if (Test-Path (Join-Path $gateway "README.md")) {
    Copy-Item (Join-Path $gateway "README.md") (Join-Path $stage "gateway") -Force
}
Copy-Item (Join-Path $gateway "ui\*") (Join-Path $stage "gateway\ui") -Force
Copy-Item (Join-Path $PSScriptRoot "install.ps1") (Join-Path $stage "deploy") -Force
Copy-Item (Join-Path $PSScriptRoot "install.cmd") $stage -Force

$zip = Join-Path $target "tts-service-$version-$stamp.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stageRoot -Recurse -Force

$item = Get-Item $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
Write-Host ""
Write-Host "包 : $($item.FullName)"
Write-Host "版本: $version"
Write-Host "大小: $([math]::Round($item.Length / 1KB, 1)) KB"
Write-Host "SHA256: $hash"
Write-Host ""
Write-Host "用法（服务器上）: 解压后运行 install.cmd；或 deploy\install.ps1 -Port 18080"
