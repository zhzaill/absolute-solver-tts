const port = process.env.DSH_CDP_PORT ?? '9333';
const nonce = Date.now().toString(36);
const prompt = process.env.DSH_TTS_TEST_PROMPT
  ?? `请分两段说话，每段只回一句话，并分别调用 tts_speak。第一段说“浏览器语音队列第一段，编号 ${nonce}”。第二段说“浏览器语音队列第二段，编号 ${nonce}”。不要在正文里输出链接。`;

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === 'page' && target.url.startsWith('dsh-app://'));
if (!page?.webSocketDebuggerUrl) throw new Error('DSH app page not found');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id === undefined) return;
  const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
  else callback.resolve(message.result);
});

function call(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression, { userGesture = false } = {}) {
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

try {
  await call('Runtime.enable');
  const baseline = await evaluate(`(() => {
    const playerSrc = () => [...document.querySelectorAll('audio[data-dsh-tts-audio-player="1"]')]
      .map((audio) => audio.getAttribute('src'));
    window.__dshTtsPlayEvents = [];
    document.removeEventListener('play', window.__dshTtsCapturePlay, true);
    document.removeEventListener('ended', window.__dshTtsCaptureEnded, true);
    window.__dshTtsCapturePlay = (event) => {
      if (event.target instanceof HTMLAudioElement) {
        window.__dshTtsPlayEvents.push({
          type: 'play',
          src: event.target.getAttribute('src'),
          at: performance.now(),
        });
      }
    };
    window.__dshTtsCaptureEnded = (event) => {
      if (event.target instanceof HTMLAudioElement) {
        window.__dshTtsPlayEvents.push({
          type: 'ended',
          src: event.target.getAttribute('src'),
          at: performance.now(),
        });
      }
    };
    document.addEventListener('play', window.__dshTtsCapturePlay, true);
    document.addEventListener('ended', window.__dshTtsCaptureEnded, true);
    return playerSrc();
  })()`);

  const composerReady = await evaluate(`(() => {
    const composer = document.querySelector('[role="textbox"][aria-label^="发消息"]');
    if (!composer) return false;
    composer.focus();
    return document.activeElement === composer;
  })()`);
  if (!composerReady) throw new Error('message composer not found');

  await call('Input.insertText', { text: prompt });
  await evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      const send = document.querySelector('button[aria-label="发送消息"]');
      if (send && !send.disabled && send.getAttribute('aria-disabled') !== 'true') return resolve(true);
      if (Date.now() > deadline) return reject(new Error('send button did not become available'));
      setTimeout(poll, 50);
    };
    poll();
  })`);
  await evaluate(`document.querySelector('button[aria-label="发送消息"]').click()`, { userGesture: true });

  const result = await evaluate(`(() => {
    const baseline = new Set(${JSON.stringify(baseline)});
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 180000;
      const poll = () => {
        const players = [...document.querySelectorAll('audio[data-dsh-tts-audio-player="1"]')]
          .filter((audio) => !baseline.has(audio.getAttribute('src')));
        const srcs = [...new Set(players.map((audio) => audio.getAttribute('src')))];
        if (srcs.length >= 2) {
          const pair = srcs.slice(0, 2).map((src) => {
            const audio = players.find((candidate) => candidate.getAttribute('src') === src);
            return {
              src,
              paused: audio.paused,
              ended: audio.ended,
              currentTime: audio.currentTime,
              readyState: audio.readyState,
              error: audio.error?.message ?? null,
            };
          });
          const events = window.__dshTtsPlayEvents
            .filter((event) => srcs.includes(event.src))
            .map((event) => ({ ...event }));
          if (pair.every((audio) => audio.ended || audio.currentTime > 0.1)) {
            return resolve({ baselineCount: baseline.size, pair, events });
          }
        }
        if (Date.now() > deadline) {
          return reject(new Error('two new tool-card audio players did not finish within 180 seconds'));
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  })()`);

  const firstPlay = result.events.find((event) => event.type === 'play');
  const firstEnded = firstPlay
    ? result.events.find((event) => event.type === 'ended' && event.src === firstPlay.src)
    : null;
  const secondPlay = result.events.find((event) => event.type === 'play' && event.src !== firstPlay?.src);

  if (result.pair.length !== 2) throw new Error(`expected two tool-card players: ${JSON.stringify(result)}`);
  if (result.pair.some((audio) => audio.error)) throw new Error(`audio error: ${JSON.stringify(result)}`);
  if (!firstPlay || !firstEnded || !secondPlay) {
    throw new Error(`missing sequential play events: ${JSON.stringify(result)}`);
  }
  if (secondPlay.at < firstEnded.at) {
    throw new Error(`second segment overlapped the first: ${JSON.stringify(result)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    baselineCount: result.baselineCount,
    players: result.pair,
    events: result.events,
  }, null, 2));
} finally {
  socket.close();
}
