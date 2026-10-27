# 从本机一键部署到服务器：打包 → 上传 → 远程执行 install.ps1 → 回显结果。
#
#   powershell -ExecutionPolicy Bypass -File deploy\deploy-remote.ps1 -Server 192.168.1.166 -HostKey "SHA256:..."
#
# 依赖 PuTTY 的 pscp/plink（默认路径 C:\Program Files\PuTTY\）。
# -Password 省略时提示输入；-HostKey 省略时先找 deploy\.deploy-key.txt，再退回交互确认。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [string]$User = "zhzaill",
    [string]$Password = "",
    [string]$HostKey = "",
    [string]$Plink = "C:\Program Files\PuTTY\plink.exe",
    [string]$Pscp = "C:\Program Files\PuTTY\pscp.exe",
    [string]$RemoteDir = "C:/Windows/Temp/tts-service-deploy",
    [string]$RemoteInstallDir = "E:\GPT-SoVITS\gateway",
    [int]$Port = 18080,
    [string]$PublicBaseUrl = "",
    [string]$KeyName = "hub",
    [switch]$ResetAdmin,
    [switch]$SkipPackage,
    [string]$Zip = ""
)

$ErrorActionPreference = "Stop"
function Say($message, $color = "Gray") { Write-Host $message -ForegroundColor $color }

# 外部程序：合并 stderr、不让 ErrorActionPreference 把 stderr 当异常抛出
function Invoke-Native {
    param([string]$Exe, [string[]]$Argv)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try { $text = (& $Exe @Argv 2>&1 | Out-String).Trim() }
    finally { $ErrorActionPreference = $previous }
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = $text }
}

if (-not (Test-Path $Plink)) { throw "找不到 plink：$Plink" }
if (-not (Test-Path $Pscp)) { throw "找不到 pscp：$Pscp" }

if (-not $Password) {
    $secure = Read-Host "SSH 密码 ($User@$Server)" -AsSecureString
    $Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if (-not $HostKey) {
    $keyFile = Join-Path $PSScriptRoot ".deploy-key.txt"
    if (Test-Path $keyFile) {
        $HostKey = (Get-Content $keyFile -Raw).Trim()
        Say "使用 .deploy-key.txt 里的主机指纹"
    }
}

$hostKeyArgs = @()
if ($HostKey) { $hostKeyArgs = @("-hostkey", $HostKey) }

function Invoke-Remote {
    param([string]$Script)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
    return Invoke-Native $Plink (@("-ssh", "-batch", "-pw", $Password) + $hostKeyArgs + @("${User}@${Server}", "powershell -NoProfile -EncodedCommand $encoded"))
}

# ---------------------------------------------------------------- 打包

if (-not $SkipPackage -and -not $Zip) {
    Say "1/4 打包"
    $repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $package = Invoke-Native "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "package.ps1"))
    Write-Host $package.Text
    if ($package.Code -ne 0) { throw "打包失败" }
    $Zip = Get-ChildItem (Join-Path $repo "dist\tts-service-*.zip") |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Zip -or -not (Test-Path $Zip)) { throw "没有可部署的安装包" }
$ZipItem = Get-Item $Zip
Say "    包：$($ZipItem.Name) ($([math]::Round($ZipItem.Length / 1KB, 1)) KB)"

# ---------------------------------------------------------------- 上传

Say "2/4 上传到 ${Server}:$RemoteDir"
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot ".staging") -Force | Out-Null
$created = Invoke-Remote "New-Item -ItemType Directory -Force -Path '$($RemoteDir.Replace('/', '\'))' | Out-Null; 'ok'"
if ($created.Code -ne 0) { throw "无法创建远端目录：$($created.Text)" }

$upload = Invoke-Native $Pscp (@("-batch", "-pw", $Password) + $hostKeyArgs + @($Zip, "${User}@${Server}:$RemoteDir/"))
if ($upload.Code -ne 0) { throw "上传失败：$($upload.Text)" }
Say "    $($upload.Text)"
$remoteZip = "$RemoteDir/$($ZipItem.Name)"

# ---------------------------------------------------------------- 远程安装

Say "3/4 远程安装"
$installArgs = @("-InstallDir", "'$RemoteInstallDir'", "-Port", "$Port", "-KeyName", "'$KeyName'")
if ($PublicBaseUrl) { $installArgs += @("-PublicBaseUrl", "'$PublicBaseUrl'") }
if ($ResetAdmin) { $installArgs += "-ResetAdmin" }

$remoteScript = @"
`$ErrorActionPreference = 'Stop'
`$work = '$($RemoteDir.Replace('/', '\'))'
`$zip = '$($remoteZip.Replace('/', '\'))'
if (Test-Path (Join-Path `$work 'unpack')) { Remove-Item (Join-Path `$work 'unpack') -Recurse -Force }
Expand-Archive -Path `$zip -DestinationPath (Join-Path `$work 'unpack') -Force
`$install = Get-ChildItem (Join-Path `$work 'unpack') -Recurse -Filter 'install.ps1' |
    Where-Object { `$_.FullName -like '*\deploy\install.ps1' } | Select-Object -First 1
if (-not `$install) { throw '安装包里没有 deploy\install.ps1' }
& powershell -NoProfile -ExecutionPolicy Bypass -File `$install.FullName $($installArgs -join ' ')
"@

$installed = Invoke-Remote $remoteScript
Write-Host $installed.Text
if ($installed.Code -ne 0) { throw "远程安装失败" }

# ---------------------------------------------------------------- 验收

Say "4/4 验收"
$check = Invoke-Remote @"
`$ErrorActionPreference = 'SilentlyContinue'
try {
  `$h = Invoke-RestMethod 'http://127.0.0.1:$Port/healthz' -TimeoutSec 5
  'healthz ok=' + `$h.ok + ' version=' + `$h.version + ' upstream_alive=' + `$h.upstream_alive
} catch { 'healthz 失败: ' + `$_.Exception.Message }
"@
Write-Host $check.Text

Say ""
Say "完成。远端部署包保留在 $RemoteDir（可手工删除）。" "Green"
