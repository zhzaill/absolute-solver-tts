import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(testDir));
const source = readFileSync(join(repoRoot, 'browser', 'lib', 'client.js'), 'utf8');

assert.equal(source.includes('MutationObserver'), false, 'client must not scrape the conversation DOM');
assert.equal(source.includes('querySelectorAll'), false, 'client must use the DSH slot API');

let definition;
let renderCard;
const react = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children } };
  },
  useEffect(run) {
    run();
  },
  useRef() {
    return { current: null };
  },
};

const context = {
  window: {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  },
  console,
};
vm.runInNewContext(source, context, { filename: 'plugin/lib/client.js' });
assert.equal(definition?.id, 'dsh-tts-browser');

const client = definition.factory((specifier) => {
  assert.equal(specifier, 'react');
  return react;
});
assert.equal(client.name, 'dsh-tts-browser');
assert.deepEqual([...client.inject], ['slots']);

const registration = {
  definition: null,
  component: null,
};
client.apply({
  slots: {
    inject(name, callback) {
      assert.equal(name, 'tool.call.toolview');
      callback();
    },
    register(value, component) {
      registration.definition = value;
      registration.component = component;
      return () => {};
    },
  },
});

assert.equal(registration.definition.name, 'tool.call.toolview');
assert.equal(registration.definition.key, 'tts_speak');

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit));
    return;
  }
  if (typeof node.type === 'function') {
    walk(node.type(node.props), visit);
    return;
  }
  visit(node);
  walk(node.props?.children, visit);
}

const resultTree = registration.component({
  block: {
    kind: 'tool-result',
    meta: {
      url: '/dsh-tts/audio?id=test',
      durationSeconds: 1.25,
      language: 'zh',
    },
  },
});

let audio;
let label;
walk(resultTree, (node) => {
  if (node.type === 'audio') audio = node;
  if (node.props?.children?.[0] === 'Speech · zh · 1.25s') label = node;
});

assert.equal(audio?.props.src, '/dsh-tts/audio?id=test');
assert.equal(audio?.props.controls, true);
assert.equal(audio?.props.preload, 'metadata');
assert.equal(audio?.props['data-dsh-tts-audio-player'], '1');
assert.ok(label, 'result card does not identify the language and duration');

const runningTree = registration.component({ block: { kind: 'tool-call' } });
let runningText = '';
walk(runningTree, (node) => {
  const child = node.props?.children?.[0];
  if (typeof child === 'string') runningText += child;
});
assert.ok(runningText.includes('Synthesizing speech'));

console.log(JSON.stringify({
  ok: true,
  slot: registration.definition,
  audio: {
    src: audio.props.src,
    controls: audio.props.controls,
    preload: audio.props.preload,
  },
}, null, 2));
