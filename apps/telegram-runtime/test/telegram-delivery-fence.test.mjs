import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramAdapter } from '../src/telegram-adapter.mjs';
import { ASSISTANT_RELEASE_LINE } from '../src/assistant-release.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response(result = { message_id: 101 }) {
  return { ok: true, async json() { return { ok: true, result }; } };
}

function markupRefusal() {
  return { ok: false, async json() {
    return { ok: false, description: "Bad Request: can't parse entities" };
  } };
}

for (const [mode, options] of [
  ['plain', {}], ['rendered', { markup: true }], ['versioned plain', { footer: ASSISTANT_RELEASE_LINE }],
]) {
  for (const [name, predicate] of [
    ['false', () => false], ['truthy string', () => 'true'], ['truthy object', () => ({ ok: true })],
    ['throw', () => { throw new Error('stale revision'); }],
    ['resolved Promise', () => Promise.resolve(true)],
    ['rejected Promise', () => Promise.reject(new Error('stale revision'))], ['non-function', true],
  ]) {
    test(`${mode} send rejects ${name} fence before transport`, async () => {
      let calls = 0;
      const adapter = createTelegramAdapter({ botToken: 'fixture', fetchFn: async () => { calls++; return response(); } });
      assert.deepEqual(await adapter.sendMessage({
        chatId: -100, text: 'Body **verbatim**', ...options, beforeSend: predicate,
      }), { ok: false, skipped: 'send_precondition_unproven', uncertain: false });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 0);
    });
  }
}

test('literal-true send fence invokes transport before the next microtask', async () => {
  let calls = 0;
  const adapter = createTelegramAdapter({ botToken: 'fixture', fetchFn: async () => { calls++; return response(); } });
  assert.equal((await adapter.sendMessage({ chatId: -100, text: 'Body', beforeSend: () => {
    queueMicrotask(() => assert.equal(calls, 1));
    return true;
  } })).ok, true);
});

for (const markup of [true, false]) {
  test(`revision change during suspended first chunk fences subsequent chunks (markup=${markup})`, async () => {
    const entered = deferred();
    const release = deferred();
    const calls = [];
    let revision = 1;
    let checks = 0;
    const adapter = createTelegramAdapter({ botToken: 'fixture', fetchFn: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      entered.resolve();
      await release.promise;
      return response();
    } });
    const pending = adapter.sendMessage({ chatId: -100, text: 'x'.repeat(9000), markup,
      footer: ASSISTANT_RELEASE_LINE, replyToMessageId: 7,
      beforeSend: () => { checks++; return revision === 1; },
    });
    await entered.promise;
    assert.equal(calls.length, 1);
    revision = 2;
    release.resolve();
    assert.deepEqual(await pending, {
      ok: true, data: { message_id: 101 }, partial: true,
      error: 'send_precondition_unproven', skipped: 'send_precondition_unproven',
    });
    assert.equal(checks, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reply_to_message_id, 7);
    assert.equal(calls[0].text.includes(ASSISTANT_RELEASE_LINE), false, 'never add an extra footer-only send after fencing');
  });
}

test('markup-stripping fallback rechecks the revision after the asynchronous refusal', async () => {
  const entered = deferred();
  const release = deferred();
  let revision = 1;
  let calls = 0;
  let checks = 0;
  const adapter = createTelegramAdapter({ botToken: 'fixture', fetchFn: async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return markupRefusal();
  } });
  const pending = adapter.sendMessage({ chatId: -100, text: '**Body**', markup: true,
    footer: ASSISTANT_RELEASE_LINE, beforeSend: () => { checks++; return revision === 1; },
  });
  await entered.promise;
  revision = 2;
  release.resolve();
  assert.deepEqual(await pending, { ok: false, skipped: 'send_precondition_unproven', uncertain: false });
  assert.equal(calls, 1);
  assert.equal(checks, 2);
});

test('fallback fencing on a later chunk reports partial delivery using the first receipt', async () => {
  let calls = 0;
  let checks = 0;
  const adapter = createTelegramAdapter({ botToken: 'fixture', fetchFn: async () => {
    calls++;
    return calls === 1 ? response() : markupRefusal();
  } });
  const result = await adapter.sendMessage({ chatId: -100, text: 'x'.repeat(9000), markup: true,
    footer: ASSISTANT_RELEASE_LINE, beforeSend: () => ++checks < 3,
  });
  assert.equal(result.partial, true);
  assert.equal(result.data.message_id, 101);
  assert.equal(result.error, 'send_precondition_unproven');
  assert.equal(calls, 2);
  assert.equal(checks, 3);
});

test('successful per-chunk fences preserve exact body, final footer and first-only reply semantics', async () => {
  for (const markup of [true, false]) {
    const calls = [];
    let checks = 0;
    const body = 'x'.repeat(9000);
    const adapter = createTelegramAdapter({ botToken: 'fixture', fetchFn: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return response({ message_id: 100 + calls.length });
    } });
    const result = await adapter.sendMessage({ chatId: -100, text: body, markup, forceReply: true,
      footer: ASSISTANT_RELEASE_LINE, replyToMessageId: 7, beforeSend: () => { checks++; return true; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.message_id, 101);
    assert.ok(calls.length > 1);
    assert.equal(checks, calls.length);
    assert.equal(calls.map(({ text }) => text).join(''), `${body}\n\n${ASSISTANT_RELEASE_LINE}`);
    assert.equal(calls[0].reply_to_message_id, 7);
    assert.ok(calls.slice(1).every((part) => part.reply_to_message_id === undefined));
    assert.ok(calls.slice(0, -1).every(({ text }) => !text.includes(ASSISTANT_RELEASE_LINE)));
    if (!markup) assert.deepEqual(calls[0].reply_markup, { force_reply: true, selective: true });
    assert.ok(calls.slice(1).every((part) => part.reply_markup === undefined));
  }
});

test('authorized markup fallback keeps the exact footer once on the delivered plain body', async () => {
  const calls = [];
  let checks = 0;
  const adapter = createTelegramAdapter({ botToken: 'fixture', fetchFn: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return calls.length === 1 ? markupRefusal() : response();
  } });
  const result = await adapter.sendMessage({ chatId: -100, text: '**Body**', markup: true,
    footer: ASSISTANT_RELEASE_LINE, beforeSend: () => { checks++; return true; },
  });
  assert.equal(result.degraded, 'markup_stripped');
  assert.equal(checks, 2);
  assert.equal(calls[1].text, `Body\n\n${ASSISTANT_RELEASE_LINE}`);
  assert.equal(calls[1].parse_mode, undefined);
});
