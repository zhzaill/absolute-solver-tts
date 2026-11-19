# 分段语音协议 v1

一句话：**网关只定义一次协议，客户端各自适配；不为某个客户端造业务接口。**

Coo 的气泡、轮次、打断、播放队列是 Coo 的事；网关只知道「文本进、按句的音频出」。这条边界一旦破，网关就会长出一个 Coo 的反向依赖。

## 传输

```
POST /v1/audio/segments
Authorization: Bearer <key>
Content-Type: application/json

{ "input": "...", "voice": "xxx_trained",
  "first_steps": 4,  "first_speed": 1.067,
  "later_steps": 16, "speed": 0.97,
  "first_early_cut": 11, "unit_max_chars": 120 }
```

响应：`Content-Type: application/x-tts-segments`。HTTP/1.1 可使用 `Transfer-Encoding: chunked`；HTTP 传输块边界与下述协议帧边界无关。

首部行：`x-tts-engine: pipeline`、`x-tts-units: <段数>`、`x-tts-voice`、`x-request-id`。

## 帧

每帧 = `4 字节小端无符号长度` + `1 字节类型` + `载荷`。长度只计载荷字节，不含长度字段与类型字节。

| 类型 | 载荷 | 说明 |
| --- | --- | --- |
| 0 | UTF-8 JSON | 元数据。`kind` 取 `plan` / `segment` / `done` |
| 1 | 完整 WAV | 一段音频；16 位 PCM，采样率按段自述 |

顺序固定：`plan` → （`segment` → 音频）× N → `done`。段号从 0 起，`meta.index` 与到达顺序一致。

### `plan`

| 字段 | 含义 |
| --- | --- |
| `units` | 切好的句子数组（上游原样，客户端可用来做字幕） |
| `count` | 段数 |

### `segment`

| 字段 | 含义 |
| --- | --- |
| `index` | 段号 |
| `text` | 本段文本 |
| `chars` | 字数 |
| `status` | `ok` / `failed` |
| `lead_ms` | 裁掉的前导静音毫秒；不代表请求到首声的延迟 |
| `audio_seconds` | 本段时长 |
| `rate` | 采样率 |
| `upstream_ms` / `first_byte_ms` | 上游耗时 / 首字节耗时 |
| `rtf` | `(upstream_ms / 1000) / audio_seconds`，无量纲；音频时长为零时为 `null` |
| `error` | 失败原因（`status=failed` 时） |

`status=failed` 时**仍然跟一帧音频**（40 ms 静音）。这是活性约定：客户端可以按序号接续，不会因为缺一段而永久停住。

### `done`

`segments`（实际交付段数）、`upstream_ms`（累计）。

## 客户端义务

1. 收到音频帧就**立刻**排队播放；不要等 `done`。
2. 按 `index` 排序；乱序或重复要能去重。
3. 关闭连接即视为取消：服务端会在下一段合成前停止。
4. 没见过的 `kind` 与未知字段一律忽略（前向兼容）。

## 服务端义务

1. 首段用首句参数（更短、更快），后续段用正常参数。
2. 每段裁掉模型生成的前导静音，且 `lead_ms` 如实上报。
3. 单段失败不中断整条流。
4. 客户端断开后，不再为它合成后续段。

## 演进

- 加字段：只加不改，客户端忽略未知字段即可。
- 保留现有 `kind` 的字段语义。可并存的新语义用新 `kind`；仅在已知 `kind` 上加 `v` 字段，旧客户端仍会按原语义解析。
- 需要别的形态（SSE、multipart、整段 WAV）时，在**同一条管线**外面套适配层，不复制切句与裁剪逻辑。整段 WAV 已经就是这样一个适配层：`/v1/audio/speech`。

## 不该放进协议的

| 概念 | 该在哪 |
| --- | --- |
| 气泡 / 轮次 / 气泡 id | Coo 侧 World |
| 打断与丢弃旧轮 | Coo 侧 World（关连接 + 本地 epoch） |
| 播放队列、音量、设备 | 客户端播放器 |
| 「谁在说话」的人格与情绪 | Persona，或将来的 `instruction` 字段 |

## 现状

- 服务端：`gateway/stream_pipeline.py` + `gateway/gateway.py`（v3.0.0，已部署）
- 客户端：`coo/cortico-world-tts-stream`（JS，含 `stream_client.js` 可直接复用）
- 参考探针：`coo/tools/stream-smoke.mjs`（Node）、`C:\Windows\Temp\tts-probe\probe_segments.py`（Python）
