import assert from 'node:assert/strict';
import test from 'node:test';
import { applySchemaDefaults, validateAgainstSchema } from '../src/schema.mjs';

/**
 * The walker is only ever pointed at the two package contracts, so the tests
 * exercise exactly the keywords those files use — plus the refusal of anything
 * they do not, because silently passing an unsupported construct would make the
 * validation a decoration.
 */

const PACK_LIKE = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'status', 'entries', 'latency_ms'],
  properties: {
    schema_version: { const: 'kb_retrieval_pack_v1' },
    status: { enum: ['ready', 'not_found'] },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'content'],
        properties: { id: { type: 'string', minLength: 1 }, content: { type: 'string' } },
      },
    },
    score: { type: 'number', minimum: 0, maximum: 1 },
    latency_ms: { type: 'integer', minimum: 0 },
    note: { type: ['string', 'null'] },
  },
};

function pack(overrides = {}) {
  return {
    schema_version: 'kb_retrieval_pack_v1',
    status: 'ready',
    entries: [{ id: 'lesson:1:a:001', content: 'текст' }],
    latency_ms: 0,
    ...overrides,
  };
}

test('a conforming document validates with no errors', () => {
  assert.deepEqual(validateAgainstSchema(pack(), PACK_LIKE), { valid: true, errors: [] });
  assert.equal(validateAgainstSchema(pack({ note: null }), PACK_LIKE).valid, true);
  assert.equal(validateAgainstSchema(pack({ score: 1 }), PACK_LIKE).valid, true);
});

test('an unknown field is refused because the contract forbids extensions', () => {
  const result = validateAgainstSchema(pack({ surprise: true }), PACK_LIKE);
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /unknown field "surprise"/);
  // Nested objects are checked with the same strictness.
  const nested = validateAgainstSchema(
    pack({ entries: [{ id: 'x', content: 'y', title: 'z' }] }), PACK_LIKE);
  assert.equal(nested.valid, false);
  assert.match(nested.errors[0], /entries\[0\]: unknown field "title"/);
});

test('a wrong type, a missing required field and a broken enum are each reported', () => {
  assert.match(validateAgainstSchema(pack({ latency_ms: 'soon' }), PACK_LIKE).errors[0], /expected type integer/);
  assert.match(validateAgainstSchema(pack({ latency_ms: 1.5 }), PACK_LIKE).errors[0], /expected type integer/);
  const missing = pack(); delete missing.status;
  assert.match(validateAgainstSchema(missing, PACK_LIKE).errors[0], /missing required field "status"/);
  assert.match(validateAgainstSchema(pack({ status: 'maybe' }), PACK_LIKE).errors[0], /outside enum/);
  assert.match(validateAgainstSchema(pack({ schema_version: 'v2' }), PACK_LIKE).errors[0], /expected const/);
});

test('numeric bounds and string lengths are enforced where the contract states them', () => {
  assert.match(validateAgainstSchema(pack({ score: 1.5 }), PACK_LIKE).errors[0], /> maximum 1/);
  assert.match(validateAgainstSchema(pack({ latency_ms: -1 }), PACK_LIKE).errors[0], /< minimum 0/);
  assert.match(
    validateAgainstSchema(pack({ entries: [{ id: '', content: 'x' }] }), PACK_LIKE).errors[0],
    /shorter than 1/,
  );
});

test('a union type accepts every listed member and refuses the rest', () => {
  assert.equal(validateAgainstSchema(pack({ note: 'text' }), PACK_LIKE).valid, true);
  assert.equal(validateAgainstSchema(pack({ note: null }), PACK_LIKE).valid, true);
  assert.equal(validateAgainstSchema(pack({ note: 7 }), PACK_LIKE).valid, false);
});

test('an if/then branch applies only when its condition holds', () => {
  const schema = {
    type: 'object',
    properties: { mode: { type: 'string' }, question: { type: 'string' } },
    allOf: [{
      if: { properties: { mode: { const: 'current_question' } }, required: ['mode'] },
      then: { required: ['question'], properties: { question: { type: 'string', minLength: 1 } } },
    }],
  };
  assert.equal(validateAgainstSchema({ mode: 'anticipatory' }, schema).valid, true);
  assert.equal(validateAgainstSchema({ mode: 'current_question' }, schema).valid, false);
  assert.equal(validateAgainstSchema({ mode: 'current_question', question: 'что такое агент' }, schema).valid, true);
});

test('an unsupported schema keyword type is refused rather than silently passed', () => {
  const result = validateAgainstSchema({ a: 1 }, { type: 'object', properties: { a: { type: 'bigint' } } });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /unsupported schema type/);
});

test('top-level defaults are applied exactly as the contract declares them', () => {
  const schema = {
    type: 'object',
    properties: { max_entries: { type: 'integer', default: 12 }, question: { type: 'string' } },
  };
  assert.deepEqual(applySchemaDefaults({ question: 'q' }, schema), { question: 'q', max_entries: 12 });
  // An explicit value is never overwritten by the default.
  assert.deepEqual(applySchemaDefaults({ question: 'q', max_entries: 5 }, schema).max_entries, 5);
});

test('validation reports rather than throws, because the runtime routes by reason code', () => {
  assert.equal(validateAgainstSchema(null, PACK_LIKE).valid, false);
  assert.equal(validateAgainstSchema(undefined, PACK_LIKE).valid, false);
  assert.equal(validateAgainstSchema('a string', PACK_LIKE).valid, false);
  assert.equal(validateAgainstSchema(pack(), null).valid, true, 'no schema is not a failure of the value');
});
