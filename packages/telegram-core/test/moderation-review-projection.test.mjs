import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  moderationReviewSourceDigest,
  projectModerationReviewUpdate,
  validateModerationReviewEnvelope,
} from '../src/moderation-review-projection.mjs';

const START = '2026-09-17T12:00:00.000Z';
const RECEIVED = '2026-09-17T12:01:00.000Z';
const START_SEC = Date.parse(START) / 1000;
const policy = (overrides = {}) => ({
  enabled: true, bindingId: 'synthetic-source', epochId: 'synthetic-epoch',
  chatIds: ['-100101'], startAt: START, allowUserId: false,
  exemptBotIds: ['9001', '9002'], maxTextChars: 64, maxContextChars: 48, ...overrides,
});
const update = (message = {}, extra = {}) => ({
  update_id: 101,
  message: { message_id: 51, chat: { id: -100101 }, date: START_SEC + 10,
    from: { id: 201, is_bot: false }, text: 'Synthetic review comment', ...message },
  ...extra,
});
function project(source = update(), rules = policy(), receivedAt = RECEIVED, role = 'moderator') {
  return projectModerationReviewUpdate({ role, update: source, policy: rules, receivedAt });
}
function envelope(source = update(), rules = policy()) {
  const result = project(source, rules);
  assert.equal(result.kind, 'candidate', JSON.stringify(result));
  return structuredClone(result.envelope);
}
const reply = (overrides = {}) => ({
  message_id: 40, chat: { id: -100101 }, text: 'Synthetic parent', ...overrides,
});
function edit({ originalDate = START_SEC + 10, editDate = START_SEC + 20 } = {}) {
  const source = update();
  return { update_id: source.update_id, edited_message: { ...source.message, date: originalDate, edit_date: editDate } };
}
function assertStatus(result, kind, code) {
  assert.deepEqual(result, { kind, code });
  assert.match(code, /^review_[a-z_]+$/u);
}
function invalid(candidate, rules = policy(), options = { now: RECEIVED }, code) {
  assert.throws(() => validateModerationReviewEnvelope(candidate, rules, options), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.code, /^review_[a-z_]+$/u);
    assert.equal(error.message, error.code);
    assert.ok(Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599);
    assert.ok(!JSON.stringify(error).includes('Synthetic review comment'));
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test('projects exactly the approved envelope and independently validates without mutation', () => {
  const source = update({
    from: { id: 201, username: 'private_name', first_name: 'private profile' },
    chat: { id: -100101, title: 'private title' }, photo: [{ file_id: 'private file' }],
    entities: [{ type: 'url', url: 'private url' }], bindingId: 'payload forgery', epochId: 'payload forgery',
  });
  const before = structuredClone(source);
  const result = project(source);
  assert.equal(result.kind, 'candidate');
  assert.deepEqual(Object.keys(result.envelope).sort(), [
    'contract', 'bindingId', 'epochId', 'updateId', 'kind', 'chatId', 'messageId',
    'sourceDateSec', 'editDateSec', 'observedAt', 'text', 'userId',
    'contextStatus', 'sourceDigest', 'context', 'truncated',
  ].sort());
  assert.deepEqual({ ...result.envelope, sourceDigest: 'DIGEST' }, {
    contract: 'moderation-review-capture/v1', bindingId: 'synthetic-source', epochId: 'synthetic-epoch',
    updateId: '101', kind: 'message', chatId: '-100101', messageId: '51',
    sourceDateSec: START_SEC + 10, editDateSec: null, observedAt: RECEIVED,
    text: 'Synthetic review comment', userId: null, contextStatus: 'none',
    sourceDigest: 'DIGEST', context: null, truncated: { text: false, context: false },
  });
  assert.deepEqual(source, before);
  assert.equal(JSON.stringify(result).includes('private'), false);
  const checked = validateModerationReviewEnvelope(result.envelope, policy(), { now: RECEIVED });
  assert.deepEqual(checked, result.envelope);
  assert.notEqual(checked, result.envelope);
  assert.ok(Object.isFrozen(checked));
  assert.ok(Object.isFrozen(checked.truncated));
});

test('keeps source text exactly and uses text before caption', () => {
  const source = update({ text: '  Exact text\n', caption: 'Ignored caption' });
  assert.equal(envelope(source).text, '  Exact text\n');
  const caption = update({ caption: 'Only caption' });
  delete caption.message.text;
  assert.equal(envelope(caption).text, 'Only caption');
  for (const text of ['', ' \n\t']) assertStatus(project(update({ text, caption: 'Not selected' })), 'skip', 'review_no_text');
});

test('capture is disabled when missing or explicitly off, without reading source fields', () => {
  const source = new Proxy({}, { get() { throw new Error('private payload'); } });
  for (const rules of [undefined, null, { enabled: false }]) {
    assertStatus(projectModerationReviewUpdate({ role: 'moderator', update: source, policy: rules }), 'skip', 'review_disabled');
  }
});

for (const role of ['assistant', 'gatekeeper', 'unknown', undefined]) {
  test(`excludes non-Moderator role ${String(role)}`, () => {
    assertStatus(projectModerationReviewUpdate({ role, update: update(), policy: policy(), receivedAt: RECEIVED }), 'skip', 'review_role_ineligible');
  });
}

for (const unsupported of [
  {}, { callback_query: { data: 'private' } }, { channel_post: update().message },
  { edited_channel_post: update().message }, { deleted_message: update().message },
  { business_message: update().message },
]) {
  test(`unsupported source is skipped: ${Object.keys(unsupported)[0] || 'empty'}`, () => {
    assertStatus(project(unsupported), 'skip', 'review_update_unsupported');
  });
}

test('skips only exact out-of-scope chats, with no payload in status', () => {
  assertStatus(project(update({ chat: { id: -100102 } })), 'skip', 'review_chat_out_of_scope');
  assertStatus(project(update({ chat: { id: 100101 } })), 'skip', 'review_chat_out_of_scope');
  assertStatus(project(update({ chat: { id: '-0100101' } })), 'reject', 'review_id_invalid');
});

for (const serviceField of [
  'pinned_message', 'new_chat_members', 'left_chat_member', 'new_chat_title',
  'migrate_to_chat_id', 'forum_topic_created', 'video_chat_ended', 'successful_payment',
  'web_app_data', 'giveaway_completed', 'checklist_tasks_done', 'suggested_post_paid',
]) {
  test(`service ${serviceField} is skipped even with a text field`, () => {
    assertStatus(project(update({ [serviceField]: {} })), 'skip', 'review_service_message');
  });
}

test('top-level automatic forward is skipped but ordinary forwarding and replies remain eligible', () => {
  assertStatus(project(update({ is_automatic_forward: true })), 'skip', 'review_automatic_forward');
  assertStatus(project(update({ is_automatic_forward: 'true' })), 'reject', 'review_message_invalid');
  assert.equal(envelope(update({ forward_origin: { chat: { id: -9000 } } })).contextStatus, 'none');
  const candidate = envelope(update({ reply_to_message: reply({ is_automatic_forward: true }) }));
  assert.equal(candidate.contextStatus, 'supplied');
  assert.deepEqual(candidate.context, { messageId: '40', text: 'Synthetic parent', relation: 'direct_reply' });
});

test('exempts own and configured bot IDs independent of untrusted sender bot flags', () => {
  for (const id of [9001, '9002']) {
    for (const is_bot of [true, false, undefined]) {
      assertStatus(project(update({ from: { id, is_bot } })), 'skip', 'review_exempt_bot');
    }
  }
  assert.equal(envelope(update({ from: { id: 7777, is_bot: true } })).userId, null);
});

test('retains user ID only when explicitly allowed and tolerates absent sender', () => {
  assert.equal(envelope(update(), policy({ allowUserId: true })).userId, '201');
  const source = update();
  delete source.message.from;
  assert.equal(envelope(source, policy({ allowUserId: true })).userId, null);
  assertStatus(project(update({ from: null })), 'reject', 'review_sender_invalid');
});

test('retains only direct same-chat context, never nested context or profile/media data', () => {
  const direct = reply({
    from: { id: 202, username: 'private parent author' }, caption: 'Ignored caption',
    photo: [{ file_id: 'private media' }], forward_origin: { chat: { id: -8000 } },
  });
  Object.defineProperty(direct, 'reply_to_message', { get() { throw new Error('must not recurse'); } });
  const candidate = envelope(update({ reply_to_message: direct }));
  assert.deepEqual(candidate.context, { messageId: '40', text: 'Synthetic parent', relation: 'direct_reply' });
  assert.equal(JSON.stringify(candidate).includes('private'), false);
  assert.ok(Object.isFrozen(project(update({ reply_to_message: direct })).envelope.context));
});

test('context caption is selected only when direct text is absent', () => {
  const parent = reply({ caption: 'Parent caption' });
  delete parent.text;
  assert.equal(envelope(update({ reply_to_message: parent })).context.text, 'Parent caption');
  assert.equal(envelope(update({ reply_to_message: reply({ text: '', caption: 'Not selected' }) })).contextStatus, 'unavailable');
});

for (const [name, parent] of [
  ['null', null], ['array', []], ['no chat', { message_id: 40, text: 'text' }],
  ['foreign chat', reply({ chat: { id: -100102 } })], ['invalid chat', reply({ chat: { id: '-0' } })],
  ['missing ID', reply({ message_id: undefined })], ['self reply', reply({ message_id: 51 })],
  ['unsafe ID', reply({ message_id: Number.MAX_SAFE_INTEGER + 1 })],
  ['no text', { message_id: 40, chat: { id: -100101 }, photo: [] }],
  ['invalid text', reply({ text: { private: true } })], ['null byte', reply({ text: 'a\0b' })],
  ['service parent', reply({ pinned_message: {} })],
]) {
  test(`unavailable direct context remains visibly incomplete: ${name}`, () => {
    const candidate = envelope(update({ reply_to_message: parent }));
    assert.equal(candidate.contextStatus, 'unavailable');
    assert.equal(candidate.context, null);
    assert.deepEqual(candidate.truncated, { text: false, context: false });
  });
}

for (const marker of ['external_reply', 'quote', 'reply_to_message_id', 'reply_to_story', 'reply_parameters']) {
  test(`missing reply body with ${marker} cannot appear as complete context`, () => {
    assert.equal(envelope(update({ [marker]: {} })).contextStatus, 'unavailable');
  });
}

test('projects original and edit event dates forward-only with inclusive start', () => {
  assert.equal(envelope(update({ date: START_SEC })).kind, 'message');
  assertStatus(project(update({ date: START_SEC - 1 })), 'skip', 'review_before_start');
  const candidate = envelope(edit({ originalDate: START_SEC - 100, editDate: START_SEC }));
  assert.equal(candidate.kind, 'edit');
  assert.equal(candidate.sourceDateSec, START_SEC - 100);
  assert.equal(candidate.editDateSec, START_SEC);
  assertStatus(project(edit({ originalDate: START_SEC - 100, editDate: START_SEC - 1 })), 'skip', 'review_before_start');
  assertStatus(project(update({ date: START_SEC }), policy({ startAt: '2026-09-17T12:00:00.001Z' })), 'skip', 'review_before_start');
});

for (const [name, source] of [
  ['absent source', update({ date: undefined })], ['string source', update({ date: String(START_SEC) })],
  ['negative source', update({ date: -1 })], ['negative zero source', update({ date: -0 })],
  ['fractional source', update({ date: START_SEC + 0.1 })], ['unsafe source', update({ date: Number.MAX_SAFE_INTEGER + 1 })],
  ['future original', update({ date: START_SEC + 61 })], ['future edit', edit({ editDate: START_SEC + 61 })],
  ['missing edit', { update_id: 101, edited_message: update().message }],
  ['null edit', edit({ editDate: null })], ['reversed edit', edit({ editDate: START_SEC })],
  ['original carries edit date', update({ edit_date: START_SEC + 20 })],
]) {
  test(`rejects invalid event time: ${name}`, () => {
    assertStatus(project(source), 'reject', 'review_source_time_invalid');
  });
}

for (const time of [undefined, null, Date.parse(RECEIVED), new Date(RECEIVED), '', '2026-09-17',
  '2026-09-17T12:01:00+00:00', '2026-02-30T12:01:00.000Z', '2026-09-17T25:00:00.000Z',
  '2026-09-17T12:01:00.00Z', '1969-12-31T23:59:59.999Z']) {
  test(`rejects invalid explicit receiver clock: ${String(time)}`, () => {
    assertStatus(projectModerationReviewUpdate({ role: 'moderator', update: update(), policy: policy(), receivedAt: time }), 'reject', 'review_clock_invalid');
  });
}

test('UTC whole seconds and exact receiver-second source dates are valid', () => {
  assert.equal(project(update({ date: START_SEC + 60 }), policy(), '2026-09-17T12:01:00Z').kind, 'candidate');
});

for (const id of ['01', '+1', '1.0', '1e3', ' 1', '1 ', '-0', '-01', 'NaN', '', null,
  Number.MAX_SAFE_INTEGER + 1, '9007199254740992', 1.5, -0, {}, true]) {
  test(`rejects unsafe/noncanonical source ID: ${String(id)}`, () => {
    assertStatus(project(update({}, { update_id: id })), 'reject', 'review_id_invalid');
  });
}

test('safe integer boundary IDs and zero update ID are accepted without precision loss', () => {
  const rules = policy({ chatIds: [String(-Number.MAX_SAFE_INTEGER)], allowUserId: true });
  const candidate = envelope(update({ chat: { id: -Number.MAX_SAFE_INTEGER },
    message_id: Number.MAX_SAFE_INTEGER, from: { id: Number.MAX_SAFE_INTEGER } }, { update_id: 0 }), rules);
  assert.equal(candidate.updateId, '0');
  assert.equal(candidate.chatId, '-9007199254740991');
  assert.equal(candidate.messageId, '9007199254740991');
  assert.equal(candidate.userId, '9007199254740991');
  for (const field of ['message_id', 'chat', 'from']) {
    const value = field === 'chat' || field === 'from' ? { id: 0 } : 0;
    assertStatus(project(update({ [field]: value })), 'reject', 'review_id_invalid');
  }
  assertStatus(project(update({}, { update_id: -1 })), 'reject', 'review_id_invalid');
});

test('malformed supported updates reject safely; ambiguous originals/edits never select a winner', () => {
  for (const source of [null, [], true, { message: null }, { message: {} },
    { message: update().message, edited_message: update().message }]) {
    assert.equal(project(source).kind, 'reject');
  }
  assertStatus(projectModerationReviewUpdate(null), 'reject', 'review_update_invalid');
  assertStatus(project(update({ text: 12 })), 'reject', 'review_text_invalid');
  assertStatus(project(update({ text: 'secret\0text' })), 'reject', 'review_text_invalid');
  const source = update();
  Object.defineProperty(source.message, 'text', { get() { throw new Error('secret source'); } });
  assertStatus(project(source), 'reject', 'review_update_invalid');
});

test('policy requires the complete exact trusted shape and typed values', () => {
  const mutations = [
    (p) => { delete p.bindingId; }, (p) => { p.bindingId = ''; }, (p) => { p.epochId = 'bad\nvalue'; },
    (p) => { p.enabled = 'true'; }, (p) => { p.allowUserId = 'false'; },
    (p) => { p.maxTextChars = 0; }, (p) => { p.maxContextChars = -1; },
    (p) => { p.maxTextChars = 0.5; }, (p) => { p.maxContextChars = Infinity; },
    (p) => { p.chatIds = []; }, (p) => { p.chatIds = [-100101]; },
    (p) => { p.chatIds = ['0']; }, (p) => { p.chatIds.push('-100101'); },
    (p) => { p.exemptBotIds = [9001]; }, (p) => { p.exemptBotIds = ['0']; },
    (p) => { p.exemptBotIds.push('9001'); }, (p) => { p.startAt = '2026-02-30T00:00:00Z'; },
    (p) => { p.untrustedExtra = true; },
  ];
  for (const mutate of mutations) {
    const rules = policy(); mutate(rules);
    assertStatus(project(update(), rules), 'reject', 'review_policy_invalid');
  }
});

test('clips text/context only at explicit caps and marks each field independently', () => {
  const rules = policy({ maxTextChars: 5, maxContextChars: 4 });
  for (const [text, parent, expected] of [
    ['12345', '1234', { text: false, context: false }],
    ['123456', '1234', { text: true, context: false }],
    ['12345', '12345', { text: false, context: true }],
    ['123456', '12345', { text: true, context: true }],
  ]) {
    const candidate = envelope(update({ text, reply_to_message: reply({ text: parent }) }), rules);
    assert.equal(candidate.text, '12345');
    assert.equal(candidate.context.text, '1234');
    assert.deepEqual(candidate.truncated, expected);
  }
});

test('zero context cap preserves supplied-but-clipped evidence instead of claiming no context', () => {
  const rules = policy({ maxContextChars: 0 });
  const candidate = envelope(update({ reply_to_message: reply() }), rules);
  assert.equal(candidate.contextStatus, 'supplied');
  assert.equal(candidate.context.text, '');
  assert.equal(candidate.truncated.context, true);
});

test('limits use store-compatible UTF-16 units and preserve visibly truncated whitespace', () => {
  const rules = policy({ maxTextChars: 3 });
  const candidate = envelope(update({ text: '😀xy' }), rules);
  assert.equal(candidate.text, '😀x');
  assert.equal(candidate.text.length, 3);
  assert.equal(candidate.truncated.text, true);
  assert.equal(envelope(update({ text: '   later content' }), rules).text, '   ');
});

test('sourceDigest is canonical SHA-256 over exactly the ordered pre-clipping semantic fields', () => {
  const candidate = envelope(update({ reply_to_message: reply() }));
  const expected = createHash('sha256').update(JSON.stringify({
    kind: candidate.kind, chatId: candidate.chatId, messageId: candidate.messageId,
    sourceDateSec: candidate.sourceDateSec, editDateSec: candidate.editDateSec,
    text: candidate.text, userId: candidate.userId, contextStatus: candidate.contextStatus,
    context: { messageId: '40', text: 'Synthetic parent', relation: 'direct_reply' },
  })).digest('hex');
  assert.equal(candidate.sourceDigest, expected);
  const reordered = { ...candidate, context: { relation: 'direct_reply', text: 'Synthetic parent', messageId: '40' },
    updateId: '0', observedAt: '1970-01-01T00:00:00Z', ignored: 'unretained value' };
  assert.equal(moderationReviewSourceDigest(reordered), expected);
});

test('full text and context tails change digest even when retained clipped envelopes match', () => {
  const rules = policy({ maxTextChars: 5, maxContextChars: 4 });
  const a = envelope(update({ text: '12345tail A', reply_to_message: reply({ text: '1234parent A' }) }), rules);
  const b = envelope(update({ text: '12345tail B', reply_to_message: reply({ text: '1234parent A' }) }), rules);
  const c = envelope(update({ text: '12345tail A', reply_to_message: reply({ text: '1234parent B' }) }), rules);
  assert.deepEqual({ ...a, sourceDigest: '' }, { ...b, sourceDigest: '' });
  assert.deepEqual({ ...a, sourceDigest: '' }, { ...c, sourceDigest: '' });
  assert.notEqual(a.sourceDigest, b.sourceDigest);
  assert.notEqual(a.sourceDigest, c.sourceDigest);
  assert.equal(JSON.stringify(a).includes('tail A'), false);
  assert.equal(JSON.stringify(a).includes('parent A'), false);
});

test('update IDs are not chronology and transport receipt time is not semantic revision', () => {
  const high = envelope(update({}, { update_id: 999 }));
  const low = envelope(update({}, { update_id: 1 }));
  const later = project(update(), policy(), '2026-09-17T12:02:00.000Z').envelope;
  assert.equal(high.sourceDigest, low.sourceDigest);
  assert.equal(high.sourceDigest, later.sourceDigest);
});

test('Console validates exact envelope, context and truncation shapes independently', () => {
  const base = envelope(update({ reply_to_message: reply() }));
  for (const field of Object.keys(base)) {
    const candidate = structuredClone(base); delete candidate[field]; invalid(candidate);
  }
  for (const field of ['context', 'truncated']) {
    const candidate = structuredClone(base); candidate[field].raw = 'private payload'; invalid(candidate);
    const symbol = structuredClone(base); symbol[field][Symbol('private')] = true; invalid(symbol);
  }
  invalid({ ...base, extra: 'private payload' });
  invalid({ ...base, [Symbol('secret')]: true });
  invalid(Object.assign(Object.create({ inherited: true }), base));
  const accessor = structuredClone(base);
  Object.defineProperty(accessor, 'text', { get() { throw new Error('secret payload'); } });
  invalid(accessor);
});

test('Console binds only to enabled trusted source, epoch, chat and allowed identity retention', () => {
  const base = envelope();
  for (const patch of [
    { contract: 'moderation-review-capture/v2' }, { bindingId: 'other-source' },
    { epochId: 'other-epoch' }, { chatId: '-100102' }, { userId: '201' },
  ]) invalid({ ...base, ...patch });
  invalid(base, { ...policy(), enabled: false });
  const withUser = envelope(update(), policy({ allowUserId: true }));
  invalid({ ...withUser, userId: '9001' }, policy({ allowUserId: true }));
});

test('Console accepts only canonical safe integer string envelope IDs with exact nullability', () => {
  const base = envelope(update({ reply_to_message: reply() }), policy({ allowUserId: true }));
  for (const field of ['updateId', 'chatId', 'messageId', 'userId']) {
    for (const value of [123, '01', '9007199254740992', '', undefined, false]) {
      invalid({ ...base, [field]: value }, policy({ allowUserId: true }));
    }
  }
  for (const field of ['updateId', 'chatId', 'messageId', 'editDateSec', 'contextStatus', 'text', 'sourceDigest']) {
    if (field === 'editDateSec') continue;
    invalid({ ...base, [field]: null }, policy({ allowUserId: true }));
  }
  invalid({ ...base, kind: 'delete' }, policy({ allowUserId: true }));
  invalid({ ...base, context: { ...base.context, messageId: 40 } }, policy({ allowUserId: true }));
});

test('Console independently rejects invalid/future clocks, future source, reversed edits and pre-start events', () => {
  const base = envelope();
  invalid(base, policy(), {}, 'review_clock_invalid');
  invalid(base, policy(), null, 'review_clock_invalid');
  invalid(base, policy(), { now: Date.parse(RECEIVED) }, 'review_clock_invalid');
  invalid(base, policy(), { now: '2026-09-17T12:00:59.999Z' }, 'review_clock_invalid');
  invalid({ ...base, observedAt: '2026-02-30T00:00:00Z' });
  invalid({ ...base, observedAt: '2026-09-17T12:00:09.999Z' }, policy(), { now: RECEIVED }, 'review_source_time_invalid');
  for (const patch of [
    { sourceDateSec: START_SEC - 1 }, { sourceDateSec: START_SEC + 61 },
    { editDateSec: START_SEC + 20 }, { kind: 'edit', editDateSec: null },
    { kind: 'edit', editDateSec: START_SEC }, { kind: 'edit', editDateSec: START_SEC + 61 },
  ]) invalid({ ...base, ...patch });
});

test('Console rejects actual overcap regardless of claimed truncation, and false/surplus flags', () => {
  const rules = policy({ maxTextChars: 5, maxContextChars: 4 });
  const base = envelope(update({ text: '123456', reply_to_message: reply({ text: '12345' }) }), rules);
  for (const flag of [false, true]) {
    invalid({ ...base, text: '123456', truncated: { ...base.truncated, text: flag } }, rules);
    invalid({ ...base, context: { ...base.context, text: '12345' }, truncated: { ...base.truncated, context: flag } }, rules);
  }
  invalid({ ...base, text: '1234' }, rules);
  invalid({ ...base, context: { ...base.context, text: '123' } }, rules);
  for (const value of [null, undefined, 0, 'false']) invalid({ ...base, truncated: { text: value, context: true } }, rules);
  invalid({ ...envelope(), truncated: { text: false, context: true } });
});

test('Console enforces context status/relation/text/nullability and missing context remains incomplete', () => {
  const base = envelope(update({ reply_to_message: reply() }));
  for (const patch of [
    { contextStatus: 'none' }, { contextStatus: 'unavailable' }, { contextStatus: 'invented' },
    { context: null }, { context: { ...base.context, relation: 'fetched' } },
    { context: { ...base.context, messageId: '51' } }, { context: { ...base.context, text: '' } },
  ]) invalid({ ...base, ...patch });
  const missing = envelope(update({ external_reply: {} }));
  assert.equal(validateModerationReviewEnvelope(missing, policy(), { now: RECEIVED }).contextStatus, 'unavailable');
});

test('Console recomputes complete digest, but clipped digests remain trusted-producer collision fences', () => {
  const complete = envelope();
  invalid({ ...complete, text: 'Changed source text' }, policy(), { now: RECEIVED }, 'review_source_digest_invalid');
  invalid({ ...complete, sourceDigest: 'a'.repeat(64) }, policy(), { now: RECEIVED }, 'review_source_digest_invalid');
  for (const sourceDigest of ['', 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), null]) {
    invalid({ ...complete, sourceDigest });
  }
  const rules = policy({ maxTextChars: 5 });
  const clipped = envelope(update({ text: '12345 full source tail' }), rules);
  const trustedDigest = { ...clipped, sourceDigest: 'a'.repeat(64) };
  assert.equal(validateModerationReviewEnvelope(trustedDigest, rules, { now: RECEIVED }).sourceDigest, 'a'.repeat(64));
});

test('digest helper rejects malformed semantics with code-only errors', () => {
  for (const value of [null, {}, [], { ...envelope(), context: undefined }, { ...envelope(), text: {} }]) {
    assert.throws(() => moderationReviewSourceDigest(value), { message: 'review_source_digest_invalid',
      code: 'review_source_digest_invalid', statusCode: 400 });
  }
});

test('projection and validator never consult an implicit clock', () => {
  const original = Date.now;
  Date.now = () => { throw new Error('implicit wall clock forbidden'); };
  try {
    const candidate = envelope();
    assert.deepEqual(validateModerationReviewEnvelope(candidate, policy(), { now: RECEIVED }), candidate);
    invalid(candidate, policy(), {});
  } finally {
    Date.now = original;
  }
});
