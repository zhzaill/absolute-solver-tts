/**
 * Verify the plugin MOUNTS and SERVES, without restarting the Harness.
 *
 * The two earlier verifications stop short of the interesting part:
 *   selftest.mjs        proves the logic is right
 *   verify-install.mjs  proves the artifact resolves and exports the contract
 *
 * This one runs `apply()` against a mock cordis context and then serves the
 * registered route from a REAL http server, so it exercises everything the
 * Harness will do except the loader itself:
 *
 *   apply()                 ->  does the plugin body run at all?
 *   ctx.tools.register      ->  are exactly the intended tools published?
 *   ctx.inject(['webServer'])->  is the optional service handled, not required?
 *   webServer.register      ->  is the same-origin route published?
 *   a real fetch            ->  does a Chinese sentence come back as playable WAV?
 *
 * Restarting the Harness ends the session that would run this test, so the
 * remaining unverified step is deliberately isolated to the loader.
 *
 * Run: node tools/verify-mount.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';

import { apply, resolveConfig, createRuntime } from '../lib/index.js';
import { TTSClient, wavInfo } from '../lib/tts.js';
import { checkRegisterPreconditions, findLosslessJsonViolations } from './verify-schemas.mjs';

let failures = 0;
const log = [];

function check(label, fn) {
  try {
    fn();
    log.push(`  ok    ${label}`);
  } catch (error) {
    failures += 1;
    log.push(`  FAIL  ${label}\n        ${error?.message ?? error}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    log.push(`  ok    ${label}`);
  } catch (error) {
    failures += 1;
    log.push(`  FAIL  ${label}\n        ${error?.message ?? error}`);
  }
}

/* ---------------------------------------------------------------- mock cordis */

function makeMockContext({ withWebServer = true, withSystemPrompt = true } = {}) {
  const state = {
    tools: new Map(),
    routes: [],
    sections: [],
    effects: [],
    injections: [],
    logs: [],
  };

  const webServer = {
    register(route) {
      state.routes.push(route);
      return () => {
        const index = state.routes.indexOf(route);
        if (index >= 0) state.routes.splice(index, 1);
      };
    },
  };

  const systemPrompt = {
    section(section) {
      // Mirrors the shipped validator: a non-finite order throws.
      if (!Number.isFinite(section.order)) {
        throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
      }
      state.sections.push(section);
      return () => {
        const index = state.sections.indexOf(section);
        if (index >= 0) state.sections.splice(index, 1);
      };
    },
    getSectionOrder(shortName) {
      return { HARNESS_IDENTITY: -1000, DEPLOYMENT_PERSONA_PREFIX: 0, PLAN_POLICY: 500,
        TEAM_POLICY: 600, PTC_ONLY: 800, FILE_REFERENCE: 900,
        DEPLOYMENT_PERSONA_SUFFIX: 10200 }[shortName];
    },
  };

  function service(name) {
    if (name === 'tools') return { register: (definition) => {
      state.tools.set(definition.name, definition);
      return () => state.tools.delete(definition.name);
    } };
    if (name === 'webServer') return withWebServer ? webServer : undefined;
    if (name === 'systemPrompt') return withSystemPrompt ? systemPrompt : undefined;
    return undefined;
  }

  const ctx = {
    logger: {
      info: (message) => state.logs.push(String(message)),
      warn: (message) => state.logs.push(String(message)),
      error: (message) => state.logs.push(String(message)),
    },
    get: service,
    tools: service('tools'),
    effect(fn, label) {
      state.effects.push(label);
      const dispose = fn();
      return dispose;
    },
    inject(names, callback) {
      state.injections.push(names.join(','));
      // cordis runs the callback in a child scope once the services exist, and
      // the callback's context exposes them as *properties* — that is how the
      // shipped prompt-contributing plugins call `inner.systemPrompt.section()`.
      // Exposing only `get()` here made the contract section silently vanish.
      if (names.every((name) => service(name) !== undefined)) {
        const child = {
          get: service,
          effect(fn, label) {
            state.effects.push(label);
            return fn();
          },
        };
        for (const name of names) child[name] = service(name);
        callback(child);
      }
    },
  };

  return { ctx, state, webServer };
}

/* ------------------------------------------------------------------ the test */

log.push('=== apply() against a mock cordis context ===');
const { ctx, state } = makeMockContext();
await apply(ctx, {
  baseUrl: process.env.DSH_TTS_TEST_BASE_URL ?? 'http://127.0.0.1:18080/v1',
  voice: 'local_voice',
  language: 'zh',
  promptLanguage: 'zh',
});

check('apply() completed and logged readiness', () => {
  assert.ok(state.logs.some((line) => line.includes('[dsh-tts] ready')),
    `no readiness log; got: ${JSON.stringify(state.logs)}`);
});
check('it declared the tools effect', () =>
  assert.ok(state.effects.includes('dsh-tts: tools'), `effects: ${JSON.stringify(state.effects)}`));
check('it requested the webServer service', () =>
  assert.ok(state.injections.includes('webServer'), `injections: ${JSON.stringify(state.injections)}`));
check('it requested the systemPrompt service', () =>
  assert.ok(state.injections.includes('systemPrompt'), `injections: ${JSON.stringify(state.injections)}`));

log.push('');
log.push('=== the voice contract is contributed by the plugin, not the persona ===');
check('exactly one prompt section is contributed', () =>
  assert.equal(state.sections.length, 1, `sections: ${JSON.stringify(state.sections.map((s) => s.name))}`));
check('the section has the documented stable name', () =>
  assert.equal(state.sections[0]?.name, 'dsh-tts-voice-contract'));
check('the section order is a finite number', () =>
  assert.ok(Number.isFinite(state.sections[0]?.order), `order=${state.sections[0]?.order}`));
check('the section sits in the policy band, before every tool section', () => {
  // Shipped policy sections are PLAN_POLICY 500 and TEAM_POLICY 600; the first
  // tool section is TOOL_BASH 1000. A contract is policy, so it belongs here.
  const order = state.sections[0]?.order;
  assert.ok(order > 600 && order < 1000, `order ${order} is outside the free policy slot`);
});
check('the section states all four contract parts', () => {
  const text = String(state.sections[0]?.text ?? '');
  assert.ok(text.includes('中文'), 'missing the language contract');
  assert.ok(text.includes('tts_speak'), 'missing the speech obligation');
  assert.ok(text.includes('读') && (text.includes('表格') || text.includes('代码块')),
    'missing the speakability rules');
  assert.ok(text.includes('能力边界') || text.includes('没有 Shell'),
    'missing the capability boundary');
  log.push(`        section "${state.sections[0]?.name}" at order ${state.sections[0]?.order}, `
    + `${text.length} chars`);
});
check('it mounted the same-origin route effect', () =>
  assert.ok(state.effects.includes('dsh-tts: same-origin audio route'), `effects: ${JSON.stringify(state.effects)}`));

check('exactly two tools are published', () =>
  assert.deepEqual([...state.tools.keys()].sort(), ['tts_speak', 'tts_status']));

check('every published definition satisfies the real register() preconditions', () => {
  for (const definition of state.tools.values()) {
    const violations = checkRegisterPreconditions(definition);
    assert.deepEqual(violations, [], `${definition.name}: ${JSON.stringify(violations)}`);
  }
});

check('tts_speak has a well-formed definition', () => {
  const tool = state.tools.get('tts_speak');
  assert.equal(typeof tool.execute, 'function');
  assert.equal(tool.parameters.type, 'object');
  assert.ok(tool.parameters.properties.text, 'text parameter missing');
  assert.deepEqual(tool.parameters.required, ['text']);
  assert.equal(typeof tool.output.render, 'function');
  assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0, 'timeoutMs must be a positive number');
});

check('tts_status has no required parameters', () => {
  const tool = state.tools.get('tts_status');
  assert.deepEqual(tool.parameters.required, []);
});

check('both intended routes are registered', () => {
  const paths = state.routes.map((route) => route.path).sort();
  assert.deepEqual(paths, ['/dsh-tts/audio', '/dsh-tts/status'], `routes: ${JSON.stringify(paths)}`);
  for (const route of state.routes) {
    assert.equal(route.kind, 'exact', `${route.path} must be an exact match`);
    assert.equal(typeof route.handler, 'function', `${route.path} has no handler`);
  }
});

log.push('');
log.push('=== a profile without a web server must still load ===');
const headless = makeMockContext({ withWebServer: false });
await checkAsync('apply() succeeds headless and still publishes tools', async () => {
  await apply(headless.ctx, { voice: 'local_voice', language: 'zh' });
  assert.deepEqual([...headless.state.tools.keys()].sort(), ['tts_speak', 'tts_status']);
  assert.equal(headless.state.routes.length, 0, 'no web server should mean no routes');
});

/* ------------------------------------------- serve the route over real HTTP */

log.push('');
log.push('=== what actually goes out on the wire ===');

await checkAsync('no Authorization header is sent when no API key is configured', async () => {
  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), headers: init?.headers ?? {}, body: init?.body });
    return realFetch(url, init);
  };
  try {
    const client = createRuntime(resolveConfig({ voice: 'local_voice', language: 'zh' }));
    try {
      await client.synthesize({ text: '出网请求头检查。', voice: 'local_voice', language: 'zh', speed: 1 });
    } catch {
      // Whether the upstream answers is not what this check measures. It inspects
      // the request that was built and sent, and the interception above captured
      // that before the transport failed — so a stopped service does not make
      // this check meaningless.
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(captured.length >= 1, 'no outbound request was captured');
  const post = captured.find((entry) => entry.url.includes('/audio/speech'));
  assert.ok(post !== undefined, `no speech request captured: ${JSON.stringify(captured.map((c) => c.url))}`);
  assert.equal('Authorization' in post.headers, false,
    `unexpected Authorization header: ${post.headers.Authorization}`);
  // The declared language must survive to the wire; that is the point of the package.
  const payload = JSON.parse(post.body);
  assert.equal(payload.text_lang, 'zh');
  assert.equal(payload.input, '出网请求头检查。');
  log.push(`        POST ${post.url}`);
  log.push(`        headers: ${JSON.stringify(Object.keys(post.headers))}`);
  log.push(`        body keys: ${JSON.stringify(Object.keys(payload))}`);
});

log.push('');
log.push('=== same-origin serving over a real http server ===');

// Mount the routes exactly the way `apply` does, so the runtime the route closes
// over is the same runtime the tool writes into.
const live = makeMockContext();
const server = http.createServer((request, response) => {
  for (const route of live.state.routes) {
    if (route.path === new URL(request.url ?? '/', 'http://localhost').pathname) {
      void route.handler(request, response);
      return;
    }
  }
  response.writeHead(404).end('not found');
});

const TEST_BASE_URL = process.env.DSH_TTS_TEST_BASE_URL ?? 'http://127.0.0.1:18080/v1';
const TEST_CONFIG = resolveConfig({
  baseUrl: TEST_BASE_URL,
  voice: 'local_voice',
  language: 'zh',
  promptLanguage: 'zh',
});

await apply(live.ctx, {
  baseUrl: TEST_BASE_URL,
  voice: 'local_voice',
  language: 'zh',
  promptLanguage: 'zh',
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
log.push(`  note  test server listening on ${origin}`);

/**
 * Probe the upstream before running anything that needs it.
 *
 * The GPU is shared with other work, so the upstream being stopped is a normal
 * state, not a defect in this plugin. Failing here would make the suite red for
 * something it does not own — and a suite that goes red for a normal state
 * teaches people to ignore red.
 */
async function upstreamHealth() {
  const client = new TTSClient({
    baseUrl: TEST_CONFIG.baseUrl,
    speechUrl: TEST_CONFIG.speechUrl,
    healthUrl: TEST_CONFIG.healthUrl,
    apiKey: TEST_CONFIG.apiKey,
    authHeader: TEST_CONFIG.authHeader,
    authScheme: TEST_CONFIG.authScheme,
    extraHeaders: TEST_CONFIG.extraHeaders,
    extraBody: TEST_CONFIG.extraBody,
    model: TEST_CONFIG.model,
    voice: TEST_CONFIG.voice,
    timeoutMs: TEST_CONFIG.timeoutMs,
    language: TEST_CONFIG.language,
    promptLanguage: TEST_CONFIG.promptLanguage,
  });
  return client.health();
}

function skip(label, reason) {
  const line = `  skip  ${label} — ${reason}`;
  console.log(line);
  log.push(line);
}

const HEALTH = await upstreamHealth();
const LIVE = HEALTH.ok || HEALTH.reachable;
if (!LIVE) {
  const note = `  note  upstream unreachable at ${TEST_BASE_URL}; `
    + 'execution checks are SKIPPED, not failed';
  console.log(note);
  log.push(note);
}

const speak = live.state.tools.get('tts_speak');
const SENTENCE = '这是一句用来验证同源播放的中文。';

// Everything from here to the cache check needs a working upstream, because the
// tools are executed for real. The route checks after it do not.
if (LIVE) {
let result;
await checkAsync('tts_speak synthesizes a Chinese sentence', async () => {
  result = await speak.execute({ text: SENTENCE });
  assert.equal(result.ok, true, `tool reported failure: ${JSON.stringify(result)}`);
  assert.equal(result.language, 'zh', `expected zh, got ${result.language}`);
  assert.ok(result.bytes > 1000, `too few bytes: ${result.bytes}`);
  assert.ok(result.url.startsWith('/dsh-tts/audio?id='), `unexpected url: ${result.url}`);
  log.push(`        ${result.characters} chars -> ${result.bytes} bytes, `
    + `${result.durationSeconds.toFixed(2)}s @ ${result.sampleRate} Hz, lang=${result.language} (${result.languageReason})`);
});

await checkAsync('the tool\'s own render() explains the result', () => {
  const parts = speak.output.render({}, result);
  const text = parts.map((part) => part.text).join('\n');
  assert.ok(text.includes('zh'), 'render does not mention the language');
  assert.ok(text.includes(result.url), 'render does not include the url');
});

await checkAsync('every result the tool can return is lossless JSON', async () => {
  // A key holding `undefined` fails the framework's lossless-JSON validation and
  // takes the whole result down, so both the success and the rejected shapes are
  // checked rather than only the happy path.
  assert.deepEqual(findLosslessJsonViolations(result), [], 'success result is not lossless JSON');
  const rejected = await speak.execute({ text: '   ' });
  assert.equal(rejected.ok, false);
  assert.deepEqual(findLosslessJsonViolations(rejected), [], 'rejected result is not lossless JSON');
  const status = await live.state.tools.get('tts_status').execute();
  assert.deepEqual(findLosslessJsonViolations(status), [], 'status result is not lossless JSON');
  log.push('        success / rejected / status results all round-trip as lossless JSON');
});

let fetched;
await checkAsync('the audio is retrievable from this origin', async () => {
  const response = await fetch(origin + result.url);
  assert.equal(response.status, 200, `HTTP ${response.status}`);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  fetched = Buffer.from(await response.arrayBuffer());
  assert.equal(fetched.length, result.bytes, 'served length differs from the reported length');
});

check('the served bytes are a valid WAV', () => {
  const info = wavInfo(fetched);
  assert.ok(info !== null, 'served body did not parse as WAV');
  assert.equal(info.channels, 1);
  assert.ok(info.sampleRate >= 8000, `implausible rate ${info.sampleRate}`);
  assert.ok(info.durationSeconds > 0.5, `implausibly short ${info.durationSeconds}`);
  log.push(`        served ${fetched.length} bytes -> ${info.sampleRate} Hz, `
    + `${info.channels}ch, ${info.bitsPerSample}-bit, ${info.durationSeconds.toFixed(2)}s`);
});

await checkAsync('a second identical request reuses the cached entry', async () => {
  const again = await speak.execute({ text: SENTENCE });
  assert.equal(again.cached, true, 'expected a cache hit');
  assert.equal(again.id, result.id, 'cache key changed for identical input');
});
} else {
  const reason = 'upstream stopped';
  for (const label of [
    'tts_speak synthesizes a Chinese sentence',
    "the tool's own render() explains the result",
    'every result the tool can return is lossless JSON',
    'the audio is retrievable from this origin',
    'the served bytes are a valid WAV',
    'a second identical request reuses the cached entry',
  ]) skip(label, reason);
  // The 404 and status-route checks below still run: the route serves them
  // without touching the upstream.
}

await checkAsync('an unknown id is a clean 404, not a crash', async () => {
  const response = await fetch(`${origin}/dsh-tts/audio?id=deadbeef`);
  assert.equal(response.status, 404);
  await response.text();
});

await checkAsync('the status route reports effective config and upstream health', async () => {
  const response = await fetch(`${origin}/dsh-tts/status`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  const body = JSON.parse(await response.text());
  assert.equal(body.baseUrl, TEST_CONFIG.baseUrl);
  assert.equal(body.speechUrl.endsWith('/audio/speech'), true);
  assert.ok(body.healthUrl.endsWith('/healthz'));
  assert.equal(body.voice, 'local_voice');
  assert.equal(body.language, 'zh');
  assert.equal(body.hasApiKey, false);
  // Assert that the route reports reality, not that reality is "up". A hardcoded
  // `true` here would make this check fail whenever the GPU is lent out, and
  // pass whenever it is not — measuring the environment rather than the route.
  assert.equal(body.ok, HEALTH.ok, `status route disagrees with the probe: ${JSON.stringify(body.upstream)}`);
  assert.equal(body.reachable, HEALTH.reachable, 'status route reachability disagrees with the probe');
  // The status route reports *whether* a key is set, never the key itself.
  // Assert the absence of the key rather than substring-matching the payload:
  // `hasApiKey` contains the substring and would satisfy a sloppy check.
  assert.equal(Object.hasOwn(body, 'apiKey'), false, 'status route echoed an apiKey field');
  assert.equal(typeof body.hasApiKey, 'boolean', 'hasApiKey must be a boolean flag');
  log.push(`        upstream ${body.upstream.url} -> ok=${body.upstream.ok}, cachedAudio=${body.cachedAudio}`);
});

await checkAsync('a Japanese sentence is declared as ja, not silently read as Chinese', async () => {
  // The defect this guards against is a *declaration* defect — the wrong
  // frontend chosen because nothing on the wire said what the text was. So it is
  // checked at the declaration, always, and only the rendered audio needs the
  // upstream. Asserting it through a live render would make the check measure
  // the environment instead of the contract.
  const japaneseText = '今日のデプロイは無事に完了したわ。';
  const probe = new TTSClient({
    baseUrl: TEST_CONFIG.baseUrl,
    speechUrl: TEST_CONFIG.speechUrl,
    healthUrl: TEST_CONFIG.healthUrl,
    authHeader: TEST_CONFIG.authHeader,
    authScheme: TEST_CONFIG.authScheme,
    extraHeaders: TEST_CONFIG.extraHeaders,
    extraBody: TEST_CONFIG.extraBody,
    model: TEST_CONFIG.model,
    voice: 'local_voice',
    language: 'zh',
    promptLanguage: 'zh',
  });
  const declared = probe.buildPayload({ text: japaneseText, responseFormat: 'wav' });
  assert.equal(declared.payload.text_lang, 'ja', 'kana text must declare ja');
  assert.equal(declared.resolved.reason, 'inferred');
  log.push(`        declared text_lang=${declared.payload.text_lang} (${declared.resolved.reason})`);

  if (!LIVE) {
    skip('the Japanese render itself', 'upstream stopped');
    return;
  }
  const japanese = await speak.execute({ text: japaneseText });
  assert.equal(japanese.ok, true);
  assert.equal(japanese.language, 'ja', `expected ja, got ${japanese.language}`);
  assert.equal(japanese.languageReason, 'inferred');
  log.push(`        ja -> ${japanese.bytes} bytes, ${japanese.durationSeconds.toFixed(2)}s (${japanese.languageReason})`);
});

await new Promise((resolve) => server.close(resolve));

console.log(log.join('\n'));
console.log('');
console.log(failures === 0
  ? '=== mount and same-origin serving verified ==='
  : `=== ${failures} check(s) failed ===`);
if (failures > 0) process.exitCode = 1;
