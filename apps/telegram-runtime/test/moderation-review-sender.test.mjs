import assert from 'node:assert/strict';
import test from 'node:test';
import { createModerationReviewTelegramSender } from '../src/moderation-review-sender.mjs';

const CASE_ID = '10000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '20000000-0000-4000-8000-000000000001';
const INPUT = { caseId: CASE_ID, attemptId: ATTEMPT_ID };
const TEXT = `Новый случай для проверки в Admin.\n\nhttps://console.example.invalid/moderation-v3.html?case=${CASE_ID}`;
const TOKEN = '123456:synthetic_credential_never_sent';
const BASE = { enabled: true, botToken: TOKEN, recipientChatId: '123456',
  consoleUrl: 'https://console.example.invalid', authorize: async () => ({ authorized: true }) };

function validResult(extra = {}) {
  return { ok: true, result: { message_id: 73, chat: { id: 123456, type: 'private' }, text: TEXT, ...extra } };
}

function jsonResponse(body = validResult(), options = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...options });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
}

test('exactly one fake call follows final authorization; fixed generic copy has no footer, preview, parse mode or source text', async () => {
  const order = [];
  const send = createModerationReviewTelegramSender({ ...BASE,
    authorize: async (input) => { assert.deepEqual(input, INPUT); order.push('authorized'); return { authorized: true }; },
    fetchImpl: async (url, init) => {
      order.push('called');
      assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.signal.aborted, false);
      assert.deepEqual(JSON.parse(init.body), { chat_id: '123456', text: TEXT, link_preview_options: { is_disabled: true } });
      return jsonResponse();
    },
  });
  const result = await send(INPUT);
  assert.deepEqual(order, ['authorized', 'called']);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'receipt']);
  assert.match(result.receipt.id, /^[a-f0-9-]{36}$/u);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('disabled, invalid destinations/configuration and malformed identifiers never authorize or send', async () => {
  let calls = 0;
  let authorizations = 0;
  const options = { ...BASE, authorize: async () => { authorizations++; return { authorized: true }; },
    fetchImpl: async () => { calls++; return jsonResponse(); } };
  for (const extra of [{ enabled: false }, { enabled: 'true' }, { botToken: 'secret\ninvalid' },
    { recipientChatId: '-1001234' }, { recipientChatId: '@name' }, { recipientChatId: '00123' },
    { recipientChatId: 1.5 }, { recipientChatId: '9007199254740992' }, { recipientChatId: '0' },
    { consoleUrl: 'https://user:password@example.invalid' }, { consoleUrl: 'https://example.invalid/path' },
    { consoleUrl: 'https://example.invalid/?case=other' }, { consoleUrl: 'http://example.invalid' },
    { timeoutMs: 0 }, { timeoutMs: 30_001 }]) {
    const result = await createModerationReviewTelegramSender({ ...options, ...extra })(INPUT);
    assert.equal(result.ok, false);
    assert.equal(result.definite, true);
  }
  const send = createModerationReviewTelegramSender(options);
  for (const input of [undefined, {}, { ...INPUT, caseId: '../private' }, { ...INPUT, attemptId: 1 },
    { ...INPUT, text: 'private evidence must be rejected' }, { ...INPUT, url: 'https://evil.invalid' }]) {
    assert.equal((await send(input)).definite, true);
  }
  assert.equal(calls, 0);
  assert.equal(authorizations, 0);
});

test('only literal authorized:true is accepted and authorization exceptions are sanitized', async () => {
  let calls = 0;
  for (const value of [false, true, null, {}, { authorized: 'true' }, { authorized: 1 }]) {
    const send = createModerationReviewTelegramSender({ ...BASE, authorize: async () => value,
      fetchImpl: async () => { calls++; return jsonResponse(); } });
    assert.deepEqual(await send(INPUT), { ok: false, definite: true, code: 'review_sender_not_authorized' });
  }
  const send = createModerationReviewTelegramSender({ ...BASE, authorize: async () => { throw new Error(TOKEN); },
    fetchImpl: async () => { calls++; return jsonResponse(); } });
  assert.deepEqual(await send(INPUT), { ok: false, definite: true, code: 'review_sender_authorization_failed' });
  assert.equal(calls, 0);
});

test('authorization timeout is definite and a late authorization cannot invoke transport', async () => {
  let calls = 0;
  const gate = deferred();
  const send = createModerationReviewTelegramSender({ ...BASE, timeoutMs: 25, authorize: () => gate.promise,
    fetchImpl: async () => { calls++; return jsonResponse(); } });
  assert.deepEqual(await send(INPUT), { ok: false, definite: true, code: 'review_sender_timeout' });
  gate.resolve({ authorized: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('an authorization callback that never resolves is hard-bounded without an external invocation', async () => {
  let calls = 0;
  const send = createModerationReviewTelegramSender({ ...BASE, timeoutMs: 25,
    authorize: () => new Promise(() => {}), fetchImpl: async () => { calls++; return jsonResponse(); } });
  const before = Date.now();
  assert.deepEqual(await send(INPUT), { ok: false, definite: true, code: 'review_sender_timeout' });
  assert.equal(calls, 0);
  assert.ok(Date.now() - before < 1000);
});

test('pre-invocation caller cancellation aborts authorization and prevents any late external call', async () => {
  const gate = deferred();
  let calls = 0;
  let authorizationSignal;
  const controller = new AbortController();
  const send = createModerationReviewTelegramSender({ ...BASE,
    authorize: (_claim, { signal }) => { authorizationSignal = signal; return gate.promise; },
    fetchImpl: async () => { calls++; return jsonResponse(); } });
  const pending = send(INPUT, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await pending, { ok: false, definite: true, code: 'review_sender_cancelled' });
  assert.equal(authorizationSignal.aborted, true);
  gate.resolve({ authorized: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.deepEqual(await send(INPUT, { signal: controller.signal }),
    { ok: false, definite: true, code: 'review_sender_cancelled' });
});

test('caller cancellation after external invocation is uncertain and aborts the response work', async () => {
  const entered = deferred();
  const controller = new AbortController();
  let calls = 0;
  let externalSignal;
  const send = createModerationReviewTelegramSender({ ...BASE,
    fetchImpl: (_url, { signal }) => {
      calls++; externalSignal = signal; entered.resolve(); return new Promise(() => {});
    } });
  const pending = send(INPUT, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  assert.deepEqual(await pending, { ok: false, definite: false, code: 'review_sender_cancelled' });
  assert.equal(externalSignal.aborted, true);
  assert.equal(calls, 1);
});

test('the Console authorization gate, not a local ledger, controls duplicate calls', async () => {
  let consumed = false;
  let calls = 0;
  const send = createModerationReviewTelegramSender({ ...BASE, authorize: async () => {
    if (consumed) return { authorized: false };
    consumed = true;
    return { authorized: true };
  }, fetchImpl: async () => { calls++; return jsonResponse(); } });
  const results = await Promise.all([send(INPUT), send(INPUT)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(calls, 1);
});

for (const [name, makeResponse] of [
  ['HTTP rejection', () => jsonResponse({ ok: false }, { status: 429 })],
  ['Telegram rejection', () => jsonResponse({ ok: false, description: TOKEN })],
  ['wrong destination', () => jsonResponse(validResult({ chat: { id: 999, type: 'private' } }))],
  ['non-private destination', () => jsonResponse(validResult({ chat: { id: 123456, type: 'supergroup' } }))],
  ['chat ID string', () => jsonResponse(validResult({ chat: { id: '123456', type: 'private' } }))],
  ['missing message ID', () => jsonResponse(validResult({ message_id: undefined }))],
  ['invalid message ID', () => jsonResponse(validResult({ message_id: 0 }))],
  ['changed text', () => jsonResponse(validResult({ text: TEXT + ' extra' }))],
  ['malformed JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
  ['invalid UTF8', () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } })],
  ['wrong media type', () => new Response(JSON.stringify(validResult()))],
  ['missing body', () => new Response(null, { headers: { 'content-type': 'application/json' } })],
  ['incomplete content length', () => jsonResponse(validResult(), { headers: { 'content-type': 'application/json', 'content-length': '1000' } })],
  ['oversized response', () => jsonResponse({ text: 'x'.repeat(17_000) })],
  ['oversized declared response', () => jsonResponse(validResult(), { headers: { 'content-type': 'application/json', 'content-length': '17000' } })],
]) {
  test(`post-invocation ${name} is uncertain, sanitized and never retried`, async () => {
    let calls = 0;
    const send = createModerationReviewTelegramSender({ ...BASE, fetchImpl: async () => { calls++; return makeResponse(); } });
    const result = await send(INPUT);
    assert.equal(result.ok, false);
    assert.equal(result.definite, false);
    assert.match(result.code, /^review_sender_/u);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.equal(calls, 1);
  });
}

test('synchronous external invocation exception is uncertain and has no fallback', async () => {
  let calls = 0;
  const send = createModerationReviewTelegramSender({ ...BASE, fetchImpl: () => { calls++; throw new Error(TOKEN); } });
  assert.deepEqual(await send(INPUT), { ok: false, definite: false, code: 'review_sender_transport_uncertain' });
  assert.equal(calls, 1);
});

test('hard deadline aborts a hanging fake fetch even if it ignores AbortSignal', async () => {
  let signal;
  let calls = 0;
  const send = createModerationReviewTelegramSender({ ...BASE, timeoutMs: 25, fetchImpl: (_url, init) => {
    calls++;
    signal = init.signal;
    return new Promise(() => {});
  } });
  const before = Date.now();
  assert.deepEqual(await send(INPUT), { ok: false, definite: false, code: 'review_sender_timeout' });
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.ok(Date.now() - before < 1000);
});

test('hard deadline cancels an endless response stream, including continuously arriving data', async () => {
  let cancelled = false;
  let interval;
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{'));
    interval = setInterval(() => controller.enqueue(new TextEncoder().encode(' ')), 4);
  }, cancel() { cancelled = true; clearInterval(interval); } });
  const send = createModerationReviewTelegramSender({ ...BASE, timeoutMs: 35,
    fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) });
  assert.deepEqual(await send(INPUT), { ok: false, definite: false, code: 'review_sender_timeout' });
  assert.equal(cancelled, true);
});

test('partial stream error is uncertain, never successful despite valid-looking initial JSON', async () => {
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(validResult())));
    setImmediate(() => controller.error(new Error(TOKEN)));
  } });
  const send = createModerationReviewTelegramSender({ ...BASE,
    fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) });
  assert.deepEqual(await send(INPUT), { ok: false, definite: false, code: 'review_sender_transport_uncertain' });
});
