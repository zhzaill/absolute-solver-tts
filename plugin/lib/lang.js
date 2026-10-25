/**
 * Text-language resolution for synthesis.
 *
 * The lesson this file exists to encode
 * -------------------------------------
 * The OpenAI `/v1/audio/speech` schema has no field for the language of
 * `input`. Amadeus's own remote backend therefore transmitted no language, and
 * the receiving gateway fell back to the voice's configured language. On this
 * deployment that configuration was Chinese while the text was Japanese, so a
 * Chinese G2P frontend read Japanese text: every kana dissolved and the
 * remaining Han characters were read with Chinese pronunciations. Measured on
 * the same 17-character sentence:
 *
 *     text_lang=zh -> ASR heard  今日无事，完了。                     (wrong words)
 *     text_lang=ja -> ASR heard  今日のデプロイは無事に完了したわ。    (exact)
 *
 * Two conclusions are baked in here:
 *
 *  1. **Declare, do not rely on defaults.** When this client knows the language,
 *     it sends `text_lang` (and `prompt_lang` for the reference audio) in the
 *     request body even though the OpenAI schema does not define those fields.
 *     A gateway that understands them uses them; one that does not ignores
 *     unknown keys. Declaring costs nothing and removes an entire failure class.
 *  2. **Infer only as a fallback, and make it observable.** If the caller gave
 *     no language, detect it from the script and report *why* the value was
 *     chosen, so a wrong guess is visible instead of silent.
 */

/** Hiragana, katakana and the katakana phonetic extensions. */
export const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff]/;
/** CJK unified ideographs plus compatibility ideographs. */
export const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** Basic Latin letters. */
export const LATIN_RE = /[A-Za-z]/;

/** Language codes the GPT-SoVITS family accepts as `text_lang`. */
export const SYNTHESIS_LANGUAGES = ['zh', 'ja', 'en', 'ko', 'yue'];

/** Values a user may write in config, mapped to a synthesis language code. */
const ALIASES = new Map(Object.entries({
  zh: 'zh', cn: 'zh', chinese: 'zh', '中文': 'zh', '简体中文': 'zh', '汉语': 'zh', '普通话': 'zh',
  ja: 'ja', jp: 'ja', japanese: 'ja', '日文': 'ja', '日语': 'ja', '日本語': 'ja',
  en: 'en', english: 'en', '英文': 'en', '英语': 'en',
  ko: 'ko', korean: 'ko', '韩文': 'ko', '韩语': 'ko',
  yue: 'yue', cantonese: 'yue', '粤语': 'yue',
  auto: 'auto', '': 'auto',
}));

/**
 * Normalise a configured or user-supplied language value to a synthesis code.
 * Unknown values become `auto` rather than throwing, so bad configuration
 * degrades into inference instead of breaking the tool.
 */
export function normalizeLanguage(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return ALIASES.get(raw) ?? 'auto';
}

/**
 * Best-effort language of `text`: `'ja'`, `'zh'`, `'en'` or `''` when unknown.
 *
 * Order matters and is the whole trick: a Japanese sentence is mostly Han
 * characters, so testing Han first would classify Japanese as Chinese and
 * reintroduce exactly the bug above. Kana are unique to Japanese and are tested
 * first.
 */
export function detectTextLanguage(text) {
  const value = String(text ?? '');
  if (KANA_RE.test(value)) return 'ja';
  if (HAN_RE.test(value)) return 'zh';
  if (LATIN_RE.test(value)) return 'en';
  return '';
}

/**
 * Decide the language to synthesize `text` in.
 *
 * Precedence: explicit request/config value, then script inference, then the
 * configured default. Returns the code together with the reason, so callers can
 * surface a guess instead of hiding it.
 *
 * @param {string} text
 * @param {{explicit?: string, configured?: string, auto?: boolean}} [options]
 * @returns {{code: string, reason: 'explicit'|'inferred'|'configured', inferred: string}}
 */
export function resolveSynthesisLanguage(text, options = {}) {
  const explicit = normalizeLanguage(options.explicit);
  if (explicit !== 'auto') return { code: explicit, reason: 'explicit', inferred: '' };

  if (options.auto !== false) {
    const inferred = detectTextLanguage(text);
    if (inferred !== '') return { code: inferred, reason: 'inferred', inferred };
  }

  const configured = normalizeLanguage(options.configured);
  return { code: configured === 'auto' ? 'zh' : configured, reason: 'configured', inferred: '' };
}
