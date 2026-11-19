/**
 * World 集成测试：假事件库 + 假网关，验证「气泡 → 分段合成 → 落盘 → 交播放器」整条自身逻辑。
 *
 * 不碰真 Coo、不碰真网关、不播放：播放器被替换成记录器。
 * 这里验的是 World 最容易错的三件事：
 *   1. 只认 desktop-pet.self 的 say/ask，并且只处理游标之后的新事件；
 *   2. 音频按到达顺序、用 meta.index 命名落盘，播放按同一顺序排队；
 *   3. 新一轮会顶掉旧一轮（旧一轮的后续段不再送播放器）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { TtsStreamWorld } from '../src/world.js';

function frame(kind, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32LE(payload.length, 0);
  head.writeUInt8(kind, 4);
  return Buffer.concat([head, payload]);
}

function wav(seconds = 0.2, rate = 16000) {
  const samples = Math.round(rate * seconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(i % 2 ? 4000 : -4000, i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/** 假网关：把入参文本按「，」切成两段，依次吐 meta + 音频。 */
function startGateway() {
  const closed = { server: null };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const input = JSON.parse(body || '{}').input ?? '';
      const units = String(input).split(/[。，]/).map((s) => s.trim()).filter(Boolean);
      res.writeHead(200, { 'content-type': 'application/x-tts-segments' });
      res.write(frame(0, Buffer.from(JSON.stringify({ kind: 'plan', units, count: units.length }))));
      units.forEach((text, index) => {
        res.write(frame(0, Buffer.from(JSON.stringify({
          kind: 'segment', index, text, chars: text.length, status: 'ok', audio_seconds: 0.2,
        }))));
        res.write(frame(1, wav()));
      });
      res.write(frame(0, Buffer.from(JSON.stringify({ kind: 'done', segments: units.length }))));
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      closed.server = server;
      resolve({ port: server.address().port, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

function fakeHost(events) {
  return {
    store: {
      latestCursor: () => 0,
      range: ({ fromCursor = 0, limit = 50 }) => events.filter((e) => e.cursor >= fromCursor).slice(0, limit),
    },
    pushEvent: async () => ({}),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

test('气泡事件被切成两段、按序落盘并按序排队播放', async () => {
  const gateway = await startGateway();
  const dir = mkdtempSync(join(tmpdir(), 'tts-world-'));
  const played = [];
  const events = [
    { cursor: 1, type: 'desktop-pet.self', meta: { kind: 'say', beats: [{ text: '第一句话' }, { text: '第二句话' }] } },
    { cursor: 2, type: 'desktop-pet.self', meta: { kind: 'activity', steps: ['pet_move_to'] } },
  ];
  const world = new TtsStreamWorld({
    cfg: { baseUrl: `http://127.0.0.1:${gateway.port}`, scanMs: 50, play: true, voice: 'v1' },
    dataDir: dir,
    secret: () => '',
    // 不启动 PowerShell：把落盘路径记下来就算「进了播放队列」
    onPlay: (path) => played.push({ name: path.split(/[\\/]/).pop(), bytes: 0 }),
  });

  try {
    await world.start(fakeHost(events));
    await world.speak('第一句话。第二句话。', { origin: 'pet' });

    const files = readdirSync(join(dir, 'tts-stream', 'segments')).sort();
    assert.equal(files.length, 2);
    assert.match(files[0], /-00\.wav$/);
    assert.match(files[1], /-01\.wav$/);
    assert.equal(played.length, 2, '两段都应送进播放队列');
    assert.match(world.statusText(), /网关/);
    assert.equal(world.lastTurn.segments, 2);
  } finally {
    await world.stop();
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('新一轮顶掉旧一轮：旧一轮的后续段不再送播放器', async () => {
  const gateway = await startGateway();
  const dir = mkdtempSync(join(tmpdir(), 'tts-world-'));
  const played = [];
  const world = new TtsStreamWorld({
    cfg: { baseUrl: `http://127.0.0.1:${gateway.port}`, play: true },
    dataDir: dir,
    secret: () => '',
    onPlay: (path) => played.push(path),
  });

  try {
    await world.start(fakeHost([]));
    const first = world.speak('旧的甲，旧的乙。', { origin: 'tool' });
    const second = world.speak('新的丙，新的丁。', { origin: 'tool' });
    const [a, b] = await Promise.allSettled([first, second]);
    assert.equal(b.status, 'fulfilled');
    // 第一轮在开始前后被顶掉：它最多来得及送出一段
    assert.ok(played.length >= 2 && played.length <= 3, `实际送播 ${played.length} 段`);
    assert.equal(world.lastTurn.segments, 2);
    assert.ok(a.status === 'fulfilled');
  } finally {
    await world.stop();
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
