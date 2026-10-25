/**
 * The voice contract: a host-owned prompt section contributed by this plugin.
 *
 * Why this is a plugin-owned section instead of preset persona text
 * -----------------------------------------------------------------
 * Amadeus draws the line explicitly (`llm/prompts.py:50-51`):
 *
 *     # Preserve the existing default verbatim; only identity and personality
 *     # are replaceable. Language, emotion/TTS and execution contracts stay
 *     # host-owned.
 *
 * DSH states the same rule for its prompt registry
 * (`@deepseek-ai/dsh-system-prompt/README.md:174`):
 *
 *     other sections come from the plugin that owns the fact
 *
 * So "answer in Chinese", "your text will be spoken aloud", "call tts_speak",
 * and "you have no shell" are not personality — they are facts about *this
 * deployment*, owned by the component that implements them. Baking them into a
 * preset's persona means:
 *
 *   - swapping the character silently drops the voice behaviour, and
 *   - the same rules must be copied into every preset that wants speech.
 *
 * Contributing a section fixes both: any preset that mounts `dsh-tts` gets the
 * contract, and the persona is free to be purely identity.
 *
 * Placement
 * ---------
 * `systemPrompt.section()` rejects a non-finite order, and
 * `getSectionOrder()` returns `undefined` for a name it does not own, so an
 * unknown key throws. This section therefore uses a literal in the policy band
 * of the shipped order table:
 *
 *     -1000 HARNESS_IDENTITY
 *         0 DEPLOYMENT_PERSONA_PREFIX
 *       500 PLAN_POLICY        <- policy band
 *       600 TEAM_POLICY
 *       700 this section       <- free slot, still policy
 *       800 PTC_ONLY
 *       900 FILE_REFERENCE
 *      1000+ TOOL_*
 *     10200 DEPLOYMENT_PERSONA_SUFFIX
 */

/** Stable section name; must be unique in the registry. */
export const VOICE_CONTRACT_SECTION = 'dsh-tts-voice-contract';

/** Policy band, after the persona prefix and before every tool section. */
export const VOICE_CONTRACT_ORDER = 700;

/**
 * The contract text.
 *
 * Written as rules the model can follow, and stated in the first person of the
 * deployment rather than of the character, so it reads as a fact about the
 * environment rather than as part of anyone's personality.
 */
export function voiceContractText() {
  return [
    '## 语音契约（由 dsh-tts 插件提供，人设不得覆盖）',
    '',
    '这个环境里，你写出来的文字会被朗读出来。以下不是风格偏好，是运行事实：',
    '',
    '**语言**：始终用中文回应，除非用户明确要求别的语言，或在讨论代码与专有名词。',
    '',
    '**可朗读**：',
    '- 用短句、口语，像说话而不像写稿。',
    '- 不要用 Markdown 表格、代码块、层层嵌套的列表——它们被读出来是噪音。',
    '- 不要输出 URL、文件路径、哈希、日志片段，除非用户明确要看。',
    '- 需要列举时，说成一句连贯的话，而不是编号清单。',
    '',
    '**发声**：',
    '- 每次给出回应后，必须调用 `tts_speak` 把要说的内容合成为语音。工具结果卡会显示播放器，不要在正文里重复 URL 或播放链接。',
    '- 传给 `tts_speak` 的 `text` 是要朗读的正文，不是你的全部输出。',
    '- 长回复拆成多次调用，每段一到三句；不要一次塞一整篇。',
    '- 不要传 `language`，让它从文本推断；只有推断明显会出错时才显式指定。',
    '- 如果合成失败或听起来不对，先用 `tts_status` 看端点和上游状态，再决定是否重试。不要盲目重试。',
    '',
    '**能力边界**：这个预设没有 Shell、没有文件工具，也不能跑工作流。用户要求动手做事时，',
    '直说你做不到，并建议他换用带完整编码能力的预设。',
  ].join('\n');
}

/**
 * Register the contract section in the calling scope.
 *
 * Registered through `ctx.effect` so it unmounts with the plugin fiber, exactly
 * as the shipped prompt-contributing plugins do.
 *
 * @returns the disposer, or `undefined` when the prompt registry is absent.
 */
export function registerVoiceContract(ctx, options = {}) {
  if (options.contract === false) return undefined;
  const systemPrompt = ctx?.systemPrompt;
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return undefined;
  const text = typeof options.contractText === 'string' && options.contractText.trim() !== ''
    ? options.contractText
    : voiceContractText();
  const order = Number.isFinite(options.contractOrder) ? options.contractOrder : VOICE_CONTRACT_ORDER;
  return ctx.effect(() => systemPrompt.section({
    name: VOICE_CONTRACT_SECTION,
    order,
    text,
  }), 'dsh-tts: voice contract section');
}
