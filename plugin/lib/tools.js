/**
 * Model-facing tools.
 *
 * Two tools, deliberately few:
 *
 *   tts_speak   synthesize text and hand back a same-origin URL
 *   tts_status  report effective configuration and upstream reachability
 *
 * `tts_status` exists because this plugin's failures are otherwise invisible:
 * a wrong language or an unreachable gateway produces audio that sounds fine
 * and says the wrong thing, which is precisely the failure this whole package
 * was written to stop repeating. Making the resolved language and the reason it
 * was chosen visible in the tool result is the cheapest possible guard.
 *
 * Tool results must be lossless JSON — a property whose value is `undefined`
 * fails validation, so optional fields are omitted rather than assigned.
 */

import { resolveSynthesisLanguage, SYNTHESIS_LANGUAGES } from './lang.js';

const LANGUAGE_HINT = 'One of zh, ja, en, ko, yue, or auto. Omit to infer from the text.';

function speakDefinition(runtime) {
  return {
    name: 'tts_speak',
    description:
      'Synthesize speech from text through the configured TTS endpoint and return a same-origin URL for the audio. '
      + 'Chinese is the default language; the language is declared to the endpoint explicitly and inferred from the '
      + 'text when you omit it, because the OpenAI speech schema cannot carry it. The result reports which language '
      + 'was actually used and why, so a wrong guess is visible instead of silent.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to speak. Required.' },
        voice: { type: 'string', description: 'Voice id on the endpoint. Omit to use the configured default.' },
        language: { type: 'string', description: LANGUAGE_HINT },
        speed: { type: 'number', description: 'Playback speed, clamped to 0.25–4.0. Default 1.0.' },
      },
      required: ['text'],
    },
    output: {
      // Declared against the framework's enforced JSON Schema subset
      // (type/oneOf/properties/required/additionalProperties/items/enum/const +
      // description/title/default/examples). This tool has two result shapes — a
      // successful synthesis and a rejected request — so fields are documented
      // without `required` or `additionalProperties`, which would admit only one.
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: 'False only when the request was rejected before synthesis.' },
          error: { type: 'string', description: 'Present when ok is false.' },
          id: { type: 'string', description: 'Content key of the retained audio.' },
          url: { type: 'string', description: 'Same-origin path that serves the audio.' },
          cached: { type: 'boolean', description: 'True when an identical earlier request was reused.' },
          characters: { type: 'integer' },
          bytes: { type: 'integer' },
          durationSeconds: { type: 'number' },
          sampleRate: { type: 'integer' },
          voice: { type: 'string' },
          language: { type: 'string', description: 'The language actually declared to the endpoint.' },
          languageReason: { type: 'string', description: 'explicit, inferred or configured.' },
        },
      },
      render(args, value) {
        const data = value;
        const lines = [
          `Spoke ${data.characters} characters in ${data.language}`
          + ` (${data.languageReason === 'inferred' ? 'inferred from the text' : data.languageReason})`
          + ` using voice "${data.voice}".`,
          `Audio: ${data.durationSeconds.toFixed(2)} s, ${data.sampleRate} Hz, ${data.bytes} bytes`
          + `${data.cached ? ' (reused from cache)' : ''}.`,
          `Same-origin URL: ${data.url}`,
        ];
        if (data.languageReason === 'inferred') {
          lines.push('The language was inferred, not declared: pass `language` explicitly if that guess is wrong.');
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 300_000,
    async execute(args) {
      const text = typeof args?.text === 'string' ? args.text : '';
      if (text.trim() === '') {
        return { ok: false, error: 'text is required and must not be blank' };
      }
      const config = runtime.getConfig();
      const language = typeof args?.language === 'string' ? args.language : '';
      const voiceArg = typeof args?.voice === 'string' && args.voice.trim() !== '' ? args.voice.trim() : config.voice;
      const speed = Number.isFinite(args?.speed) ? args.speed : 1;

      const resolved = resolveSynthesisLanguage(text, {
        explicit: language,
        configured: config.language,
      });

      const result = await runtime.synthesize({
        text,
        voice: voiceArg,
        language: resolved.code,
        speed,
      });

      const url = `${runtime.audioBasePath}?id=${result.id}`;
      return {
        ok: true,
        id: result.id,
        url,
        cached: result.cached,
        characters: text.length,
        bytes: result.bytes,
        durationSeconds: result.durationSeconds,
        sampleRate: result.sampleRate,
        voice: result.voice,
        language: result.language,
        // Provenance belongs to whoever saw the caller's input. This tool is
        // that party: by the time the language reaches the client it is already
        // a resolved code, so the client would report `explicit` for a value it
        // never received as one — and `reason` exists precisely to keep an
        // inference visible.
        languageReason: resolved.reason,
      };
    },
  };
}

function statusDefinition(runtime) {
  return {
    name: 'tts_status',
    description:
      'Report the TTS plugin\'s effective connection (speech URL, health URL, auth header, extra header names, model, '
      + 'voice and language) and whether the endpoint is reachable. Use it when speech fails or sounds wrong.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      // This tool has exactly one result shape, so it can declare the full
      // contract: every field required, no unexpected keys.
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          baseUrl: { type: 'string' },
          speechUrl: { type: 'string' },
          healthUrl: { type: 'string' },
          authHeader: { type: 'string' },
          authScheme: { type: 'string' },
          extraHeaderNames: { type: 'array', items: { type: 'string' } },
          model: { type: 'string' },
          voice: { type: 'string' },
          language: { type: 'string' },
          promptLanguage: { type: 'string' },
          hasApiKey: { type: 'boolean' },
          upstream: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              reachable: { type: 'boolean' },
              status: { type: 'integer' },
              url: { type: 'string' },
              tried: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    url: { type: 'string' },
                    status: { type: 'integer' },
                  },
                  required: ['url', 'status'],
                },
              },
            },
            required: ['ok', 'reachable', 'status', 'url', 'tried'],
          },
          cachedAudio: { type: 'integer' },
          route: { type: 'string' },
          languages: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'baseUrl', 'speechUrl', 'healthUrl', 'authHeader', 'authScheme',
          'extraHeaderNames', 'model', 'voice', 'language', 'promptLanguage',
          'hasApiKey', 'upstream', 'cachedAudio', 'route', 'languages',
        ],
      },
      render(_args, value) {
        const data = value;
        const lines = [
          `Speech endpoint: ${data.speechUrl}`,
          `Health endpoint: ${data.healthUrl}`,
          `Auth: ${data.authHeader}${data.authScheme ? ` / ${data.authScheme}` : ''}`
          + `   API key: ${data.hasApiKey ? 'set' : 'not set'}`,
          `Extra headers: ${data.extraHeaderNames.length > 0 ? data.extraHeaderNames.join(', ') : '(none)'}`,
          `Model: ${data.model}   Voice: ${data.voice}`,
          `Default language: ${data.language}   Reference-audio language: ${data.promptLanguage || '(unset)'}`,
          `Upstream health: ${data.upstream.ok ? 'healthy' : data.upstream.reachable ? 'reachable' : 'UNREACHABLE'}`
          + ` (${data.upstream.url}`
          + `${data.upstream.status ? `, HTTP ${data.upstream.status}` : ''})`,
          `Cached audio entries: ${data.cachedAudio}   Same-origin route: ${data.route}`,
          `Supported text languages: ${data.languages.join(', ')}`,
        ];
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 30_000,
    async execute() {
      const config = runtime.getConfig();
      const client = runtime.client();
      const health = await client.health();
      const connection = client.describeConnection();
      return {
        baseUrl: connection.baseUrl,
        speechUrl: connection.speechUrl,
        healthUrl: connection.healthUrl,
        authHeader: connection.authHeader,
        authScheme: connection.authScheme,
        extraHeaderNames: connection.extraHeaderNames,
        model: config.model,
        voice: config.voice,
        language: config.language,
        promptLanguage: config.promptLanguage,
        hasApiKey: connection.hasApiKey,
        upstream: {
          ok: health.ok,
          reachable: health.reachable === true,
          status: health.status ?? 0,
          url: health.url,
          tried: health.tried ?? [],
        },
        cachedAudio: runtime.audio.size(),
        route: runtime.audioBasePath,
        languages: [...SYNTHESIS_LANGUAGES, 'auto'],
      };
    },
  };
}

/** Register the plugin tools; returns disposers. */
export function registerTTSTools(ctx, runtime) {
  const tools = ctx.tools;
  const disposers = [];
  disposers.push(tools.register(speakDefinition(runtime)));
  disposers.push(tools.register(statusDefinition(runtime)));
  return disposers;
}
