/**
 * OpenAI-compatible TTS client.
 *
 * This is a JavaScript port of Amadeus's `tts/backends/openai_compatible.py`,
 * keeping the parts that carry real information and dropping the parts that
 * only existed for that project's internal plumbing:
 *
 *   kept   endpoint joining, Bearer auth, the exact buffered request shape,
 *          the 64 MiB response cap, WAV header validation, the SSE event
 *          protocol (`speech.audio.delta` / `speech.audio.done` / `[DONE]`),
 *          base64 PCM16LE framing at 24 kHz, and the 80 ms re-chunking rule.
 *   added  explicit `text_lang` / `prompt_lang` declaration, because the OpenAI
 *          schema cannot carry the language and that omission is what produced
 *          the wrong-language renders described in `lang.js`.
 *   dropped Amadeus's TTSAudioChunk wrapper and numpy conversion; Node gives us
 *          Buffers and the HTTP layer wants bytes.
 */

import { resolveSynthesisLanguage } from './lang.js';

/** Matches Amadeus's `_MAX_SPEECH_RESPONSE_BYTES`. */
export const MAX_SPEECH_BYTES = 64 * 1024 * 1024;
/** The OpenAI SSE speech protocol carries no sample rate; the client assumes 24 kHz. */
export const OPENAI_PCM_SAMPLE_RATE = 24000;
/** Amadeus re-chunks a stream into 80 ms frames before handing it to the player. */
export const STREAM_CHUNK_MS = 80;

/**
 * Turn a transport failure into one readable clause.
 *
 * Node's `fetch` collapses every connection problem into `TypeError: fetch
 * failed` and stores the real reason in `cause` (an `AggregateError` for
 * multi-address hosts). Unwrapping it is what separates "the service is stopped"
 * from "the host name is wrong" — the difference between a five-second fix and
 * an afternoon.
 */
export function describeTransportError(error) {
  const codes = [];
  const visit = (node, depth = 0) => {
    if (node === null || typeof node !== 'object' || depth > 3) return;
    if (typeof node.code === 'string') codes.push(node.code);
    else if (typeof node.message === 'string' && node.message !== 'fetch failed') codes.push(node.message);
    for (const nested of node.errors ?? []) visit(nested, depth + 1);
    if (node.cause) visit(node.cause, depth + 1);
  };
  visit(error);
  const unique = [...new Set(codes.filter(Boolean))];
  return unique.length > 0 ? unique.join(', ') : (error?.message ?? String(error));
}

export class TTSError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TTSError';
  }
}

/** Join a base URL with the speech endpoint without doubling `/audio/speech`. */
export function speechEndpoint(baseUrl) {
  const value = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (value === '') throw new TTSError('TTS base URL is empty');
  return value.endsWith('/audio/speech') ? value : `${value}/audio/speech`;
}

/**
 * Read a RIFF/WAVE header. Returns `null` when the payload is not a WAV, so the
 * caller can report a useful error instead of writing unusable audio to disk.
 */
export function wavInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, buffer.length - body);
    }
    offset = body + size + (size % 2);
  }
  if (format === null || dataOffset < 0) return null;
  const bytesPerFrame = Math.max(1, format.channels * (format.bitsPerSample / 8));
  return {
    ...format,
    dataOffset,
    dataLength,
    frames: Math.floor(dataLength / bytesPerFrame),
    durationSeconds: dataLength / Math.max(1, format.byteRate),
  };
}

/** Incremental `data:` line reader for `text/event-stream` bodies. */
async function* iterSseData(body) {
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let dataLines = [];
  const flush = () => {
    if (dataLines.length > 0) {
      const value = dataLines.join('\n');
      dataLines = [];
      return value;
    }
    return null;
  };
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      if (line === '') {
        const event = flush();
        if (event !== null) yield event;
        continue;
      }
      if (line.startsWith(':')) continue; // SSE comment / keep-alive
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  pending += decoder.decode();
  if (pending !== '') {
    const line = pending.replace(/\r$/, '');
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  const event = flush();
  if (event !== null) yield event;
}

export class TTSClient {
  /**
   * @param {object} config
   * @param {string} config.baseUrl      e.g. `http://127.0.0.1:18080/v1`
   * @param {string} [config.apiKey]
   * @param {string} [config.model]      sent as `model`; the gateway ignores unknown values
   * @param {string} [config.voice]
   * @param {number} [config.timeoutMs]
   * @param {string} [config.language]   default language when the text gives no clue
   * @param {string} [config.promptLanguage] language of the reference audio the voice uses
   */
  constructor(config = {}) {
    this.baseUrl = config.baseUrl ?? '';
    this.apiKey = config.apiKey ?? '';
    this.model = config.model ?? 'tts-1';
    this.voice = config.voice ?? '';
    this.timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 120_000;
    this.language = config.language ?? 'zh';
    this.promptLanguage = config.promptLanguage ?? '';
  }

  /** Build the request body. Unknown keys are ignored by strict gateways and honoured by ours. */
  buildPayload({ text, voice, language, promptLanguage, speed, seed, responseFormat, stream }) {
    const resolved = resolveSynthesisLanguage(text, {
      explicit: language,
      configured: this.language,
    });
    const payload = {
      model: this.model,
      input: text,
      voice: voice ?? this.voice,
      response_format: responseFormat,
      speed: Math.max(0.25, Math.min(4, Number.isFinite(speed) ? speed : 1)),
      // Declared even though the OpenAI schema omits them: this is the fix for
      // the wrong-language class of failure.
      text_lang: resolved.code,
    };
    const promptLang = promptLanguage ?? this.promptLanguage;
    if (promptLang !== '') payload.prompt_lang = promptLang;
    // A GPT-SoVITS-class engine samples: without a seed the same text yields
    // different audio each run, which makes a content check unreproducible.
    // Forwarded only when the caller pins one; -1 keeps the engine's default.
    if (Number.isInteger(seed) && seed > -1) payload.seed = seed;
    if (stream) payload.stream_format = 'sse';
    return { payload, resolved };
  }

  #headers(streaming) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (this.apiKey !== '') headers.Authorization = `Bearer ${this.apiKey}`;
    if (streaming) headers.Accept = 'text/event-stream';
    return headers;
  }

  #signal() {
    return AbortSignal.timeout(Math.max(1, this.timeoutMs));
  }

  /**
   * Synthesize one complete response.
   * @returns {Promise<{wav: Buffer, info: object|null, language: string, languageReason: string, voice: string}>}
   */
  async synthesize(request) {
    const text = String(request?.text ?? '');
    if (text.trim() === '') throw new TTSError('text is required');
    const { payload, resolved } = this.buildPayload({
      ...request,
      text,
      responseFormat: 'wav',
      stream: false,
    });

    let response;
    try {
      response = await fetch(speechEndpoint(this.baseUrl), {
        method: 'POST',
        headers: this.#headers(false),
        body: JSON.stringify(payload),
        signal: this.#signal(),
      });
    } catch (error) {
      // Node's fetch reports every transport failure as a bare "fetch failed"
      // and hides the reason in `cause`. Without unwrapping it, a stopped
      // service and a wrong host look identical, which is exactly the kind of
      // undiagnosable message this whole exercise was about.
      throw new TTSError(
        `TTS request failed: cannot reach ${speechEndpoint(this.baseUrl)}`
        + ` (${describeTransportError(error)})`,
        { cause: error },
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new TTSError(`TTS endpoint returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new TTSError('TTS endpoint returned empty audio');
    if (buffer.length > MAX_SPEECH_BYTES) throw new TTSError('TTS response exceeded 64 MiB');

    return {
      wav: buffer,
      info: wavInfo(buffer),
      language: resolved.code,
      languageReason: resolved.reason,
      voice: payload.voice,
    };
  }

  /**
   * Synthesize as a stream of PCM chunks.
   *
   * Only meaningful when the endpoint implements the OpenAI SSE speech protocol;
   * the caller decides whether to use it. Yields `{audio: Buffer, sampleRate}`
   * where `audio` holds raw little-endian PCM16 mono.
   */
  async *synthesizeStream(request) {
    const text = String(request?.text ?? '');
    if (text.trim() === '') throw new TTSError('text is required');
    const { payload, resolved } = this.buildPayload({
      ...request,
      text,
      responseFormat: 'pcm',
      stream: true,
    });

    let response;
    try {
      response = await fetch(speechEndpoint(this.baseUrl), {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify(payload),
        signal: this.#signal(),
      });
    } catch (error) {
      throw new TTSError(`TTS streaming request failed: ${error?.message ?? error}`, { cause: error });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new TTSError(`TTS endpoint returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    if (response.body === null) throw new TTSError('TTS endpoint returned no stream body');

    const target = Math.max(2, ((OPENAI_PCM_SAMPLE_RATE * 2 * STREAM_CHUNK_MS) / 1000) & ~1);
    let pending = Buffer.alloc(0);
    let received = 0;

    for await (const raw of iterSseData(response.body)) {
      if (raw === '[DONE]') break;
      let event;
      try {
        event = JSON.parse(raw);
      } catch (error) {
        throw new TTSError('TTS endpoint returned malformed SSE JSON', { cause: error });
      }
      const type = String(event?.type ?? '');
      if (type === 'speech.audio.done') break;
      if (type === 'error' || type.endsWith('.error')) {
        throw new TTSError(`TTS streaming failed: ${event.error ?? event.message ?? type}`);
      }
      if (type !== 'speech.audio.delta') continue;
      if (typeof event.audio !== 'string' || event.audio === '') {
        throw new TTSError('TTS audio delta did not contain base64 audio');
      }
      const decoded = Buffer.from(event.audio, 'base64');
      if (decoded.length === 0) throw new TTSError('TTS audio delta decoded to nothing');
      received += decoded.length;
      if (received > MAX_SPEECH_BYTES) throw new TTSError('TTS stream exceeded 64 MiB');
      pending = Buffer.concat([pending, decoded]);
      while (pending.length >= target) {
        yield { audio: pending.subarray(0, target), sampleRate: OPENAI_PCM_SAMPLE_RATE, language: resolved.code };
        pending = pending.subarray(target);
      }
    }
    if (pending.length > 0) {
      yield { audio: pending, sampleRate: OPENAI_PCM_SAMPLE_RATE, language: resolved.code };
    }
  }

  /** Cheap liveness probe for the tool's error messages. */
  async health() {
    const base = String(this.baseUrl ?? '').trim().replace(/\/+$/, '');
    const candidate = base.endsWith('/v1') ? `${base.slice(0, -3)}/healthz` : `${base}/healthz`;
    try {
      const response = await fetch(candidate, { signal: AbortSignal.timeout(5000) });
      return { ok: response.ok, status: response.status, url: candidate };
    } catch (error) {
      return { ok: false, status: 0, url: candidate, error: String(error?.message ?? error) };
    }
  }
}
