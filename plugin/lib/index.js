/**
 * dsh-tts host entry: gives the agent a voice.
 *
 * Wires three things and unmounts all of them with the plugin fiber:
 *
 *   tools    `tts_speak` and `tts_status` in the model-facing registry
 *   routes   a same-origin audio endpoint under the Harness web origin
 *   config   defaults from the bundle patch, overridable by environment
 *
 * `tools` is a required service: the fiber must wait for it, because reading
 * `ctx.tools` without declaring it is what cordis rejects with
 * "cannot get property \"tools\" without inject". `webServer` stays OUT of the
 * inject list and is acquired through `ctx.inject` instead, so the plugin still
 * works in a headless profile with no web server at all — it simply loses the
 * playback route and says so.
 */

import { TTSClient } from './tts.js';
import { AudioStore, audioKey } from './store.js';
import { registerTTSTools } from './tools.js';
import { mountTTSRoutes } from './routes.js';
import { registerVoiceContract } from './contract.js';
import { parseObject } from './connection.js';

export const name = 'dsh-tts';

/** Required services. Optional ones are acquired with `ctx.inject` instead. */
export const inject = ['tools'];

const DEFAULTS = {
  /** The GPT-SoVITS OpenAI-compatible gateway on the model server. */
  baseUrl: 'http://127.0.0.1:18080/v1',
  /** Browser-facing Harness origin used to make returned audio links clickable. */
  publicBaseUrl: 'http://127.0.0.1:19387',
  speechUrl: '',
  healthUrl: '',
  model: 'tts-1',
  /** Voice id registered on the gateway. */
  voice: 'local_voice',
  /** Language of the reference audio that voice conditions on. */
  promptLanguage: 'zh',
  /** Default synthesis language: Chinese, as requested. */
  language: 'zh',
  apiKey: '',
  authHeader: 'Authorization',
  authScheme: 'Bearer',
  extraHeaders: {},
  extraBody: {},
  timeoutMs: 120_000,
  cacheEntries: 32,
};

const AUDIO_BASE_PATH = '/dsh-tts/audio';

/**
 * First non-nullish value, blanks included.
 *
 * Blanks must be preserved for fields where the empty string is a legitimate
 * value. Treating `''` as "unset" and falling through to nothing is what made an
 * unset API key stringify to the literal `"undefined"` and be sent as
 * `Authorization: Bearer undefined` — invisible against a gateway that does not
 * check keys, fatal against one that does.
 */
function first(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    return value;
  }
  return undefined;
}

/** First value that is neither nullish nor blank; for fields where blank means unset. */
function firstNonBlank(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return undefined;
}

/** Merge patch config, environment and defaults into one frozen record. */
export function resolveConfig(entryConfig = {}) {
  const env = typeof process !== 'undefined' ? process.env : {};
  const connection = entryConfig.connection !== null && typeof entryConfig.connection === 'object'
    ? entryConfig.connection
    : {};
  return Object.freeze({
    baseUrl: String(firstNonBlank(
      entryConfig.baseUrl,
      entryConfig.gatewayUrl,
      connection.baseUrl,
      connection.gatewayUrl,
      env.DSH_TTS_BASE_URL,
      DEFAULTS.baseUrl,
    )),
    publicBaseUrl: String(firstNonBlank(
      entryConfig.publicBaseUrl, connection.publicBaseUrl, env.DSH_TTS_PUBLIC_BASE_URL, DEFAULTS.publicBaseUrl,
    )).replace(/\/+$/, ''),
    speechUrl: String(first(
      entryConfig.speechUrl,
      connection.speechUrl,
      env.DSH_TTS_SPEECH_URL,
      DEFAULTS.speechUrl,
    ) ?? ''),
    healthUrl: String(first(
      entryConfig.healthUrl,
      connection.healthUrl,
      env.DSH_TTS_HEALTH_URL,
      DEFAULTS.healthUrl,
    ) ?? ''),
    model: String(firstNonBlank(entryConfig.model, env.DSH_TTS_MODEL, DEFAULTS.model)),
    voice: String(firstNonBlank(entryConfig.voice, env.DSH_TTS_VOICE, DEFAULTS.voice)),
    promptLanguage: String(firstNonBlank(
      entryConfig.promptLanguage, env.DSH_TTS_PROMPT_LANGUAGE, DEFAULTS.promptLanguage,
    )),
    language: String(firstNonBlank(entryConfig.language, env.DSH_TTS_LANGUAGE, DEFAULTS.language)),
    // An empty key is a valid configuration, so blanks are kept rather than skipped.
    apiKey: String(first(entryConfig.apiKey, env.DSH_TTS_API_KEY, DEFAULTS.apiKey) ?? ''),
    authHeader: String(first(
      entryConfig.authHeader,
      connection.authHeader,
      env.DSH_TTS_AUTH_HEADER,
      DEFAULTS.authHeader,
    ) ?? ''),
    // An empty scheme is valid for Azure-style `api-key` headers.
    authScheme: String(first(
      entryConfig.authScheme,
      connection.authScheme,
      env.DSH_TTS_AUTH_SCHEME,
      DEFAULTS.authScheme,
    ) ?? ''),
    extraHeaders: Object.freeze(parseObject(first(
      entryConfig.extraHeaders,
      connection.extraHeaders,
      env.DSH_TTS_EXTRA_HEADERS,
      DEFAULTS.extraHeaders,
    ), 'extraHeaders')),
    extraBody: Object.freeze(parseObject(first(
      entryConfig.extraBody,
      connection.extraBody,
      env.DSH_TTS_EXTRA_BODY,
      DEFAULTS.extraBody,
    ), 'extraBody')),
    timeoutMs: Number(firstNonBlank(entryConfig.timeoutMs, env.DSH_TTS_TIMEOUT_MS, DEFAULTS.timeoutMs)),
    cacheEntries: Number(firstNonBlank(
      entryConfig.cacheEntries, env.DSH_TTS_CACHE_ENTRIES, DEFAULTS.cacheEntries,
    )),
  });
}

/**
 * Build the shared runtime the tools and routes both use. Kept separate from
 * `apply` so it can be exercised without a cordis context.
 */
export function createRuntime(config = resolveConfig()) {
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
  const audio = new AudioStore(Number.isFinite(config.cacheEntries) ? config.cacheEntries : DEFAULTS.cacheEntries);

  return {
    audio,
    audioBasePath: AUDIO_BASE_PATH,
    audioUrl: (id) => `${config.publicBaseUrl}${AUDIO_BASE_PATH}?id=${encodeURIComponent(id)}`,
    getConfig: () => config,
    client: () => client,

    /**
     * Synthesize and retain the result under a content key.
     * A repeated identical request returns the cached entry without re-synthesis.
     */
    async synthesize({ text, voice, language, speed }) {
      const key = audioKey({
        baseUrl: config.baseUrl,
        model: config.model,
        voice,
        language,
        promptLanguage: config.promptLanguage,
        speed,
        text,
      });
      const cached = audio.get(key);
      if (cached !== undefined) {
        return {
          id: key,
          cached: true,
          bytes: cached.bytes.length,
          durationSeconds: cached.info?.durationSeconds ?? 0,
          sampleRate: cached.info?.sampleRate ?? 0,
          voice: cached.voice,
          language: cached.language,
          languageReason: cached.languageReason,
        };
      }

      const result = await client.synthesize({ text, voice, language, speed });
      const info = result.info;
      audio.put(key, {
        bytes: result.wav,
        contentType: 'audio/wav',
        info,
        voice: result.voice,
        language: result.language,
        languageReason: result.languageReason,
      });
      return {
        id: key,
        cached: false,
        bytes: result.wav.length,
        durationSeconds: info?.durationSeconds ?? 0,
        sampleRate: info?.sampleRate ?? 0,
        voice: result.voice,
        language: result.language,
        languageReason: result.languageReason,
      };
    },
  };
}

/**
 * Plugin body. The loader validates the entry config and hands the resolved
 * object here.
 */
export async function apply(ctx, entryConfig = {}) {
  const config = resolveConfig(entryConfig);
  const runtime = createRuntime(config);

  ctx.effect(() => {
    const disposers = registerTTSTools(ctx, runtime);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // One failing disposer must not strand the others.
        }
      }
      runtime.audio.clear();
    };
  }, 'dsh-tts: tools');

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = mountTTSRoutes(webCtx, runtime);
      return () => {
        if (dispose !== undefined) dispose();
      };
    }, 'dsh-tts: same-origin audio route');
  });

  // The voice contract is a fact about this deployment, so this plugin owns it
  // rather than each preset restating it in persona text. Acquired optionally:
  // the prompt registry ships in dsh-base, dsh-web-app and dsh-headless, but a
  // plugin that hard-requires it could not load in an unusual composition.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    registerVoiceContract(promptCtx, {
      contract: entryConfig.contract,
      contractText: entryConfig.contractText ?? entryConfig.contract_text,
      contractOrder: Number(entryConfig.contractOrder ?? entryConfig.contract_order),
    });
  });

  ctx.logger?.info?.(
    `[dsh-tts] ready: ${runtime.client().describeConnection().speechUrl}`
    + ` voice=${config.voice} default=${config.language}`,
  );
}
