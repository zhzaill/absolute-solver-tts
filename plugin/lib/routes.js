/**
 * Same-origin HTTP surface for the plugin.
 *
 * Two routes, both exact so no prefix-routing capability is required:
 *
 *   GET /dsh-tts/audio?id=<key>   the synthesized WAV, served from this origin
 *   GET /dsh-tts/status           effective config plus a liveness probe
 *
 * The audio route is deliberately public-within-the-origin: it serves only
 * bytes this plugin already synthesized, keyed by content hash, and it never
 * echoes configuration or credentials. The status route redacts the API key.
 */

export function mountTTSRoutes(ctx, runtime) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) return undefined;

  const disposers = [];

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-tts/audio',
    handler: async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('method not allowed');
        return;
      }
      let key = '';
      try {
        key = new URL(request.url ?? '/', 'http://localhost').searchParams.get('id') ?? '';
      } catch {
        key = '';
      }
      const entry = key === '' ? undefined : runtime.audio.get(key);
      if (entry === undefined) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('unknown or expired audio id');
        return;
      }
      response.writeHead(200, {
        'Content-Type': entry.contentType,
        'Content-Length': String(entry.bytes.length),
        // Synthesized audio is immutable for a given key.
        'Cache-Control': 'private, max-age=3600, immutable',
        'Content-Disposition': `inline; filename="dsh-tts-${key}.wav"`,
      });
      response.end(request.method === 'HEAD' ? undefined : entry.bytes);
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-tts/status',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('method not allowed');
        return;
      }
      const config = runtime.getConfig();
      const health = await runtime.client().health();
      const body = JSON.stringify({
        ok: health.ok,
        baseUrl: config.baseUrl,
        model: config.model,
        voice: config.voice,
        language: config.language,
        promptLanguage: config.promptLanguage,
        hasApiKey: config.apiKey !== '',
        upstream: health,
        cachedAudio: runtime.audio.size(),
      }, null, 2);
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    },
  }));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // A failing disposer must not prevent the others from running.
      }
    }
  };
}
