# dsh-tts

DeepSeek Harness 插件：**给 Agent 一副嗓子。**

> 本插件的 OpenAI 兼容 TTS 客户端契约、语言处理、同源媒体交付和验证方法来自
> [Code-Amadeus/Amadeus](https://github.com/Code-Amadeus/Amadeus) 的开源工作，特此致谢。
> 本仓库包含其衍生代码，整体按 AGPL-3.0 发布。

它把 [Amadeus](https://github.com/Code-Amadeus/Amadeus) 的 OpenAI 兼容 TTS 客户端契约抽出来，做成一个独立的 npm bundle。默认配置面向 GPT-SoVITS 网关，但连接层也支持任意 OpenAI 兼容或自定义 speech/health 端点，并提供一个**专门的对话型 agent 预设**——中文作答，每次回应都合成成语音，附同源播放地址。

---

## 它解决的是什么问题

不是"缺一个 TTS 客户端"。Amadeus 已经有一个很完整的（`tts/backends/openai_compatible.py`）。真正要解决的是**那个客户端在三处丢失了信息**，而其中第一处直接导致过整句话被说错：

### 一、OpenAI 的语音协议装不下语言

`POST /v1/audio/speech` 的请求体只有 `model / input / voice / response_format / speed`——**没有"文本是什么语言"这个字段**。而 GPT-SoVITS 这类引擎的前端（G2P）是由语言决定的：中文前端只有汉字与中文标点的字符表，**没有假名条目**。

于是当日文文本被送进一个默认语言为 `zh` 的网关时：

| 渲染 | 配置 | ASR 往返听到了什么 |
|---|---|---|
| A | `text_lang=zh` | `今日无事，完了。` |
| B | `text_lang=ja` + `prompt_lang=zh` | `今日のデプロイは無事に完了したわ。` |

原文是 `今日のデプロイは無事に完了したわ。`（17 字）。A 把假名全部丢掉、把汉字用中文读音念了出来，`デプロイ`（deploy）整个消失——**不是音频损坏，是说了一句完全不同的中文**。而且它听起来完全健康：三种渲染的 zcr、频谱平坦度、周期性几乎重合，任何只看波形的指标都会给它满分。

本插件的处理：**显式声明语言。** 请求体里照样带上 `text_lang`（以及参考音频语言的 `prompt_lang`），尽管 OpenAI 协议没有定义这两个字段——理解的网关会用，不理解的网关忽略未知键。**声明的成本是零，却消掉了一整类故障。** 调用方没给语言时才从字形推断，并且把"推断的"这件事**写进工具返回值**，让猜错可见而不静默。

### 二、浏览器跨源取不到音频

网关在 `127.0.0.1:18080`，Harness 的 Web 源在别处。浏览器的跨源请求会被拦，https 页面还会把它当成混合内容。所以音频必须**由 Harness 自己的源重新提供**——这就是 `dsh-comfyui` 里那个 "same-origin media proxy" 的同一件事。

本插件的处理：起一条 `GET /dsh-tts/audio?id=<key>` 路由，按内容哈希从内存里取音频回吐。`tts_speak` 的 `presentationMeta` 把同源路径交给 DSH 工具卡，工具卡直接渲染原生播放器。

### 三、"说错了"与"说不出来"长得一样

一次合成的失败方式有两种：拿不到音频（可见），或者拿到了音频但内容是错的（不可见）。第二种更危险，因为它会被当成成功。

本插件的处理：`tts_status` 工具把**生效配置 + 上游可达性**暴露给模型，`tts_speak` 的返回值里带上**实际使用的语言与它的来源**（`explicit` / `inferred` / `configured`）。

---

## 内容

```
dsh-tts/
├── package.json          dsh.bundle.patch 指向补丁
├── cordis.patch.yml      插入 preset-chat-voice 声明（唯一补丁）
├── lib/
│   ├── index.js          插件入口：name / inject / apply / createRuntime / resolveConfig
│   ├── lang.js           语言归一、字形检测、语言决策（含优先级与理由）
│   ├── tts.js            OpenAI 兼容 TTS 客户端（buffered WAV + SSE 流式）
│   ├── store.js          同源音频的内存 LRU 与内容哈希键
│   ├── routes.js         同源路由 /dsh-tts/audio 与 /dsh-tts/status
│   └── tools.js          模型可见工具 tts_speak / tts_status
└── tools/selftest.mjs    独立自检（不需要 cordis 上下文）
```

**零运行时依赖**，只用 Node 22 内置的 `fetch` 与 `node:crypto`。

---

## 两个工具

### `tts_speak`

| 参数 | 必填 | 说明 |
|---|---|---|
| `text` | ✅ | 要朗读的正文 |
| `voice` | | 端点上的音色 id，省略用配置默认 |
| `language` | | `zh` / `ja` / `en` / `ko` / `yue` / `auto`，省略则从文本推断 |
| `speed` | | 0.25–4.0，默认 1.0 |

返回同源播放地址、字节数、时长、采样率、**实际使用的语言与其来源**。

### `tts_status`

返回生效的端点、模型、音色、默认语言、是否配了 API key、上游是否可达、缓存条目数。**语音失败或听起来不对时，先看它，再决定是否重试。**

---

## 终端前端

不想开浏览器、不想新建会话时，直接命令行驱动同一条中继：

```powershell
node bin/tts.mjs --status                  # 端点配置与上游可达性
node bin/tts.mjs --check                   # 中继检查：合成 + ASR 往返内容保真
node bin/tts.mjs "今天天气不错。"            # 合成到文件，打印路径
node bin/tts.mjs "今天天气不错。" --play     # 合成并播放
node bin/tts.mjs "..." --voice local_voice # 指定音色
node bin/tts.mjs "..." --language ja       # 显式声明语言
```

> **上面那些 `#` 注释是 PowerShell 语法。** 在 **cmd** 里 `#` 不是注释——那一整段
> 会被当作额外实参传进来，于是**注释被念出来**（`#` 本身还会作为覆盖外字符被静默丢掉，
> 和假名是同一类失效）。
>
> 本 CLI 现在会**拒绝**多于一个的位置参数并说明原因，而不是猜。所以在 cmd 里别带行内注释；
> 要写注释就用 `::` 或 `REM`，或者干脆把命令单独放一行。

### 路径要加引号，且不要写成尖括号

```powershell
tts --verify "C:\Users\me\AppData\Local\dsh-tts\out\zh-abc123.wav" --expect "今天天气不错。"
```

`<某个.wav>` 这种占位符写法在 cmd 和 PowerShell 里都**不可用**：`<` `>` 是**重定向操作符**，
所以 `tts --verify <某个.wav>` 会被 shell 解释成"从该文件读标准输入"，
报 `The system cannot find the file specified.`——**而 node 根本不会被启动**。
这是文档惯例在 Windows shell 里的陷阱，不是工具的问题。

`bin/tts.cmd` 是同一入口的 Windows 包装；执行过 `npm link` 之后，直接敲 `tts "..."` 即可（见下）。

### 让它变成一条命令

在仓库的 `plugin/` 目录执行：

```powershell
npm link
```

`npm link` 会把 `package.json` 的 `bin.tts` 装进 Node 的用户级 bin 目录。确认该目录在 `PATH` 中后，可在任意目录运行：

```powershell
tts --check
tts "今天天气不错。" --play
```

不 link 也能用，只是要写全路径：`node <repo>\plugin\bin\tts.mjs ...`。

输出默认落在 `%LOCALAPPDATA%\dsh-tts\out`，**不落在当前目录**——否则在 `C:\` 下跑一次就会生成 `C:\tts-out`。

### `--check` 才是重点

一条中继坏起来有两种样子：**什么都拿不到**（看得见），或者**拿到了音频但说的不是那句话**（看不见）。第二种花了我们整整一天——所以 `--check` 不满足于"有音频回来"，它**把自己的输出送去转写，再与输入比对**：

```
  lang   dur     rate    bytes      ASR round-trip
  zh     3.28s   32000   209964     MATCH
  ja     3.30s   32000   211244     MATCH
```

失败时它会用 JSON 转义打印两侧文本——**ASCII 安全，且逐字节完整**，所以差异可诊断，而不是只能被告知"不一致"。

### 关于可复现性（一个实测结论）

GPT-SoVITS 这类引擎是**采样**的：同一个 seed 默认是 `-1`（随机）。所以 `--check` 默认固定 `seed 20261016`，否则两次运行的音频不同，**你分不清是回归还是又一次随机抽样**。

但固定 seed 之后的精确行为值得说清（实测同一 seed 跑两次）：

| 项 | 结果 |
|---|---|
| 字节数 | **完全相同** |
| WAV 头 | **逐字节相同** |
| 采样点数 | **相同** |
| 最大偏差 | **1 LSB** |
| 逐样本相同率 | **99.97%** |

也就是说：**固定 seed 让中继检查在"判定"上可复现，而不是在"字节"上**——差异来自 GPU 声码器浮点归约顺序，量化为 16 位最低位。

**所以这个引擎的检查必须比对内容，不能比对哈希。** 一个字节哈希断言会永远红着，然后被人加 `--force` 忽略掉。

### 远端服务

远程部署只需要三个逻辑端点：

| 端口 | 作用 |
|---|---|
| 9880 | GPT-SoVITS 上游 `api_v2.py` |
| 18080 | OpenAI 兼容网关 |
| 9881 | 可选 ASR，用于 `--check` 内容往返 |

网关和上游都应绑定回环地址。跨机器访问使用 SSH 转发，不要暴露明文密码。
仓库根目录的 `scripts/start-tunnel.ps1` 是通用入口。

---

## 预设：对话·有声

`cordis.patch.yml` 插入一个 agent 预设（`id: chat-voice`）。它**只包含对话需要的东西**——人设、指令、`dsh-tts`、提问、Web、present、**以及压缩**——**没有文件编辑、没有 Shell、没有待办清单**。

两处省略和一处包含，都值得单独说：

**省略 Shell 与文件工具。** 这个预设是用来交谈的。每一个它不需要的工具，都是模型可能浪费掉的一个回合。人设里也明说"你不能执行命令、改文件或跑工作流"，做不到就直说，并建议换用带完整编码能力的预设——**一个只有对话能力的 agent，最有价值的品质是承认自己没有别的能力。**

**省略待办清单。** 对话没有任务清单要维护。这一条是我在复核时**自己删掉的**：我先前把它放进去了，而它恰恰违背了我上面刚写下的那句原则。原则要么执行，要么不写。

**包含压缩，而且它不是可选项。** 编码任务会结束，对话不会；没有压缩，长对话必然撑爆上下文窗口。所以它被挂成一个 `cordis:group`（带 `isolate: { compaction: true, toolResultPruner: true }`），而不是一行普通声明。

**这份预设逐项对照过出货预设。** 出货的三套预设（`standard` / `ptc` / `minimal`）与一份 `cordis` 就在 Harness 归档里，`@deepseek-ai/dsh-web-app/presets/`。对照结果：

- 上面那个压缩组与出货版本**逐字一致**——同样的 `isolate` 标志、同样三个子插件、同样的 pruner 参数。
- `persona` 的配置方式与 `standard` 一致（只给 `prefix` + `suffix`）。`complete` 默认 `false`、`includeRuntimeContext` 默认 `true`，二者都沿用默认。**并且 `dsh-persona` 是"shadowing the deployment default"——它取代默认人设而不是附加**，所以"你不能执行命令"这条不会与某个默认的"编码 Agent"提示冲突。
- `order` 在出货预设里是 1/2/3/4，本预设取 **5**，排在它们之后。

人设里还有一条设计约束值得单独说：
> **你写出来的每个字都可能被读出来。** 所以用短句、口语；不要用 Markdown 表格、代码块、嵌套列表——它们读出来是噪音；不要输出 URL、路径、哈希、日志片段。

这是一条**由输出通道反推出来的写作规则**：文本要被朗读时，"好看"和"好听"是冲突的。Amadeus 也有同源的一条（它的日文提示词要求"回复开头必须是能立刻朗读的短句"）。同理，人设要求长回复**拆成多次 `tts_speak` 调用**，每段一两句，而不是一次塞一整篇。

预设还明说：**你不能执行命令、改文件或跑工作流。** 做不到的事直说，并建议换用带完整编码能力的预设——一个只有对话能力的 agent 最有价值的品质是承认自己没有别的能力。

---

## 安装

优先使用 DSH 自带的插件管理器。没有可用的管理器时，从仓库根目录运行：

```powershell
.\scripts\install-plugin.ps1 `
  -ProfileDirectory "$env:USERPROFILE\.dsh\profiles\desktop"
```

重启后在**新建会话**时选预设 **对话·有声**。会话一旦产出内容便无法中途切换预设。

## 卸载

```powershell
.\scripts\uninstall-plugin.ps1 `
  -ProfileDirectory "$env:USERPROFILE\.dsh\profiles\desktop"
```

重启后预设与工具一并消失。

---

## 配置

在预设的 `config` 里给，或经环境变量覆盖（环境变量优先顺序低于补丁内的显式配置）：

| 配置键 | 环境变量 | 默认 |
|---|---|---|
| `baseUrl` | `DSH_TTS_BASE_URL` | `http://127.0.0.1:18080/v1` |
| `publicBaseUrl` | `DSH_TTS_PUBLIC_BASE_URL` | `http://127.0.0.1:19387` |
| `speechUrl` | `DSH_TTS_SPEECH_URL` | 空，按 `baseUrl` 推导 |
| `healthUrl` | `DSH_TTS_HEALTH_URL` | 空，自动探测 |
| `model` | `DSH_TTS_MODEL` | `tts-1` |
| `voice` | `DSH_TTS_VOICE` | `local_voice` |
| `language` | `DSH_TTS_LANGUAGE` | `zh` |
| `promptLanguage` | `DSH_TTS_PROMPT_LANGUAGE` | `zh`（参考音频的语言） |
| `apiKey` | `DSH_TTS_API_KEY` | 空 |
| `authHeader` | `DSH_TTS_AUTH_HEADER` | `Authorization` |
| `authScheme` | `DSH_TTS_AUTH_SCHEME` | `Bearer`，置空表示裸 key |
| `extraHeaders` | `DSH_TTS_EXTRA_HEADERS` | `{}` 或 JSON |
| `extraBody` | `DSH_TTS_EXTRA_BODY` | `{}` 或 JSON |
| `timeoutMs` | `DSH_TTS_TIMEOUT_MS` | `120000` |
| `cacheEntries` | `DSH_TTS_CACHE_ENTRIES` | `32` |

`promptLanguage` 是**参考音频**的语言，与要合成的文本语言是两个独立的轴。中文参考 + 日文文本 = 用那把嗓子说日文，这是正确的跨语种配对，不是矛盾。

连接层支持 origin、`/v1` API 根、反向代理子路径和完整 speech URL。路由不符合
OpenAI 约定时设置 `speechUrl`；健康检查路径不同则设置 `healthUrl`。认证头可通过
`authHeader`/`authScheme` 改为 `api-key` 或裸 token。状态接口只报告连接元数据，
不会回显 key，也不会输出未遮蔽的敏感查询参数。

也可以在 `config` 内使用 `connection` 分组承载这些字段；顶层的 `baseUrl` 等旧写法继续有效。
`gatewayUrl` 是 `baseUrl` 的兼容别名。

---

## 自检

不需要 cordis 上下文，直接跑：

```powershell
node tools/selftest.mjs
node tools/verify-connection.mjs
```

它检查语言归一、字形检测、决策优先级（含"中文文本不该被默认语言带走"）、端点拼接、LRU 与键稳定性，并**真的打一次网关**验证能拿到合法 WAV、以及载荷里确实带了 `text_lang`。

---

## 已知边界

- **浏览器播放需要一次点击或允许自动播放。** `tts_speak` 工具卡通过 `tool.call.toolview` 渲染原生 `<audio>`，按到达顺序串行播放多段语音，浏览器拦截自动播放时保留控件供用户点击。
- **SSE 流式已实现但未启用。** `TTSClient.synthesizeStream` 完整实现了 `speech.audio.delta` / `speech.audio.done` / `[DONE]` 协议并保留 Amadeus 的 80 ms 分块规则，但当前后端网关只提供 buffered WAV，所以工具走的是 buffered 路径。网关侧支持 SSE 后即可切换。
- **SSE 采样率是硬编码的 24 kHz**（`OPENAI_PCM_SAMPLE_RATE`），因为协议里没有采样率字段。GPT-SoVITS 常见输出为 **32 kHz**——实现 SSE 端点时必须重采样到 24 kHz，否则播放会变速变调。
- **语言推断在纯汉字文本上会判成 `zh`。** `今日無事完了` 没有假名，字形上就是汉字。这是字形检测的原理性边界，不是缺陷；需要时由调用方显式给 `language`。
- **不同 DSH 版本可能改变 bundle 加载机制。** 插件包结构和离线契约已测试；实际装载后仍应以新会话中工具是否可见为准。
