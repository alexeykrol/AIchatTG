import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  loadModerationReviewBinding, reviewCapturePolicy, reviewSocketPaths, validateModerationReviewBinding,
} from '../src/moderation-review-config.mjs';

function binding(overrides = {}) {
  return {
    contract: 'moderation-review-binding/v1', enabled: true,
    bindingId: 'synthetic_source', epochId: 'synthetic_epoch', chatIds: ['-100101'],
    startAt: '2026-09-17T12:00:00.000Z', allowUserId: false, exemptBotIds: ['9001', '9002'],
    limits: { retentionMs: null, maxTextChars: 256, maxContextChars: 128, maxNoteChars: 256, maxObservations: 100 },
    maxEvents: 200, maxErasureReceipts: 100, maxInflight: 2,
    captureTimeoutMs: 100, ipcTimeoutMs: 100, notificationTimeoutMs: 500,
    notificationIntervalMs: 1000, maxAlertsPerHour: 5,
    recipientChatId: '777001', reviewerPrincipal: 'synthetic-reviewer',
    consoleUrl: 'https://review.example.invalid',
    ipcRoot: '/private/tmp/synthetic-review-ipc', storeRoot: '/private/tmp/synthetic-review-store',
    deliveryEnabled: false, ...overrides,
  };
}
function invalid(value) {
  assert.throws(() => validateModerationReviewBinding(value), (error) => {
    assert.equal(error.message, 'review_binding_invalid');
    assert.equal(error.code, 'review_binding_invalid');
    assert.equal(error.statusCode, 503);
    assert.equal(JSON.stringify(error).includes('777001'), false);
    return true;
  });
}
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'review-config-test-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'binding.json') };
}
function writeBinding(file, value = binding()) {
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  chmodSync(file, 0o600);
}

test('valid binding is a detached deeply frozen narrow policy with fixed socket names', () => {
  const source = binding(), before = structuredClone(source);
  const validated = validateModerationReviewBinding(source);
  assert.deepEqual(validated, before);
  assert.notEqual(validated, source);
  for (const value of [validated, validated.chatIds, validated.exemptBotIds, validated.limits]) assert.ok(Object.isFrozen(value));
  source.chatIds[0] = '-222'; source.limits.maxTextChars = 1;
  assert.deepEqual(validated, before);
  const capture = reviewCapturePolicy(validated);
  assert.deepEqual(capture, { enabled: true, bindingId: 'synthetic_source', epochId: 'synthetic_epoch',
    chatIds: ['-100101'], startAt: '2026-09-17T12:00:00.000Z', allowUserId: false,
    exemptBotIds: ['9001', '9002'], maxTextChars: 256, maxContextChars: 128 });
  capture.chatIds.push('-333'); capture.exemptBotIds.push('444');
  assert.deepEqual(validated.chatIds, ['-100101']);
  assert.deepEqual(validated.exemptBotIds, ['9001', '9002']);
  assert.deepEqual(reviewSocketPaths(validated), {
    console: '/private/tmp/synthetic-review-ipc/console-review.sock',
    runtime: '/private/tmp/synthetic-review-ipc/runtime-review.sock',
  });
});

test('all binding and limit fields are explicit with exact nullability; unknown fields reject', () => {
  for (const key of Object.keys(binding())) {
    const absent = binding(); delete absent[key]; invalid(absent);
    invalid(binding({ [key]: null }));
  }
  invalid({ ...binding(), token: 'private-secret' });
  for (const key of Object.keys(binding().limits)) {
    const absent = binding(); delete absent.limits[key]; invalid(absent);
  }
  invalid(binding({ limits: { ...binding().limits, extra: 1 } }));
  for (const value of [undefined, null, [], {}, true, 1]) invalid(value);
});

const bounds = [
  ['limits.maxTextChars', 1, 8192], ['limits.maxContextChars', 1, 4096], ['limits.maxNoteChars', 1, 4096],
  ['limits.maxObservations', 1, 1_000_000], ['maxEvents', 1, 5_000_000], ['maxErasureReceipts', 1, 2_000_000],
  ['maxInflight', 1, 32], ['captureTimeoutMs', 50, 5000], ['ipcTimeoutMs', 50, 5000],
  ['notificationTimeoutMs', 100, 10_000], ['notificationIntervalMs', 1000, 60_000], ['maxAlertsPerHour', 1, 60],
];
for (const [field, min, max] of bounds) {
  test(`strict integer bounds: ${field}`, () => {
    const assign = (value) => {
      const candidate = binding(), [first, second] = field.split('.');
      if (second) candidate[first][second] = value; else candidate[first] = value;
      return candidate;
    };
    for (const value of [min, max]) assert.doesNotThrow(() => validateModerationReviewBinding(assign(value)));
    for (const value of [min - 1, max + 1, min + 0.5, String(min), true, null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) invalid(assign(value));
  });
}

test('enabled, delivery, retention and identity-retention switches never coerce strings/defaults', () => {
  for (const enabled of [false, 1, 'true']) invalid(binding({ enabled }));
  for (const field of ['deliveryEnabled', 'allowUserId']) {
    for (const value of [true, false]) assert.doesNotThrow(() => validateModerationReviewBinding(binding({ [field]: value })));
    for (const value of ['true', 'false', 0, 1]) invalid(binding({ [field]: value }));
  }
  for (const value of [0, 1, 'null', false]) invalid(binding({ limits: { ...binding().limits, retentionMs: value } }));
});

test('identities and lists reject unsafe IDs, wrong roles, duplicates and excess entries', () => {
  for (const bad of ['', '1', '-01', '-0', '-9007199254740992', -100101, ' -100101', '-100101 ']) {
    invalid(binding({ chatIds: [bad] }));
  }
  for (const bad of ['', '-1', '0', '01', '+1', '1.0', '1e3', '9007199254740992', 201]) {
    invalid(binding({ exemptBotIds: [bad] })); invalid(binding({ recipientChatId: bad }));
  }
  invalid(binding({ chatIds: [] })); invalid(binding({ chatIds: ['-100101', '-100101'] }));
  invalid(binding({ chatIds: Array.from({ length: 21 }, (_, index) => `-${index + 1}`) }));
  invalid(binding({ exemptBotIds: ['9001', '9001'] }));
  invalid(binding({ exemptBotIds: Array.from({ length: 101 }, (_, index) => String(index + 1)) }));
  assert.doesNotThrow(() => validateModerationReviewBinding(binding({ chatIds: ['-9007199254740991'],
    exemptBotIds: ['9007199254740991'], recipientChatId: '9007199254740991' })));
  for (const field of ['bindingId', 'epochId']) {
    for (const value of ['short', 'a'.repeat(81), 'space value', 'bad\nvalue']) invalid(binding({ [field]: value }));
  }
  for (const reviewerPrincipal of ['', 'a'.repeat(129), 'space name', 'private\nname']) invalid(binding({ reviewerPrincipal }));
});

test('activation clocks are exact valid nonnegative UTC instants', () => {
  for (const startAt of ['', '2026-09-17', '2026-09-17T12:00:00Z', '2026-09-17T12:00:00.000+00:00',
    '2026-02-30T12:00:00.000Z', '1969-12-31T23:59:59.999Z', Date.now()]) invalid(binding({ startAt }));
  assert.doesNotThrow(() => validateModerationReviewBinding(binding({ startAt: '1970-01-01T00:00:00.000Z' })));
});

for (const field of ['ipcRoot', 'storeRoot']) {
  test(`rejects unsafe/ambiguous storage path: ${field}`, () => {
    for (const value of ['', '.', 'relative/path', '/', '/tmp', '/private/tmp/test/',
      '/private/tmp/a/../b', '/private/tmp/a/./b', '/private/tmp/a/..', '/private/tmp/a/.',
      '/private//tmp/a', '/private/tmp/a\0b', '/private/tmp/a\nb']) invalid(binding({ [field]: value }));
  });
}

test('IPC and private store roots must be distinct and nonoverlapping after canonicalization', () => {
  for (const [ipcRoot, storeRoot] of [
    ['/private/tmp/synthetic', '/private/tmp/synthetic'],
    ['/private/tmp/synthetic', '/private/tmp/synthetic/sub'],
    ['/private/tmp/synthetic/sub', '/private/tmp/synthetic'],
    ['/private/tmp/synthetic/child/..', '/private/tmp/synthetic'],
    ['/private//tmp/synthetic', '/private/tmp/synthetic'],
  ]) invalid(binding({ ipcRoot, storeRoot }));
});

test('console URL is only an explicit credential-free canonical HTTPS origin', () => {
  for (const consoleUrl of ['http://review.example.invalid', 'https://review.example.invalid/',
    'https://review.example.invalid/cases', 'https://user:password@review.example.invalid',
    'https://review.example.invalid?x=1', 'https://review.example.invalid#fragment',
    'file:///private/tmp/test', '//review.example.invalid', 'not a URL']) invalid(binding({ consoleUrl }));
});

test('missing config disables the optional feature without inferring a path or identity', () => {
  for (const path of [undefined, null, '']) assert.deepEqual(loadModerationReviewBinding(path), { binding: null, code: 'review_disabled' });
});

test('owned0600 exact regular JSON file loads and creates no external resources', (t) => {
  const { file } = fixture(t); writeBinding(file);
  const loaded = loadModerationReviewBinding(file);
  assert.equal(loaded.code, null); assert.deepEqual(loaded.binding, binding());
  assert.ok(Object.isFrozen(loaded.binding));
});

test('invalid/missing JSON or file permissions return only safe unavailable status', (t) => {
  const { directory, file } = fixture(t);
  for (const path of [join(directory, 'absent.json'), directory, 'binding.json', 12, '/private/tmp/does-not-exist-review-config']) {
    assert.deepEqual(loadModerationReviewBinding(path), { binding: null, code: 'review_binding_unavailable' });
  }
  for (const raw of ['', '{"secret": "private-source",', 'null', '[]', JSON.stringify(binding({ enabled: false }))]) {
    writeFileSync(file, raw, { mode: 0o600 });
    assert.deepEqual(loadModerationReviewBinding(file), { binding: null, code: 'review_binding_unavailable' });
  }
  writeBinding(file);
  for (const mode of [0o644, 0o640, 0o400, 0o700]) {
    chmodSync(file, mode);
    assert.deepEqual(loadModerationReviewBinding(file), { binding: null, code: 'review_binding_unavailable' });
  }
});

test('symlink, hardlink and noncanonical configuration-file aliases are refused', (t) => {
  const { directory, file } = fixture(t); writeBinding(file);
  const symbolic = join(directory, 'symbolic.json'); symlinkSync(file, symbolic);
  assert.deepEqual(loadModerationReviewBinding(symbolic), { binding: null, code: 'review_binding_unavailable' });
  assert.deepEqual(loadModerationReviewBinding(`${directory}/./binding.json`), { binding: null, code: 'review_binding_unavailable' });
  const linked = join(directory, 'hard.json'); linkSync(file, linked);
  for (const path of [file, linked]) assert.deepEqual(loadModerationReviewBinding(path), { binding: null, code: 'review_binding_unavailable' });
});

test('configuration reads are bounded to16KiB and malformed private values never escape status', (t) => {
  const { file } = fixture(t), raw = JSON.stringify(binding());
  writeFileSync(file, raw + ' '.repeat(16_384 - Buffer.byteLength(raw)), { mode: 0o600 });
  assert.equal(loadModerationReviewBinding(file).code, null);
  writeFileSync(file, raw + ' '.repeat(16_385 - Buffer.byteLength(raw)), { mode: 0o600 });
  assert.deepEqual(loadModerationReviewBinding(file), { binding: null, code: 'review_binding_unavailable' });
});
