#!/usr/bin/env node
/**
 * Terminal front end for the TTS relay.
 *
 * The DSH plugin exists so the *agent* can speak. This CLI exists so a human can
 * check and drive the same relay from a shell, without a browser, a session
 * restart, or any preset:
 *
 *   tts --status                      endpoint and upstream reachability
 *   tts --check                       relay check: synthesize + ASR round-trip
 *   tts "今天天气不错。"                 synthesize to a file
 *   tts "..." --play                  synthesize and play it
 *   tts "..." --voice local_voice     pick a registered voice
 *   tts "..." --language ja           declare the text language explicitly
 *
 * `--check` is the point of this file. A relay can fail in two ways: it can
 * return nothing (visible), or it can return audio that says the wrong words
 * (invisible). The second is the one that cost this deployment a full day, so
 * the check verifies content by transcribing its own output and comparing it
 * against the input rather than trusting that audio came back.
 *
 * Zero dependencies: it drives the same client the plugin ships.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { TTSClient, wavInfo } from '../lib/tts.js';
import { resolveSynthesisLanguage } from '../lib/lang.js';
import { resolveConfig } from '../lib/index.js';

// A stable output root, not the current directory: this tool gets run from
// wherever the user happens to be, and defaulting to `./tts-out` litters that
// directory — running once from C:\ created C:\tts-out.
const OUT_ROOT = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'dsh-tts')
  : path.join(os.homedir(), '.dsh-tts');

const DEFAULTS = {
  asrUrl: process.env.DSH_TTS_ASR_URL ?? 'http://127.0.0.1:9881/v1/audio/transcriptions',
  asrModel: 'qwen3-asr-0.6b',
  outDir: path.join(OUT_ROOT, 'out'),
  // The engine samples. A check whose inputs change between runs cannot tell a
  // regression from a different draw, so --check pins a seed by default.
  checkSeed: 20261016,
};

const PROBES = [
  { label: 'zh', text: '这是一次中继检查，说的是中文。' },
  { label: 'ja', text: '今日のデプロイは無事に完了したわ。' },
];

function parseArgs(argv) {
  const options = { text: '', check: false, status: false, play: false, out: '', voice: '', language: '', asrUrl: '', seed: undefined, verify: '', expect: '', keep: false, positional: [], unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--check') options.check = true;
    else if (arg === '--status') options.status = true;
    else if (arg === '--play') options.play = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--out') options.out = next() ?? '';
    else if (arg === '--voice') options.voice = next() ?? '';
    else if (arg === '--language') options.language = next() ?? '';
    else if (arg === '--asr') options.asrUrl = next() ?? '';
    else if (arg === '--seed') options.seed = Number(next());
    else if (arg === '--verify') options.verify = next() ?? '';
    else if (arg === '--expect') options.expect = next() ?? '';
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) options.unknown.push(arg);
    else options.positional.push(arg);
  }
  // One positional argument is the sentence. More than one is a mistake, and
  // silently joining them puts words into the speaker's mouth: `cmd` has no `#`
  // comment syntax, so `tts "…" # note` passes `#` and `note` as arguments, and
  // the synthesizer then reads the annotation aloud while dropping the `#` as an
  // out-of-coverage character. Refuse instead of guessing.
  options.text = options.positional.length === 1 ? options.positional[0] : '';
  return options;
}

function usage() {
  return [
    'tts — 终端 TTS 中继',
    '',
    '  tts --status                     端点配置与上游可达性',
    '  tts --check                      中继检查（合成 + ASR 往返内容保真）',
    '  tts "<文本>"                      合成到文件，打印路径',
    '  tts "<文本>" --play               合成并播放',
    '  tts "<文本>" --voice <id>         指定音色',
    '  tts "<文本>" --language zh|ja     显式声明语言（默认从文本推断）',
    '  tts "<文本>" --out <file.wav>     指定输出路径',
    '  tts "<文本>" --seed <int>         固定随机种子（引擎默认随机）',
    '  tts --verify "D:\\path\\file.wav"   转写一个已有文件（字节数说明不了内容）',
    '  tts --verify "D:\\path\\file.wav" --expect "期望文本"',
    '                                    转写并与期望文本比对',
    '',
    '  注意：路径要加引号，且不要写成 <占位符> —— cmd 把 < 和 > 当重定向，',
    '        那样会在 node 启动之前就失败（The system cannot find the file specified）。',
    '',
    `  --asr <url>                      ASR 端点，默认 ${DEFAULTS.asrUrl}`,
    `  --check 固定使用 seed ${DEFAULTS.checkSeed}，否则两次运行的音频不同、结果不可复现`,
  ].join('\n');
}

function hud(label, value) {
  const text = String(value ?? '');
  // The Windows console code page mangles non-ASCII; print an ASCII-safe label
  // plus a length so the line is readable even when the value is not.
  const safe = /^[\x20-\x7e]*$/.test(text) ? text : `<${Buffer.byteLength(text, 'utf8')} bytes utf-8>`;
  return `  ${label.padEnd(22)} ${safe}`;
}

/**
 * Escape every non-ASCII code point as `\uXXXX`.
 *
 * `JSON.stringify` does NOT do this — it keeps non-ASCII literal, which the
 * Windows console then mangles. This tool's whole point is to let a reader see
 * exactly what was said, so the escaping has to be real.
 */
function asciiEscape(value) {
  return String(value ?? '').replace(/[^\x20-\x7e]/g, (character) => {
    const code = character.codePointAt(0);
    if (code > 0xffff) {
      const offset = code - 0x10000;
      const high = 0xd800 + (offset >> 10);
      const low = 0xdc00 + (offset & 0x3ff);
      return `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
    }
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

async function transcribe(wav, asrUrl, asrModel) {
  const form = new FormData();
  form.append('model', asrModel);
  form.append('response_format', 'json');
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'probe.wav');
  const response = await fetch(asrUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`ASR HTTP ${response.status}`);
  const body = await response.json();
  return String(body.text ?? '');
}

/** Compare while tolerating what transcriptions legitimately normalise. */
function sameContent(heard, expected) {
  const strip = (value) => String(value)
    .replace(/[\s，。、！？,.!?；;：:"'“”‘’（）()\[\]【】]/g, '')
    .replace(/[0-9]+/g, (digits) => digits);
  return strip(heard) === strip(expected);
}

function play(file) {
  if (process.platform !== 'win32') {
    const player = spawnSync('ffplay', ['-nodisp', '-autoexit', file], { stdio: 'ignore' });
    if (player.error) throw new Error('no player available (ffplay missing)');
    return;
  }
  const script = `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'inherit' });
  if (result.error) throw new Error(`playback failed: ${result.error.message}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.unknown.length > 0) {
    console.error(`unknown option(s): ${options.unknown.join(' ')}`);
    console.error('run `tts --help` for the accepted options.');
    return 2;
  }
  if (options.positional.length > 1) {
    console.error('the sentence must be exactly ONE argument.');
    console.error(`  got ${options.positional.length}: ${options.positional.map((a) => `"${asciiEscape(a)}"`).join(' ')}`);
    console.error('  A shell comment is the usual cause: cmd has no # comment syntax, so');
    console.error('  `tts "..." # note` hands "#" and "note" to this program, and the note');
    console.error('  gets read aloud while "#" is dropped as an uncovered character.');
    console.error('  Quote the whole sentence instead:  tts "今天天气不错。"');
    return 2;
  }
  const noAction = !options.check && !options.status && options.verify === '';
  if (options.help || (noAction && options.text.trim() === '')) {
    console.log(usage());
    return 0;
  }

  const config = resolveConfig({});
  const client = new TTSClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    voice: options.voice || config.voice,
    timeoutMs: config.timeoutMs,
    language: config.language,
    promptLanguage: config.promptLanguage,
  });

  if (options.status) {
    const health = await client.health();
    console.log('TTS relay');
    console.log(hud('endpoint', config.baseUrl));
    console.log(hud('model / voice', `${config.model} / ${options.voice || config.voice}`));
    console.log(hud('default language', config.language));
    console.log(hud('reference language', config.promptLanguage));
    console.log(hud('api key', config.apiKey === '' ? 'not set' : 'set'));
    console.log(hud('upstream', `${health.ok ? 'reachable' : 'UNREACHABLE'} (${health.url}${health.status ? `, HTTP ${health.status}` : ''})`));
    return health.ok ? 0 : 1;
  }

  if (options.verify !== '') {
    // Verify an audio file that already exists. Byte size says nothing about
    // whether the file says the right words, and two different sentences can
    // render to the same length — so the only useful check is a transcription.
    const asrUrl = options.asrUrl || DEFAULTS.asrUrl;
    let wav;
    try {
      wav = readFileSync(options.verify);
    } catch (error) {
      // A missing file is a caller mistake, not a relay failure, and the shell
      // may not even have reached this program: in cmd, `<path>` is a stdin
      // redirection, so a placeholder written with angle brackets fails before
      // node starts. Say both things rather than printing a bare ENOENT.
      console.error(`  cannot read            ${options.verify} (${error?.code ?? error?.message})`);
      console.error('  note                   paths must exist and must not be written as a <placeholder>;');
      console.error('                         cmd treats < and > as redirection operators');
      return 1;
    }
    const info = wavInfo(wav);
    console.log('verify');
    console.log(hud('file', options.verify));
    console.log(hud('bytes / duration', `${wav.length} / ${(info?.durationSeconds ?? 0).toFixed(2)}s @ ${info?.sampleRate ?? 0} Hz`));
    let heard;
    try {
      heard = await transcribe(wav, asrUrl, DEFAULTS.asrModel);
    } catch (error) {
      console.error(`  asr                    FAILED ${error?.message ?? error}`);
      return 1;
    }
    // Print the transcription escaped: the Windows console code page mangles
    // non-ASCII, and hiding it behind a byte count would defeat this mode.
    console.log(hud('heard (escaped)', `"${asciiEscape(heard)}"`));
    if (options.expect !== '') {
      const ok = sameContent(heard, options.expect);
      console.log(`  ${'expected (escaped)'.padEnd(22)} "${asciiEscape(options.expect)}"`);
      console.log(`  ${'verdict'.padEnd(22)} ${ok ? 'MATCH' : 'MISMATCH'}`);
      return ok ? 0 : 1;
    }
    return 0;
  }

  if (options.check) {
    const health = await client.health();
    console.log('=== relay check ===');
    console.log(hud('endpoint', config.baseUrl));
    console.log(hud('upstream', health.ok ? `reachable (HTTP ${health.status})` : 'UNREACHABLE'));
    if (!health.ok) return 1;

    const asrUrl = options.asrUrl || DEFAULTS.asrUrl;
    let asrOk = true;
    try {
      const probe = await fetch(asrUrl.replace(/\/audio\/transcriptions$/, '/models'), { signal: AbortSignal.timeout(8000) });
      asrOk = probe.ok;
    } catch {
      asrOk = false;
    }
    console.log(hud('asr endpoint', asrOk ? `reachable (${asrUrl})` : `UNREACHABLE (${asrUrl})`));
    if (!asrOk) console.log('  note                   content fidelity cannot be verified without ASR');
    console.log(hud('seed', `${DEFAULTS.checkSeed} (pinned so the check is reproducible)`));
    console.log('');

    console.log('  lang   dur     rate    bytes      ASR round-trip');
    let failures = 0;
    for (const { label, text } of PROBES) {
      try {
        const resolved = resolveSynthesisLanguage(text, { configured: config.language });
        const result = await client.synthesize({ text, language: resolved.code, seed: DEFAULTS.checkSeed });
        const info = wavInfo(result.wav);
        const heard = asrOk ? await transcribe(result.wav, asrUrl, DEFAULTS.asrModel) : '';
        const verdict = asrOk ? (sameContent(heard, text) ? 'MATCH' : 'MISMATCH') : 'not checked';
        if (asrOk && verdict === 'MISMATCH') failures += 1;
        console.log(`  ${label.padEnd(6)} ${(info?.durationSeconds ?? 0).toFixed(2)}s   ${String(info?.sampleRate ?? 0).padEnd(7)} ${String(result.wav.length).padEnd(10)} ${verdict}`);
        if (verdict === 'MISMATCH') {
          // Print both sides JSON-escaped: ASCII-safe for the console, and
          // byte-exact so the difference is diagnosable rather than described.
          console.log(`         expected "${asciiEscape(text)}"`);
          console.log(`         heard    "${asciiEscape(heard)}"`);
        }
        if (options.keep) {
          mkdirSync(DEFAULTS.outDir, { recursive: true });
          const file = path.join(DEFAULTS.outDir, `check-${label}.wav`);
          writeFileSync(file, result.wav);
          console.log(hud('  saved', file));
        }
      } catch (error) {
        failures += 1;
        console.log(`  ${label.padEnd(6)} FAILED  ${error?.message ?? error}`);
      }
    }
    console.log('');
    if (failures === 0) {
      console.log('=== relay ok: audio returned and it says the right words ===');
      return 0;
    }
    console.log(`=== ${failures} problem(s): audio returned but content or transport is wrong ===`);
    return 1;
  }

  const resolved = resolveSynthesisLanguage(options.text, {
    explicit: options.language,
    configured: config.language,
  });
  const result = await client.synthesize({
    text: options.text,
    voice: options.voice || config.voice,
    language: resolved.code,
    seed: Number.isInteger(options.seed) ? options.seed : undefined,
  });
  const info = wavInfo(result.wav);

  let file = options.out;
  if (file === '') {
    mkdirSync(DEFAULTS.outDir, { recursive: true });
    const key = createHash('sha1').update(options.text, 'utf8').digest('hex').slice(0, 12);
    file = path.join(DEFAULTS.outDir, `${resolved.code}-${key}.wav`);
  }
  writeFileSync(file, result.wav);

  console.log(hud('language', `${resolved.code} (${resolved.reason})`));
  console.log(hud('voice', options.voice || config.voice));
  console.log(hud('duration / rate', `${(info?.durationSeconds ?? 0).toFixed(2)}s @ ${info?.sampleRate ?? 0} Hz`));
  console.log(hud('bytes', result.wav.length));
  console.log(hud('file', file));

  if (options.play) {
    play(file);
    console.log(hud('played', 'yes'));
  }
  if (resolved.reason !== 'explicit') {
    console.log('  note                   the language was inferred; pass --language to override');
  }
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`relay failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
