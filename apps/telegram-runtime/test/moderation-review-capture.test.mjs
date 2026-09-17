import assert from 'node:assert/strict';
import http from 'node:http';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createModerationReviewCapture } from '../src/moderation-review-capture.mjs';
import { createTelegramRuntimeHttpServer } from '../src/http-server.mjs';

const NOW = Date.parse('2026-09-17T12:01:00.000Z');
const policy = () => ({ enabled: true, bindingId: 'synthetic-source', epochId: 'synthetic-epoch',
  chatIds: ['-100101'], startAt: '2026-09-17T12:00:00.000Z', allowUserId: false,
  exemptBotIds: ['9001'], maxTextChars: 32, maxContextChars: 16 });
const update = (updateId = 101) => ({ update_id: updateId, message: { message_id: 51,
  chat: { id: -100101 }, from: { id: 201, username: 'private-profile' }, date: NOW / 1000 - 10,
  text: 'Synthetic private comment', photo: [{ file_id: 'private-media' }] } });
const ack = (overrides = {}) => ({ statusCode: 200, body: { contract: 'moderation-review-receipt/v1',
  bindingId: 'synthetic-source', epochId: 'synthetic-epoch', intakeSeq: 1, outcome: 'accepted', ...overrides } });
const zero = () => ({ acknowledged: 0, not_attempted: 0, rejected: 0, uncertain: 0 });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function capture(t, overrides = {}) {
  const result = createModerationReviewCapture({ policy: policy(), now: () => NOW, timeoutMs: 500, ...overrides });
  t.after(() => result.close()); return result;
}
async function server(t, runtime, reviewCapture, config = {}) {
  const errors = [];
  const instance = createTelegramRuntimeHttpServer({
    config: { ingressEnabled: true, moderator: { webhookSecret: 'synthetic-moderator-secret' },
      assistant: { webhookSecret: 'synthetic-assistant-secret' }, ...config },
    runtime, reviewCapture, logger: { error(...args) { errors.push(args); } },
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { instance.close(resolve); instance.closeAllConnections(); }));
  return { instance, errors };
}
function request(instance, { path = '/webhooks/telegram/moderator', role = 'moderator', body = update(), raw,
  secret = `synthetic-${role}-secret`, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: instance.address().port, path, method, agent: false,
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret } }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.setTimeout(1500, () => req.destroy(new Error('synthetic request timed out')));
    req.on('error', reject); req.end(raw === undefined ? JSON.stringify(body) : raw);
  });
}

test('disabled, closed and unconfigured capture never projects or calls a transport', (t) => {
  let calls = 0;
  for (const overrides of [{ policy: null }, { policy: { enabled: false } }, { send: null }]) {
    const subject = capture(t, { send() { calls++; }, project() { calls++; }, ...overrides });
    subject.start('moderator', update())();
    assert.deepEqual(subject.snapshot().counts, zero());
  }
  const subject = capture(t, { send() { calls++; } }); subject.close(); subject.start('moderator', update())();
  assert.equal(calls, 0);
});

test('capture capacity/deadline limits are explicit bounded safe integers', () => {
  for (const maxInflight of [0, 33, 1.5, '1', null, Infinity]) {
    assert.throws(() => createModerationReviewCapture({ maxInflight }), { message: 'review_capture_limits_invalid' });
  }
  for (const timeoutMs of [0, 10_001, 1.5, '1', null, Infinity]) {
    assert.throws(() => createModerationReviewCapture({ timeoutMs }), { message: 'review_capture_limits_invalid' });
  }
});

test('positive receipt counts once, copied policy cannot be mutated by its caller, snapshots are detached', async (t) => {
  const rules = policy(), subject = capture(t, { policy: rules, send: () => ack() });
  rules.bindingId = 'changed-policy'; rules.chatIds.length = 0;
  const cancel = subject.start('moderator', update());
  await immediate(); cancel(); cancel();
  const snapshot = subject.snapshot();
  assert.deepEqual(snapshot.counts, { ...zero(), acknowledged: 1 });
  assert.deepEqual(snapshot.reasons, { review_receipt_verified: 1 });
  assert.equal(snapshot.active, 0);
  snapshot.counts.acknowledged = 200; snapshot.reasons.review_receipt_verified = 200;
  assert.equal(subject.snapshot().counts.acknowledged, 1);
  assert.equal(subject.snapshot().reasons.review_receipt_verified, 1);
});

test('late success/rejection after primary cancellation cannot doublecount or retry an envelope', async (t) => {
  for (const settle of ['resolve', 'reject']) {
    const pending = deferred(); let calls = 0, signal;
    const subject = capture(t, { send(envelope, options) {
      calls++; signal = options.signal;
      assert.equal(envelope.text, 'Synthetic private comment');
      assert.equal(JSON.stringify(envelope).includes('private-profile'), false);
      return pending.promise;
    } });
    const cancel = subject.start('moderator', update());
    assert.equal(subject.snapshot().active, 1); cancel(); cancel();
    assert.equal(signal.aborted, true); assert.equal(subject.snapshot().active, 0);
    pending[settle](settle === 'resolve' ? ack() : new Error('private transport detail'));
    await immediate();
    assert.equal(calls, 1);
    assert.deepEqual(subject.snapshot().counts, { ...zero(), uncertain: 1 });
    assert.deepEqual(subject.snapshot().reasons, { review_primary_completed: 1 });
    assert.equal(JSON.stringify(subject.snapshot()).includes('private'), false);
  }
});

test('finite timeout aborts once, releases busy slot and never resends after late receipt', async (t) => {
  const pending = deferred(); let calls = 0, signal;
  const subject = capture(t, { timeoutMs: 10, maxInflight: 1, send(_envelope, options) {
    calls++; signal = options.signal; return pending.promise;
  } });
  const cancel = subject.start('moderator', update());
  await delay(30);
  assert.equal(signal.aborted, true); assert.equal(subject.snapshot().active, 0);
  pending.resolve(ack()); await immediate(); cancel();
  assert.equal(calls, 1);
  assert.deepEqual(subject.snapshot().counts, { ...zero(), uncertain: 1 });
  assert.deepEqual(subject.snapshot().reasons, { review_capture_timeout: 1 });
});

test('busy capture refuses new attempts without a raw-envelope queue or later replay', async (t) => {
  let calls = 0;
  const subject = capture(t, { maxInflight: 1, send() { calls++; return new Promise(() => {}); } });
  const first = subject.start('moderator', update(1));
  const second = subject.start('moderator', update(2));
  assert.equal(calls, 1); second(); first(); await immediate();
  assert.equal(calls, 1);
  assert.deepEqual(subject.snapshot().counts, { ...zero(), uncertain: 1, not_attempted: 1 });
  assert.deepEqual(subject.snapshot().reasons, { review_busy: 1, review_primary_completed: 1 });
});

test('close cancels all active captures; shutdown and later callbacks are idempotent', async (t) => {
  const pending = deferred(), signals = [];
  const subject = capture(t, { send(_envelope, { signal }) { signals.push(signal); return pending.promise; } });
  subject.start('moderator', update(1)); subject.start('moderator', update(2));
  subject.close(); subject.close(); pending.resolve(ack()); await immediate();
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(subject.snapshot().active, 0);
  assert.deepEqual(subject.snapshot().counts, { ...zero(), uncertain: 2 });
  subject.start('moderator', update(3)); assert.equal(signals.length, 2);
});

test('skip, invalid projection and projection exceptions retain no raw status fields', (t) => {
  let calls = 0;
  const skipped = capture(t, { send() { calls++; }, project: () => ({ kind: 'skip', code: 'review_no_text' }) });
  skipped.start('moderator', update())(); assert.deepEqual(skipped.snapshot().counts, zero());
  for (const project of [() => ({ kind: 'reject', code: 'private source text' }), () => null,
    () => { throw new Error('private source text'); }]) {
    const subject = capture(t, { send() { calls++; }, project }); subject.start('moderator', update())();
    assert.deepEqual(subject.snapshot().counts, { ...zero(), not_attempted: 1 });
    assert.equal(JSON.stringify(subject.snapshot()).includes('private'), false);
  }
  assert.equal(calls, 0);
});

test('transport throw/rejection has one uncertain count and no retry', async (t) => {
  for (const send of [() => { throw new Error('private network failure'); },
    () => Promise.reject(new Error('private network failure'))]) {
    const subject = capture(t, { send }); const cancel = subject.start('moderator', update());
    await immediate(); cancel();
    assert.deepEqual(subject.snapshot().counts, { ...zero(), uncertain: 1 });
    assert.deepEqual(subject.snapshot().reasons, { review_transport_unavailable: 1 });
  }
});

test('only exact bounded authenticated-style receipts acknowledge capture', async (t) => {
  for (const outcome of ['accepted', 'duplicate', 'stale']) {
    const subject = capture(t, { send: () => ack({ outcome }) }); subject.start('moderator', update()); await immediate();
    assert.deepEqual(subject.snapshot().counts, { ...zero(), acknowledged: 1 });
  }
  const malformed = [null, {}, { statusCode: 200, body: null }, { ...ack(), statusCode: 201 },
    ack({ contract: 'other/v1' }), ack({ bindingId: 'wrong-source' }), ack({ epochId: 'wrong-epoch' }),
    ack({ extra: 'private body' }), ack({ intakeSeq: 0 }), ack({ intakeSeq: '1' }),
    ack({ intakeSeq: Number.MAX_SAFE_INTEGER + 1 }), ack({ outcome: 'erased' })];
  for (const response of malformed) {
    const subject = capture(t, { send: () => response }); subject.start('moderator', update()); await immediate();
    assert.deepEqual(subject.snapshot().counts, { ...zero(), uncertain: 1 });
    assert.deepEqual(subject.snapshot().reasons, { review_receipt_unverified: 1 });
  }
});

test('rejection needs explicit no-commit proof; reasons are safe bounded aggregate counters', async (t) => {
  for (const response of [
    { statusCode: 409, body: { error: 'review_event_conflict', definiteNoCommit: true } },
    { statusCode: 409, body: { error: 'review_event_conflict' } },
    { statusCode: 500, body: { error: 'review_failed', definiteNoCommit: true } },
    { statusCode: 409, body: { error: 'private error body', definiteNoCommit: true } },
  ]) {
    const subject = capture(t, { send: () => response }); subject.start('moderator', update()); await immediate();
    const rejected = response.statusCode === 409 && response.body.definiteNoCommit === true && response.body.error === 'review_event_conflict';
    assert.deepEqual(subject.snapshot().counts, { ...zero(), [rejected ? 'rejected' : 'uncertain']: 1 });
    assert.equal(JSON.stringify(subject.snapshot()).includes('private'), false);
  }
  let sequence = 0;
  const subject = capture(t, { project: () => ({ kind: 'reject', code: `review_reason_${String.fromCharCode(97 + Math.floor(sequence / 26), 97 + sequence++ % 26)}` }), send() {} });
  for (let index = 0; index < 80; index++) subject.start('moderator', update(index));
  const snapshot = subject.snapshot();
  assert.equal(snapshot.counts.not_attempted, 80);
  assert.ok(Object.keys(snapshot.reasons).length <= 33);
  assert.equal(Object.values(snapshot.reasons).reduce((sum, value) => sum + value, 0), 80);
  assert.ok(snapshot.reasons.review_other > 0);
});

test('coverage always labels attempts, no backfill and unknown pre-boot/restart history', async (t) => {
  const first = capture(t, { send: () => ack() }); first.start('moderator', update()); await immediate();
  assert.equal(first.snapshot().counts.acknowledged, 1); first.close();
  const second = capture(t, { now: () => NOW + 1000, send: () => ack() }), snapshot = second.snapshot();
  assert.equal(snapshot.status, 'unknown'); assert.equal(snapshot.priorCoverage, 'unknown');
  assert.equal(snapshot.sinceBoot, '2026-09-17T12:01:01.000Z');
  assert.equal(snapshot.countersKnownSinceBoot, true); assert.equal(snapshot.backfillEnabled, false);
  assert.equal(snapshot.semantics, 'observed_attempts_not_unique_messages'); assert.deepEqual(snapshot.counts, zero());
});

test('primary starts first; never-resolving Review cannot delay completion and is cancelled afterwards', { timeout: 2500 }, async (t) => {
  const primary = deferred(), started = deferred(), order = [], payload = update(); let signal, sendCalls = 0;
  const subject = capture(t, { send(envelope, options) {
    order.push('review-start'); signal = options.signal; sendCalls++;
    signal.addEventListener('abort', () => order.push('review-abort')); started.resolve();
    assert.equal(envelope.text, payload.message.text); return new Promise(() => {});
  } });
  const result = { kind: 'synthetic-primary', sanctions: 'unchanged' };
  const { instance, errors } = await server(t, { handleUpdate(role, source) {
    order.push('primary-start'); assert.equal(role, 'moderator'); assert.deepEqual(source, payload);
    return primary.promise.then(() => { order.push('primary-finish'); return result; });
  } }, subject);
  const response = request(instance); await started.promise;
  assert.deepEqual(order, ['primary-start', 'review-start']);
  primary.resolve();
  assert.deepEqual(await response, { status: 200, body: { ok: true, result } });
  assert.deepEqual(order, ['primary-start', 'review-start', 'primary-finish', 'review-abort']);
  assert.equal(signal.aborted, true); assert.equal(sendCalls, 1); assert.deepEqual(errors, []);
  assert.deepEqual(subject.snapshot().counts, { ...zero(), uncertain: 1 });
});

for (const variant of ['throwing-transport', 'rejecting-transport', 'invalid-receipt', 'busy', 'throwing-review-start', 'throwing-review-cancel']) {
  test(`primary HTTP result is unchanged with ${variant}`, { timeout: 2500 }, async (t) => {
    let primaryCalls = 0, sendCalls = 0;
    const subject = capture(t, { maxInflight: 1, send() {
      sendCalls++;
      if (variant === 'throwing-transport') throw new Error('private transport failure');
      if (variant === 'rejecting-transport') return Promise.reject(new Error('private transport failure'));
      if (variant === 'busy') return new Promise(() => {});
      return { statusCode: 200, body: { private: 'invalid receipt' } };
    } });
    if (variant === 'busy') subject.start('moderator', update(99));
    let optional = subject;
    if (variant === 'throwing-review-start') optional = { start() { throw new Error('private capture failure'); } };
    if (variant === 'throwing-review-cancel') optional = { start() { return () => { throw new Error('private cancel failure'); }; } };
    const result = { kind: 'same-primary-result', actions: ['synthetic-action'] };
    const { instance, errors } = await server(t, { async handleUpdate() { primaryCalls++; return result; } }, optional);
    assert.deepEqual(await request(instance), { status: 200, body: { ok: true, result } });
    assert.equal(primaryCalls, 1); assert.deepEqual(errors, []);
    if (variant === 'busy') { assert.equal(sendCalls, 1); assert.equal(subject.snapshot().counts.not_attempted, 1); }
  });
}

test('primary failure preserves HTTP error and cancels only its in-flight Review', { timeout: 2500 }, async (t) => {
  let signal;
  const subject = capture(t, { send(_envelope, options) { signal = options.signal; return new Promise(() => {}); } });
  const { instance, errors } = await server(t, { async handleUpdate() { throw Object.assign(new Error('synthetic primary failure'), { statusCode: 503 }); } }, subject);
  assert.deepEqual(await request(instance), { status: 503, body: { error: 'runtime_error' } });
  assert.equal(signal.aborted, true); assert.equal(subject.snapshot().active, 0); assert.equal(errors.length, 1);
  assert.deepEqual(subject.snapshot().counts, { ...zero(), uncertain: 1 });
});

test('invalid secret, JSON, disabled ingress and unsupported route do not invoke either lane', async (t) => {
  let calls = 0;
  const runtime = { handleUpdate() { calls++; return {}; } }, optional = { start() { calls++; } };
  const { instance } = await server(t, runtime, optional);
  assert.equal((await request(instance, { secret: 'wrong' })).status, 401);
  assert.equal((await request(instance, { raw: '{"private":' })).status, 400);
  assert.equal((await request(instance, { path: '/capture' })).status, 404);
  assert.equal((await request(instance, { path: '/health', method: 'GET' })).status, 200);
  const disabled = await server(t, runtime, optional, { ingressEnabled: false });
  assert.equal((await request(disabled.instance)).status, 404); assert.equal(calls, 0);
});

test('Assistant primary webhook is preserved while projection excludes its Review lane', async (t) => {
  let sendCalls = 0;
  const subject = capture(t, { send() { sendCalls++; return ack(); } });
  const { instance } = await server(t, { async handleUpdate(role) { return { role }; } }, subject);
  assert.deepEqual(await request(instance, { path: '/webhooks/telegram/assistant', role: 'assistant' }),
    { status: 200, body: { ok: true, result: { role: 'assistant' } } });
  assert.equal(sendCalls, 0); assert.deepEqual(subject.snapshot().counts, zero());
});
