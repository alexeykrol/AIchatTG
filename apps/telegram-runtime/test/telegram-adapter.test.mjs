import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramAdapter } from '../src/telegram-adapter.mjs';
import { TELEGRAM_MESSAGE_LIMIT } from '@aichattg/telegram-core';

/** Записывает каждый вызов Bot API и отдаёт заранее заготовленные ответы. */
function recorder(responses = []) {
  const calls = [];
  const queue = [...responses];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: url.split('/').pop(), body });
    const next = queue.shift() || { ok: true, result: { message_id: 100 + calls.length } };
    return { ok: next.ok !== false, async json() { return next; } };
  };
  return { calls, fetchFn };
}

test('without the markup flag the text goes out exactly as written, with no parse_mode', async () => {
  const { calls, fetchFn } = recorder();
  const adapter = createTelegramAdapter({ botToken: 'T', fetchFn });

  const result = await adapter.sendMessage({ chatId: -1, text: 'Служебный текст **как есть**', replyToMessageId: 7 });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { chat_id: -1, text: 'Служебный текст **как есть**', reply_to_message_id: 7 });
  assert.equal('parse_mode' in calls[0].body, false);
});

test('with the markup flag the answer is rendered to HTML and the link preview stays off', async () => {
  const { calls, fetchFn } = recorder();
  const adapter = createTelegramAdapter({ botToken: 'T', fetchFn });

  const result = await adapter.sendMessage({
    chatId: -1, text: '### Ответ\n\nГлавное — **действие**.', replyToMessageId: 7, markup: true,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    chat_id: -1,
    text: '<b>Ответ</b>\n\nГлавное — <b>действие</b>.',
    parse_mode: 'HTML',
    reply_to_message_id: 7,
    link_preview_options: { is_disabled: true },
  });
});

/**
 * Отказ по разбору разметки — единственная законная повторная отправка: при нём
 * сообщение не доставлено (400 до доставки), поэтому задвоить ответ нечем.
 */
test('a markup refusal is retried once as plain text and the degradation is reported', async () => {
  const { calls, fetchFn } = recorder([
    { ok: false, description: "Bad Request: can't parse entities: Unsupported start tag" },
    { ok: true, result: { message_id: 55 } },
  ]);
  const adapter = createTelegramAdapter({ botToken: 'T', fetchFn });

  const result = await adapter.sendMessage({ chatId: -1, text: 'Текст с **выделением**', markup: true });

  assert.equal(result.ok, true);
  assert.equal(result.degraded, 'markup_stripped');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.text, 'Текст с выделением');
  assert.equal('parse_mode' in calls[1].body, false);
});

test('any other refusal is never resent: delivery there is ambiguous', async () => {
  const { calls, fetchFn } = recorder([{ ok: false, description: 'Too Many Requests: retry after 30' }]);
  const adapter = createTelegramAdapter({ botToken: 'T', fetchFn });

  const result = await adapter.sendMessage({ chatId: -1, text: '**текст**', markup: true });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Too Many Requests: retry after 30');
  assert.equal(calls.length, 1);
});

test('every Telegram request has one bounded deadline and a timeout is never retried', async () => {
  let calls = 0;
  const adapter = createTelegramAdapter({
    botToken: 'T',
    requestTimeoutMs: 100,
    fetchFn: async (_url, init) => {
      calls++;
      assert.equal(init.signal instanceof AbortSignal, true);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    },
  });

  // AbortSignal.timeout() is intentionally unref'ed by Node. Keep the test
  // event loop alive long enough to observe the real deadline firing.
  const keepAlive = setTimeout(() => {}, 250);
  try {
    await assert.rejects(adapter.sendMessage({ chatId: -1, text: 'bounded' }), /abort|timeout/i);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(calls, 1);
});

test('headers without a readable Telegram receipt remain ambiguous and are never retried', async () => {
  let calls = 0;
  const adapter = createTelegramAdapter({
    botToken: 'T', requestTimeoutMs: 100,
    fetchFn: async (_url, init) => {
      calls++;
      return {
        ok: true,
        status: 200,
        async json() {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          });
        },
      };
    },
  });
  const keepAlive = setTimeout(() => {}, 250);
  try {
    await assert.rejects(adapter.sendMessage({ chatId: -1, text: 'receipt required' }), /abort|timeout/i);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(calls, 1);
});

test('an invalid Telegram request deadline is rejected before transport', () => {
  let calls = 0;
  assert.throws(() => createTelegramAdapter({
    botToken: 'T', requestTimeoutMs: 0, fetchFn: async () => { calls++; },
  }), /requestTimeoutMs/);
  assert.equal(calls, 0);
});

test('a long answer is delivered in parts, only the first one replying to the question', async () => {
  const { calls, fetchFn } = recorder();
  const adapter = createTelegramAdapter({ botToken: 'T', fetchFn });
  const long = Array.from({ length: 14 }, (_, index) => `${index}: ${'слово '.repeat(60).trim()}`).join('\n\n');
  assert.ok(long.length > TELEGRAM_MESSAGE_LIMIT);

  const result = await adapter.sendMessage({ chatId: -1, text: long, replyToMessageId: 7, markup: true });

  assert.ok(calls.length > 1);
  assert.equal(calls[0].body.reply_to_message_id, 7);
  for (const call of calls.slice(1)) assert.equal(call.body.reply_to_message_id, undefined);
  // Квитанция — у первой части: именно её id является ответом на вопрос.
  assert.equal(result.data.message_id, 101);
});

test('a failure in a later part is reported without inventing a clean receipt', async () => {
  const { calls, fetchFn } = recorder([
    { ok: true, result: { message_id: 101 } },
    { ok: false, description: 'Forbidden: bot was blocked by the user' },
  ]);
  const adapter = createTelegramAdapter({ botToken: 'T', fetchFn });
  const long = Array.from({ length: 14 }, (_, index) => `${index}: ${'слово '.repeat(60).trim()}`).join('\n\n');

  const result = await adapter.sendMessage({ chatId: -1, text: long, replyToMessageId: 7, markup: true });

  assert.equal(result.partial, true);
  assert.equal(result.error, 'Forbidden: bot was blocked by the user');
  assert.equal(calls.length, 2);
});

test('an adapter without a token stays disabled even when markup is requested', async () => {
  const adapter = createTelegramAdapter({ botToken: '', fetchFn: async () => { throw new Error('must not call'); } });
  assert.deepEqual(await adapter.sendMessage({ chatId: -1, text: '**x**', markup: true }), {
    ok: false, skipped: 'telegram_transport_disabled',
  });
});
