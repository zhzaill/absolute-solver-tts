/**
 * Provider-neutral connection checks.
 *
 * These deliberately do not depend on GPT-SoVITS routes. They prove that the
 * plugin can target an origin, a path-prefixed API, or an exact speech URL, and
 * can use a non-Bearer auth header with static routing headers.
 */

import assert from 'node:assert/strict';
import http from 'node:http';

import {
  connectionHeaders,
  healthEndpoints,
  normalizeHttpUrl,
  redactUrl,
  resolveConnection,
  speechEndpoint,
} from '../lib/connection.js';
import { TTSClient } from '../lib/tts.js';
import { resolveConfig } from '../lib/index.js';

let checks = 0;
let failures = 0;
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

function wavFixture() {
  const sampleCount = 1600;
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

console.log('=== URL derivation ===');
check('origin gains the OpenAI v1 speech path', () => {
  assert.equal(speechEndpoint('http://host:18080'), 'http://host:18080/v1/audio/speech');
});
check('/v1 gains only the speech path', () => {
  assert.equal(speechEndpoint('http://host:18080/v1'), 'http://host:18080/v1/audio/speech');
});
check('a path-prefixed API base is preserved', () => {
  assert.equal(speechEndpoint('https://host/edge/tts/v1'), 'https://host/edge/tts/v1/audio/speech');
});
check('a complete speech URL is not appended twice', () => {
  assert.equal(
    speechEndpoint('https://host/edge/tts/v1/audio/speech?api-version=2026-01-01'),
    'https://host/edge/tts/v1/audio/speech?api-version=2026-01-01',
  );
});
check('scheme-less host:port input defaults to http', () => {
  assert.equal(normalizeHttpUrl('host:18080/v1'), 'http://host:18080/v1');
});
check('non-http protocols are rejected', () => {
  assert.throws(() => normalizeHttpUrl('file:///tmp/tts'), /http or https/);
});
check('header injection is rejected', () => {
  assert.throws(
    () => resolveConnection({
      baseUrl: 'http://host/v1',
      authHeader: 'Authorization\r\nX-Injected: yes',
    }),
    /valid HTTP header name/,
  );
});

console.log('=== health discovery ===');
check('root and /v1 bases both probe root health first', () => {
  assert.deepEqual(healthEndpoints('http://host:18080'), [
    'http://host:18080/healthz',
    'http://host:18080/v1/healthz',
  ]);
  assert.deepEqual(healthEndpoints('http://host:18080/v1'), [
    'http://host:18080/healthz',
    'http://host:18080/v1/healthz',
  ]);
});
check('path prefixes stay inside the proxy prefix', () => {
  assert.deepEqual(healthEndpoints('https://host/edge/tts/v1'), [
    'https://host/edge/tts/healthz',
    'https://host/edge/tts/v1/healthz',
  ]);
});
check('an explicit health URL wins', () => {
  assert.deepEqual(healthEndpoints({
    baseUrl: 'https://host/v1',
    healthUrl: 'https://status.example/ready',
  }), ['https://status.example/ready']);
});

console.log('=== headers and payload ===');
const connection = resolveConnection({
  baseUrl: 'https://host/edge/v1',
  apiKey: 'unit' + '-auth',
  authHeader: 'api-key',
  authScheme: '',
  extraHeaders: { 'X-TTS-Route': 'blue' },
  extraBody: { temperature: 0.4, input: 'must not win' },
});
check('non-Bearer auth and static routing headers are emitted', () => {
  const headers = connectionHeaders(connection);
  assert.equal(headers['api-key'], 'unit-auth');
  assert.equal(headers['X-TTS-Route'], 'blue');
  assert.equal('Authorization' in headers, false);
});
check('extra body fields are sent, but core request fields win', () => {
  const client = new TTSClient({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    authHeader: connection.authHeader,
    authScheme: connection.authScheme,
    extraHeaders: connection.extraHeaders,
    extraBody: connection.extraBody,
    model: 'provider-model',
    voice: 'provider-voice',
    language: 'zh',
  });
  const { payload } = client.buildPayload({
    text: 'real input',
    voice: 'provider-voice',
    language: 'zh',
    responseFormat: 'wav',
  });
  assert.equal(payload.temperature, 0.4);
  assert.equal(payload.input, 'real input');
});

console.log('=== redaction and config aliases ===');
check('sensitive query values are redacted', () => {
  const value = redactUrl('https://user:pass@host/speech?api_key=abc&token=def&model=tts');
  assert.equal(value, 'https://host/speech?api_key=***&token=***&model=tts');
});
check('connection block and gatewayUrl alias resolve', () => {
  const config = resolveConfig({
    connection: {
      gatewayUrl: 'https://host/edge/v1',
      speechUrl: 'https://host/edge/v1/audio/speech',
      healthUrl: 'https://host/edge/healthz',
      authHeader: 'api-key',
      authScheme: '',
      extraHeaders: { 'X-Edge': 'one' },
      extraBody: { seed: 7 },
    },
  });
  assert.equal(config.baseUrl, 'https://host/edge/v1');
  assert.equal(config.speechUrl, 'https://host/edge/v1/audio/speech');
  assert.equal(config.authHeader, 'api-key');
  assert.equal(config.extraHeaders['X-Edge'], 'one');
  assert.equal(config.extraBody.seed, 7);
});

console.log('=== exact endpoint against a generic provider ===');
const routeHeader = 'blue';
const apiKey = 'unit' + '-auth';
let receivedAuth = '';
let receivedRoute = '';
let receivedBody = null;
const server = http.createServer(async (request, response) => {
  if (request.url === '/health') {
    receivedAuth = String(request.headers['api-key'] ?? '');
    receivedRoute = String(request.headers['x-tts-route'] ?? '');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  if (request.url === '/custom/speak?api-version=2026-01-01' && request.method === 'POST') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const audio = wavFixture();
    response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(audio.length) });
    response.end(audio);
    return;
  }
  response.writeHead(404).end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

await checkAsync('a custom speech URL authenticates and synthesizes', async () => {
  const client = new TTSClient({
    speechUrl: `${origin}/custom/speak?api-version=2026-01-01`,
    healthUrl: `${origin}/health`,
    apiKey,
    authHeader: 'api-key',
    authScheme: '',
    extraHeaders: { 'X-TTS-Route': routeHeader },
    extraBody: { provider_field: true },
    model: 'provider-model',
    voice: 'provider-voice',
    language: 'zh',
  });
  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(health.reachable, true);
  assert.equal(receivedAuth, apiKey);
  assert.equal(receivedRoute, routeHeader);

  const result = await client.synthesize({ text: 'generic endpoint', language: 'zh' });
  assert.equal(result.wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(receivedBody.provider_field, true);
  assert.equal(receivedBody.text_lang, 'zh');
  assert.equal(receivedBody.input, 'generic endpoint');
});

await new Promise((resolve) => server.close(resolve));

console.log('');
console.log(`=== ${checks - failures}/${checks} connection checks passed ===`);
if (failures > 0) process.exitCode = 1;
