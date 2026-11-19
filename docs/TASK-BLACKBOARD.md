# TTS 黑板：公共协议和 MicroDuck 播放

2026-11-19 · 以 [分段语音协议 v1](segment-protocol.md) 为唯一公共契约。World 将可朗读文本一次提交给 `/v1/audio/segments`；网关统一切句、合成和裁剪，按协议交付各段的完整 WAV。`/v1/audio/speech` 是同一管线的整段 WAV 适配。气泡、工具、配置、归档事件及轮次取消留在 World；设备、音量、排队留在播放器。旧方案不再用于实施。

## MicroDuck 板端约定（待实现）

主机从客户端收到 WAV 后交给独立播放适配；主机和板端只通过已认证的 SSH 会话传送音频与回执。现有 [单文件验收](microduck-acceptance.md) 可以先确认设备和声源。

| 项目 | 最小约定 |
| --- | --- |
| 主机 → 板端 stdin | 一条会话可发多段。每段是 `uint32_le(n) + n 字节完整 PCM WAV`，没有 HTTP 元数据或类型字节。`n` 只计 WAV 字节，且 `1 ≤ n ≤ 8 MiB`。板端读满并校验格式后才交给 `aplay`。设备在会话启动时选定。 |
| 板端 → 主机 stdout | 每个完整段返回一行 UTF-8 JSON。`seq` 从 0 起，按连接递增；`bytes`、`sha256` 由板端对收到的 WAV 计算；`alsa_exit_code` 只有实际运行并退出时才是整数，否则为 `null`。成功须 `ok: true` 且退出码为 0；失败返回 `ok: false` 和 `error`。诊断走 stderr。 |
| 生命周期 | 段边界 EOF 正常结束；半帧 EOF、越界长度或断连使本次会话失败。主机按顺序核对回执与发送记录；超时或丢回执记为播放结果未知，不自动重播。主机约束待播量、负责取消与丢弃；关闭会话后在播段能否立即停，留真机验证。 |

网关的 `status=failed` 占位静音由主机识别并记录为合成失败，不当作鸭身出声证据。`aplay` 成功回执只能证明文件已交给指定设备，扬声器首声和段间连贯性以现场听辨或录音为准。

## 验收状态

- `1b15281` 的 World 测试已复跑，6/6；其中 2 项用假事件库和假网关验证气泡到排队，以及替换轮次后旧段不再入队。
- **板端约定已实现**：`scripts/duck_player.py`（板端，读帧 → 校验 → aplay → 回执）与 `scripts/duck_relay.py`（主机端，送源码 + 送帧 + 核对回执）。9 项协议测试全过：连续两段、逐字节跨读边界、0 长度帧、半帧、非 16 位 PCM、播放器非零退出、段边界 EOF、主机端拒绝发送坏帧。
- **真实音频上的链路冒烟**：`scripts/duck-smoke.py` 走真网关合成 3 段 → 主机端适配 → 假板子，3/3 回执的字节数与 SHA-256 与发送记录一致，每段一次 aplay，首段交付 1.39 s。
- **真实 Coo 气泡已验收（本机出声）**：2026-11-19 14:06，向桌宠发一句 `用一句话跟我打个招呼`，`desktop-pet.message` 落在 14:06:18.533；Coo 的 `pet_say` 产生两条 `desktop-pet.self` say，`worlds.tts-stream` 记下两次「一段说完」。段文件落盘时间：第一轮 14:06:22 / :23 / :24，第二轮 14:06:30 / :31 / :32 / :33 —— **段与段之间约 1 秒**，说明后段是在前段播放时合成的。现场人格自己表述为「3 段，第一段 0.91 秒就出声了，总共不到 3 秒，中间没断」。
- World 已接入鸭身：`duckEnabled` / `duckTarget` / `duckDevice`，帧写入有集成测试（假适配进程验 2 段）。
- 板端待做：在真机核对 ALSA 设备、接口速率与出声；鸭子 192.168.67.200 目前不在线（ping 与 22 端口都不通）。

## 历史方案（已被 v1 取代）

2026-11-19 · 设计待评审。首轮优化的是「多久开口」，并以 Cortico 的现有音色完成 MicroDuck 扬声器验收。

## 1. 路线

~~~text
Cortico/Coo 产生文本
  → 首个语义完整、已稳定的短句提交给 TTS
  → POST /v1/audio/speech → 自有主机 GPT-SoVITS v2Pro → 完整 PCM WAV
  → tts.voice + 音频附件 → 首段进入播放队列 → 本机或 MicroDuck
                           ↳ 首段播放时，TTS 继续合成后续句子
~~~

**流的是句子和播放队列；每次 HTTP 响应仍是一份完整 WAV。** 沿用用户选择的音色、参考资料和已加载的权重。MicroDuck 负责播放；不在鸭身安装推理服务。现行整段 WAV 路径保留为回退选项。已核：这里的"句子"来自**同一条完整气泡的按句切分**，不是流式文本（见 §5.1）。

## 2. 从哪里改

| 环节 | 第一版做法 |
| --- | --- |
| Cortico/Coo | **已核：没有流式文本入口。** `pet_say(script)` 在工具调用完成时一次性发出整条气泡（Coo `world.ts:1940-1951` 同时 `sendPet` 与 `record`），世界侧只有只读事件库，没有订阅、也没有工具参数流回调。所以"首句"只能从这条**已完整**的文本里按句切分，首段先合成；不存在"模型说到第二句时第一句已经稳定"这种更早的点。详见 §5。 |
| 请求与推理 | 保留 OpenAI 兼容请求、认证和完整 WAV 响应；每段沿用同一个音色。推理预热后保持单并发，先做首段，限制后段排队长度。错误、截断和静音要按失败记录；真实测速前确认部署网关已更新静音拒绝修复。 |
| 事件与队列 | 复用 **tts.voice + 附件**；由生产端或适配层给出可验证的轮次和顺序。建议元数据为 **turn_id、segment_index、clip_id**，另给明确的轮次结束或取消信号，字段形态以 Coo 实际扩展点为准。按轮次和序号去重，依序播；缺段或合成失败要有明确失败结果。打断时丢弃旧轮次待播段和晚到结果；能否拦停已在 MicroDuck 播的段，另测。 |
| MicroDuck 适配 | 先用现有校验脚本验证 WAV、SHA-256、ALSA 设备及回执，再测多段连续播放。记录取附件、板端收齐和 ALSA 写入的耗时。若每段单开 SSH 或播放器造成明显断档，先复用连接或播放器；预置叫声的 **robot.sound** 继续走现有路径。 |

目前 Coo 原生链是 **tts → tts.voice → audio-play**；Solver Host 另有新附件投影。切句和首句提交应靠近 Coo 的文本生产端，播放器只消费已经生成的音频。现有投影、单文件验收脚本和目标播放队列是三个不同层次。若走跨主机许可路径，还需验证分段请求的授权范围，不能默认一段的许可可供其它段复用。

## 3. 验收怎么测

1. **软件基线**：先从真实 Cortico 对话拿到新 **tts.voice** 和附件，确认音色与文本正确，格式可解码，非静音。控制台试听只用于排查合成链；真机不在手边时保留附件与摘要。
2. **热机 A/B**：同一 P104、权重、音色、文本和合成参数，交替跑「整段 WAV」与「首句先播、后句续播」。用同一批中文、日文和混合文本，包含短句和多句长回复。先关闭首句缓存，预热与冷启动分开记；再单列缓存命中和未命中。记录成功率、显存、合成耗时与 RTF（合成耗时 ÷ 成品音频时长）。
3. **首声和连贯性**：同一计时端分别记录「用户提交 → 首声」与「首句文本稳定 → 首声」，另记请求发出、WAV 收齐、解码和段间空隙。报告中位数和 P95，并保留逐轮记录。首个有声采样可用短窗 RMS 粗定位并人工复核；本地估算可用「WAV 收齐时间 + 有声采样偏移」，要单独注明解码、排队和设备延迟未计入。WAV 头、HTTP 首包、提交 ALSA 均不能充当扬声器首声。
4. **验收目标**：热机、缓存关闭时，短首句从文本稳定到本地可听首声以 **1.5–2 秒**为目标；同时检查首字、段间断档、重复、失序与取消后的晚到段。先量本项目的前导静音；确有收益再试保留起音余量的裁剪，并用听辨检查不削首字。真机回来后按验收手册核对语音内容、板端摘要、ALSA 设备和播放回执；由现场听辨或录音确认鸭身出声和多段连贯性。

回退顺序：首句方案若明显改善首声且听感达标，保留完整 WAV 接口；若长段合成或逐段交付仍无法满足目标，再单独评估真正的 PCM 分块协议。部署和真机验收都还没有完成。

## 4. 决策依据

- Amadeus 0.16.1 的 10 轮麦克风实测中，识别文本就绪到首声标记的中位数为 **1.62 秒**，4/10 命中首句缓存。0.15.2 的 **0.33 秒**为 RTX 4070 Ti SUPER 上文本已就绪、裁掉前导静音后的单句个案，不能当作 P104 的目标成绩。
- P104 + v2Pro 历史热机 RTF 约 **0.44–0.56**。近期 CPU 样本耗时 **26.3 秒 / 5.82 秒音频**；最近 GPU 测试受显存不足影响，没有有效成绩。先在 GPU 有资源时重建基线。
- 历史流式探测中，直连 966 ms 首包只有 44 字节 WAV 头；经网关首包约 3.22 秒，几乎与整体完成同时。先用有效音频验证提速。

相关资料：[本地 GPT TTS v1](local-gpt-tts.md) · [MicroDuck 验收手册](microduck-acceptance.md) · [TTS 历史](history.md) · [Amadeus 0.16.1 验收](D:/11/Repos/Amadeus/docs/alpha-0.16.1-acceptance.md) · [Amadeus 0.15.2 首声实验](D:/11/Repos/Amadeus/docs/alpha-0.15.2.md) · [流式探测记录](D:/11/Logs/2026-10-27-tts-streaming-pcm-可行性判定.md)

## 5. 只读核查：文本入口与各层现状（2026-11-19）

本轮只读代码与配置，未改任何实现、未起推理、未连真机。安装位置 `D:\11\Tools\coo`（Coopanion 0.2.21，Cortico API 6），核心源码在 `resources\app\build\cortico\src`，扩展在 `data\extensions\node_modules\.pnpm\*`。

### 5.1 稳定文本点在哪

- Coo 的 `pet_say(script)` 是**一次性**的：`parseScript` 按 `【表情,动作】` 阻塞标记切出 beats，然后同时 `server.sendPet({t:'say',id,beats})` 和 `record({kind:'say',beats})`（`cortico-world-desktop-pet\src\world.ts:1940-1951`）。
- beats 的切分依据是**换气泡**，不是句号（`src\script.ts:77-113`）；工具描述建议"每个气泡一两句"（`src\tools.ts:23`）。
- 世界侧没有流式文本钩子：`WorldHost` 只提供 `store`（只读 `EventStoreReader`：get / latestCursor / range / around / grep）、`pushEvent` / `pushDeferred` / `pushCandidate`、`blob`、`log`（`build\cortico\src\core\types.ts:687-749`）。没有订阅接口，核心也还没有"工具参数流式执行"这一层。

**结论**：能拿到的最早文本就是**一条完整气泡**。切句必须发生在 TTS 世界内部，按句末标点切；不要按"模型还没说完"来设计等待预算。

### 5.2 TTS 世界现在怎么取文本、怎么合成

| 位置 | 事实 |
| --- | --- |
| `cortico-world-tts\src\world.js:105` | 轮询间隔默认 **1500 ms**；`definition.js:41-48` 的 `create()` 没传 `scanMs`，所以恒为 1500。 |
| `world.js:516-534` `#scanPet` | 每轮从游标读事件，只认 `desktop-pet.self`。 |
| `world.js:537-548` `#lineOf` | 把 beats 用 `'。 '` 拼成一行 → `speakable()`（去 URL/emoji/markdown，截 600 字）。 |
| `world.js:550-584` `#submitAuto` | **整行作为一个 prep** 入队，一次请求合成全部。 |
| `world.js:401-406` `#enqueueJob` | 串行队列：同一时刻只有一个合成任务。 |
| `world.js:308-324` `#request` | 一次完整 WAV 请求（`/v1/audio/speech` 或 dashscope）。 |
| `world.js:408-453` `#pushVoice` | `tts.voice` 事件 + `blobs[0].bytes`；`meta` 是自由字段（origin/requestId/text/voice/model/format/seconds/mime/path/itemId/note）。 |

### 5.3 播放端现状

- **本机** `cortico-world-audio-play@0.4.0` 已订阅 `tts.voice`（`src\config.js:20`），每 **1000 ms** 扫一次（`src\world.js:137`），串行队列、带 id、可 `skip` / `remove` / `clear`（`world.js:347-376`）。它只认 `blobs[].handle` 或 `meta.path`（`world.js:318-326`），**不读 meta 其它字段** ⇒ 加 `turnId`/`segmentIndex` 不会误伤它，也不需要它改。没有"轮次"概念，也没有基于 meta 的去重。
- **MicroDuck 世界不播音频**：`cortico-world-microduck` 只有 `md_observe` / `md_health` / `md_act` / `md_log` 四个工具（`tools\coo-world-microduck\src\world.js:56-109`、`381-391`），**不订阅 `tts.voice`**。鸭身出声目前只有手工脚本 `scripts/play-microduck.py`（单文件、一次 SSH、板端 aplay）。

⇒ 黑板第 2 节"MicroDuck 适配"里真正的空白是**订阅者本身还不存在**，不是延迟。

### 5.4 延迟账（按现行代码，热机）

~~~text
文本完整（pet_say 执行，同时落事件）
  + 0–1500 ms   TTS 轮询
  + 整段合成    （历史 22 条 api 气泡：15–47 字、音频均值 4.16 s、最长 9 s；P104 RTF 0.44–0.56 ⇒ 约 2–5 s）
  + 0–1000 ms   播放端轮询
  + 解码 / 设备启动
~~~

切句只改第三项。两处轮询的期望值合计约 **1.25 s**、最坏 2.5 s，比切句更便宜且与切句正交。**先降轮询，再切句。**

### 5.5 具体落点（仍未动代码）

1. `cortico-world-tts\src\world.js`：`#scanMs` 默认改小（或在 `definition.js` 的 `create` 里传 `opts.scanMs`），1500 → 200 量级。
2. 同文件新增切句：`#lineOf` 之后按 `。！？!?…；;` 与换行切段，合并过短段（< 6 字），限制最长段（建议 24–32 字，约 4–7 s 音频）；首段只取一句。
3. `#submitAuto` / `#pushVoice`：给每段 `turnId`（取触发事件的 cursor）、`segmentIndex`、`clipId`，写进 meta。Core 与播放端都不用改。
4. 顺序与失败：`#enqueueJob` 已串行 ⇒ 落库顺序即段序，播放端按游标天然有序；失败按段发 `tts.voice-failed`，带同一组 `turnId`/`segmentIndex`。
5. 鸭身：新增订阅 `tts.voice` 的播放器（World 或主机进程），按 `turnId` + `segmentIndex` 排序、按 SHA-256 校验、板端 aplay；复用已验收的 SSH 通道，避免每段新开连接。

### 5.6 风险与待定

- 逐段独立请求会丢跨句韵律与句尾语气，同音色同参数下仍需人耳确认断档和重音。
- 后段排队要有上限，否则长回复把串行队列压满，播放端反而断续。
- `worlds.tts.baseUrl` 现在是 `http://127.0.0.1:18080`（本机网关），服务器在 166；多一跳链路的首包延迟要实测，不能拿直连数字外推。
- 打断：播放端只有 skip/clear，没有"按轮次取消"。分段后需支持按 `turnId` 清队列，否则旧段会念完。
- 若要真正"文本流式"，需要在 Coo 核心加流式文本钩子；那已越出本方案范围。
