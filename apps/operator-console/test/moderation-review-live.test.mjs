import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createModerationReviewStore } from '../src/moderation-review-store.mjs';
import { createConsoleReviewService } from '../src/moderation-review-service.mjs';
import { createOperatorConsoleServer } from '../src/server.mjs';
import { loadOperatorConsoleConfig } from '../src/config.mjs';
import { createRuntimeReviewService } from '../../telegram-runtime/src/moderation-review-service.mjs';
import { validateModerationReviewBinding, reviewCapturePolicy } from '../../../packages/telegram-core/src/moderation-review-config.mjs';
import { projectModerationReviewUpdate } from '../../../packages/telegram-core/src/moderation-review-projection.mjs';

const TIME = Date.parse('2026-09-17T12:00:00.000Z');
const PROMO = 'Я прочитал книгу «Синтетическая орбита». Купите книгу по промокоду FIXTURE.';
const now = () => TIME;
function binding(overrides = {}) {
  // Short real temp path also satisfies Unix socket length/platform limits.
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rv-'));
  const ipcRoot = join(root, 'ipc'), storeRoot = join(root, 'store');
  mkdirSync(ipcRoot, { mode: 0o700 });
  return validateModerationReviewBinding({ contract: 'moderation-review-binding/v1', enabled: true,
    bindingId: 'fixture_binding', epochId: 'fixture_epoch', chatIds: ['-100100'],
    startAt: '2026-09-17T11:00:00.000Z', allowUserId: false, exemptBotIds: ['111', '222'],
    limits: { retentionMs: null, maxTextChars: 2000, maxContextChars: 500, maxNoteChars: 1000, maxObservations: 100 },
    maxEvents: 100, maxErasureReceipts: 100, maxInflight: 4, captureTimeoutMs: 1000, ipcTimeoutMs: 1000,
    notificationTimeoutMs: 1000, notificationIntervalMs: 60_000, maxAlertsPerHour: 5,
    recipientChatId: '999001', reviewerPrincipal: 'fixture-owner', consoleUrl: 'https://console.example.invalid',
    ipcRoot, storeRoot, deliveryEnabled: true, ...overrides });
}
function options(b) {
  return { root: b.storeRoot, mode: 'live', capturePolicy: reviewCapturePolicy(b), limits: b.limits,
    maxEvents: b.maxEvents, maxErasureReceipts: b.maxErasureReceipts, maxAlertsPerHour: b.maxAlertsPerHour, now };
}
function fixture(t, changes = {}) {
  const b = binding(changes), opts = options(b);
  let store = createModerationReviewStore({ ...opts, provision: true });
  t.after(() => store.close());
  return { b, opts, get store() { return store; },
    reopen() { store.close(); store = createModerationReviewStore(opts); return store; },
    db() { return new Database(join(b.storeRoot, 'moderation-review.sqlite')); } };
}
function envelope(b, { updateId = 1, messageId = 1, text = PROMO, editDate = null, context = undefined } = {}) {
  const message = { message_id: messageId, date: Math.floor(TIME / 1000) - 100, chat: { id: -100100 },
    from: { id: 333 }, text, ...(editDate === null ? {} : { edit_date: editDate }),
    ...(context === undefined ? {} : { reply_to_message: context }) };
  const result = projectModerationReviewUpdate({ role: 'moderator', update: { update_id: updateId,
    [editDate === null ? 'message' : 'edited_message']: message }, receivedAt: new Date(TIME).toISOString(), policy: reviewCapturePolicy(b) });
  assert.equal(result.kind, 'candidate', JSON.stringify(result));
  return result.envelope;
}
function erase(store, id) {
  return store.eraseCase({ caseId: id, expectedVersion: store.getCase(id).version, requestId: randomUUID() }, 'fixture-owner');
}

test('live capture is explicitly provisioned; ordinary synthetic API cannot bypass envelope validation', (t) => {
  const b = binding();
  assert.throws(() => createModerationReviewStore(options(b)), /review_storage_not_provisioned/u);
  const f = fixture(t);
  assert.throws(() => f.store.ingest({}), /review_capture_required/u);
  const wrong = { ...envelope(f.b), epochId: 'wrong_epoch' };
  assert.throws(() => f.store.capture(wrong), /review_binding_invalid/u);
  assert.equal(f.store.listCases({ status: 'all' }).total, 0);
});

test('event replay, native duplicate, ordering and known historical conflicts are atomic', (t) => {
  const f = fixture(t), first = envelope(f.b);
  const receipt = f.store.capture(first);
  assert.equal(receipt.intakeSeq, 1); assert.equal(receipt.outcome, 'accepted');
  assert.deepEqual(f.store.capture(first), receipt);
  assert.equal(f.store.capture(envelope(f.b, { updateId: 2 })).outcome, 'duplicate');
  assert.throws(() => f.store.capture(envelope(f.b, { text: PROMO + ' altered' })), /review_event_conflict/u);
  const editDate = first.sourceDateSec + 10;
  assert.equal(f.store.capture(envelope(f.b, { updateId: 3, editDate, text: PROMO + ' revision' })).outcome, 'accepted');
  assert.throws(() => f.store.capture(envelope(f.b, { updateId: 4, text: PROMO + ' conflicting old' })), /review_revision_order_conflict/u);
  assert.throws(() => f.store.capture(envelope(f.b, { updateId: 5, editDate, text: PROMO + ' conflicting edit' })), /review_revision_order_conflict/u);
  assert.equal(f.store.capture(envelope(f.b, { updateId: 6 })).outcome, 'stale');
  const id = f.store.listCases().cases[0].id;
  assert.equal(f.store.getCase(id).messages.length, 2);
  f.reopen();
  assert.deepEqual(f.store.capture(first), receipt);
});

test('receipt write failure rolls back evidence, alert, native, revisions and checkpoint', (t) => {
  const f = fixture(t), db = f.db(); t.after(() => db.close());
  db.exec("CREATE TRIGGER fixture_abort_receipt BEFORE INSERT ON review_intake_events BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(() => f.store.capture(envelope(f.b)), /fixture/u);
  for (const table of ['review_cases', 'review_observations', 'review_alerts', 'review_native_sources', 'review_source_revisions', 'review_intake_events']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(db.prepare('SELECT intake_seq FROM review_intake_binding').get().intake_seq, 0);
});

test('incomplete source or missing supplied context stays erasable without new suspicion', (t) => {
  const f = fixture(t);
  f.store.capture(envelope(f.b, { context: { message_id: 8, text: 'No same-chat proof' } }));
  let entry = f.store.listCases({ status: 'retained' }).cases[0];
  assert.equal(f.store.getCase(entry.id).messages[0].truncated.contextUnavailable, true);
  assert.equal(f.store.claimAlert(), null); erase(f.store, entry.id);
  f.store.capture(envelope(f.b, { updateId: 2, text: PROMO + 'x'.repeat(2100) }));
  entry = f.store.listCases({ status: 'retained' }).cases[0];
  assert.equal(f.store.getCase(entry.id).messages[0].truncated.text, true);
  assert.equal(f.store.claimAlert(), null);
});

test('erase removes ALL linked identifiers and permits genuine redelivery without a suppression promise', (t) => {
  const f = fixture(t), first = envelope(f.b);
  f.store.capture(first); f.store.capture(envelope(f.b, { updateId: 2 }));
  const claim = f.store.claimAlert();
  assert.deepEqual(f.store.authorizeAlert(claim), { authorized: true });
  assert.deepEqual(f.store.authorizeAlert(claim), { authorized: false });
  erase(f.store, claim.caseId);
  assert.deepEqual(f.store.finishAlert({ ...claim, state: 'sent', receipt: { id: randomUUID() } }), { caseId: claim.caseId, state: 'erased' });
  const db = f.db();
  for (const table of ['review_cases', 'review_observations', 'review_native_sources', 'review_source_revisions', 'review_intake_events', 'review_dispatch_authorizations', 'review_alerts']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  }
  const erased = db.prepare('SELECT * FROM review_erasure_receipts').get();
  assert.deepEqual(Object.keys(erased).sort(), ['case_id', 'deleted_at', 'expected_version', 'principal', 'request_id']);
  assert.equal(db.prepare('SELECT used FROM review_alert_budget').get().used, 1, 'content-free aggregate survives erase');
  db.close(); f.reopen();
  assert.equal(f.store.capture(first).outcome, 'accepted');
  assert.notEqual(f.store.listCases().cases[0].id, claim.caseId);
});

test('erase before dispatch cancels authorization; restart never resends calling', (t) => {
  const f = fixture(t);
  f.store.capture(envelope(f.b)); const claim = f.store.claimAlert();
  erase(f.store, claim.caseId);
  assert.deepEqual(f.store.authorizeAlert(claim), { authorized: false });
  f.store.capture(envelope(f.b, { updateId: 2, messageId: 2 }));
  const calling = f.store.claimAlert(); f.reopen();
  assert.equal(f.store.getCase(calling.caseId).alert.state, 'uncertain');
  assert.equal(f.store.claimAlert(), null);
  assert.deepEqual(f.store.authorizeAlert(calling), { authorized: false });
});

test('coalescing moves historical identifiers and erase clears every donor', (t) => {
  const f = fixture(t), text = 'Одинаковый синтетический ответ для проверки повтора. '.repeat(4);
  for (let i = 1; i <= 3; i++) f.store.capture(envelope(f.b, { updateId: i, messageId: i, text }));
  assert.equal(f.store.listCases({ status: 'all' }).total, 1);
  const id = f.store.listCases().cases[0].id;
  assert.equal(f.store.getCase(id).messages.length, 3); f.reopen(); erase(f.store, id);
  const db = f.db();
  for (const table of ['review_native_sources', 'review_source_revisions', 'review_intake_events']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  db.close();
});

test('full admission capacity still allows erasure; dispatch cap survives erase and restart', (t) => {
  const f = fixture(t, { maxErasureReceipts: 1, maxAlertsPerHour: 1 });
  f.store.capture(envelope(f.b)); const claim = f.store.claimAlert();
  assert.equal(f.store.authorizeAlert(claim).authorized, true);
  assert.throws(() => f.store.capture(envelope(f.b, { updateId: 2, messageId: 2 })), /review_erasure_reserve_full/u);
  erase(f.store, claim.caseId); f.reopen();
  assert.throws(() => f.store.capture(envelope(f.b, { updateId: 3 })), /review_erasure_reserve_full/u);
});

for (const mutation of [
  'DROP TABLE review_intake_events', 'DROP TABLE review_dispatch_authorizations',
  'DELETE FROM review_native_sources', 'DELETE FROM review_source_revisions',
  'UPDATE review_observations SET case_id=NULL', 'UPDATE review_alert_budget SET used=-1',
]) test(`damaged live state fails closed without repair: ${mutation}`, (t) => {
  const f = fixture(t); f.store.capture(envelope(f.b)); f.store.close();
  const db = f.db(); db.exec(mutation); db.close();
  assert.throws(() => createModerationReviewStore(f.opts), /review_(storage_schema_invalid|checkpoint_unknown)/u);
  assert.equal(existsSync(join(f.b.storeRoot, '.review-owner')), false, 'failed startup releases its own lock');
});

test('another process cannot open/recover the private database while owner is active', (t) => {
  const f = fixture(t); f.store.capture(envelope(f.b)); const claim = f.store.claimAlert();
  const module = new URL('../src/moderation-review-store.mjs', import.meta.url).href;
  const code = `import {createModerationReviewStore} from ${JSON.stringify(module)};
    try { createModerationReviewStore({...${JSON.stringify({ ...f.opts, now: undefined })},now:()=>${TIME}}); process.exit(2); }
    catch(e) { if(e.code!=='review_owner_unavailable') process.exit(3); }`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000 }).status, 0);
  assert.equal(f.store.getCase(claim.caseId).alert.state, 'calling');
});

test('real private socket chain: projection -> durable case -> one fake Telegram notice -> owner decision -> erase', async (t) => {
  const b = binding(), notices = [];
  const consoleService = await createConsoleReviewService({ binding: b, now, provision: true });
  const runtimeService = await createRuntimeReviewService({ binding: b, now,
    config: { moderator: { chatIds: b.chatIds, exemptBotIds: [], botToken: '111:fixture_secret_000000000000' }, assistant: { botToken: '222:fixture_secret_000000000000' } },
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body); notices.push(payload);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 81, chat: { id: 999001, type: 'private' }, text: payload.text } }),
        { headers: { 'content-type': 'application/json' } });
    } });
  t.after(async () => { await consoleService.close(); await runtimeService.close(); });
  const update = { update_id: 2, message: { message_id: 3, date: TIME / 1000 - 20, chat: { id: -100100 }, from: { id: 333 }, text: PROMO } };
  const cancel = runtimeService.capture.start('moderator', update);
  for (let i = 0; i < 40 && runtimeService.capture.snapshot().counts.acknowledged !== 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  cancel(); assert.equal(runtimeService.capture.snapshot().counts.acknowledged, 1);
  const result = await consoleService.step(); assert.equal(result.state, 'sent');
  assert.equal(notices.length, 1); assert.doesNotMatch(JSON.stringify(notices), /Синтетическая|100100|333/u);
  assert.equal((await consoleService.step()).state, 'idle');
  const status = await consoleService.status(); assert.equal(status.coverage.counts.acknowledged, 1);
  const config = loadOperatorConsoleConfig({ AICHATTG_OPERATOR_TOKEN: 'fixture_admin_secret' });
  const http = createOperatorConsoleServer({ config, review: consoleService, reviewBinding: b });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => http.close(resolve)));
  const auth = 'Basic ' + Buffer.from('operator:fixture_admin_secret').toString('base64');
  const root = `http://127.0.0.1:${http.address().port}`, prefix = '/api/operator/moderation-review/v1';
  const read = await fetch(root + prefix + '/cases/' + result.caseId, { headers: { authorization: auth } });
  assert.equal(read.status, 200);
  const record = await read.json();
  const decision = consoleService.store.decide({ caseId: record.id, expectedVersion: record.version, decisionId: randomUUID(), label: 'hidden_advertising', note: 'Fixture owner decision' }, b.reviewerPrincipal);
  assert.ok(decision.patternDraftId); assert.equal(consoleService.store.listPatterns().patterns[0].state, 'draft');
  erase(consoleService.store, record.id);
  assert.equal((await fetch(root + prefix + '/cases/' + result.caseId, { headers: { authorization: auth } })).status, 404);
});
