window.__ModuleLoader__.load({
  id: 'dsh-tts-browser',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const queue = [];
    let current = null;

    function playNext() {
      while (queue.length > 0) {
        const audio = queue.shift();
        if (!audio?.isConnected || audio.error) continue;
        current = audio;
        audio.currentTime = 0;
        const pending = audio.play();
        if (pending && typeof pending.catch === 'function') {
          pending.catch(() => {
            if (current === audio) current = null;
          });
        }
        return;
      }
      current = null;
    }

    function enqueue(audio) {
      if (audio === current || queue.includes(audio)) return;
      queue.push(audio);
      if (current === null) playNext();
    }

    function release(audio) {
      const index = queue.indexOf(audio);
      if (index >= 0) queue.splice(index, 1);
      if (current === audio) {
        audio.pause();
        current = null;
        playNext();
      }
    }

    function TTSCard({ block }) {
      const meta = block?.kind === 'tool-result' && block.meta && typeof block.meta === 'object'
        ? block.meta
        : null;
      const audioRef = React.useRef(null);

      React.useEffect(() => {
        const audio = audioRef.current;
        if (meta?.url && audio) enqueue(audio);
        return () => {
          if (audio) release(audio);
        };
      }, [meta?.url]);

      if (block?.isError === true) {
        return React.createElement('div', {
          style: {
            border: '1px solid var(--dsw-alias-state-error-primary, #d9534f)',
            borderRadius: 6,
            padding: '8px 10px',
            fontSize: 12,
            color: 'var(--dsw-alias-state-error-primary, #d9534f)',
          },
        }, 'Speech synthesis failed');
      }

      if (meta?.url) {
        const duration = Number.isFinite(meta.durationSeconds)
          ? ` · ${meta.durationSeconds.toFixed(2)}s`
          : '';
        return React.createElement('div', {
          style: {
            display: 'grid',
            gap: 6,
            margin: '6px 0',
            padding: '8px 10px',
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
            borderRadius: 6,
            background: 'var(--dsw-alias-bg-layer-1, transparent)',
          },
        },
        React.createElement('div', {
          style: {
            fontSize: 12,
            color: 'var(--dsw-alias-label-secondary, inherit)',
          },
        }, `Speech${meta.language ? ` · ${meta.language}` : ''}${duration}`),
        React.createElement('audio', {
          ref: audioRef,
          src: meta.url,
          controls: true,
          preload: 'metadata',
          'data-dsh-tts-audio-player': '1',
          'aria-label': 'Play synthesized speech',
          onEnded: playNext,
          onError: playNext,
          style: { display: 'block', width: 'min(420px, 100%)', height: 34 },
        }));
      }

      return React.createElement('div', {
        style: {
          fontSize: 12,
          color: 'var(--dsw-alias-label-secondary, inherit)',
          padding: '6px 0',
        },
      }, 'Synthesizing speech…');
    }

    function apply(ctx) {
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'tts_speak',
      }, (props) => React.createElement(TTSCard, props ?? {})));
    }

    exports.name = 'dsh-tts-browser';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
