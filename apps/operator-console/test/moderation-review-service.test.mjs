import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createConsoleReviewService, createUnavailableConsoleReviewService } from '../src/moderation-review-service.mjs';
import { createModerationReviewCapture } from '../../telegram-runtime/src/moderation-review-capture.mjs';
import { projectModerationReviewUpdate } from '../../../packages/telegram-core/src/moderation-review-projection.mjs';
import { validateModerationReviewBinding, reviewCapturePolicy } from '../../../packages/telegram-core/src/moderation-review-config.mjs';

const TIME = Date.parse('2026-09-17T12:00:00.000Z');
const now = () => TIME;
const unknown = { contract: 'moderation-review-coverage/v1', status: 'unknown', sinceBoot: null,
  priorCoverage: 'unknown', countersKnownSinceBoot: false, counts: null, reasons: null, active: null,
  semantics: 'observed_attempts_not_unique_messages', backfillEnabled: false };
const fresh = () => createModerationReviewCapture({ now }).snapshot();
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
}

async function fixture(t, { request = async () => ({ statusCode: 200, body: fresh() }), deliveryEnabled = false } = {}) {
  const root = await mkdtemp(join(await realpath('/tmp'), 'review-console-'));
  await chmod(root, 0o700);
  const ipcRoot = join(root, 'ipc');
  await mkdir(ipcRoot, { mode: 0o700 });
  let service;
  t.after(async () => { await service?.close(); await rm(root, { recursive: true, force: true }); });
  const binding = validateModerationReviewBinding({ contract: 'moderation-review-binding/v1', enabled: true,
    bindingId: 'fixture_binding', epochId: 'fixture_epoch', chatIds: ['-100100'],
    startAt: '2026-09-17T11:00:00.000Z', allowUserId: false, exemptBotIds: ['111', '222'],
    limits: { retentionMs: null, maxTextChars: 2000, maxContextChars: 500, maxNoteChars: 1000, maxObservations: 100 },
    maxEvents: 100, maxErasureReceipts: 100, maxInflight: 4, captureTimeoutMs: 1000, ipcTimeoutMs: 1000,
    notificationTimeoutMs: 1000, notificationIntervalMs: 60_000, maxAlertsPerHour: 5,
    recipientChatId: '999001', reviewerPrincipal: 'fixture-owner', consoleUrl: 'https://console.example.invalid',
    ipcRoot, storeRoot: join(root, 'store'), deliveryEnabled });
  service = await createConsoleReviewService({ binding, now, provision: true, request });
  return { binding, service };
}

function capture(service, binding, id = 1) {
  const projected = projectModerationReviewUpdate({ role: 'moderator', receivedAt: new Date(TIME).toISOString(),
    policy: reviewCapturePolicy(binding), update: { update_id: id, message: { message_id: id, date: TIME / 1000 - 10,
      chat: { id: -100100 }, from: { id: 333 }, text: `Я прочитал книгу «Синтетическая орбита ${id}». Купите книгу по промокоду FIXTURE${id}.` } } });
  assert.equal(projected.kind, 'candidate');
  service.store.capture(projected.envelope);
}

test('real capture snapshot is strictly projected and detached before public status', async (t) => {
  const producer = createModerationReviewCapture({ now, policy: { enabled: true }, project: () => ({ kind: 'reject', code: 'review_text_invalid' }),
    send: () => assert.fail('rejected projection never sends') });
  producer.start('moderator', {});
  const source = producer.snapshot();
  const { service } = await fixture(t, { request: async () => ({ statusCode: 200, body: source }) });
  const status = await service.status();
  assert.equal(status.mode, 'live');
  assert.deepEqual(status.coverage, source);
  assert.notEqual(status.coverage, source);
  assert.notEqual(status.coverage.counts, source.counts);
  assert.notEqual(status.coverage.reasons, source.reasons);
  source.counts.not_attempted = 999;
  source.reasons.review_text_invalid = 999;
  assert.equal(status.coverage.counts.not_attempted, 1);
  assert.equal(status.coverage.reasons.review_text_invalid, 1);
});

test('unavailable peer, wrong HTTP status and malformed coverage yield unknown, never zero or private content', async (t) => {
  let response;
  const { service } = await fixture(t, { request: async () => {
    if (response instanceof Error) throw response;
    return response;
  } });
  const mutations = [
    (body) => ({ ...body, sourceText: 'PRIVATE_EVIDENCE' }),
    (body) => ({ ...body, contract: 'other-contract' }),
    (body) => ({ ...body, status: 'complete' }),
    (body) => ({ ...body, priorCoverage: 'complete' }),
    (body) => ({ ...body, semantics: 'PRIVATE_EVIDENCE' }),
    (body) => ({ ...body, backfillEnabled: true }),
    (body) => ({ ...body, sinceBoot: 'PRIVATE_EVIDENCE' }),
    (body) => ({ ...body, sinceBoot: '2026-09-17T12:00:01.000Z' }),
    (body) => ({ ...body, sinceBoot: '2026-02-30T12:00:00.000Z' }),
    (body) => ({ ...body, active: 5 }),
    (body) => ({ ...body, active: -1 }),
    (body) => ({ ...body, active: '0' }),
    (body) => ({ ...body, countersKnownSinceBoot: 'true' }),
    (body) => ({ ...body, countersKnownSinceBoot: false }),
    (body) => ({ ...body, counts: { ...body.counts, chatId: 333 } }),
    (body) => ({ ...body, counts: { ...body.counts, acknowledged: -1 } }),
    (body) => ({ ...body, counts: { ...body.counts, acknowledged: Number.MAX_SAFE_INTEGER + 1 } }),
    (body) => ({ ...body, counts: { ...body.counts, acknowledged: 0.5 } }),
    (body) => ({ ...body, counts: { ...body.counts, acknowledged: 1 } }),
    (body) => ({ ...body, reasons: { review_private_evidence: 1 } }),
    (body) => ({ ...body, reasons: { review_unknown: 'PRIVATE_EVIDENCE' } }),
    (body) => ({ ...body, reasons: { review_unknown: 0 } }),
    (body) => ({ ...body, reasons: { review_unknown: 1 } }),
    (body) => { const copy = { ...body }; delete copy.active; return copy; },
  ];
  for (const mutate of mutations) {
    response = { statusCode: 200, body: mutate(fresh()) };
    const status = await service.status();
    assert.deepEqual(status.coverage, unknown);
    assert.equal(JSON.stringify(status).includes('PRIVATE_EVIDENCE'), false);
    assert.equal(JSON.stringify(status).includes('private_evidence'), false);
  }
  for (const value of [new Error('PRIVATE_EVIDENCE'), undefined, null, { statusCode: 503, body: fresh() },
    { statusCode: 200, body: null }, { statusCode: 200, body: [] }, { statusCode: 200, body: {} }]) {
    response = value;
    assert.deepEqual((await service.status()).coverage, unknown);
  }
});

test('explicit producer telemetry loss preserves its boot boundary but never invents counters', async (t) => {
  const snapshot = { ...fresh(), countersKnownSinceBoot: false, counts: null, reasons: null };
  const { service } = await fixture(t, { request: async () => ({ statusCode: 200, body: snapshot }) });
  assert.deepEqual((await service.status()).coverage, snapshot);
});

test('unavailable bootstrap helper has no store or capabilities and returns detached unknown statuses', async () => {
  const service = createUnavailableConsoleReviewService();
  assert.equal(service.store, null);
  const status = await service.status();
  assert.equal(status.mode, 'unavailable');
  for (const key of ['collectionEnabled', 'deliveryEnabled', 'decisionsEnabled', 'patternActivationEnabled', 'sanctionsEnabled']) {
    assert.equal(status[key], false);
  }
  assert.equal(status.counts, null);
  assert.deepEqual(status.coverage, unknown);
  status.coverage.status = 'mutated';
  assert.deepEqual((await service.status()).coverage, unknown);
  assert.deepEqual(await service.step(), { state: 'unavailable' });
  await service.close();
  const disabled = await createConsoleReviewService();
  assert.equal((await disabled.status()).mode, 'disabled', 'deliberately disabled remains distinct');
});

test('uncertain notification halts this service run and cannot be automatically retried', async (t) => {
  let sends = 0;
  const { service, binding } = await fixture(t, { deliveryEnabled: true, request: async ({ path }) => {
    if (path === '/coverage') return { statusCode: 200, body: fresh() };
    assert.equal(path, '/notify'); sends++;
    return { statusCode: 200, body: { ok: false } };
  } });
  capture(service, binding);
  const first = await service.step();
  assert.equal(first.state, 'uncertain');
  assert.equal(service.store.getCase(first.caseId).alert.state, 'uncertain');
  assert.deepEqual(await service.step(), { state: 'idle' });
  assert.equal(sends, 1);
  assert.equal((await service.status()).deliveryEnabled, false);
});

test('shutdown aborts notification/status, releases ownership and permits restart without replay', async (t) => {
  const notifyEntered = deferred(), coverageEntered = deferred();
  const signals = [];
  const { service, binding } = await fixture(t, { deliveryEnabled: true, request: ({ path, signal }) => {
    signals.push(signal);
    if (path === '/notify') notifyEntered.resolve(); else coverageEntered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('PRIVATE_EVIDENCE')), { once: true }));
  } });
  capture(service, binding);
  const sending = service.step(), status = service.status();
  await Promise.all([notifyEntered.promise, coverageEntered.promise]);
  await service.close();
  const sent = await sending;
  assert.equal(sent.state, 'uncertain');
  assert.equal((await status).mode, 'unavailable');
  assert.deepEqual((await service.status()).coverage, unknown);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.deepEqual(await service.step(), { state: 'idle' });
  const restarted = await createConsoleReviewService({ binding, now, request: async ({ path }) => {
    assert.equal(path, '/coverage', 'restart must not replay an uncertain alert');
    return { statusCode: 200, body: fresh() };
  } });
  try {
    assert.equal((await restarted.status()).mode, 'live');
    assert.equal(restarted.store.getCase(sent.caseId).alert.state, 'uncertain');
    assert.deepEqual(await restarted.step(), { state: 'idle' });
  } finally { await restarted.close(); }
});
