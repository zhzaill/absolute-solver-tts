# TTS Service 一键安装 / 升级（在目标服务器上运行）
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Port 18080 -KeyName hub
#
# 幂等：重复运行＝升级。已存在的管理员口令、客户端密钥、音色表都不会被覆盖（除非显式 -ResetAdmin）。
# 只写 InstallDir 下的文件，并在动文件前做带时间戳的备份。

[CmdletBinding()]
param(
    [string]$InstallDir = "E:\GPT-SoVITS\gateway",
    [string]$GptSoVitsHome = "E:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50",
    [string]$ListenHost = "0.0.0.0",
    [int]$Port = 18080,
    [string]$PublicBaseUrl = "",
    [string]$AdminPassword = "",
    [switch]$ResetAdmin,
    [string]$KeyName = "hub",
    [string]$KeyNote = "Absolute Solver Hub (server)",
    [string]$DefaultVoice = "xxx_trained",
    [string]$TaskName = "Absolute-Solver-TTS",
    [switch]$SkipFirewall,
    [switch]$SkipTask,
    [switch]$NoStart,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Say($message, $color = "Gray") { Write-Host $message -ForegroundColor $color }
function Fail($message) { Write-Host "✗ $message" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 定位源文件

$candidates = @(
    (Join-Path $PSScriptRoot "..\gateway"),
    (Join-Path $PSScriptRoot ".."),
    $PSScriptRoot
)
$Source = $null
foreach ($candidate in $candidates) {
    if (Test-Path (Join-Path $candidate "gateway.py")) {
        $Source = (Resolve-Path $candidate).Path
        break
    }
}
if (-not $Source) { Fail "找不到 gateway.py；请在解压后的安装包目录里运行 install.ps1" }
Say "源目录   : $Source"

$required = @("gateway.py", "provision.py", "run-tts-service.cmd", "run-tts-service.ps1", "ui\index.html", "ui\app.css", "ui\app.js")
foreach ($relative in $required) {
    if (-not (Test-Path (Join-Path $Source $relative))) { Fail "安装包不完整，缺少 $relative" }
}

# ---------------------------------------------------------------- Python

$python = Join-Path $GptSoVitsHome "runtime\python.exe"
if (-not (Test-Path $python)) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $cmd) { Fail "找不到 Python：既没有 $python，也没有 PATH 里的 python" }
    $python = $cmd.Source
}
Say "Python   : $python"

& $python -c "import fastapi, uvicorn, requests" 2>$null
if ($LASTEXITCODE -ne 0) { Fail "该 Python 缺少 fastapi/uvicorn/requests，请用 GPT-SoVITS 的 runtime" }

# ---------------------------------------------------------------- 停服务

if (-not $DryRun) {
    Say ""
    Say "1/6 停止现有服务"
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Say "     已停止计划任务 $TaskName" -color DarkGray
    }
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*gateway.py*" } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            Say "     已结束 PID $($_.ProcessId)" -color DarkGray
        }
    Start-Sleep -Seconds 2
}

# ---------------------------------------------------------------- 备份与复制

Say ""
Say "2/6 备份并安装文件到 $InstallDir"
if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
foreach ($name in @("gateway.py", "config.json", "run-absolute-solver-gateway.cmd")) {
    $target = Join-Path $InstallDir $name
    if (Test-Path $target) {
        if ($DryRun) {
            Say "     [dry-run] 将备份 $name → $name.pre-install-$stamp.bak" -color DarkGray
        } else {
            Copy-Item $target (Join-Path $InstallDir "$name.pre-install-$stamp.bak") -Force
            Say "     备份 $name → $name.pre-install-$stamp.bak" -color DarkGray
        }
    }
}

if (-not $DryRun) {
    Copy-Item (Join-Path $Source "gateway.py") $InstallDir -Force
    Copy-Item (Join-Path $Source "provision.py") $InstallDir -Force
    Copy-Item (Join-Path $Source "run-tts-service.cmd") $InstallDir -Force
    Copy-Item (Join-Path $Source "run-tts-service.ps1") $InstallDir -Force
    $uiTarget = Join-Path $InstallDir "ui"
    New-Item -ItemType Directory -Path $uiTarget -Force | Out-Null
    Copy-Item (Join-Path $Source "ui\*") $uiTarget -Force
    Say "     已复制 gateway.py / provision.py / run-tts-service.* / ui\"
}

# ---------------------------------------------------------------- 初始化配置

Say ""
Say "3/6 写入配置（管理员口令与密钥已存在则保留）"
$env:GPTSOVITS_HOME = $GptSoVitsHome
$env:TTS_CONFIG = Join-Path $InstallDir "config.json"

$provisionArgs = @(
    (Join-Path $InstallDir "provision.py"),
    "--host", $ListenHost,
    "--port", "$Port"
)
if ($PublicBaseUrl) { $provisionArgs += @("--public-base-url", $PublicBaseUrl) }
if ($AdminPassword) { $provisionArgs += @("--admin-password", $AdminPassword) }
if ($ResetAdmin) { $provisionArgs += "--reset-admin" }
if ($KeyName) { $provisionArgs += @("--key-name", $KeyName, "--key-note", $KeyNote) }
if ($DefaultVoice) { $provisionArgs += @("--default-voice", $DefaultVoice) }

if ($DryRun) {
    Say "     [dry-run] $python $($provisionArgs -join ' ')" -color DarkGray
} else {
    Push-Location $InstallDir
    try { & $python $provisionArgs 2>&1 | ForEach-Object { Say "     $_" } }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Fail "配置初始化失败" }
}

# ---------------------------------------------------------------- 防火墙

Say ""
Say "4/6 防火墙入站规则"
if ($SkipFirewall) {
    Say "     已跳过（-SkipFirewall）" -color DarkGray
} else {
    $rule = Get-NetFirewallRule -DisplayName "TTS Service $Port" -ErrorAction SilentlyContinue
    if ($rule) {
        Say "     规则已存在（TTS Service $Port）" -color DarkGray
    } elseif ($DryRun) {
        Say "     [dry-run] 将创建 TCP $Port 入站规则" -color DarkGray
    } else {
        try {
            New-NetFirewallRule -DisplayName "TTS Service $Port" -Direction Inbound `
                -Protocol TCP -LocalPort $Port -Action Allow -Profile Any -ErrorAction Stop | Out-Null
            Say "     已放行 TCP $Port（需要管理员权限，失败不影响服务本身）"
        } catch {
            Say "     放行失败：$($_.Exception.Message)；请在管理员 PowerShell 里手工放行 $Port" -color Yellow
        }
    }
}

# ---------------------------------------------------------------- 计划任务

Say ""
Say "5/6 计划任务 $TaskName"
$launcher = Join-Path $InstallDir "run-tts-service.cmd"
if ($SkipTask) {
    Say "     已跳过（-SkipTask）" -color DarkGray
} elseif ($DryRun) {
    Say "     [dry-run] schtasks /Create /F /SC ONLOGON /TN $TaskName /TR cmd.exe /c `"$launcher`"" -color DarkGray
} else {
    # 兼容旧部署：老入口 run-absolute-solver-gateway.cmd 继续指到新启动器
    $legacy = Join-Path $InstallDir "run-absolute-solver-gateway.cmd"
    $legacyBody = "@echo off`r`nREM v2: real implementation is run-tts-service.cmd (exit code 75 = restart loop)`r`ncall `"$launcher`"`r`n"
    [System.IO.File]::WriteAllText($legacy, $legacyBody, (New-Object System.Text.ASCIIEncoding))

    $action = "cmd.exe /c `"$launcher`""
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        try {
            $set = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$launcher`""
            Set-ScheduledTask -TaskName $TaskName -Action $set | Out-Null
            Say "     已更新现有任务的启动命令"
        } catch {
            Say "     更新失败，改注册新任务：$($_.Exception.Message)" -color Yellow
            $existing = $null
        }
    }
    if (-not $existing) {
        & schtasks.exe /Create /F /SC ONLOGON /TN $TaskName /TR $action | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Say "     计划任务创建失败（可能不是管理员）；可用 -SkipTask 后手工启动 $launcher" -color Yellow
        } else {
            Say "     已创建登录时启动的计划任务"
        }
    }
}

# ---------------------------------------------------------------- 启动与验收

Say ""
Say "6/6 启动并验收"
if ($NoStart -or $DryRun) {
    Say "     未启动（-NoStart / -DryRun）" -color DarkGray
} else {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Start-ScheduledTask -TaskName $TaskName
    } else {
        Start-Process -FilePath $launcher -WindowStyle Hidden
    }
    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
            $ready = $true
            Say "     /healthz ok=$($health.ok) version=$($health.version) upstream_alive=$($health.upstream_alive)"
            break
        } catch { }
    }
    if (-not $ready) { Fail "服务未在 20 秒内响应 http://127.0.0.1:$Port/healthz（看 $InstallDir\tts-service.log）" }
}

Say ""
Say "完成。配置界面：http://127.0.0.1:$Port/admin   对外地址：$(if ($PublicBaseUrl) { $PublicBaseUrl } else { "http://<本机IP>:$Port" })" "Green"
Say "客户端的 sk- 密钥在配置文件 $(Join-Path $InstallDir 'config.json') 的 keys[] 里；界面「客户端密钥」页可复制。" "DarkGray"
