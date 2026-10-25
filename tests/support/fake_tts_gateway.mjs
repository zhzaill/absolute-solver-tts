import { createServer } from 'node:http';

const port = Number(process.env.FAKE_TTS_PORT ?? 18080);
const sampleRate = 32000;
const seconds = 1;
const samples = sampleRate * seconds;
const dataBytes = samples * 2;
const wav = Buffer.alloc(44 + dataBytes);
wav.write('RIFF', 0, 'ascii');
wav.writeUInt32LE(36 + dataBytes, 4);
wav.write('WAVE', 8, 'ascii');
wav.write('fmt ', 12, 'ascii');
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36, 'ascii');
wav.writeUInt32LE(dataBytes, 40);
for (let sample = 0; sample < samples; sample += 1) {
  const envelope = Math.min(1, sample / 800, (samples - sample) / 800);
  const value = Math.sin((2 * Math.PI * 440 * sample) / sampleRate) * 0.08 * envelope;
  wav.writeInt16LE(Math.round(value * 0x7fff), 44 + sample * 2);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, fake: true }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/audio/speech') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': wav.byteLength,
      });
      response.end(wav);
    });
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake TTS gateway listening on http://127.0.0.1:${port}`);
});
