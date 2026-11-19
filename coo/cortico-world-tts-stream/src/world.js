/**
 * 流式语音 World：让桌宠一开口就出声。
 *
 * 旧链路是「整条气泡 → 一次合成 → 一个完整 WAV → 交给了播放器」，所以第一声要等
 * 整段合成完。这里改成：
 *
 *   desktop-pet.self（一条完整气泡）
 *     → 网关 /v1/audio/segments 按句合成
 *     → 每段音频一到就落盘、立刻进本地播放队列
 *     → 后面的句子在放第一段的时候继续合成
 *
 * 本 World 不合成任何东西，也不替模型说话；它只订阅、转发、播放。
 * 与旧的 `tts` World 互斥：用它之前请把 `worlds.tts.autoSpeak` 关掉，否则会双份出声。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { streamSegments } from './stream_client.js';

export const ID = 'tts-stream';
export const LABEL = '流式语音';

/** 桌宠气泡事件；本 World 只读这一种。 */
export const PET_EVENT = 'desktop-pet.self';
/** 自己发的观测事件：只归档，永远不唤醒模型。 */
export const STREAM_EVENT = 'tts.stream';

const PLAYER_SCRIPT = fileURLToPath(new URL('./player.ps1', import.meta.url));

export const DEFAULTS = {
  enabled: false,
  // 网关地址：局域网里就是那台跑 GPT-SoVITS 的机器
  baseUrl: 'http://127.0.0.1:18080',
  // 密钥在 .env 里的变量名；网关开 openai 协议时用
  apiKeySecret: 'AUDIO_API_KEY',
  // 留空 = 用网关的默认音色
  voice: '',
  // 扫桌宠气泡的间隔：越短首声越早，200 ms 是实测与开销的折中
  scanMs: 200,
  // 首句用更少的 CFM 步数与更快的语速；后续句用正常参数
  firstSteps: 4,
  firstSpeed: 1.067,
  laterSteps: 16,
  speed: 0.97,
  // 播放与留存
  play: true,
  keep: 200,
  // 单次合成上限；超时按失败处理，不挂住队列
  timeoutMs: 120000,
  // 鸭身：把每段 WAV 经同一套帧协议交给主机端适配（scripts/duck_relay.py）
  duckEnabled: false,
  duckPython: 'python',
  duckTarget: '',
  duckDevice: '',
  duckRelay: '',
  duckHostKey: '',
  duckPassword: '',
  duckPlink: '',
  // 板上的 aplay 不做软件音量，缩放放在板端播放器里；0.5 是「听得到但不吵」
  duckGain: 0.5,
};

const msg = (err) => (err instanceof Error ? err.message : String(err));

const NOISE = /[\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const MARKS = /[*_`~#>|]+/g;
const URLS = /https?:\/\/\S+/g;

/** 气泡文本 → 可朗读文本；去 URL、emoji、markdown 标记，截 600 字。 */
export function speakable(text) {
  const cleaned = String(text ?? '')
    .replace(URLS, ' ')
    .replace(NOISE, ' ')
    .replace(MARKS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > 600 ? `${cleaned.slice(0, 600)}……` : cleaned;
}

/** 一条气泡该念什么：say 拼 beats，ask 只念问题。 */
export function lineOf(event) {
  const meta = event?.meta ?? {};
  if (meta.kind === 'say' && Array.isArray(meta.beats)) {
    return speakable(meta.beats.map((beat) => (beat && typeof beat.text === 'string' ? beat.text : '')).filter(Boolean).join('。 '));
  }
  if (meta.kind === 'ask' && typeof meta.question === 'string') return speakable(meta.question);
  return '';
}

export class TtsStreamWorld {
  id = ID;
  #host = null;
  #timer = null;
  #cursor = 0;
  #player = null;
  #playerPending = new Map();
  #playerSeq = 0;
  #abort = null;
  #jobEpoch = 0;
  #busy = false;
  #lastError = '';
  #lastTurn = null;
  #segments = [];
  #duck = null;
  #duckState = 'off';

  constructor(opts = {}) {
    this.cfg = opts.cfg ?? { ...DEFAULTS };
    this.dataDir = opts.dataDir ?? process.cwd();
    this.secret = typeof opts.secret === 'function' ? opts.secret : () => '';
    // 测试用：给了 onPlay 就不去起 PowerShell，直接把落盘路径交出去
    this.onPlay = typeof opts.onPlay === 'function' ? opts.onPlay : null;
    this.language = 'zh';
  }

  /** 上一轮的摘要（状态工具与测试用）。 */
  get lastTurn() {
    return this.#lastTurn;
  }

  // ---------------------------------------------------------------- 配置

  #raw(key) {
    const value = this.cfg?.[key];
    return value === undefined || value === null ? DEFAULTS[key] : value;
  }

  #str(key) {
    const value = this.#raw(key);
    const s = typeof value === 'string' ? value.trim() : '';
    return s || String(DEFAULTS[key] ?? '');
  }

  #num(key, min, max) {
    const n = Number(this.#raw(key));
    if (!Number.isFinite(n)) return Number(DEFAULTS[key]) || min;
    return Math.min(Math.max(n, min), max);
  }

  #bool(key) {
    const value = this.#raw(key);
    return typeof value === 'boolean' ? value : Boolean(DEFAULTS[key]);
  }

  dir() {
    return join(this.dataDir, 'tts-stream');
  }

  // ---------------------------------------------------------------- 播放器

  #ensurePlayer() {
    if (this.#player) return this.#player;
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PLAYER_SCRIPT]
      : ['-NoProfile', '-File', PLAYER_SCRIPT];
    const player = spawn(shell, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    player.stdout.setEncoding('utf8');
    player.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        this.#onPlayerLine(line);
        index = buffer.indexOf('\n');
      }
    });
    player.stderr.setEncoding('utf8');
    player.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.#lastError = text.slice(0, 300);
    });
    const finish = (reason) => {
      if (this.#player === player) {
        this.#player = null;
        this.#playerPending.clear();
        this.#lastError = `播放器退出：${reason}`;
        this.#host?.log?.warn?.('流式语音：播放器退出', { reason });
      }
    };
    player.on('exit', (code) => finish(`exit ${code}`));
    player.on('error', (err) => finish(msg(err)));
    this.#player = player;
    return player;
  }

  #onPlayerLine(line) {
    if (!line) return;
    let frame = null;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame?.id) this.#playerPending.delete(frame.id);
    if (frame?.error) {
      this.#lastError = `播放失败：${frame.error}`;
      this.#host?.log?.warn?.('流式语音：播放失败', { id: frame.id, error: frame.error });
    }
  }

  /** 把一段 WAV 交给播放器；播放器串行播放。 */
  #play(wav, name) {
    const dir = join(this.dir(), 'segments');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, wav);
    this.#segments.push({ path, at: Date.now() });
    this.#pruneSegments();
    this.#writeDuck(wav);
    if (this.onPlay) {
      this.onPlay(path, wav);
      return;
    }
    if (!this.#bool('play')) return;
    const player = this.#ensurePlayer();
    const id = String(++this.#playerSeq);
    this.#playerPending.set(id, path);
    try {
      player.stdin.write(`${JSON.stringify({ id, path })}\n`);
    } catch (err) {
      this.#lastError = `写播放器失败：${msg(err)}`;
    }
  }

  #pruneSegments() {
    const keep = Math.max(1, this.#num('keep', 1, 5000));
    while (this.#segments.length > keep) {
      const oldest = this.#segments.shift();
      try {
        rmSync(oldest.path, { force: true });
      } catch {
        /* 文件被占着就算了 */
      }
    }
  }

  // ---------------------------------------------------------------- 鸭身

  /**
   * 主机端播放适配：`scripts/duck_relay.py` 收同一套帧，经一条 SSH 会话送到板端，
   * 逐段回执。鸭子的音量、设备、待播量都在这一层，World 只负责按序写帧。
   */
  #ensureDuck() {
    if (this.#duck) return this.#duck;
    const relay = this.#str('duckRelay') || fileURLToPath(new URL('../../../scripts/duck_relay.py', import.meta.url));
    const args = [relay];
    const target = this.#str('duckTarget');
    if (target) args.push('--target', target);
    else args.push('--local');
    const device = this.#str('duckDevice');
    if (device) args.push('--device', device);
    const hostKey = this.#str('duckHostKey');
    if (hostKey) args.push('--host-key', hostKey);
    const password = this.#str('duckPassword');
    if (password) args.push('--password', password);
    if (target && this.#str('duckPlink')) args.push('--plink', this.#str('duckPlink'));
    const gain = this.#num('duckGain', 0, 1);
    if (gain < 0.999) args.push('--gain', String(gain));
    const python = this.#str('duckPython') || 'python';
    const child = spawn(python, ['-u', ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let cut = buffer.indexOf('\n');
      while (cut >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        cut = buffer.indexOf('\n');
        if (!line) continue;
        try {
          const receipt = JSON.parse(line);
          if (receipt.summary) this.#duckState = `上次会话 ${receipt.summary.ok}/${receipt.summary.sent}`;
          else if (receipt.ok === false) this.#duckState = `段 ${receipt.seq} 失败：${receipt.error ?? ''}`;
        } catch {
          this.#duckState = `回执不是 JSON：${line.slice(0, 80)}`;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.#host?.log?.warn?.('流式语音：鸭身适配', { text: text.slice(0, 200) });
    });
    child.on('exit', (code) => {
      if (this.#duck === child) {
        this.#duck = null;
        this.#duckState = `适配进程退出（${code}）`;
      }
    });
    child.on('error', (error) => {
      this.#duckState = `起不来：${msg(error)}`;
      this.#duck = null;
    });
    this.#duck = child;
    this.#duckState = 'running';
    return child;
  }

  #writeDuck(wav) {
    if (!this.#bool('duckEnabled')) return;
    const duck = this.#ensureDuck();
    const size = Buffer.alloc(4);
    size.writeUInt32LE(wav.length, 0);
    try {
      duck.stdin.write(Buffer.concat([size, wav]));
    } catch (error) {
      this.#duckState = `写不进适配进程：${msg(error)}`;
    }
  }

  // ---------------------------------------------------------------- 合成

  /** 说一段文本；新的一次会中止上一次还没送完的段。 */
  async speak(text, { origin = 'tool', note = '' } = {}) {
    const line = speakable(text);
    if (!line) return { text: '[tts_stream 没执行] 没有可朗读的内容。', failed: true };

    const epoch = ++this.#jobEpoch;
    this.#abort?.abort();
    const controller = new AbortController();
    this.#abort = controller;
    this.#busy = true;

    const voice = this.#str('voice');
    const keyName = this.#str('apiKeySecret');
    let apiKey = '';
    try {
      apiKey = keyName ? String(this.secret(keyName) ?? '').trim() : '';
    } catch {
      apiKey = '';
    }
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const turn = `${stamp}-${randomBytes(2).toString('hex')}`;
    let index = 0;

    try {
      const summary = await streamSegments(
        `${this.#str('baseUrl').replace(/\/+$/, '')}/v1/audio/segments`,
        {
          input: line,
          ...(voice ? { voice } : {}),
          first_steps: this.#num('firstSteps', 1, 64),
          first_speed: this.#num('firstSpeed', 0.5, 2),
          later_steps: this.#num('laterSteps', 1, 64),
          speed: this.#num('speed', 0.5, 2),
        },
        {
          headers,
          signal: controller.signal,
          timeoutMs: this.#num('timeoutMs', 5000, 900000),
          onAudio: (wav, meta) => {
            if (epoch !== this.#jobEpoch) return; // 已被新一轮顶掉
            const seq = typeof meta?.index === 'number' ? meta.index : index;
            index += 1;
            this.#play(wav, `${turn}-${String(seq).padStart(2, '0')}.wav`);
          },
        },
      );
      this.#lastTurn = {
        turn,
        origin,
        note,
        chars: line.length,
        segments: summary.segments,
        firstAudioMs: summary.firstAudioMs,
        totalMs: summary.totalMs,
        at: new Date().toISOString(),
      };
      this.#host?.log?.info?.('流式语音：一段说完', this.#lastTurn);
      if (this.#host?.pushEvent) {
        await this.#host.pushEvent({
          type: STREAM_EVENT,
          source: this.id,
          ts: new Date().toISOString(),
          text: `分段语音完成：${summary.segments} 段，首段 ${summary.firstAudioMs ?? '-'} ms，共 ${summary.totalMs} ms`,
          meta: { ...this.#lastTurn, text: line.slice(0, 400) },
        }, { deliver: false, trigger: 'debounce' }).catch(() => null);
      }
      return { text: `已说完：${summary.segments} 段，首段 ${summary.firstAudioMs ?? '-'} ms，总 ${summary.totalMs} ms。` };
    } catch (err) {
      if (controller.signal.aborted) return { text: '[tts_stream] 被新的一段顶替了。' };
      const detail = msg(err);
      this.#lastError = detail;
      this.#host?.log?.warn?.('流式语音：合成失败', { error: detail });
      return { text: `[tts_stream 失败] ${detail}`, failed: true };
    } finally {
      if (epoch === this.#jobEpoch) this.#busy = false;
    }
  }

  // ---------------------------------------------------------------- 订阅

  async #scan() {
    const host = this.#host;
    if (!host) return;
    try {
      const events = host.store.range({ fromCursor: this.#cursor + 1, limit: 50 });
      for (const event of events) {
        this.#cursor = Math.max(this.#cursor, event.cursor);
        if (event.type !== PET_EVENT) continue;
        const line = lineOf(event);
        if (!line) continue;
        void this.speak(line, { origin: 'pet', note: '桌宠气泡' });
      }
    } catch (err) {
      this.#lastError = `读事件失败：${msg(err)}`;
    }
  }

  // ---------------------------------------------------------------- 工具

  tools() {
    return [
      {
        name: 'tts_stream_say',
        tags: ['speak'],
        interruptible: true,
        description: 'Speak a line through the streaming gateway: sentences are synthesized one by one and each segment is played as soon as it arrives. Returns when the last segment has been handed to the player.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: 2000, description: 'What to say.' },
          },
          required: ['text'],
        },
        handler: async (args) => this.speak(args?.text ?? '', { origin: 'tool' }),
      },
      {
        name: 'tts_stream_status',
        tags: ['read'],
        description: 'Show the streaming speech state: gateway, voice, scan interval, last turn timing and last error.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: () => ({ text: this.statusText() }),
      },
    ];
  }

  statusText() {
    const bits = [
      `网关 ${this.#str('baseUrl')}`,
      `音色 ${this.#str('voice') || '（默认）'}`,
      `扫描 ${this.#num('scanMs', 10, 5000)} ms`,
      `播放 ${this.#bool('play') ? '开' : '关'}`,
      this.#busy ? '正在说' : '空闲',
    ];
    if (this.#lastTurn) {
      bits.push(`上一段 ${this.#lastTurn.segments} 段 / 首段 ${this.#lastTurn.firstAudioMs ?? '-'} ms`);
    }
    if (this.#lastError) bits.push(`最近错误：${this.#lastError.slice(0, 120)}`);
    if (this.#bool('duckEnabled')) bits.push(`鸭身 ${this.#duckState}`);
    return bits.join(' · ');
  }

  // ---------------------------------------------------------------- WebUI

  webUi() {
    const last = this.#lastTurn;
    return {
      label: LABEL,
      lamps: [
        {
          label: '网关',
          state: last ? 'online' : (this.#lastError ? 'error' : 'offline'),
          hint: this.#lastError || this.#str('baseUrl'),
        },
      ],
      badges: [
        { label: '模式', value: '分段流式', tone: 'on' },
        { label: '首段', value: last?.firstAudioMs ? `${last.firstAudioMs} ms` : '—', tone: last ? 'on' : 'off' },
      ],
      config: [configGroup()],
    };
  }

  envPromptVars() {
    return null;
  }

  // ---------------------------------------------------------------- 生命周期

  async start(host) {
    this.#host = host;
    this.#cursor = host.store.latestCursor();
    if (this.#timer) clearInterval(this.#timer);
    try {
      mkdirSync(join(this.dir(), 'segments'), { recursive: true });
    } catch (err) {
      host?.log?.warn?.('流式语音：目录建不出来', { error: msg(err) });
    }
    const scanMs = this.#num('scanMs', 50, 5000);
    this.#timer = setInterval(() => { void this.#scan(); }, scanMs);
    this.#timer.unref?.();
    // 预热：SSH 会话与板端播放器的启动（约 2 秒）挪到 World 启动时，
    // 别让第一条气泡替它买单。
    if (this.#bool('duckEnabled')) {
      try {
        this.#ensureDuck();
      } catch (err) {
        this.#duckState = `预热失败：${msg(err)}`;
      }
    }
    host?.log?.info?.('流式语音已就绪', {
      gateway: this.#str('baseUrl'),
      voice: this.#str('voice') || '(default)',
      scanMs,
      play: this.#bool('play'),
    });
  }

  async stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#jobEpoch += 1;
    this.#abort?.abort();
    this.#abort = null;
    if (this.#duck) {
      try {
        this.#duck.stdin.end();
      } catch {
        /* ignore */
      }
      this.#duck.kill();
      this.#duck = null;
      this.#duckState = 'off';
    }
    if (this.#player) {
      try {
        this.#player.stdin.end();
      } catch {
        /* ignore */
      }
      this.#player.kill();
      this.#player = null;
    }
    this.#host = null;
  }
}

/**
 * 配置组：WebUI 的「设置」页直接改 `worlds.tts-stream.*`，因为 World 每次用时现读，
 * 不需要重启。
 */
export function configGroup() {
  const K = `worlds.${ID}`;
  const str = (title, description, extra = {}) => ({ type: 'string', title, description, 'x-hot': true, ...extra });
  const num = (title, description, minimum, maximum, extra = {}) => ({
    type: 'integer', title, description, minimum, maximum, multipleOf: 1, 'x-hot': true, ...extra,
  });
  return {
    id: `world:${ID}`,
    owner: `world:${ID}`,
    schema: {
      type: 'object',
      title: '流式语音',
      properties: {
        [`${K}.baseUrl`]: str('网关地址', '语音服务的根地址，例如 http://192.168.67.166:18080'),
        [`${K}.apiKeySecret`]: { type: 'string', title: '密钥变量名', description: '密钥在 .env 里的变量名' },
        [`${K}.voice`]: str('音色', '留空使用网关默认音色'),
        [`${K}.scanMs`]: num('扫描间隔', '多久看一次桌宠气泡（毫秒）', 50, 5000, { 'x-suffix': 'ms' }),
        [`${K}.firstSteps`]: num('首句步数', '首句 CFM 步数，越少越快', 1, 64),
        [`${K}.firstSpeed`]: { type: 'number', title: '首句语速', 'x-hot': true },
        [`${K}.laterSteps`]: num('后续步数', '后续句的 CFM 步数', 1, 64),
        [`${K}.speed`]: { type: 'number', title: '后续语速', 'x-hot': true },
        [`${K}.play`]: { type: 'boolean', title: '本机播放', description: '关掉就只合成落盘、不出声' },
        [`${K}.duckEnabled`]: { type: 'boolean', title: '转给 MicroDuck', description: '每段 WAV 交给主机端适配，经 SSH 送板端 aplay' },
        [`${K}.duckTarget`]: str('鸭身 SSH', '如 radxa@microduck.local；留空则本机直跑（调试用）'),
        [`${K}.duckDevice`]: str('ALSA 设备', '如 plughw:CARD=Speak,DEV=0；留空用默认设备'),
        [`${K}.duckPython`]: str('Python', '跑主机端适配的解释器，默认 python'),
        [`${K}.duckRelay`]: str('适配脚本', '留空用仓库里的 scripts/duck_relay.py'),
        [`${K}.duckPlink`]: str('plink 路径', 'Windows 上走 plink 时填完整路径；留空用 ssh'),
        [`${K}.duckHostKey`]: str('主机指纹', 'plink 的 -hostkey，如 SHA256:...'),
        [`${K}.duckPassword`]: str('SSH 密码', 'plink 的 -pw；明文存在 Coo 的 config.json 里，能换密钥就换密钥'),
        [`${K}.duckGain`]: { type: 'number', title: '鸭声音量', description: '0–1，板端软件缩放（板上 aplay 没有音量参数）', minimum: 0, maximum: 1, 'x-hot': true },
        [`${K}.keep`]: num('保留段数', '超出后删最旧的', 1, 5000),
        [`${K}.timeoutMs`]: num('超时', '单次合成的上限（毫秒）', 5000, 900000, { 'x-suffix': 'ms' }),
      },
    },
  };
}
