/**
 * Provider-neutral connection resolution.
 *
 * `baseUrl` is the compatibility path: it accepts an origin, an OpenAI API base
 * such as `/v1`, a path-prefixed API base, or the final speech endpoint.
 * `speechUrl` and `healthUrl` are exact overrides for providers whose routes do
 * not follow the OpenAI speech convention.
 */

import { TTSError } from './errors.js';

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const SENSITIVE_QUERY_KEY = /(?:^|[-_])(?:api[-_]?key|auth|key|password|secret|sig|signature|token)(?:$|[-_])/i;
const SPEECH_SUFFIX = '/audio/speech';

function asUrl(value, label = 'TTS URL') {
  let raw = String(value ?? '').trim();
  if (raw === '') throw new TTSError(`${label} is empty`);
  if (raw.startsWith('//')) raw = `http:${raw}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new TTSError(`${label} is not a valid URL: ${raw}`, { cause: error });
  }
  if (!HTTP_PROTOCOLS.has(url.protocol)) {
    throw new TTSError(`${label} must use http or https`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new TTSError(`${label} must not embed credentials; use apiKey or extraHeaders`);
  }
  url.hash = '';
  if (url.pathname === '/') url.pathname = '';
  else url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function renderUrl(url) {
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}${url.search}`;
}

function withPath(url, pathname) {
  const next = new URL(url.href);
  next.pathname = pathname;
  return next;
}

function stripSuffix(pathname, suffix) {
  return pathname.endsWith(suffix) ? pathname.slice(0, -suffix.length) : pathname;
}

/** Normalize a user-supplied HTTP endpoint and strip a trailing slash/hash. */
export function normalizeHttpUrl(value, label = 'TTS URL') {
  return renderUrl(asUrl(value, label));
}

/**
 * Resolve the final speech endpoint.
 *
 * Accepted baseUrl forms:
 *   http://host:18080                  -> /v1/audio/speech
 *   http://host:18080/v1               -> /v1/audio/speech
 *   https://host/proxy/v1              -> /proxy/v1/audio/speech
 *   https://host/v1/audio/speech       -> unchanged
 *
 * A `speechUrl` override is used exactly as supplied.
 */
export function speechEndpoint(baseOrConnection) {
  const connection = typeof baseOrConnection === 'string'
    ? { baseUrl: baseOrConnection }
    : (baseOrConnection ?? {});
  if (typeof connection.speechUrl === 'string' && connection.speechUrl.trim() !== '') {
    return normalizeHttpUrl(connection.speechUrl, 'TTS speech URL');
  }

  const base = asUrl(connection.baseUrl, 'TTS base URL');
  const basePath = base.pathname === '/' ? '' : base.pathname;
  if (basePath.endsWith(SPEECH_SUFFIX)) return renderUrl(base);
  if (basePath === '') base.pathname = `/v1${SPEECH_SUFFIX}`;
  else base.pathname = `${basePath}${SPEECH_SUFFIX}`;
  return renderUrl(base);
}

/**
 * Build likely health endpoints without requiring a proprietary health route.
 * An explicit `healthUrl` always wins.
 */
export function healthEndpoints(baseOrConnection) {
  const connection = typeof baseOrConnection === 'string'
    ? { baseUrl: baseOrConnection }
    : (baseOrConnection ?? {});
  if (typeof connection.healthUrl === 'string' && connection.healthUrl.trim() !== '') {
    return [normalizeHttpUrl(connection.healthUrl, 'TTS health URL')];
  }

  const candidates = [];
  const add = (url) => {
    const rendered = renderUrl(url);
    if (!candidates.includes(rendered)) candidates.push(rendered);
  };

  const sources = [];
  if (typeof connection.speechUrl === 'string' && connection.speechUrl.trim() !== '') {
    sources.push(asUrl(connection.speechUrl, 'TTS speech URL'));
  }
  if (typeof connection.baseUrl === 'string' && connection.baseUrl.trim() !== '') {
    sources.push(asUrl(connection.baseUrl, 'TTS base URL'));
  }

  for (const source of sources) {
    const sourcePath = source.pathname === '/' ? '' : source.pathname;
    const withoutSpeech = stripSuffix(sourcePath, SPEECH_SUFFIX);
    if (withoutSpeech.endsWith('/v1')) {
      add(withPath(source, `${stripSuffix(withoutSpeech, '/v1')}/healthz`));
      add(withPath(source, `${withoutSpeech}/healthz`));
    } else {
      add(withPath(source, `${withoutSpeech}/healthz`));
      if (withoutSpeech === '') add(withPath(source, '/v1/healthz'));
    }
  }
  return candidates;
}

/** Parse an object supplied as a config value or a JSON environment variable. */
export function parseObject(value, label) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (typeof value !== 'string') throw new TTSError(`${label} must be an object or a JSON object string`);
  const text = value.trim();
  if (text === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TTSError(`${label} is not valid JSON`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TTSError(`${label} must be a JSON object`);
  }
  return { ...parsed };
}

function normalizedHeaders(value) {
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(parseObject(value, 'extraHeaders'))) {
    const name = String(rawName).trim();
    if (name === '' || /[\r\n:]/.test(name)) throw new TTSError(`invalid extra header name: ${rawName}`);
    if (rawValue === null || rawValue === undefined) continue;
    const headerValue = String(rawValue);
    if (/[\r\n]/.test(headerValue)) throw new TTSError(`extra header ${name} contains a newline`);
    headers[name] = headerValue;
  }
  return headers;
}

/** Construct the provider-neutral connection record used by TTSClient. */
export function resolveConnection(config = {}) {
  const speechOverride = typeof config.speechUrl === 'string' ? config.speechUrl.trim() : '';
  const baseUrl = normalizeHttpUrl(
    speechOverride !== '' ? asUrl(speechOverride, 'TTS speech URL').origin : config.baseUrl,
    'TTS base URL',
  );
  const speechUrl = speechEndpoint({ baseUrl, speechUrl: speechOverride });
  const candidates = healthEndpoints({
    baseUrl,
    speechUrl: config.speechUrl,
    healthUrl: config.healthUrl,
  });
  const apiKey = String(config.apiKey ?? '');
  const authHeader = String(config.authHeader ?? 'Authorization').trim();
  const authScheme = String(config.authScheme ?? 'Bearer').trim();
  if (/[\r\n:]/.test(authHeader)) throw new TTSError('authHeader is not a valid HTTP header name');
  if (/[\r\n]/.test(authScheme)) throw new TTSError('authScheme contains a newline');
  if (/[\r\n]/.test(apiKey)) throw new TTSError('apiKey contains a newline');
  return Object.freeze({
    baseUrl,
    speechUrl,
    healthUrls: Object.freeze(candidates),
    apiKey,
    authHeader,
    authScheme,
    extraHeaders: Object.freeze(normalizedHeaders(config.extraHeaders)),
    extraBody: Object.freeze(parseObject(config.extraBody, 'extraBody')),
  });
}

/** Headers sent to both speech and health endpoints. */
export function connectionHeaders(connection, { streaming = false, json = true } = {}) {
  const headers = { ...connection.extraHeaders };
  if (json) headers['Content-Type'] = 'application/json; charset=utf-8';
  if (streaming) headers.Accept = 'text/event-stream';
  if (connection.apiKey !== '' && connection.authHeader !== '') {
    headers[connection.authHeader] = connection.authScheme === ''
      ? connection.apiKey
      : `${connection.authScheme} ${connection.apiKey}`;
  }
  return headers;
}

/** Remove credentials and sensitive query values before showing a URL to a user. */
export function redactUrl(value) {
  try {
    let raw = String(value ?? '').trim();
    if (raw.startsWith('//')) raw = `http:${raw}`;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
    const url = new URL(raw);
    if (!HTTP_PROTOCOLS.has(url.protocol)) return '(invalid URL)';
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, '***');
    }
    return renderUrl(url);
  } catch {
    return '(invalid URL)';
  }
}

/** Safe connection metadata for status routes and tool results. */
export function describeConnection(connection) {
  return {
    baseUrl: redactUrl(connection.baseUrl),
    speechUrl: redactUrl(connection.speechUrl),
    healthUrl: redactUrl(connection.healthUrls[0] ?? connection.baseUrl),
    authHeader: connection.authHeader || '(none)',
    authScheme: connection.authScheme,
    hasApiKey: connection.apiKey !== '',
    extraHeaderNames: Object.keys(connection.extraHeaders),
  };
}
