# TTS Service（局域网 OpenAI 兼容语音服务）

一个进程同时提供三件事：**OpenAI 兼容合成接口**、**浏览器配置界面**、**上游 GPT-SoVITS 进程托管**。
典型部署：跑在模型服务器上，绑定 `0.0.0.0:18080`，局域网内任何客户端用一把 `sk-` 密钥调用。

## 架构

```text
客户端（Hub / DSH 插件 / 脚本 / 手机）
        │  POST http://192.168.1.166:18080/v1/audio/speech
        │  Authorization: Bearer sk-...
        ▼
TTS Service（gateway.py，FastAPI）        ←→  浏览器 http://192.168.1.166:18080/admin（管理员口令）
        │  POST http://127.0.0.1:9880/tts（只走回环）
        ▼
GPT-SoVITS api_v2.py（GPU 合成）
```

对外只有 `18080`。上游 `9880` 始终只监听回环地址，配置界面里的「上游启动」也强制 `-a 127.0.0.1`。

## 目录

| 文件 | 作用 |
|---|---|
| `gateway.py` | 服务本体：OpenAI 接口 + 管理 API + 静态界面 |
| `ui/` | 配置界面（`index.html` / `app.css` / `app.js`，无构建） |
| `provision.py` | 一次性初始化：写管理员口令、创建客户端密钥、迁移旧音色 |
| `run-tts-service.ps1` / `.cmd` | 启动器：退出码 75 时自动重启（界面「重启服务」用） |
| `config.json` | 运行配置与密钥（由服务写入，含明文密钥，别提交） |

## 打包与一键部署

仓库带 `deploy/`：

| 文件 | 作用 |
|---|---|
| `deploy/package.ps1` | 把服务端源码打成 `dist/tts-service-<版本>-<时间>.zip` |
| `deploy/install.ps1` | 在目标机安装/升级：备份 → 复制 → 初始化配置 → 防火墙 → 计划任务 → 启动 → 验收 |
| `deploy/install.cmd` | 双击入口（调用 install.ps1） |
| `deploy/deploy-remote.ps1` | 在本机一条命令完成"打包 → 上传 → 远程安装 → 回显验收" |

本机一条命令部署到服务器：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\deploy-remote.ps1 `
    -Server 192.168.1.166 -Password '***' -HostKey "SHA256:..." `
    -PublicBaseUrl http://192.168.1.166:18080
```

目标机上直接安装（解压 zip 后）：

```powershell
.\install.cmd
# 或：powershell -ExecutionPolicy Bypass -File deploy\install.ps1 -Port 18080 -DefaultVoice xxx_trained
```

`install.ps1` 是**幂等**的：重复运行即升级，已存在的管理员口令、客户端密钥、音色表都不会被覆盖；
每次动手前把 `gateway.py` / `config.json` / 旧启动脚本备份成 `*.pre-install-<时间>.bak`。
支持 `-DryRun` 预演、`-SkipFirewall` / `-SkipTask` 跳过系统改动。

> 所有 `.ps1` 必须存成 **UTF-8 with BOM**：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读，
> 中文字符串里的引号会被吞掉，脚本直接解析失败（这次踩过）。

## 手动部署（不用安装包）

```powershell
# 1. 复制 gateway.py / provision.py / run-tts-service.* / ui\ 到 E:\GPT-SoVITS\gateway\
# 2. 初始化（管理员口令只在未设置时写入；密钥只打印这一次）
cd E:\GPT-SoVITS\gateway
& 'E:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50\runtime\python.exe' provision.py `
    --host 0.0.0.0 --port 18080 --public-base-url http://192.168.1.166:18080 `
    --admin-password '你的管理员口令' --key-name hub --key-note 'Absolute Solver Hub' `
    --default-voice xxx_trained

# 3. 放行入站（只需一次）
New-NetFirewallRule -DisplayName "TTS Service 18080" -Direction Inbound `
    -Protocol TCP -LocalPort 18080 -Action Allow -Profile Any

# 4. 用计划任务托管（推荐），或直接运行启动器
Start-Process -FilePath "E:\GPT-SoVITS\gateway\run-tts-service.cmd" -WindowStyle Hidden
```

`provision.py --list` 可以随时查看当前配置与密钥掩码；`--key-name X` 会再建一把（已存在则不动）；
`--default-voice X` 切换默认音色。

## 鉴权

| 角色 | 凭证 | 用途 |
|---|---|---|
| 客户端 | `Authorization: Bearer sk-...` 或 `X-Api-Key` | 只能调 `/v1/*` |
| 管理员 | 口令 → HttpOnly 会话 Cookie（默认 12 小时） | 配置界面与 `/admin/api/*` |

- 客户端密钥可多把、可命名、可停用、可删除；停用或删除后立刻 401。
- 配置界面的写操作要求会话 Cookie **加** `X-TTS-Admin: 1` 自定义头，跨站表单无法直接改写配置。
- 首次初始化只允许在本机（`127.0.0.1`）完成，除非显式打开 `auth.allow_remote_setup`。
- 非回环地址启动时，缺少管理员口令或没有启用的客户端密钥会直接拒绝启动。

## 接口

`POST /v1/audio/speech`

```json
{"model": "tts-1", "input": "要合成的文本", "voice": "furina_normal", "response_format": "wav"}
```

- `voice` 缺省用默认音色；`response_format` 支持 `wav` / `ogg` / `aac`（`mp3` 会映射为 `aac`）。
- 语言：请求未带 `text_lang` 时按文本推断（假名→ja，汉字→zh，拉丁→en），音色可 `auto_text_lang=false` 关掉。
- 响应头：`x-tts-ms`（合成耗时）、`x-tts-voice`、`x-tts-chars`、`x-request-id`。
- 错误：`401` 密钥无效、`413` 超过 `limits.max_input_chars`、`429` 并发已满、`502` 上游失败、`503` 上游未运行。

`GET /v1/models`、`GET /v1/audio/voices` 需要同一把客户端密钥；`GET /healthz` 不需要密钥，返回 `upstream_alive`。

## 配置界面

`http://<服务器>:18080/admin`

| 页面 | 内容 |
|---|---|
| 概览 | 请求/字符/字节统计、**健康自检**（口令/密钥/音色/安装目录/上游，可选含合成）、异常清单、最近请求 |
| 最近请求 | 100 条记录（只有长度、状态、耗时，不含文本），按客户端与状态筛选 |
| 上游进程 | 状态、启停、日志尾部、**权重热加载** |
| 音色 | 增删改、设默认、参考音频校验、**自动推断语言开关**、**按段语言推断预览**、试听 |
| 客户端密钥 | 创建（明文只显示一次）、改名/备注、停用、复制、删除 |
| 服务设置 | 监听/对外地址、上游地址、超时、默认音色与格式、限额；改动未保存时离开会提示 |
| 安全 | 改管理员口令、查看暴露面 |
| 接入示例 | 当前对外地址生成的 cURL / Python / Node / 环境变量示例 |

错误会按 HTTP 状态给出可执行的下一步（如 503 → "去启动上游"、413 → "调整上限"），而不是只丢一个原始报文。

改「监听地址、端口、最大并发」需要重启；页面会提示并给出「重启服务」（依赖启动器的退出码 75 循环）。

## 配置项（config.json）

| 键 | 说明 |
|---|---|
| `server.host` / `server.port` | 监听地址与端口（默认 `0.0.0.0:18080`） |
| `server.public_base_url` | 写进接入示例的对外地址 |
| `upstream.base` | 上游地址，默认 `http://127.0.0.1:9880` |
| `upstream.api_host` / `api_port` / `config_path` | 「上游启动」用的参数 |
| `upstream.timeout_seconds` | 单次合成超时（默认 600） |
| `auth.admin_password_hash` | `pbkdf2_sha256$…` |
| `auth.session_hours` | 会话时长（默认 12） |
| `keys[]` | 客户端密钥：`id/name/key/enabled/uses/last_used_at` |
| `defaults.voice` / `response_format` / `speed` | 缺省合成参数 |
| `limits.max_input_chars` / `max_concurrent` | 单条上限与并发上限 |
| `voices{}` | 音色表（`ref_audio` / `ref_text` / 权重相对路径） |

## 边界（诚实声明）

- **不做流式**：上游分块会在本服务被收齐后整段返回。`/v1/audio/speech` 的语义就是"完整音频"；
  Provider 侧流式 PCM 是独立任务（见 `D:\11\Logs\2026-10-27-tts-streaming-pcm-可行性判定.md`）。
- **明文 HTTP**：只用于可信局域网，不要直接映射到公网。
- 密钥明文存在 `config.json`：能读该文件就能冒充客户端；装机和备份时按凭据对待。
- 请求记录不保存文本，只有字符数；诊断 WAV 不落盘（界面试听走浏览器内存）。

## 排障

| 现象 | 检查 |
|---|---|
| 全部 401 | 密钥是否被停用/删除；是否带 `Bearer ` 前缀 |
| 全部 503 | `/healthz` 的 `upstream_alive`；上游进程是否在跑（`9880` 是否监听） |
| 502 | 上游返回非 200，看「上游进程 → 日志尾部」 |
| 界面打不开 | 端口是否放行、服务是否以 `0.0.0.0` 启动 |
| 语言读错 | 音色是否 `auto_text_lang=false` 且 `text_lang` 不匹配 |
