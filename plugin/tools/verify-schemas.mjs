/**
 * Verify the tool definitions against the framework's real contract.
 *
 * Why this file exists
 * --------------------
 * The three earlier suites all mocked `ctx.tools.register` as a bare Map insert,
 * so nothing ever checked the two things the real registry actually enforces.
 * Reading the shipped implementation showed what those are
 * (`@deepseek-ai/dsh-tools/lib/index.js`):
 *
 *   register(definition):
 *     - output must be an object whose render is a function
 *     - assertSupportedJsonSchema(output.schema)          <- the enforced subset
 *     - timeoutMs, when present, must be a positive finite number
 *     - the name `run_code` is reserved
 *
 *   `parameters` is NOT inspected by register at all: by the time a definition
 *   reaches it, `parameters` must already be a JSON Schema. `defineTool` is the
 *   author-side translator from the parameter DSL to that schema, not a
 *   registration requirement.
 *
 * The subset checker below is a faithful re-implementation of the rules read out
 * of the shipped validator, not a guess. Its vocabularies are copied verbatim:
 *
 *   CONSTRAINT_KEYWORDS      type oneOf properties required additionalProperties
 *                            items enum const
 *   ANNOTATION_KEYWORDS      description title default examples
 *   SCHEMA_TYPES             object array string number integer boolean null
 *   ONE_OF_SIBLING_KEYWORDS  properties required additionalProperties items enum const
 *
 * Rules: a node must declare `type` XOR `oneOf`; `required` must be an array of
 * strings naming only declared `properties`; `additionalProperties` must be a
 * boolean; `description` and `title` must be strings; unknown keys are rejected.
 *
 * Run: node tools/verify-schemas.mjs
 */

import assert from 'node:assert/strict';

import { registerTTSTools } from '../lib/tools.js';

const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
]);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ONE_OF_SIBLING_KEYWORDS = [
  'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Collect every violation for one raw schema tree. */
export function checkSchemaNode(root, rootPath) {
  const violations = [];
  const visit = (node, path) => {
    if (!isRecord(node)) {
      violations.push(`${path} must be a schema object`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
      violations.push(`${path}.${key} is not a supported keyword`);
    }
    if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
      violations.push(`${path}.description must be a string`);
    }
    if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') {
      violations.push(`${path}.title must be a string`);
    }

    const hasType = Object.hasOwn(node, 'type');
    const hasOneOf = Object.hasOwn(node, 'oneOf');
    if (hasType && hasOneOf) {
      violations.push(`${path} cannot declare both type and oneOf`);
      return;
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
      }
      return;
    }
    if (hasType && !SCHEMA_TYPES.has(node.type)) {
      violations.push(`${path}.type ${JSON.stringify(node.type)} is not a supported type`);
    }
    if (hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`);
      }
      if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) {
        violations.push(`${path}.oneOf must be a non-empty array`);
      } else {
        node.oneOf.forEach((branch, index) => visit(branch, `${path}.oneOf[${index}]`));
      }
    }
    if (Object.hasOwn(node, 'properties')) {
      if (!isRecord(node.properties)) {
        violations.push(`${path}.properties must be an object`);
      } else {
        for (const [key, value] of Object.entries(node.properties)) {
          visit(value, `${path}.properties.${key}`);
        }
      }
    }
    if (Object.hasOwn(node, 'items')) visit(node.items, `${path}.items`);

    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${path}.required must be an array of strings`);
      } else {
        const declared = isRecord(node.properties) ? node.properties : {};
        for (const key of node.required) {
          if (!Object.hasOwn(declared, key)) {
            violations.push(`${path}.required names "${key}" which is not in properties`);
          }
        }
      }
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties must be a boolean`);
    }
  };
  visit(root, rootPath);
  return violations;
}

/** The preconditions the shipped `register()` actually enforces, in its order. */
export function checkRegisterPreconditions(definition) {
  const violations = [];
  if (typeof definition?.name !== 'string' || definition.name === '') {
    violations.push('name must be a non-empty string');
  }
  if (definition?.name === 'run_code') {
    violations.push('run_code is reserved for the PTC presentation transport');
  }
  if (typeof definition?.execute !== 'function') violations.push('execute must be a function');
  const output = definition?.output;
  if (!isRecord(output)) {
    violations.push('output must be an object');
  } else {
    if (typeof output.render !== 'function') violations.push('output.render must be a function');
    violations.push(...checkSchemaNode(output.schema, 'output.schema'));
  }
  if (definition?.timeoutMs !== undefined
    && (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0)) {
    violations.push('timeoutMs must be a positive finite number');
  }
  return violations;
}

/** Lossless JSON: no undefined, NaN, Infinity or non-plain objects anywhere. */
export function findLosslessJsonViolations(value, path = 'value') {
  const violations = [];
  const walk = (node, at) => {
    if (node === null) return;
    const type = typeof node;
    if (type === 'string' || type === 'boolean') return;
    if (type === 'number') {
      if (!Number.isFinite(node)) violations.push(`${at} is not a finite number`);
      return;
    }
    if (type === 'undefined') {
      violations.push(`${at} is undefined, which is not a lossless JSON value`);
      return;
    }
    if (type === 'function') {
      violations.push(`${at} is a function`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    if (type === 'object') {
      if (Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) {
        violations.push(`${at} is not a plain object`);
        return;
      }
      for (const [key, item] of Object.entries(node)) walk(item, `${at}.${key}`);
      return;
    }
    violations.push(`${at} has unsupported type ${type}`);
  };
  walk(value, path);
  return violations;
}

/* ------------------------------------------------------------------- the run */

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

// Capture the real definitions by registering into a capture-only context.
const registered = [];
const ctx = { tools: { register: (definition) => { registered.push(definition); return () => {}; } } };
const connection = {
  baseUrl: 'http://127.0.0.1:18080/v1',
  speechUrl: 'http://127.0.0.1:18080/v1/audio/speech',
  healthUrl: 'http://127.0.0.1:18080/healthz',
  authHeader: 'Authorization',
  authScheme: 'Bearer',
  hasApiKey: false,
  extraHeaderNames: [],
};
const runtime = {
  audio: { size: () => 0 },
  audioBasePath: '/dsh-tts/audio',
  audioUrl: (id) => `http://127.0.0.1:19387/dsh-tts/audio?id=${id}`,
  getConfig: () => ({
    baseUrl: 'http://127.0.0.1:18080/v1', model: 'tts-1', voice: 'local_voice',
    language: 'zh', promptLanguage: 'zh', apiKey: '', timeoutMs: 120000, cacheEntries: 32,
  }),
  client: () => ({
    health: async () => ({
      ok: true,
      reachable: true,
      status: 200,
      url: 'u',
      tried: [{ url: 'u', status: 200 }],
    }),
    describeConnection: () => connection,
  }),
  synthesize: async () => ({ id: 'x', cached: false, bytes: 1, durationSeconds: 1, sampleRate: 24000, voice: 'v', language: 'zh', languageReason: 'inferred' }),
};
registerTTSTools(ctx, runtime);

console.log(`captured ${registered.length} definition(s)`);
console.log('');

check('both tools were registered', () => {
  assert.deepEqual(registered.map((d) => d.name).sort(), ['tts_speak', 'tts_status']);
});

for (const definition of registered) {
  check(`${definition.name}: passes the real register() preconditions`, () => {
    const violations = checkRegisterPreconditions(definition);
    assert.deepEqual(violations, [], `violations: ${JSON.stringify(violations, null, 2)}`);
  });

  check(`${definition.name}: output.schema conforms to the enforced subset`, () => {
    const violations = checkSchemaNode(definition.output.schema, 'output.schema');
    assert.deepEqual(violations, []);
  });

  check(`${definition.name}: parameters conform to the enforced subset`, () => {
    // register() does not inspect parameters, but they are the schema the model
    // receives, so they must belong to the same subset the framework validates
    // everywhere else.
    const violations = checkSchemaNode(definition.parameters, 'parameters');
    assert.deepEqual(violations, [], `violations: ${JSON.stringify(violations, null, 2)}`);
  });

  check(`${definition.name}: description is substantive for the model`, () => {
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length >= 40, 'description is too thin to guide the model');
  });
}

// Negative controls: the checker must reject what the framework rejects, or a
// green run above means nothing.
console.log('');
console.log('negative controls (the checker must reject these)');
check('rejects an unsupported keyword', () => {
  assert.ok(checkSchemaNode({ type: 'object', patternProperties: {} }, 's').length > 0);
});
check('rejects required naming an undeclared property', () => {
  assert.ok(checkSchemaNode({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }, 's').length > 0);
});
check('rejects both type and oneOf', () => {
  assert.ok(checkSchemaNode({ type: 'object', oneOf: [{ type: 'string' }] }, 's').length > 0);
});
check('rejects a non-boolean additionalProperties', () => {
  assert.ok(checkSchemaNode({ type: 'object', additionalProperties: {} }, 's').length > 0);
});
check('rejects an unknown type', () => {
  assert.ok(checkSchemaNode({ type: 'money' }, 's').length > 0);
});
check('rejects the reserved run_code name', () => {
  assert.ok(checkRegisterPreconditions({ name: 'run_code', execute() {}, output: { schema: { type: 'object' }, render() {} } }).length > 0);
});
check('rejects a non-positive timeoutMs', () => {
  assert.ok(checkRegisterPreconditions({ name: 'x', execute() {}, timeoutMs: 0, output: { schema: { type: 'object' }, render() {} } }).length > 0);
});
check('rejects undefined inside a result', () => {
  assert.ok(findLosslessJsonViolations({ a: undefined }).length > 0);
});
check('rejects NaN inside a result', () => {
  assert.ok(findLosslessJsonViolations({ a: Number.NaN }).length > 0);
});

// The declared parameter shape must admit the fields the tools actually read.
check('tts_speak parameters declare text as required', () => {
  const speak = registered.find((d) => d.name === 'tts_speak');
  assert.deepEqual(speak.parameters.required, ['text']);
  for (const key of ['text', 'voice', 'language', 'speed']) {
    assert.ok(speak.parameters.properties[key], `missing parameter ${key}`);
  }
});

console.log('');
console.log(failures === 0 ? '=== tool definitions conform to the framework contract ===' : `=== ${failures} check(s) failed ===`);
if (failures > 0) process.exitCode = 1;
