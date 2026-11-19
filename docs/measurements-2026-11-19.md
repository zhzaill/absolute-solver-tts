# 首声测量：CPU vs GPU，上游流式（2026-11-19）

同一台服务器（DESKTOP-6PVSJFV，P104-100 8 GB）、同一套权重（v2Pro `xxx-e15.ckpt` / `xxx_e8_s208.pth`）、同一参考音频（`refs/furina/furina_normal.wav`）、同一段文本，只改上游实例的 device。

探针：`C:\Windows\Temp\tts-probe\probe_stream.py`，直连 `127.0.0.1:9880`（CPU 实例）与 `127.0.0.1:9881`（GPU 实例，`tts_gpu.yaml`，`device: cuda`、`is_half: false`）。计时从发出 POST 到收到第一个 44 字节 WAV 头。`sample_steps` 用上游默认 32，未调优。

## 结果

| 设备 | streaming_mode | 字数 | 首字节 | 整段耗时 | 音频时长 | RTF |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| CPU | 3 | 9 | 2.20 s | 4.35 s | 2.40 s | 1.81 |
| CPU | 2 | 9 | 3.33 s | 5.03 s | 2.34 s | 2.15 |
| CPU | 3 | 29 | 2.13 s | 9.92 s | 5.95 s | 1.67 |
| CPU | 2 | 29 | 4.00 s | 9.17 s | 5.72 s | 1.60 |
| CPU | 3 | 35 | 2.14 s | 11.53 s | 6.82 s | 1.69 |
| CPU | 2 | 35 | 3.42 s | 10.15 s | 6.92 s | 1.47 |
| **GPU** | 3 | 9 | **0.73 s** | 1.65 s | 2.41 s | 0.68 |
| GPU | 2 | 9 | 24.45 s ※ | 25.45 s | 2.94 s | 8.66 |
| **GPU** | 3 | 29 | **0.36 s** | 2.72 s | 6.40 s | 0.42 |
| GPU | 2 | 29 | 0.83 s | 2.71 s | 7.19 s | 0.38 |
| **GPU** | 3 | 35 | **0.37 s** | 3.05 s | 6.93 s | 0.44 |
| GPU | 2 | 35 | 0.72 s | 2.80 s | 7.68 s | 0.36 |

※ 该行是 GPU 实例加载后的**第一次请求**（CUDA 上下文/JIT 冷启动），不代表热机；随后各例均为热机。

## 结论

1. **现场部署的是 CPU 实例**：9880 的进程用 `solver-tts-cpu-*.yaml`（`device: cpu`、`is_half: false`）启动，所以现行 26 s / 5.8 s 音频不是硬件极限，是配置。P104 上 CUDA 可用（torch 2.7.0+cu128，capability (6,1)，arch 列表含 sm_61）。
2. **GPU 热机首字节 0.36–0.83 s**，整段 6.9 s 音频 3.0 s 合成完 ⇒ RTF 0.36–0.44，与历史记载的 0.44–0.56 同量级。
3. `streaming_mode=3` 的首字节比 `=2` 早约 0.36 s，代价是分块更碎（质量模式差异需听辨确认）。
4. **首字节 ≠ 能听**：GPT-SoVITS 每段开头有 0.79–1.01 s 生成静音（Amadeus 实测 58 条），必须按 0.15.2 的做法裁到第一个有声帧前 50 ms，否则 1.5–2 s 目标被这段静音白吃掉。
5. 因此预算表应改为：**首句文本就绪 → 上游首字节 0.4–0.8 s → 首句整段合成完 0.9–1.2 s → 裁剪 + 传输 <0.1 s → 播放启动**。这条链路有希望落在 1.5–2 s 内，前提是 GPU 常驻、句子切得短、播放端不轮询。

## 复现

```powershell
# 1) 起 GPU 实例（前台，SSH 会话关闭即退出；生产要换成任务/服务）
cd E:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50
runtime\python.exe -u api_v2.py -a 127.0.0.1 -p 9881 -c C:\Windows\Temp\tts-probe\tts_gpu.yaml

# 2) 探针
runtime\python.exe C:\Windows\Temp\tts-probe\probe_stream.py http://127.0.0.1:9881
```

未决：`sample_steps` 未做 A/B（Amadeus 首段 4 步、后续 16 步，配合 CUDA Graph）；`overlap_length` / `min_chunk_length` 未调；首字节到首个**有声**样本的差尚未测（需要把裁剪逻辑接进探针）。
