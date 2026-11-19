# Cortico 语音接入 MicroDuck：验收手册

接口边界是完整的 PCM WAV：Cortico/Coo 负责用已配置的音色合成，主机负责取回附件，MicroDuck 通过板上的 ALSA 设备播放。服务拓扑见 [本地 GPT TTS v1 定义](local-gpt-tts.md)。MicroDuck 的既有 robot.sound 接口负责原生预置叫声。本验收直接使用声卡，不通过 robotd，不控制舵机，不改板端的音量或配置。

1. 在 Cortico「文本转语音 → 状态」使用当前音色试听一句有编号的短句，保存 WAV，记录音色、预期文本、Clip ID、请求时间和状态。要验收会话下行，另外在 Cortico 对话中触发回复，并令保存的 WAV 来自该条新 tts.voice 事件及其附件；控制台试听不能代替这一步。
2. 在主机执行本地校验。脚本要求 8–48 kHz、16 位、单/双声道 PCM、最长 30 秒，拒绝截断和数字静音，并输出字节数、SHA-256、采样率、时长、峰值和 RMS。用现成 ASR 逐字核对，或播放原件人工听辨并记录结果。收到 HTTP 200 只说明服务器成功返回，需分别验证信号和内容。

   ~~~powershell
   python .\scripts\play-microduck.py $wav
   ~~~

3. MicroDuck 上电后，用已经验证的 SSH 主机公钥登录，核对主机名。运行 aplay -l 并查看板端已配置的扬声器声卡；如果没有对应的 ALSA 设备，先确认声卡和扬声器的硬件及权限。用专用 SSH 密钥或已加载的 SSH agent，再显式选择实际 ALSA 输出。正式测试只发送步骤 2 校验过的同一文件。

   ~~~powershell
   python .\scripts\play-microduck.py $wav --ssh 'radxa@microduck.local' --known-hosts $knownHosts --identity $identity --device 'plughw:CARD=Speak,DEV=0'
   ~~~

   地址和声卡名称仅作示例。播放要求板上安装 python3 和 alsa-utils，SSH 账户有权打开所选的 PCM 设备。脚本通过 SSH 标准输入传输 WAV，板端核对摘要后调用 aplay。摘要不一致、连接失败、播放超时或非零退出都要保留失败回执。板端 aplay 返回 0 说明 PCM 已交给该设备；现场仍须确认声音从鸭身扬声器发出并能听清编号。

4. 用第二个编号重复一次，并检查断网时不会返回播放成功。正式收官记录：软件回归、真实 Cortico 合成、来自会话的事件与附件、语音内容复核、MicroDuck 的设备名与两次摘要匹配的播放回执、现场听感。真机不可用时保留 WAV 和校验结果，明确把真机项标成待验，之后无需重新选样本。

这条验收路径按完整 WAV 交付。需要持续订阅、播放排队或真正的分块 PCM 时，应单独验收这些能力。
