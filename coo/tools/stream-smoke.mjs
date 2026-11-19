/**
 * 端到端冒烟：网关分段合成 → 本机播放器。
 *
 * 不经过 Coo，只验证「请求 → 首段音频 → 交给播放器」这条真实链路和它的耗时。
 *
 *   $env:TTS_KEY = '...'; node coo/tools/stream-smoke.mjs "要说的话"
 *
 * 退出码：0 = 收到至少一段音频；1 = 一段都没收到。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { streamSegments } from '../cortico-world-tts-stream/src/stream_client.js';

const base = (process.env.TTS_BASE || 'http://127.0.0.1:18080').replace(/\/+$/, '');
const text = process.argv[2] || '你好，我是科提科。这一句是分段合成的第一段，后面还有第二段。';
const voice = process.env.TTS_VOICE || '';
const key = process.env.TTS_KEY || '';
const play = process.env.TTS_PLAY !== '0';

const dir = mkdtempSync(join(tmpdir(), 'tts-smoke-'));
const started = Date.now();

let player = null;
if (play) {
  const script = new URL('../cortico-world-tts-stream/src/player.ps1', import.meta.url).pathname
    .replace(/^\/([A-Za-z]:)/, '$1');
  player = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  player.stdout.setEncoding('utf8');
  player.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      try {
        const frame = JSON.parse(line);
        console.log(JSON.stringify({ event: 'played', ...frame, at_ms: Date.now() - started }));
      } catch {
        console.log(JSON.stringify({ event: 'player', line }));
      }
    }
  });
}

const segments = [];
const summary = await streamSegments(
  `${base}/v1/audio/segments`,
  { input: text, ...(voice ? { voice } : {}) },
  {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    timeoutMs: 180000,
    onMeta: (meta) => {
      if (meta.kind === 'plan') console.log(JSON.stringify({ event: 'plan', units: meta.units, at_ms: Date.now() - started }));
      if (meta.kind === 'segment') console.log(JSON.stringify({ event: 'segment', index: meta.index, chars: meta.chars, status: meta.status, lead_ms: meta.lead_ms, audio_s: meta.audio_seconds, upstream_ms: meta.upstream_ms, at_ms: Date.now() - started }));
    },
    onAudio: (wav, meta) => {
      const index = typeof meta?.index === 'number' ? meta.index : segments.length;
      const path = join(dir, `seg-${String(index).padStart(2, '0')}.wav`);
      writeFileSync(path, wav);
      const at = Date.now() - started;
      segments.push({ index, path, bytes: wav.length, at });
      if (player) player.stdin.write(`${JSON.stringify({ id: String(index), path })}\n`);
      console.log(JSON.stringify({ event: 'handoff', index, bytes: wav.length, at_ms: at }));
    },
  },
);

await new Promise((resolve) => setTimeout(resolve, 400));
console.log(JSON.stringify({
  event: 'summary',
  text,
  segments: summary.segments,
  firstAudioMs: summary.firstAudioMs,
  totalMs: summary.totalMs,
  files: dir,
}, null, 1));

if (player) {
  player.stdin.end();
  setTimeout(() => player.kill(), 300);
}
process.exit(summary.segments > 0 ? 0 : 1);
