/**
 * Verify the plugin as INSTALLED into the desktop profile.
 *
 * The standalone selftest proves the logic works from the source tree. This
 * proves the installed artifact resolves, exports the cordis contract, and ships
 * a patch file that parses into the shape the loader expects.
 *
 * Run: node tools/verify-install.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const requestedPlugin = process.env.DSH_TTS_PLUGIN_DIR ?? process.argv[2];
const profile = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? '',
  '.dsh',
  'profiles',
  'desktop',
);
const installed = requestedPlugin
  ? path.resolve(requestedPlugin)
  : path.join(profile, 'node_modules', 'dsh-tts');

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok    ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${label}\n        ${error?.message ?? error}`);
  }
}

console.log(`profile : ${profile}`);
console.log(`plugin  : ${installed}`);
console.log('');

check('the package directory exists', () => assert.ok(existsSync(installed), 'missing package dir'));

check('package.json declares the bundle patch', () => {
  const pkg = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-tts');
  assert.deepEqual(pkg.dsh.bundle.patch, ['./cordis.patch.yml']);
  assert.equal(pkg.type, 'module');
});

check('the patch file is shipped', () => assert.ok(existsSync(path.join(installed, 'cordis.patch.yml'))));

check('license and upstream attribution are shipped', () => {
  assert.ok(existsSync(path.join(installed, 'LICENSE')), 'LICENSE missing');
  const notice = readFileSync(path.join(installed, 'NOTICE.md'), 'utf8');
  assert.ok(notice.includes('Code-Amadeus/Amadeus'), 'Amadeus attribution missing');
  assert.ok(notice.includes('AGPL-3.0'), 'AGPL notice missing');
});

// `references/host-plugin.md` requires display metadata to live in the locale
// files and the icon to be a top-level manifest field, so the plugin manager can
// render a card without activating the plugin.
check('display metadata is declared where the spec requires it', () => {
  const pkg = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true, 'a profile-installed bundle should be private');
  assert.equal(pkg.icon, './icon.svg');
  assert.ok(pkg.exports['./package.json'], 'exports must expose ./package.json');
  assert.ok(pkg.exports['./locale/*.json'], 'exports must expose ./locale/*.json');
  assert.ok(existsSync(path.join(installed, 'icon.svg')), 'icon.svg missing');
  for (const language of ['en', 'zh']) {
    const file = path.join(installed, 'locale', `${language}.json`);
    assert.ok(existsSync(file), `locale/${language}.json missing`);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(typeof parsed.meta?.title, 'string', `locale/${language}.json needs meta.title`);
    assert.ok(parsed.meta.title.length > 0);
    assert.equal(typeof parsed.meta?.description, 'string', `locale/${language}.json needs meta.description`);
  }
});

check('the icon is an SVG within the documented size limit', () => {
  const icon = readFileSync(path.join(installed, 'icon.svg'), 'utf8');
  assert.ok(icon.includes('<svg'), 'icon is not SVG');
  assert.ok(Buffer.byteLength(icon) < 256 * 1024, 'icon exceeds the 256 KiB limit');
});

let mod;
try {
  mod = await import(new URL(`file:///${installed.replace(/\\/g, '/')}/lib/index.js`).href);
  console.log('  ok    the installed entry imports cleanly');
} catch (error) {
  failures += 1;
  console.log(`  FAIL  the installed entry imports cleanly\n        ${error?.message ?? error}`);
}

if (mod !== undefined) {
  check('exports name', () => assert.equal(mod.name, 'dsh-tts'));
  check('declares the required service', () => assert.deepEqual(mod.inject, ['tools']));
  check('exports apply', () => assert.equal(typeof mod.apply, 'function'));
  check('exports resolveConfig', () => assert.equal(typeof mod.resolveConfig, 'function'));
  check('exports createRuntime', () => assert.equal(typeof mod.createRuntime, 'function'));

  check('resolveConfig applies the documented defaults', () => {
    const config = mod.resolveConfig({});
    assert.equal(config.baseUrl, 'http://127.0.0.1:18080/v1');
    assert.equal(config.speechUrl, '');
    assert.equal(config.healthUrl, '');
    assert.equal(config.voice, 'local_voice');
    assert.equal(config.language, 'zh');
    assert.equal(config.promptLanguage, 'zh');
    assert.equal(config.authHeader, 'Authorization');
    assert.equal(config.authScheme, 'Bearer');
    assert.deepEqual(config.extraHeaders, {});
    assert.deepEqual(config.extraBody, {});
    assert.equal(config.cacheEntries, 32);
  });

  // Regression: an unset API key once stringified to the literal "undefined" and
  // was sent as `Authorization: Bearer undefined`. A gateway that does not check
  // keys hides this, so it needs an explicit assertion.
  check('an unset API key stays an empty string, never "undefined"', () => {
    const config = mod.resolveConfig({});
    assert.equal(config.apiKey, '');
    assert.notEqual(config.apiKey, 'undefined');
    assert.equal(config.hasOwnProperty('apiKey'), true, 'apiKey must still be present as a field');
  });

  check('an explicitly empty API key is preserved as empty', () => {
    assert.equal(mod.resolveConfig({ apiKey: '' }).apiKey, '');
    assert.equal(mod.resolveConfig({ apiKey: 'secret' }).apiKey, 'secret');
  });

  check('resolveConfig lets the patch config win over defaults', () => {
    const config = mod.resolveConfig({ voice: 'other_voice', language: 'ja' });
    assert.equal(config.voice, 'other_voice');
    assert.equal(config.language, 'ja');
  });

  // `webServer` must NOT be a required service, or the plugin cannot load in a
  // headless profile.
  check('webServer is not a required service', () => assert.equal(mod.inject.includes('webServer'), false));
}

// Parse the patch with whatever YAML parser the profile already has, so this
// checks the shipped bytes rather than a restatement of them.
const require = createRequire(path.join(profile, 'package.json'));
let yaml = null;
for (const candidate of ['js-yaml', 'yaml']) {
  try {
    yaml = require(candidate);
    console.log(`  ok    YAML parser available: ${candidate}`);
    break;
  } catch {
    // try the next one
  }
}

if (yaml === null) {
  console.log('  note  no YAML parser in the profile; checking the shipped bytes instead');
  console.log('  note  plugin presence/absence is verified by parse in tools/verify_preset.py');
  const raw = readFileSync(path.join(installed, 'cordis.patch.yml'), 'utf8');
  // Strip comment lines before matching package names. A comment that documents
  // *why* a tool is omitted necessarily names that tool, so a naive substring
  // search over the raw file reports the document's own explanation as a
  // violation. This stays a coarse byte-level check; verify_preset.py owns the
  // semantic one.
  const text = raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  check('the patch declares the preset id', () => assert.ok(text.includes('id: preset-chat-voice')));
  check('the patch declares the preset plugin', () => assert.ok(text.includes("name: '@deepseek-ai/dsh-agent-preset'")));
  check('the patch binds the tts tool', () => assert.ok(text.includes("name: 'dsh-tts'")));
  check('the patch carries the endpoint config', () => assert.ok(text.includes('baseUrl: http://127.0.0.1:18080/v1')));
  // Two opposite omissions, both deliberate. A conversation has no task list to
  // keep, so a todo tool is a turn the model may waste; and a conversation does
  // not end the way a coding task does, so compaction is not optional.
  check('the preset omits a todo tool', () => assert.equal(text.includes('dsh-tool-todo'), false,
    'a conversation preset has no task list to keep'));
  check('the preset omits shell and file tools', () => {
    for (const packageName of ['dsh-tool-pwsh', 'dsh-tool-bash', 'dsh-tool-fs']) {
      assert.equal(text.includes(packageName), false, `${packageName} should not be mounted`);
    }
  });
  check('the preset includes compaction', () => {
    assert.ok(text.includes('dsh-compaction-basic'), 'compaction-basic missing');
    assert.ok(text.includes('cordis:group'), 'compaction must be mounted as a group');
  });
} else {
  const parse = yaml.load ?? yaml.parse;
  const doc = parse(readFileSync(path.join(installed, 'cordis.patch.yml'), 'utf8'));
  check('the patch parses as YAML', () => assert.ok(Array.isArray(doc) && doc.length === 1));
  check('it is an insert operation', () => assert.ok(Array.isArray(doc[0].insert)));

  const preset = doc[0].insert[0];
  check('the inserted entry is the agent preset', () => {
    assert.equal(preset.id, 'preset-chat-voice');
    assert.equal(preset.name, '@deepseek-ai/dsh-agent-preset');
    assert.equal(preset.config.id, 'chat-voice');
    assert.equal(preset.config.name, '对话·有声');
  });
  check('the preset contains exactly one dsh-tts plugin', () => {
    const tts = preset.config.plugins.filter((plugin) => plugin.name === 'dsh-tts');
    assert.equal(tts.length, 1, `found ${tts.length} declarations; duplicate registration would collide`);
    assert.equal(tts[0].config.voice, 'local_voice');
    assert.equal(tts[0].config.language, 'zh');
  });
  check('the preset is conversation-scoped (no shell or file tools)', () => {
    const names = preset.config.plugins.map((plugin) => plugin.name);
    assert.equal(names.includes('@deepseek-ai/dsh-tool-pwsh'), false);
    assert.equal(names.includes('@deepseek-ai/dsh-tool-bash'), false);
    assert.equal(names.includes('@deepseek-ai/dsh-tool-fs'), false);
  });
  check('the persona instructs spoken-style Chinese', () => {
    const persona = preset.config.plugins.find((plugin) => plugin.id === 'persona');
    assert.ok(persona !== undefined, 'no persona plugin');
    const prompt = String(persona.config.prefix ?? '');
    assert.ok(prompt.includes('中文'), 'persona does not require Chinese');
    assert.ok(prompt.includes('tts_speak'), 'persona does not call the tool');
    assert.ok(prompt.includes('可朗读') || prompt.includes('读出来'), 'persona lacks the speakability rule');
  });
}

console.log('');
console.log(failures === 0 ? '=== install verification passed ===' : `=== ${failures} check(s) failed ===`);
if (failures > 0) process.exitCode = 1;
