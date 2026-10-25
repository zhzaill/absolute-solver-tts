/**
 * Standalone selftest for dsh-tts.
 *
 * Everything here runs without a cordis context, which is exactly why
 * `createRuntime` is separated from `apply`. It checks the two things that can
 * genuinely be wrong before the plugin ever reaches DSH:
 *
 *   the language logic   — does it resolve the language we intend?
 *   the TTS contract     — can it really get audio out of the gateway?
 *
 * Run: node tools/selftest.mjs
 */

import assert from 'node:assert/strict';

import { detectTextLanguage, normalizeLanguage, resolveSynthesisLanguage } from '../lib/lang.js';
import { TTSClient, wavInfo, speechEndpoint, TTSError } from '../lib/tts.js';
import { AudioStore, audioKey } from '../lib/store.js';
import { createRuntime, resolveConfig } from '../lib/index.js';

let failures = 0;
let checks = 0;

function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ok    ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${label}\n        ${error?.message ?? error}`);
  }
}

async function checkAsync(label, fn) {
  checks += 1;
  try {
    await fn();
    console.log(`  ok    ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${label}\n        ${error?.message ?? error}`);
  }
}

console.log('=== language normalisation ===');
check('日文 -> ja', () => assert.equal(normalizeLanguage('日文'), 'ja'));
check('中文 -> zh', () => assert.equal(normalizeLanguage('中文'), 'zh'));
check('英文 -> en', () => assert.equal(normalizeLanguage('英文'), 'en'));
check('unknown -> auto', () => assert.equal(normalizeLanguage('klingon'), 'auto'));
check('empty -> auto', () => assert.equal(normalizeLanguage(''), 'auto'));

console.log('=== script detection ===');
check('Japanese sentence -> ja', () => assert.equal(detectTextLanguage('今日のデプロイは無事に完了したわ。'), 'ja'));
check('Chinese sentence -> zh', () => assert.equal(detectTextLanguage('今天的部署已顺利完成。'), 'zh'));
check('Han-only -> zh (the ambiguity that broke the gateway)', () =>
  assert.equal(detectTextLanguage('今日無事完了'), 'zh'));
check('kana-only -> ja', () => assert.equal(detectTextLanguage('テストです'), 'ja'));
check('English -> en', () => assert.equal(detectTextLanguage('deploy complete'), 'en'));
check('digits only -> empty', () => assert.equal(detectTextLanguage('12345'), ''));

console.log('=== resolution precedence ===');
check('explicit wins', () => {
  const r = resolveSynthesisLanguage('今日のデプロイ', { explicit: 'zh', configured: 'ja' });
  assert.deepEqual([r.code, r.reason], ['zh', 'explicit']);
});
check('inferred beats configured', () => {
  const r = resolveSynthesisLanguage('今日のデプロイは無事に完了したわ。', { configured: 'zh' });
  assert.deepEqual([r.code, r.reason], ['ja', 'inferred']);
});
check('auto can be disabled', () => {
  const r = resolveSynthesisLanguage('今日のデプロイ', { configured: 'zh', auto: false });
  assert.deepEqual([r.code, r.reason], ['zh', 'configured']);
});
check('Chinese text resolves to zh, not to the default', () => {
  const r = resolveSynthesisLanguage('今天天气不错。', { configured: 'ja' });
  assert.deepEqual([r.code, r.reason], ['zh', 'inferred']);
});

console.log('=== endpoint joining ===');
check('appends the speech path', () =>
  assert.equal(speechEndpoint('http://h:1/v1'), 'http://h:1/v1/audio/speech'));
check('does not double it', () =>
  assert.equal(speechEndpoint('http://h:1/v1/audio/speech'), 'http://h:1/v1/audio/speech'));
check('tolerates a trailing slash', () =>
  assert.equal(speechEndpoint('http://h:1/v1/'), 'http://h:1/v1/audio/speech'));
check('rejects an empty base', () => assert.throws(() => speechEndpoint(''), TTSError));

console.log('=== store ===');
check('LRU keeps the newest entries', () => {
  const store = new AudioStore(2);
  store.put('a', { bytes: Buffer.from([1]) });
  store.put('b', { bytes: Buffer.from([2]) });
  store.put('c', { bytes: Buffer.from([3]) });
  assert.equal(store.size(), 2);
  assert.equal(store.has('a'), false);
  assert.equal(store.has('c'), true);
});
check('keys are stable and distinct', () => {
  const base = { baseUrl: 'u', model: 'm', voice: 'v', language: 'zh', promptLanguage: 'zh', speed: 1, text: 'x' };
  assert.equal(audioKey(base), audioKey({ ...base }));
  assert.notEqual(audioKey(base), audioKey({ ...base, text: 'y' }));
  assert.notEqual(audioKey(base), audioKey({ ...base, language: 'ja' }));
});

const testBaseUrl = process.env.DSH_TTS_TEST_BASE_URL?.trim();
const config = resolveConfig(testBaseUrl ? { baseUrl: testBaseUrl } : {});
console.log(`=== live endpoint: ${config.baseUrl} voice=${config.voice} ===`);

/**
 * Report a check that could not run, without calling it a failure.
 *
 * The GPU is shared with other work, so the upstream being stopped is a normal
 * state. A suite that goes red for it teaches people to ignore red — which is
 * the opposite of what a verification suite is for.
 */
function skip(label, reason) {
  console.log(`  skip  ${label} — ${reason}`);
}

const client = new TTSClient({
  baseUrl: config.baseUrl,
  speechUrl: config.speechUrl,
  healthUrl: config.healthUrl,
  apiKey: config.apiKey,
  authHeader: config.authHeader,
  authScheme: config.authScheme,
  extraHeaders: config.extraHeaders,
  extraBody: config.extraBody,
  model: config.model,
  voice: config.voice,
  timeoutMs: config.timeoutMs,
  language: config.language,
  promptLanguage: config.promptLanguage,
});
const health = await client.health();
const LIVE = health.ok || health.reachable;
if (!LIVE) {
  console.log('');
  console.log(`  note  upstream unreachable at ${config.baseUrl}`);
  console.log('  note  live synthesis checks are SKIPPED, not failed; offline checks still run');
  console.log('');
}

if (LIVE) {
  await checkAsync('endpoint is reachable', async () => {
    const health = await client.health();
    assert.equal(health.reachable, true, `health probe failed: ${JSON.stringify(health)}`);
  });

  await checkAsync('Chinese synthesis returns a valid WAV', async () => {
  const result = await client.synthesize({ text: '这是插件自检，说的是中文。', language: 'zh' });
  assert.ok(result.wav.length > 1000, `too few bytes: ${result.wav.length}`);
  assert.ok(result.info !== null, 'WAV header did not parse');
  assert.ok(result.info.sampleRate >= 8000 && result.info.sampleRate <= 96000,
    `implausible sample rate ${result.info.sampleRate}`);
  assert.ok(result.info.durationSeconds > 0.5, `too short: ${result.info.durationSeconds}`);
  assert.equal(result.language, 'zh');
  console.log(`        bytes=${result.wav.length} rate=${result.info.sampleRate} `
    + `dur=${result.info.durationSeconds.toFixed(2)}s channels=${result.info.channels}`);
  });
} else {
  skip('endpoint is reachable', 'upstream stopped');
  skip('Chinese synthesis returns a valid WAV', 'upstream stopped');
}

await checkAsync('the payload declares the text language', async () => {
  // The failure this guards against: omitting the language let the gateway fall
  // back to a Chinese frontend for Japanese text and drop every kana.
  const { payload } = client.buildPayload({ text: '今日のデプロイは無事に完了したわ。', responseFormat: 'wav' });
  assert.equal(payload.text_lang, 'ja');
  assert.equal(payload.prompt_lang, config.promptLanguage);
  assert.equal(payload.input, '今日のデプロイは無事に完了したわ。');
});

await checkAsync('an explicit language overrides inference', async () => {
  const { payload, resolved } = client.buildPayload({
    text: '今日のデプロイは無事に完了したわ。', language: 'zh', responseFormat: 'wav',
  });
  assert.equal(payload.text_lang, 'zh');
  assert.equal(resolved.reason, 'explicit');
});

if (LIVE) {
  await checkAsync('runtime caches an identical request', async () => {
    const runtime = createRuntime(config);
    const first = await runtime.synthesize({ text: '缓存检查。', voice: config.voice, language: 'zh', speed: 1 });
    const second = await runtime.synthesize({ text: '缓存检查。', voice: config.voice, language: 'zh', speed: 1 });
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.id, first.id);
    console.log(`        id=${first.id} bytes=${first.bytes} dur=${first.durationSeconds.toFixed(2)}s`);
  });
} else {
  skip('runtime caches an identical request', 'upstream stopped');
}

await checkAsync('a blank request is rejected before any network call', async () => {
  await assert.rejects(() => client.synthesize({ text: '   ' }), TTSError);
});

console.log('');
console.log(`=== ${checks - failures}/${checks} checks passed ===`);
if (failures > 0) process.exitCode = 1;
