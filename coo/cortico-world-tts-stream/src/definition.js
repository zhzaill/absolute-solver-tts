import { DEFAULTS, ID, LABEL, STREAM_EVENT, TtsStreamWorld } from './world.js';

const TOOL_SUMMARIES = {
  tts_stream_say: {
    zh: '用分段流式网关说一段话：逐句合成、每段一到就播；返回时最后一段已交给播放器。',
    en: 'Speak through the streaming gateway: sentences are synthesized one by one and each segment plays as it arrives.',
  },
  tts_stream_status: {
    zh: '查看流式语音的状态：网关、音色、扫描间隔、上一段的计时和最近的错误。',
    en: 'Show the streaming speech state: gateway, voice, scan interval, last turn timing and last error.',
  },
};

export const ttsStreamDefinition = {
  id: ID,
  label: LABEL,
  /** `worlds.tts-stream` 段的默认值；启用与否由部署决定。 */
  defaults: () => structuredClone(DEFAULTS),
  preflight: (ctx) => {
    if (typeof fetch !== 'function') throw new Error('流式语音需要 Node 22+ 的全局 fetch');
    if (!String(ctx?.cfg?.baseUrl ?? DEFAULTS.baseUrl).trim()) {
      throw new Error('网关地址为空：先把 worlds.tts-stream.baseUrl 指向语音服务');
    }
  },
  create: (ctx) => new TtsStreamWorld({
    cfg: ctx.cfg,
    dataDir: ctx.dataDir,
    secret: (name) => ctx.secret(name),
  }),
  describe: {
    tools: [
      { name: 'tts_stream_say', summary: TOOL_SUMMARIES.tts_stream_say },
      { name: 'tts_stream_status', summary: TOOL_SUMMARIES.tts_stream_status },
    ],
    events: [{
      type: STREAM_EVENT,
      description: {
        zh: '一段分段语音说完了：正文给段数与时延，meta 带 turn、段数、首段毫秒与总毫秒。只归档，不唤醒模型。',
        en: 'A segmented utterance finished: the text carries segment count and timing, meta carries the turn, segments, first-segment ms and total ms. Archived only; it never wakes the model.',
      },
      trigger: 'debounce',
    }],
  },
};

export default ttsStreamDefinition;
