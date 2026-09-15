import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createModerationReviewStore, ModerationReviewError } from '../src/moderation-review-store.mjs';

const PROMOTION = 'Я прочитал книгу «Синтетическая орбита». Купите книгу по промокоду FIXTURE.';
const LIMITS = { retentionMs: null, maxTextChars: 2000, maxContextChars: 500, maxNoteChars: 1000, maxObservations: 100 };
const BASE_TIME = Date.parse('2026-09-15T12:00:00.000Z');
function input(overrides = {}) {
  return { chatId: 'synthetic-chat-one', messageId: 'synthetic-message-one', revision: 1,
    text: PROMOTION, observedAt: '2026-09-15T12:00:00.000Z', userId: 'synthetic-user', ...overrides };
}
function fixture(t, limits = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'aichattg-review-synthetic-')), 'private');
  let time = BASE_TIME;
  const options = { root, mode: 'synthetic', limits: { ...LIMITS, ...limits }, now: () => time };
  let store = createModerationReviewStore(options);
  t.after(() => store.close());
  return { root, options, get store() { return store; },
    advance(value) { time += value; },
    reopen() { store.close(); store = createModerationReviewStore(options); return store; } };
}
function failure(code, statusCode = 409) {
  return (error) => error instanceof ModerationReviewError && error.code === code && error.statusCode === statusCode;
}
function decision(store, caseId, overrides = {}) {
  return { caseId, expectedVersion: store.getCase(caseId).version, decisionId: randomUUID(),
    label: 'hidden_advertising', note: 'Synthetic owner note.', ...overrides };
}
function assertVisibleRepeatEvidence(detail) {
  const byText = new Map();
  for (const message of detail.messages) {
    const text = message.text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
    const group = byText.get(text) || { text, nativeIds: new Set(), contexts: new Set() };
    group.nativeIds.add(message.messageId);
    if (message.context?.messageId) group.contexts.add(message.context.messageId);
    byText.set(text, group);
  }
  const groups = [...byText.values()];
  if (detail.reasons.includes('repeated_promotional_text')
    || detail.patternIds.includes('repeated-product-seeding') || detail.patternIds.includes('templated-testimonial')) {
    assert.ok(groups.some((group) => group.nativeIds.size >= 2), 'promotion repeat requires two visible native messages');
  }
  if (detail.reasons.includes('repeated_long_standard_reply') || detail.patternIds.includes('repeated-standard-reply')) {
    assert.ok(groups.some((group) => group.nativeIds.size >= 3 && group.text.length >= 120),
      'standard-reply repeat requires three visible native messages');
  }
  if (detail.reasons.includes('observed_in_multiple_contexts')) {
    assert.ok(groups.some((group) => group.nativeIds.size >= 2 && group.contexts.size >= 2),
      'multiple-context claim requires visible corroborating messages and contexts');
  }
}

test('construction is synthetic-only with explicit retention and bounded private configuration', (t) => {
  const f = fixture(t);
  f.store.close();
  for (const mode of [undefined, 'production', 'live']) {
    assert.throws(() => createModerationReviewStore({ ...f.options, mode }), failure('review_mode_invalid', 400));
  }
  const { retentionMs, ...missing } = LIMITS;
  assert.throws(() => createModerationReviewStore({ ...f.options, limits: missing }), failure('review_shape_invalid', 400));
  for (const value of [0, -1, '100', NaN]) {
    assert.throws(() => createModerationReviewStore({ ...f.options, limits: { ...LIMITS, retentionMs: value } }),
      failure('review_retentionMs_invalid', 400));
  }
  for (const root of ['relative/path', '/', tmpdir()]) {
    assert.throws(() => createModerationReviewStore({ ...f.options, root }), failure('review_root_invalid', 400));
  }
});

test('private SQLite uses DELETE journal, secure deletion and private file modes', (t) => {
  const f = fixture(t);
  const path = join(f.root, 'moderation-review.sqlite');
  assert.equal(lstatSync(f.root).mode & 0o777, 0o700);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  assert.equal(db.pragma('journal_mode', { simple: true }), 'delete');
  assert.equal(db.pragma('application_id', { simple: true }), 0x4d525631);
  // secure_delete is connection-specific; the erasure test additionally inspects logical content.
  db.close();
  assert.equal(existsSync(path + '-wal'), false);
  assert.equal(existsSync(path + '-shm'), false);
  assert.deepEqual(readdirSync(f.root), ['moderation-review.sqlite']);
});

test('symlink roots/databases/journals and foreign databases are rejected', (t) => {
  const f = fixture(t); f.store.close();
  const parent = mkdtempSync(join(tmpdir(), 'aichattg-review-symlink-'));
  const link = join(parent, 'root-link'); symlinkSync(f.root, link);
  assert.throws(() => createModerationReviewStore({ ...f.options, root: link }), failure('review_storage_invalid', 503));
  const dangling = join(parent, 'dangling-root'); symlinkSync(join(parent, 'absent'), dangling);
  assert.throws(() => createModerationReviewStore({ ...f.options, root: dangling }), failure('review_storage_invalid', 503));
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const root = mkdtempSync(join(tmpdir(), 'aichattg-review-file-link-'));
    symlinkSync(join(f.root, 'moderation-review.sqlite'), join(root, 'moderation-review.sqlite' + suffix));
    assert.throws(() => createModerationReviewStore({ ...f.options, root }), failure('review_storage_invalid', 503));
  }
  const root = mkdtempSync(join(tmpdir(), 'aichattg-review-foreign-'));
  const db = new Database(join(root, 'moderation-review.sqlite'));
  db.exec('CREATE TABLE unrelated_runtime (id TEXT)'); db.close();
  assert.throws(() => createModerationReviewStore({ ...f.options, root }), failure('review_storage_schema_invalid', 503));
});

test('one process owns a store: a second open cannot orphan its healthy alert', (t) => {
  const f = fixture(t), { caseId } = f.store.ingest(input());
  const claim = f.store.claimAlert();
  assert.throws(() => createModerationReviewStore(f.options), failure('review_store_already_open'));
  assert.equal(f.store.getCase(caseId).alert.state, 'calling');
  f.store.finishAlert({ ...claim, state: 'sent', receipt: { id: randomUUID() } });
  assert.equal(f.reopen().getCase(caseId).alert.state, 'sent');
});

test('negative observations are privately retained and removable without inventing suspicion or delivery', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.ingest(input({ text: 'Прочитал книгу. Какие задания обсудим на занятии?' })),
    { caseId: null, duplicate: false, stale: false });
  assert.deepEqual(f.store.listCases(), { cases: [], total: 0 });
  assert.equal(f.store.claimAlert(), null);
  const retained = f.store.listCases({ status: 'retained' });
  assert.equal(retained.total, 1);
  const detail = f.store.getCase(retained.cases[0].id);
  assert.equal(detail.status, 'retained'); assert.equal(detail.label, null);
  assert.deepEqual(detail.patternIds, []); assert.deepEqual(detail.reasons, []);
  assert.equal(detail.alert.state, 'disabled'); assert.equal(detail.messages.length, 1);
  assert.deepEqual(f.store.status(), { mode: 'synthetic', collectionEnabled: false, deliveryEnabled: false,
    decisionsEnabled: true, patternActivationEnabled: false, sanctionsEnabled: false,
    retentionMs: null, counts: { retained: 1, pending: 0, reviewed: 0, patterns: 0 } });
});

test('ordinary observations fill the cap but target-only erasure after restart frees capacity without orphans', (t) => {
  const f = fixture(t, { maxObservations: 2 });
  const first = input({ messageId: 'ordinary-1', text: 'Synthetic ordinary comment one.',
    context: { text: 'Private synthetic context one.', messageId: 'ordinary-post-1' } });
  const second = input({ messageId: 'ordinary-2', text: 'Synthetic ordinary comment two.' });
  assert.equal(f.store.ingest(first).caseId, null); assert.equal(f.store.ingest(second).caseId, null);
  const before = f.store.listCases({ status: 'retained' });
  assert.equal(before.total, 2); assert.equal(f.store.listCases().total, 0);
  assert.equal(f.store.claimAlert(), null);
  assert.throws(() => f.store.ingest(input()), failure('review_capacity_reached'));
  f.advance(30 * 365 * 24 * 60 * 60 * 1000);
  f.reopen();
  assert.deepEqual(f.store.listCases({ status: 'retained' }), before);
  assert.equal(f.store.ingest({ ...first, observedAt: '2026-09-16T12:00:00.000Z' }).duplicate, true);
  const details = before.cases.map((row) => f.store.getCase(row.id));
  const target = details.find((row) => row.messages[0].messageId === first.messageId);
  const other = details.find((row) => row.id !== target.id);
  const request = { caseId: target.id, expectedVersion: target.version, requestId: randomUUID() };
  const receipt = f.store.eraseCase(request, 'operator');
  assert.deepEqual(f.store.getCase(other.id), other);
  assert.equal(f.store.getCase(target.id), null);
  const db = new Database(join(f.root, 'moderation-review.sqlite'), { readonly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM review_observations WHERE case_id IS NULL').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM review_observations WHERE message_id=?').get(first.messageId).n, 0);
  db.close();
  assert.ok(f.store.ingest(input()).caseId);
  assert.equal(f.store.listCases({ status: 'retained' }).total, 1);
  assert.equal(f.store.listCases().total, 1);
  assert.equal(f.store.listCases({ status: 'all' }).total, 2);
  assert.deepEqual(f.reopen().eraseCase(request, 'operator'), receipt);
});

test('three ordinary long repeats coalesce all retained revisions into one pending case with one alert', (t) => {
  const f = fixture(t);
  const reply = 'Это синтетический стандартный ответ для проверки очереди. '
    + 'Он предлагает внимательно разобрать наблюдение, уточнить исходный вопрос и сохранить выводы без рекламных обещаний.';
  const first = input({ messageId: 'ordinary-1', text: 'Earlier ordinary synthetic revision.' });
  f.store.ingest(first);
  f.store.ingest({ ...first, revision: 2, text: reply });
  f.store.ingest(input({ messageId: 'ordinary-2', text: reply }));
  const prior = f.store.listCases({ status: 'retained' }).cases;
  assert.equal(prior.length, 2); assert.equal(f.store.claimAlert(), null);
  const result = f.store.ingest(input({ messageId: 'ordinary-3', text: reply }));
  assert.ok(result.caseId);
  const detail = f.store.getCase(result.caseId);
  assert.equal(detail.status, 'pending'); assert.equal(detail.messageCount, 3);
  assert.equal(detail.messages.length, 4, 'all earlier immutable revisions move with their native source');
  assertVisibleRepeatEvidence(detail);
  assert.equal(f.store.listCases({ status: 'retained' }).total, 0);
  assert.equal(f.store.listCases({ status: 'all' }).total, 1);
  assert.equal(f.store.listHistory().total, 0); assert.equal(f.store.listPatterns().total, 0);
  const targetBefore = prior.find((row) => row.id === result.caseId);
  const retired = prior.find((row) => row.id !== result.caseId);
  assert.equal(detail.version, targetBefore.version + 1);
  assert.equal(f.store.getCase(retired.id), null);
  assert.throws(() => f.store.eraseCase({ caseId: retired.id, expectedVersion: retired.version, requestId: randomUUID() }, 'operator'),
    failure('review_case_not_found', 404));
  assert.throws(() => f.store.eraseCase({ caseId: detail.id, expectedVersion: targetBefore.version, requestId: randomUUID() }, 'operator'),
    failure('review_case_stale'));
  const claim = f.store.claimAlert();
  assert.equal(claim.caseId, detail.id); assert.equal(f.store.claimAlert(), null);
  f.store.finishAlert({ ...claim, state: 'sent' });
  f.store.ingest(input({ messageId: 'ordinary-4', text: reply }));
  assert.equal(f.store.claimAlert(), null);
  assert.equal(f.reopen().getCase(detail.id).messageCount, 4);
  assert.equal(f.store.getCase(detail.id).alert.state, 'sent');
});

test('retained promotion never coalesces another pending/reviewed case or its owner decisions', (t) => {
  const f = fixture(t);
  const protectedId = f.store.ingest(input({ messageId: 'protected-message' })).caseId;
  f.store.decide(decision(f.store, protectedId, { label: 'legitimate' }), 'operator');
  const protectedBefore = f.store.getCase(protectedId), history = f.store.listHistory(), patterns = f.store.listPatterns();
  const ordinary = input({ messageId: 'ordinary-to-promote', text: 'An ordinary synthetic reply.' });
  f.store.ingest(ordinary);
  const retained = f.store.listCases({ status: 'retained' }).cases[0];
  const promoted = f.store.ingest({ ...ordinary, revision: 2, text: PROMOTION });
  assert.equal(promoted.caseId, retained.id);
  assert.equal(f.store.getCase(retained.id).messageCount, 1);
  assert.equal(f.store.getCase(retained.id).reasons.includes('repeated_promotional_text'), false);
  assertVisibleRepeatEvidence(f.store.getCase(retained.id));
  assert.deepEqual(f.store.getCase(protectedId), protectedBefore);
  assert.deepEqual(f.store.listHistory(), history); assert.deepEqual(f.store.listPatterns(), patterns);
});

test('reopening an older synthetic store makes unassigned ordinary revisions erasable without reclassifying them', (t) => {
  const f = fixture(t), ordinary = input({ text: 'Legacy ordinary synthetic observation.' });
  f.store.ingest(ordinary); f.store.ingest({ ...ordinary, revision: 2, text: 'Legacy synthetic edited observation.' });
  f.store.close();
  const db = new Database(join(f.root, 'moderation-review.sqlite'));
  db.exec('UPDATE review_observations SET case_id=NULL; DELETE FROM review_alerts; DELETE FROM review_cases;');
  db.close();
  f.reopen();
  const retained = f.store.listCases({ status: 'retained' });
  assert.equal(retained.total, 1);
  const detail = f.store.getCase(retained.cases[0].id);
  assert.deepEqual(detail.messages.map((row) => row.revision), [1, 2]);
  assert.equal(detail.detectorVersion, 'retained-legacy-v1');
  assert.deepEqual(detail.patternIds, []); assert.deepEqual(detail.reasons, []);
  assert.equal(f.store.claimAlert(), null);
  f.store.eraseCase({ caseId: detail.id, expectedVersion: detail.version, requestId: randomUUID() }, 'operator');
  assert.equal(f.store.listCases({ status: 'all' }).total, 0);
});

test('native identity deduplicates retries, uses numeric revision order and rejects collisions', (t) => {
  const f = fixture(t), first = f.store.ingest(input({ revision: 2 }));
  assert.ok(first.caseId);
  assert.deepEqual(f.store.ingest(input({ revision: 2, observedAt: '2026-09-16T12:00:00.000Z' })),
    { caseId: first.caseId, duplicate: true, stale: false });
  assert.equal(f.store.getCase(first.caseId).messages[0].observedAt, '2026-09-15T12:00:00.000Z');
  assert.throws(() => f.store.ingest(input({ revision: 2, text: PROMOTION + ' Changed.' })), failure('review_revision_conflict'));
  assert.throws(() => f.store.ingest(input({ revision: 2, userId: 'different-synthetic-user' })), failure('review_revision_conflict'));
  assert.throws(() => f.store.ingest(input({ revision: 2, context: { text: 'Changed context', messageId: 'post' } })),
    failure('review_revision_conflict'));
  const edited = f.store.ingest(input({ revision: 10, text: PROMOTION + ' Synthetic revision ten.' }));
  assert.equal(edited.caseId, first.caseId);
  assert.deepEqual(f.store.ingest(input({ revision: 3 })), { caseId: first.caseId, duplicate: false, stale: true });
  assert.deepEqual(f.store.getCase(first.caseId).messages.map((row) => row.revision), [2, 10]);
  assert.equal(f.store.getCase(first.caseId).version, 2);
});

test('same-chat repetitions group only within their own chat and distinct native messages', (t) => {
  const f = fixture(t), first = f.store.ingest(input());
  const repeat = f.store.ingest(input({ messageId: 'synthetic-message-two', userId: 'another-synthetic-user' }));
  assert.equal(repeat.caseId, first.caseId);
  assert.equal(f.store.getCase(first.caseId).messageCount, 2);
  assert.ok(f.store.getCase(first.caseId).patternIds.includes('repeated-product-seeding'));
  const other = f.store.ingest(input({ chatId: 'synthetic-chat-two', messageId: 'synthetic-message-two' }));
  assert.notEqual(other.caseId, first.caseId);
  assert.equal(f.store.getCase(other.caseId).messageCount, 1);
  assert.equal(f.store.getCase(other.caseId).patternIds.includes('repeated-product-seeding'), false);
});

test('editing Alpha into Beta never borrows invisible repeat evidence from another existing case', (t) => {
  const f = fixture(t);
  const alpha = input({ messageId: 'native-1', text: PROMOTION + ' Alpha.',
    context: { messageId: 'alpha-post', text: 'Synthetic Alpha discussion.' } });
  const beta = input({ messageId: 'native-2', text: PROMOTION + ' Beta.',
    context: { messageId: 'beta-post', text: 'Synthetic Beta discussion.' } });
  const caseA = f.store.ingest(alpha).caseId, caseB = f.store.ingest(beta).caseId;
  assert.notEqual(caseA, caseB);
  f.store.decide(decision(f.store, caseA), 'operator');
  f.store.decide(decision(f.store, caseB, { label: 'legitimate' }), 'operator');
  const beforeA = f.store.getCase(caseA), beforeB = f.store.getCase(caseB);
  const history = f.store.listHistory(), patterns = f.store.listPatterns();
  assert.equal(f.store.ingest({ ...alpha, revision: 2, text: beta.text }).caseId, caseA);
  const afterA = f.store.getCase(caseA);
  assert.equal(afterA.messageCount, 1);
  assert.equal(afterA.version, beforeA.version + 1);
  assert.equal(afterA.reasons.includes('repeated_promotional_text'), false);
  assert.equal(afterA.reasons.includes('observed_in_multiple_contexts'), false);
  assert.equal(afterA.patternIds.includes('repeated-product-seeding'), false);
  assert.deepEqual(afterA.decisions, beforeA.decisions);
  assert.deepEqual(afterA.messages[0], beforeA.messages[0]);
  assert.deepEqual(f.store.getCase(caseB), beforeB);
  assert.deepEqual(f.store.listHistory(), history);
  assert.deepEqual(f.store.listPatterns(), patterns);
  assertVisibleRepeatEvidence(afterA); assertVisibleRepeatEvidence(beforeB);

  // A fresh Beta can select one existing case, but cannot carry hidden proof
  // or the distinct Beta-post context from the other case into that selection.
  const joined = f.store.ingest({ ...alpha, messageId: 'native-3', text: beta.text });
  assert.equal(joined.caseId, caseA);
  assert.equal(f.store.getCase(caseA).messageCount, 2);
  assert.equal(f.store.getCase(caseA).reasons.includes('repeated_promotional_text'), true);
  assert.equal(f.store.getCase(caseA).reasons.includes('observed_in_multiple_contexts'), false);
  assertVisibleRepeatEvidence(f.store.getCase(caseA));
  assert.deepEqual(f.store.getCase(caseB), beforeB);
  assert.deepEqual(f.store.listHistory(), history);
  assert.deepEqual(f.store.listPatterns(), patterns);
});

test('joining multiple cases cannot meet the standard-reply threshold using hidden native messages', (t) => {
  const f = fixture(t);
  const longReply = 'Это синтетический стандартный ответ для проверки очереди. '
    + 'Он предлагает внимательно разобрать наблюдение, уточнить исходный вопрос и сохранить выводы без рекламных обещаний.';
  const first = input({ messageId: 'native-1', text: PROMOTION + ' Alpha.' });
  const second = input({ messageId: 'native-2', text: PROMOTION + ' Beta.' });
  const caseA = f.store.ingest(first).caseId, caseB = f.store.ingest(second).caseId;
  f.store.decide(decision(f.store, caseA), 'operator');
  f.store.decide(decision(f.store, caseB), 'operator');
  f.store.ingest({ ...first, revision: 2, text: longReply });
  f.store.ingest({ ...second, revision: 2, text: longReply });
  const beforeB = f.store.getCase(caseB), history = f.store.listHistory(), patterns = f.store.listPatterns();
  const joined = f.store.ingest(input({ messageId: 'native-3', text: longReply }));
  assert.equal(joined.caseId, caseA);
  const detail = f.store.getCase(caseA);
  assert.equal(detail.messageCount, 2);
  assert.equal(detail.reasons.includes('repeated_long_standard_reply'), false);
  assert.equal(detail.patternIds.includes('repeated-standard-reply'), false);
  assertVisibleRepeatEvidence(detail);
  assert.deepEqual(f.store.getCase(caseB), beforeB);
  assert.deepEqual(f.store.listHistory(), history); assert.deepEqual(f.store.listPatterns(), patterns);

  // Once three actual native messages are visible in case A, its own evidence
  // supports the signal without merging case B or changing old decisions.
  assert.equal(f.store.ingest(input({ messageId: 'native-4', text: longReply })).caseId, caseA);
  assert.equal(f.store.getCase(caseA).patternIds.includes('repeated-standard-reply'), true);
  assertVisibleRepeatEvidence(f.store.getCase(caseA));
  assert.deepEqual(f.store.getCase(caseB), beforeB);
  assert.deepEqual(f.store.listHistory(), history); assert.deepEqual(f.store.listPatterns(), patterns);
});

test('clipped evidence stays visible and erasable without unsupported detector claims', (t) => {
  const f = fixture(t, { maxTextChars: 30, maxContextChars: 12 });
  const first = f.store.ingest(input({ context: { text: 'Synthetic original context is long.', messageId: 'synthetic-post' } }));
  assert.equal(first.caseId, null, 'clipped evidence cannot introduce a review request');
  const id = f.store.listCases({ status: 'retained' }).cases[0].id;
  const message = f.store.getCase(id).messages[0];
  assert.equal(message.text.length, 30);
  assert.equal(message.context.text.length, 12);
  assert.deepEqual(message.truncated, { text: true, context: true });
  f.store.ingest(input({ revision: 2, text: PROMOTION + ' Changed after the retained prefix.' }));
  assert.equal(f.store.getCase(id).messages.length, 2);
  assert.equal(f.store.getCase(id).messages[1].context, null);
  assert.throws(() => f.store.ingest(input({ revision: 2, text: PROMOTION + ' Different hidden suffix.' })),
    failure('review_revision_conflict'));
  const distinct = f.store.ingest(input({ messageId: 'second', text: PROMOTION.replace('орбита', 'галактика') }));
  assert.equal(distinct.caseId, null);
  assert.equal(f.store.listCases({ status: 'retained' }).total, 2,
    'truncated shared prefixes cannot merge different product identities');
  f.reopen();
  const detail = f.store.getCase(id);
  assert.deepEqual(detail.patternIds, []);
  assert.deepEqual(detail.reasons, []);
  assert.equal(detail.alert.state, 'disabled');
  assert.equal(f.store.claimAlert(), null);
  f.store.eraseCase({ caseId: id, expectedVersion: detail.version, requestId: randomUUID() }, 'operator');
  assert.equal(f.store.getCase(id), null);
  assert.equal(f.store.listCases({ status: 'retained' }).total, 1);
});

test('clipped context cannot introduce suspicion or serve as repeat corroboration', (t) => {
  const f = fixture(t, { maxContextChars: 12 });
  assert.equal(f.store.ingest(input({ context: { text: 'An ordinary discussion with a missing qualification.',
    messageId: 'clipped-post' } })).caseId, null);
  const retained = f.store.listCases({ status: 'retained' }).cases[0].id;
  const next = f.store.ingest(input({ messageId: 'complete-source' }));
  assert.ok(next.caseId);
  assert.notEqual(next.caseId, retained);
  const detail = f.store.getCase(next.caseId);
  assert.equal(detail.messageCount, 1);
  assert.equal(detail.patternIds.includes('repeated-product-seeding'), false);
  assert.equal(f.store.getCase(retained).status, 'retained');
});

test('stale clipped fingerprints do not group new messages after a complete unrelated edit', (t) => {
  const f = fixture(t, { maxTextChars: PROMOTION.length });
  assert.equal(f.store.ingest(input({ text: PROMOTION + ' Unretained qualification.' })).caseId, null);
  const retained = f.store.listCases({ status: 'retained' }).cases[0].id;
  assert.equal(f.store.ingest(input({ revision: 2, text: 'An ordinary unrelated complete comment.' })).caseId, null);
  const before = f.store.getCase(retained);
  const next = f.store.ingest(input({ messageId: 'fresh-complete-promotion' }));
  assert.ok(next.caseId);
  assert.notEqual(next.caseId, retained);
  assert.equal(f.store.getCase(next.caseId).messageCount, 1);
  assert.deepEqual(f.store.getCase(retained), before);
});

test('exercise exclusions and future observations cannot become fingerprint grouping anchors', (t) => {
  const exercise = fixture(t);
  assert.equal(exercise.store.ingest(input({ context: { text: 'Classroom exercise: analyze the advertisement.',
    messageId: 'exercise-post' } })).caseId, null);
  const retained = exercise.store.listCases({ status: 'retained' }).cases[0].id;
  const current = exercise.store.ingest(input({ messageId: 'ordinary-promotion' }));
  assert.notEqual(current.caseId, retained);
  assert.equal(exercise.store.getCase(current.caseId).messageCount, 1);
  assert.equal(exercise.store.getCase(retained).status, 'retained');

  const future = fixture(t);
  const later = future.store.ingest(input({ observedAt: '2026-09-15T13:00:00.000Z' }));
  const earlier = future.store.ingest(input({ messageId: 'earlier-promotion' }));
  assert.ok(earlier.caseId);
  assert.notEqual(earlier.caseId, later.caseId);
  assert.equal(future.store.getCase(earlier.caseId).messageCount, 1);
  assert.equal(future.store.getCase(earlier.caseId).patternIds.includes('repeated-product-seeding'), false);
});

test('decisions bind immutable evidence versions, replay all fields, and reopen on new evidence', (t) => {
  const f = fixture(t), { caseId } = f.store.ingest(input());
  const request = decision(f.store, caseId);
  const result = f.store.decide(request, 'operator');
  assert.equal(result.version, 2); assert.equal(result.replayed, false); assert.ok(result.patternDraftId);
  assert.deepEqual(f.store.decide(request, 'operator'), { ...result, replayed: true });
  assert.equal(f.store.listPatterns().total, 1);
  assert.equal(f.store.listHistory().total, 1);
  assert.equal(f.store.getCase(caseId).status, 'reviewed');
  for (const mutation of [{ expectedVersion: 2 }, { label: 'legitimate' }, { note: 'Changed note' }, { caseId: randomUUID() }]) {
    assert.throws(() => f.store.decide({ ...request, ...mutation }, 'operator'), failure('review_decision_conflict'));
  }
  assert.throws(() => f.store.decide(request, 'other-reviewer'), failure('review_decision_conflict'));
  assert.throws(() => f.store.decide({ ...request, decisionId: randomUUID() }, 'operator'), failure('review_case_stale'));
  f.store.ingest(input({ revision: 2, text: PROMOTION + ' More synthetic material.' }));
  const updated = f.store.getCase(caseId);
  assert.equal(updated.version, 3); assert.equal(updated.status, 'pending'); assert.equal(updated.label, null);
  assert.deepEqual(updated.decisions[0].evidence, [{ messageId: 'synthetic-message-one', revision: 1 }]);
  assert.equal(updated.decisions[0].evidenceVersion, 1);
  assert.equal(updated.messages.length, 2);
  assert.deepEqual(f.store.decide(request, 'operator'), { ...result, replayed: true }, 'old exact replay does not relabel the new version');
  const negative = f.store.decide(decision(f.store, caseId, { label: 'legitimate' }), 'operator');
  assert.equal(negative.version, 4);
  assert.deepEqual(f.store.listPatterns().patterns.map((row) => [row.revision, row.label, row.state]),
    [[2, 'legitimate', 'draft'], [1, 'hidden_advertising', 'draft']]);
  assert.equal(f.store.listHistory().history[0].evidence.length, 2);
});

test('insufficient evidence is immutable audit-only and never creates a draft example', (t) => {
  const f = fixture(t), { caseId } = f.store.ingest(input());
  const request = decision(f.store, caseId, { label: 'insufficient_evidence' });
  assert.equal(f.store.decide(request, 'operator').patternDraftId, null);
  assert.equal(f.store.decide(request, 'operator').patternDraftId, null);
  assert.equal(f.store.listPatterns().total, 0);
  assert.equal(f.store.listHistory().history[0].label, 'insufficient_evidence');
  assert.equal(f.store.getCase(caseId).decisions[0].patternDraftId, null);
});

test('all retained revisions count toward backpressure; duplicates survive and nothing is evicted', (t) => {
  const f = fixture(t, { maxObservations: 2 });
  const { caseId } = f.store.ingest(input());
  f.store.ingest(input({ revision: 2 }));
  assert.throws(() => f.store.ingest(input({ revision: 3 })), failure('review_capacity_reached'));
  assert.throws(() => f.store.ingest(input({ messageId: 'third', text: 'Not promotional.' })), failure('review_capacity_reached'));
  assert.equal(f.store.ingest(input({ revision: 2 })).duplicate, true);
  assert.equal(f.store.getCase(caseId).messages.length, 2);
  assert.equal(f.store.getCase(caseId).version, 2);
});

test('indefinite evidence, audit and drafts survive distant clock advances and restart', (t) => {
  const f = fixture(t), { caseId } = f.store.ingest(input());
  f.store.decide(decision(f.store, caseId), 'operator');
  f.advance(365 * 24 * 60 * 60 * 1000 * 30);
  assert.deepEqual(f.store.purgeExpired(), { cases: 0, observations: 0 });
  assert.equal(f.reopen().getCase(caseId).expiresAt, null);
  assert.equal(f.store.getCase(caseId).messages[0].text, PROMOTION);
  assert.equal(f.store.listHistory().total, 1);
  assert.equal(f.store.listPatterns().total, 1);
});

test('explicit synthetic expiry erases case evidence, notes, examples and delivery together', (t) => {
  const f = fixture(t, { retentionMs: 1000 });
  const { caseId } = f.store.ingest(input());
  f.store.decide(decision(f.store, caseId), 'operator');
  f.store.finishAlert({ ...f.store.claimAlert(), state: 'sent', receipt: { id: randomUUID() } });
  f.advance(1000);
  assert.deepEqual(f.store.purgeExpired(), { cases: 1, observations: 1 });
  assert.equal(f.store.getCase(caseId), null);
  assert.equal(f.store.listHistory().total, 0); assert.equal(f.store.listPatterns().total, 0);
  assert.equal(f.store.claimAlert(), null);
});

test('manual erase is target-only, complete, content-free, exact-version and principal fenced', (t) => {
  const f = fixture(t), { caseId } = f.store.ingest(input());
  const other = f.store.ingest(input({ chatId: 'synthetic-other-chat' })).caseId;
  const originalDecision = decision(f.store, caseId);
  f.store.decide(originalDecision, 'operator');
  const otherDecision = decision(f.store, other, { note: 'Synthetic note that stays.' });
  f.store.decide(otherDecision, 'operator');
  const alert = f.store.claimAlert();
  f.store.finishAlert({ ...alert, state: 'sent', receipt: { id: randomUUID() } });
  const request = { caseId, expectedVersion: f.store.getCase(caseId).version, requestId: randomUUID() };
  assert.throws(() => f.store.eraseCase({ ...request, expectedVersion: 1 }, 'operator'), failure('review_case_stale'));
  const receipt = f.store.eraseCase(request, 'operator');
  assert.deepEqual(Object.keys(receipt).sort(), ['caseId', 'requestId', 'principal', 'expectedVersion', 'deletedAt', 'erased'].sort());
  assert.equal(receipt.erased, true);
  assert.deepEqual(f.store.eraseCase(request, 'operator'), receipt);
  for (const patch of [{ expectedVersion: 1 }, { caseId: other }, { requestId: randomUUID() }]) {
    assert.throws(() => f.store.eraseCase({ ...request, ...patch }, 'operator'), failure('review_erasure_conflict'));
  }
  assert.throws(() => f.store.eraseCase(request, 'another-owner'), failure('review_erasure_conflict'));
  assert.equal(f.store.getCase(caseId), null);
  assert.equal(f.store.getCase(other).messages[0].text, PROMOTION);
  assert.equal(f.store.listPatterns().total, 1); assert.equal(f.store.listHistory().total, 1);
  assert.throws(() => f.store.decide(originalDecision, 'operator'), failure('review_case_not_found', 404));
  const db = new Database(join(f.root, 'moderation-review.sqlite'), { readonly: true });
  for (const table of ['review_observations', 'review_decisions', 'review_patterns', 'review_alerts']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE case_id=?`).get(caseId).n, 0);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM review_decision_evidence WHERE decision_id=?').get(originalDecision.decisionId).n, 0);
  assert.deepEqual(db.prepare('PRAGMA table_info(review_erasure_receipts)').all().map((row) => row.name),
    ['request_id', 'case_id', 'principal', 'expected_version', 'deleted_at']);
  db.close();
  assert.deepEqual(f.reopen().eraseCase(request, 'operator'), receipt);
});

test('secure_delete removes erased fixture content from this SQLite file, without physical-erasure claims', (t) => {
  const f = fixture(t), marker = 'SYNTHETIC_ERASURE_PRIVATE_MARKER_6f8e';
  const { caseId } = f.store.ingest(input({ text: PROMOTION + marker,
    context: { text: marker, messageId: marker } }));
  f.store.decide(decision(f.store, caseId, { note: marker }), 'operator');
  const before = readFileSync(join(f.root, 'moderation-review.sqlite'));
  assert.equal(before.includes(Buffer.from(marker)), true);
  f.store.eraseCase({ caseId, expectedVersion: f.store.getCase(caseId).version, requestId: randomUUID() }, 'operator');
  const after = readFileSync(join(f.root, 'moderation-review.sqlite'));
  assert.equal(after.includes(Buffer.from(marker)), false);
  assert.equal(existsSync(join(f.root, 'moderation-review.sqlite-journal')), false);
});

test('alert claims persist before send, exact attempts finish once and failures never retry', (t) => {
  const f = fixture(t), { caseId } = f.store.ingest(input());
  const claim = f.store.claimAlert();
  assert.equal(claim.caseId, caseId); assert.equal(f.store.claimAlert(), null);
  assert.equal(f.store.getCase(caseId).alert.state, 'calling');
  assert.throws(() => f.store.finishAlert({ ...claim, attemptId: randomUUID(), state: 'sent' }), failure('review_alert_attempt_conflict'));
  assert.throws(() => f.store.finishAlert({ ...claim, state: 'sent', receipt: { privateBody: PROMOTION } }),
    failure('review_alert_receipt_invalid', 400));
  assert.throws(() => f.store.finishAlert({ ...claim, state: 'sent', receipt: 'private-human-content' }),
    failure('review_alert_receipt_invalid', 400));
  assert.deepEqual(f.store.finishAlert({ ...claim, state: 'failed' }), { caseId, state: 'failed' });
  assert.deepEqual(f.store.finishAlert({ ...claim, state: 'failed' }), { caseId, state: 'failed' });
  assert.throws(() => f.store.finishAlert({ ...claim, state: 'sent' }), failure('review_alert_terminal'));
  f.store.ingest(input({ revision: 2 }));
  f.store.ingest(input({ messageId: 'new-repetition' }));
  assert.equal(f.store.claimAlert(), null);
  assert.equal(f.reopen().getCase(caseId).alert.state, 'failed');
});

test('orphaned calling becomes uncertain on reopen, never pending or automatically retried', (t) => {
  const f = fixture(t), { caseId } = f.store.ingest(input());
  const claim = f.store.claimAlert();
  assert.equal(f.reopen().getCase(caseId).alert.state, 'uncertain');
  assert.equal(f.store.claimAlert(), null);
  assert.throws(() => f.store.finishAlert({ ...claim, state: 'sent' }), failure('review_alert_terminal'));
});

test('strict inputs reject extra fields, invalid IDs/versions, forged principals and unsafe pagination', (t) => {
  const f = fixture(t), { caseId } = f.store.ingest(input());
  const request = decision(f.store, caseId);
  assert.throws(() => f.store.decide({ ...request, principal: 'forged' }, 'operator'), failure('review_shape_invalid', 400));
  assert.throws(() => f.store.decide(request, ''), failure('review_principal_invalid', 400));
  assert.throws(() => f.store.decide({ ...request, note: 'x'.repeat(1001) }, 'operator'), failure('review_note_too_large', 400));
  assert.throws(() => f.store.decide({ ...request, expectedVersion: '1' }, 'operator'), failure('review_expectedVersion_invalid', 400));
  assert.throws(() => f.store.decide({ ...request, label: 'ban' }, 'operator'), failure('review_label_invalid', 400));
  assert.throws(() => f.store.getCase('../native-message'), failure('review_caseId_invalid', 400));
  assert.throws(() => f.store.ingest(input({ rawTelegramPayload: '{}' })), failure('review_shape_invalid', 400));
  assert.throws(() => f.store.ingest(input({ observedAt: '2026-02-30T00:00:00Z' })), failure('review_observedAt_invalid', 400));
  for (const options of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { limit: '30' }, { extra: true }]) {
    assert.throws(() => f.store.listCases(options), (error) => error instanceof ModerationReviewError && error.statusCode === 400);
  }
  assert.throws(() => f.store.listCases({ status: 'deleted' }), failure('review_status_invalid', 400));
  assert.deepEqual(f.store.listCases({ status: 'all', limit: 1, offset: 1 }), { cases: [], total: 1 });
});

test('private path changes fail closed and no returned record reveals the filesystem path', (t) => {
  const f = fixture(t), { caseId } = f.store.ingest(input());
  assert.equal(JSON.stringify(f.store.getCase(caseId)).includes(f.root), false);
  chmodSync(join(f.root, 'moderation-review.sqlite'), 0o644);
  assert.throws(() => f.store.status(), failure('review_storage_invalid', 503));
  chmodSync(join(f.root, 'moderation-review.sqlite'), 0o600);
  f.store.close();
  assert.throws(() => f.store.status(), failure('review_store_closed', 503));
});
