import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverNextModerationReviewAlert } from '../src/moderation-review-alerts.mjs';

const CASE = '10000000-0000-4000-8000-000000000001';
const ATTEMPT = '20000000-0000-4000-8000-000000000002';
const RECEIPT = '30000000-0000-4000-8000-000000000003';
const consoleUrl = 'https://console.example.invalid';

function fixture() {
  let state = 'pending';
  const calls = [];
  const store = {
    claimAlert() {
      calls.push('claim');
      if (state !== 'pending') return null;
      state = 'calling';
      return { caseId: CASE, attemptId: ATTEMPT, privateText: 'PRIVATE FIXTURE NOT FOR TRANSPORT' };
    },
    finishAlert(value) {
      assert.equal(state, 'calling');
      assert.equal(value.caseId, CASE);
      assert.equal(value.attemptId, ATTEMPT);
      calls.push(value);
      state = value.state;
    },
  };
  return { store, calls, state: () => state };
}

test('durable calling claim precedes send; payload contains generic notice and authenticated opaque deep link only', async () => {
  const f = fixture();
  let payload;
  const result = await deliverNextModerationReviewAlert({ store: f.store, consoleUrl, send: async (value) => {
    assert.equal(f.state(), 'calling');
    assert.deepEqual(f.calls, ['claim']);
    payload = value;
    return { ok: true, receipt: { id: RECEIPT, raw: 'PRIVATE RESPONSE' } };
  } });
  assert.deepEqual(result, { caseId: CASE, attemptId: ATTEMPT, state: 'sent' });
  assert.deepEqual(Object.keys(payload).sort(), ['text', 'url']);
  assert.equal(payload.url, `${consoleUrl}/moderation-v3.html?case=${CASE}`);
  assert.ok(payload.text.includes(payload.url));
  assert.equal(JSON.stringify(payload).includes('PRIVATE'), false);
  assert.deepEqual(f.calls.at(-1).receipt, { id: RECEIPT });
});

test('empty queue does not call the sender', async () => {
  const result = await deliverNextModerationReviewAlert({
    store: { claimAlert: () => null, finishAlert: () => assert.fail('nothing to finish') },
    consoleUrl, send: () => assert.fail('nothing to send'),
  });
  assert.deepEqual(result, { state: 'idle' });
});

for (const [name, response, expected] of [
  ['confirmed', { ok: true }, 'sent'],
  ['definitely rejected', { ok: false, definite: true, error: 'PRIVATE REJECTION' }, 'failed'],
  ['ambiguous false', { ok: false }, 'uncertain'],
  ['empty', {}, 'uncertain'],
  ['null', null, 'uncertain'],
  ['undefined', undefined, 'uncertain'],
  ['string boolean', { ok: 'true' }, 'uncertain'],
  ['malformed definite', { ok: false, definite: 'true' }, 'uncertain'],
]) {
  test(`${name} is persisted as ${expected} and never automatically retried`, async () => {
    const f = fixture();
    let sends = 0;
    const send = async () => { sends++; return response; };
    const first = await deliverNextModerationReviewAlert({ store: f.store, send, consoleUrl });
    assert.equal(first.state, expected);
    assert.equal(f.state(), expected);
    assert.deepEqual(f.calls.at(-1), { caseId: CASE, attemptId: ATTEMPT, state: expected, receipt: null });
    assert.deepEqual(await deliverNextModerationReviewAlert({ store: f.store, send, consoleUrl }), { state: 'idle' });
    assert.equal(sends, 1);
  });
}

test('thrown transport error becomes uncertain without private error text', async () => {
  const f = fixture();
  const result = await deliverNextModerationReviewAlert({ store: f.store, consoleUrl, send: async () => {
    throw new Error('PRIVATE FIXTURE TOKEN and response body');
  } });
  assert.equal(result.state, 'uncertain');
  assert.equal(JSON.stringify(f.calls).includes('PRIVATE'), false);
  assert.equal(f.calls.at(-1).receipt, null);
});

test('only UUID receipt identifiers survive; provider bodies, tokens and nonopaque IDs do not', async () => {
  for (const receipt of ['secret-token', { id: 'http://private.invalid/token' }, { messageId: '123' }, { text: 'PRIVATE' }, null]) {
    const f = fixture();
    await deliverNextModerationReviewAlert({ store: f.store, consoleUrl, send: async () => ({ ok: true, receipt }) });
    assert.equal(f.calls.at(-1).receipt, null);
  }
  const f = fixture();
  await deliverNextModerationReviewAlert({ store: f.store, consoleUrl, send: async () => ({ ok: true, receipt: RECEIPT }) });
  assert.deepEqual(f.calls.at(-1).receipt, { id: RECEIPT });
});

test('unsafe origin/config fails before consuming a claim', async () => {
  for (const unsafe of [
    'javascript:alert(1)', 'file:///tmp/private', 'http://console.example.invalid',
    'https://user:pass@console.example.invalid', 'https://console.example.invalid/?token=secret',
    'https://console.example.invalid/#private', 'https://console.example.invalid/arbitrary-path',
    '//console.example.invalid', 'not-a-url',
  ]) {
    const f = fixture();
    await assert.rejects(deliverNextModerationReviewAlert({ store: f.store, send: () => assert.fail(), consoleUrl: unsafe }), /console_url_invalid/u);
    assert.deepEqual(f.calls, []);
  }
  await assert.rejects(deliverNextModerationReviewAlert({}), /delivery_config_invalid/u);
});

test('loopback fixture URLs and exact Console page URL resolve to a clean deep link', async () => {
  for (const origin of ['http://127.0.0.1:8790', 'http://localhost:8790', 'http://[::1]:8790', consoleUrl]) {
    const f = fixture();
    await deliverNextModerationReviewAlert({ store: f.store, consoleUrl: `${origin}/moderation-v3.html`, send: async ({ url }) => {
      assert.equal(url, `${origin}/moderation-v3.html?case=${CASE}`);
      return { ok: true };
    } });
  }
});

test('parallel delivery cannot resend a calling attempt', async () => {
  const f = fixture();
  let resolveSend;
  let started;
  const sendStarted = new Promise((resolve) => { started = resolve; });
  const pending = deliverNextModerationReviewAlert({ store: f.store, consoleUrl, send: () => {
    started();
    return new Promise((resolve) => { resolveSend = resolve; });
  } });
  await sendStarted;
  assert.deepEqual(await deliverNextModerationReviewAlert({ store: f.store, consoleUrl, send: () => assert.fail('duplicate') }), { state: 'idle' });
  resolveSend({ ok: true });
  assert.equal((await pending).state, 'sent');
});

test('failed terminal persistence propagates while original calling claim stays fenced', async () => {
  const f = fixture();
  f.store.finishAlert = () => { throw new Error('synthetic persistence failure'); };
  await assert.rejects(deliverNextModerationReviewAlert({ store: f.store, consoleUrl, send: async () => ({ ok: true }) }), /synthetic persistence failure/u);
  assert.equal(f.state(), 'calling');
  assert.deepEqual(await deliverNextModerationReviewAlert({ store: f.store, consoleUrl, send: () => assert.fail('blind retry') }), { state: 'idle' });
});

test('nonopaque case identity never enters a URL or sender', async () => {
  let terminal;
  const result = await deliverNextModerationReviewAlert({
    store: {
      claimAlert: () => ({ caseId: 'native-chat-id:123', attemptId: ATTEMPT }),
      finishAlert: (value) => { terminal = value; },
    },
    consoleUrl, send: () => assert.fail('unsafe claim must not send'),
  });
  assert.equal(result.state, 'failed');
  assert.equal(terminal.state, 'failed');
});
