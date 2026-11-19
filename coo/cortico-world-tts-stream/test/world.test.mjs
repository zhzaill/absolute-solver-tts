import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrameParser, FRAME_AUDIO, FRAME_META, parseMeta } from '../src/stream_client.js';
import { lineOf, speakable } from '../src/world.js';

function frame(kind, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32LE(payload.length, 0);
  head.writeUInt8(kind, 4);
  return Buffer.concat([head, payload]);
}

test('speakable 去掉链接、emoji 与标记', () => {
  assert.equal(speakable('看这个 https://example.com/x 很开心 😀 **加粗**'), '看这个 很开心 加粗');
});

test('speakable 超过 600 字会截断', () => {
  const text = speakable('字'.repeat(700));
  assert.equal(text.length, 602);
  assert.ok(text.endsWith('……'));
});

test('lineOf 拼 say 的 beats，ask 只念问题', () => {
  assert.equal(lineOf({ meta: { kind: 'say', beats: [{ text: '第一句' }, { text: '第二句' }] } }), '第一句。 第二句');
  assert.equal(lineOf({ meta: { kind: 'ask', question: '要不要继续？' } }), '要不要继续？');
  assert.equal(lineOf({ meta: { kind: 'activity', steps: ['a'] } }), '');
});

test('FrameParser 能跨 chunk 拼回帧', () => {
  const a = frame(FRAME_META, Buffer.from(JSON.stringify({ kind: 'plan', count: 2 })));
  const b = frame(FRAME_AUDIO, Buffer.from([1, 2, 3, 4]));
  const stream = Buffer.concat([a, b]);
  const parser = new FrameParser();

  const first = parser.push(stream.subarray(0, 3));
  assert.equal(first.length, 0);

  const second = parser.push(stream.subarray(3, 20));
  const third = parser.push(stream.subarray(20));
  const frames = [...first, ...second, ...third];

  assert.equal(frames.length, 2);
  assert.equal(parseMeta(frames[0].payload).count, 2);
  assert.deepEqual([...frames[1].payload], [1, 2, 3, 4]);
});
