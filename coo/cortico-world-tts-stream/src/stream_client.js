/**
 * 网关分段协议的最小客户端。
 *
 * 帧格式：4 字节小端长度 + 1 字节类型 + 载荷。
 *   类型 0 = JSON 元数据（plan / segment / done）
 *   类型 1 = 该段完整的 WAV
 *
 * 这里只做「拆帧」和「按到达顺序回调」，不做任何缓冲以外的策略：
 * 收到一段音频就交给调用方，调用方立刻排队播放，这才是首声的关键。
 */

export const FRAME_META = 0;
export const FRAME_AUDIO = 1;

/** 把一个字节流切成帧；跨 chunk 的半帧留在内部。 */
export class FrameParser {
  #buffer = Buffer.alloc(0);

  /** @param {Uint8Array} chunk @returns {Array<{kind:number,payload:Buffer}>} */
  push(chunk) {
    const piece = Buffer.from(chunk);
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, piece]) : piece;
    const frames = [];
    for (;;) {
      if (this.#buffer.length < 5) break;
      const size = this.#buffer.readUInt32LE(0);
      if (size > 64 * 1024 * 1024) throw new Error(`帧长度不合理：${size}`);
      if (this.#buffer.length < 5 + size) break;
      const kind = this.#buffer.readUInt8(4);
      const payload = this.#buffer.subarray(5, 5 + size);
      this.#buffer = this.#buffer.subarray(5 + size);
      frames.push({ kind, payload });
    }
    return frames;
  }
}

/** 解析元数据帧；解析失败返回 null，不抛错。 */
export function parseMeta(payload) {
  try {
    const value = JSON.parse(payload.toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * POST 到分段接口，按到达顺序推送每一帧。
 *
 * @param {string} url
 * @param {object} body
 * @param {{headers?: Record<string,string>, signal?: AbortSignal, timeoutMs?: number,
 *          onMeta?: (meta: object) => void, onAudio?: (wav: Buffer, meta: object|null) => void}} options
 * @returns {Promise<{segments: number, bytes: number, firstAudioMs: number|null, totalMs: number}>}
 */
export async function streamSegments(url, body, options = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const parser = new FrameParser();
  let segments = 0;
  let bytes = 0;
  let firstAudioMs = null;
  let lastMeta = null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`网关返回 ${response.status}: ${detail.slice(0, 300)}`);
    }
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const frame of parser.push(value)) {
        if (frame.kind === FRAME_META) {
          const meta = parseMeta(frame.payload);
          if (!meta) continue;
          lastMeta = meta;
          options.onMeta?.(meta);
        } else if (frame.kind === FRAME_AUDIO) {
          segments += 1;
          bytes += frame.payload.length;
          if (firstAudioMs === null) firstAudioMs = Date.now() - started;
          options.onAudio?.(Buffer.from(frame.payload), lastMeta);
        }
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  return { segments, bytes, firstAudioMs, totalMs: Date.now() - started };
}
