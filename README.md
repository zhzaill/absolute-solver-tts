# Absolute Solver TTS

一个可直接部署的 GPT-SoVITS OpenAI 兼容语音服务，以及配套的 DeepSeek Harness（DSH）插件。

它解决的不是“能不能合成音频”，而是语音链路里三个容易被误判为成功的问题：

1. OpenAI `/v1/audio/speech` 协议没有文本语言字段，日文可能被中文前端静默读错。
2. 浏览器不能安全、稳定地跨源取得本机网关的音频，必须由宿主同源转发。
3. “拿到了 WAV”不等于“说的是那句话”，需要 ASR 往返或人工听辨做内容校验。

仓库只包含代码、配置模板和文档。**不包含任何第三方角色音色、训练权重或参考音频。**

## 架构

```text
DSH Agent / OpenAI-compatible client
        |
        | POST /v1/audio/speech
        v
dsh-tts plugin
  - declares text language
  - buffers and validates WAV
  - serves audio from the DSH origin
        |
        | localhost or SSH forward
        v
GPT-SoVITS gateway :18080
  - maps voice id -> weights + reference audio
  - OpenAI-compatible request/response
  - validates text language and asset paths
        |
        v
GPT-SoVITS api_v2.py :9880
        |
        v
GPU / CPU inference
```

DSH 推荐把网关放在模型服务器上，通过 SSH 将远端 `127.0.0.1:18080` 转发到本机
`127.0.0.1:18080`。网关默认只绑定回环地址，不要求把模型端口直接暴露到局域网。

## 已实现

- OpenAI 兼容接口：`POST /v1/audio/speech`
- 音色注册：模型权重、参考音频、参考原文、参考语言、默认合成语言
- 文本语言优先级：请求显式声明 -> 字形推断 -> 音色默认值
- 中文、日文、英文的显式语言声明
- DSH 工具：`tts_speak`、`tts_status`
- DSH 同源音频路由：`GET /dsh-tts/audio?id=...`
- 内容哈希 LRU 缓存
- 终端 CLI：状态检查、合成、播放、文件转写校验
- 本地或 SSH 隧道部署
- 音色资产外置与提交前检查
- 网关 API Key、管理接口鉴权和路径逃逸校验

## 不包含

- 不包含 GPT-SoVITS 本体或权重。
- 不包含任何角色语音、角色模型、参考 WAV 或训练数据。
- 不包含真实 API Key、服务器地址、账号、密码或本地状态文件。
- 不宣称任何第三方角色音色可以随本仓库再分发。

使用者必须自行取得 GPT-SoVITS、模型权重和参考音频，并确认这些资产的使用、复制和再分发权利。
详见 [资产与许可](docs/assets-and-licenses.md)。

## 目录

```text
plugin/                 DSH bundle（零运行时依赖）
gateway/                FastAPI OpenAI 兼容网关
config/                 音色与插件配置模板
scripts/                安装、隧道、注册、校验和测试脚本
docs/                   架构、部署、故障排查、历史结论、许可
tests/                  网关离线测试
```

## 快速开始

### 1. 准备 GPT-SoVITS

先安装并启动一个可用的 GPT-SoVITS `api_v2.py`。本仓库不复制其源码或模型。

```powershell
git clone https://github.com/<your-account>/absolute-solver-tts.git
Set-Location absolute-solver-tts

$env:GPTSOVITS_HOME = "D:\GPT-SoVITS"
$env:GATEWAY_API_KEY = "<generate-a-long-random-token>"

.\scripts\setup-gateway.ps1
.\scripts\start-gateway.ps1
```

网关默认绑定 `127.0.0.1:18080`。如果确实要直接监听局域网，需显式设置：

```powershell
$env:GATEWAY_HOST = "0.0.0.0"
$env:GATEWAY_API_KEY = "<required-for-non-loopback>"
```

### 2. 注册自己的音色

复制示例并填写本地资产：

```powershell
Copy-Item .\config\voices.example.json .\config\voices.local.json
notepad .\config\voices.local.json
.\scripts\check-assets.ps1 -Manifest .\config\voices.local.json
.\scripts\register-voices.ps1 -Manifest .\config\voices.local.json
```

`voices.local.json` 已被 `.gitignore` 排除。不要把真实音色资产放进仓库。

### 3. 安装 DSH 插件

```powershell
.\scripts\install-plugin.ps1 `
  -ProfileDirectory "$env:USERPROFILE\.dsh\profiles\desktop"
```

脚本会先备份 profile 的 `package.json` 与 lockfile，再安装 tarball。安装完成后重启 DSH，
新建会话并选择“对话·有声”。

如果 DSH 提供 `plugin_manager.install_bundle`，优先使用其图形界面或官方安装流程。

### 4. 可选：通过 SSH 转发

当网关在另一台机器上：

```powershell
.\scripts\start-tunnel.ps1 `
  -ServerHost "192.0.2.10" `
  -UserName "tts" `
  -KeyFile "$env:USERPROFILE\.ssh\id_ed25519"
```

这会把本机 `127.0.0.1:18080` 转发到服务器的 `127.0.0.1:18080`。
不要使用明文密码参数。

### 5. 验证

```powershell
node .\plugin\bin\tts.mjs --status
node .\plugin\bin\tts.mjs "这是一次中继检查。"
```

内容保真检查需要独立 ASR 服务，默认地址为 `http://127.0.0.1:9881/v1/audio/transcriptions`：

```powershell
$env:DSH_TTS_ASR_URL = "http://127.0.0.1:9881/v1/audio/transcriptions"
node .\plugin\bin\tts.mjs --check
```

如果没有 ASR，`--check` 会报告“未检查内容”，不会把“有音频”误报成“内容正确”。

## OpenAI 兼容调用

```powershell
$headers = @{
  Authorization = "Bearer $env:GATEWAY_API_KEY"
  "Content-Type" = "application/json; charset=utf-8"
}
$body = @{
  model = "tts-1"
  voice = "local_voice"
  input = "今日のデプロイは無事に完了した。"
  response_format = "wav"
  text_lang = "ja"
  prompt_lang = "zh"
} | ConvertTo-Json

Invoke-WebRequest `
  -Uri "http://127.0.0.1:18080/v1/audio/speech" `
  -Method Post `
  -Headers $headers `
  -Body ([Text.Encoding]::UTF8.GetBytes($body)) `
  -OutFile ".\sample.wav"
```

`text_lang` 和 `prompt_lang` 不是 OpenAI 官方字段，但 GPT-SoVITS 需要它们。
支持该扩展的网关会使用，不支持该扩展的 OpenAI 客户端通常会忽略未知字段。

## 测试

```powershell
.\scripts\run-tests.ps1
```

测试覆盖：

- Python 语法编译
- 网关鉴权、路径逃逸、音色注册、语言推断和上游请求形状
- DSH 工具 schema 与安装包结构
- 插件离线自检

真实合成、播放和 ASR 往返属于部署验收，不作为 CI 的离线前提。

## 已知边界

- 当前网关返回缓冲 WAV，未实现 OpenAI SSE 流式音频。
- DSH 同源路由解决音频取回，但浏览器自动播放仍受用户交互策略限制。
- 纯汉字文本可能无法区分中文和日文；需要调用方显式传入语言。
- ASR 往返只能抓住句子级内容错误，不能可靠判断标点、同音词和自然度。
- GPU 采样即使固定 seed 也可能出现最低有效位差异，不能做字节哈希相等的验收。

更多内容：

- [架构](docs/architecture.md)
- [部署](docs/deployment.md)
- [故障排查](docs/troubleshooting.md)
- [历史与实测结论](docs/history.md)
- [资产与许可](docs/assets-and-licenses.md)

## 许可

本仓库以 GNU Affero General Public License v3 发布。它包含从 Amadeus 的 TTS 客户端契约和设计
移植/改写而来的部分；Amadeus 使用 AGPL-3.0。GPT-SoVITS 和 DeepSeek Harness 是独立项目，
各有自己的许可和发行方式。

Third-party voice models and reference audio are not part of this repository and are not
licensed by this repository.
