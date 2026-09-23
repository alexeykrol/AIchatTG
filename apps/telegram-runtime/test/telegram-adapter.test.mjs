import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramAdapter } from '../src/telegram-adapter.mjs';
import { TELEGRAM_MESSAGE_LIMIT } from '@aichattg/telegram-core';
import { ASSISTANT_RELEASE, ASSISTANT_RELEASE_LINE } from '../src/assistant-release.mjs';
import { ASSISTANT_OUT_OF_COVERAGE_TEXT } from '../src/assistant-policy.mjs';

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

test('the menu prompt requests a selective reply to the exact command without altering its text', async () => {
  const { calls, fetchFn } = recorder();
  const adapter = createTelegramAdapter({ botToken: 'T', fetchFn });
  const text = '✍️ Теперь напишите вопрос в ответ на это сообщение и отправьте его. /ask повторно писать не нужно.';
  await adapter.sendMessage({ chatId: -1, text, replyToMessageId: 7, forceReply: true });
  assert.deepEqual(calls[0].body, { chat_id: -1, text, reply_to_message_id: 7,
    reply_markup: { force_reply: true, selective: true } });
  assert.equal(calls.length, 1);
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

test('the public Assistant release metadata is independent and deterministic', () => {
  assert.deepEqual(ASSISTANT_RELEASE, { version: '2.4.42', releasedOn: '2026-09-23' });
  assert.equal(ASSISTANT_RELEASE_LINE, 'Версия 2.4.42 от 23.09.2026');
  assert.equal(Object.isFrozen(ASSISTANT_RELEASE), true);
});

test('a plain approved answer keeps its body verbatim and adds one release line', async () => {
  const { calls, fetchFn } = recorder();
  const adapter = createTelegramAdapter({ botToken: 'T', fetchFn });
  await adapter.sendMessage({ chatId: -1, text: ASSISTANT_OUT_OF_COVERAGE_TEXT, footer: ASSISTANT_RELEASE_LINE, replyToMessageId: 7 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, `${ASSISTANT_OUT_OF_COVERAGE_TEXT}\n\n${ASSISTANT_RELEASE_LINE}`);
  assert.equal('parse_mode' in calls[0].body, false);
});

test('the versioned menu prompt preserves selective forceReply and its first receipt', async () => {
  const { calls, fetchFn } = recorder();
  const adapter = createTelegramAdapter({ botToken: 'T', fetchFn });
  const result = await adapter.sendMessage({ chatId: -1, text: 'Задайте вопрос.', footer: ASSISTANT_RELEASE_LINE,
    replyToMessageId: 7, forceReply: true });
  assert.deepEqual(calls[0].body, { chat_id: -1, text: `Задайте вопрос.\n\n${ASSISTANT_RELEASE_LINE}`,
    reply_to_message_id: 7, reply_markup: { force_reply: true, selective: true } });
  assert.equal(result.data.message_id, 101);
});

test('long plain and Markdown answers keep an intact footer only on the last part', async () => {
  for (const markup of [false, true]) {
    for (const body of ['x'.repeat(3770), 'x'.repeat(9000), '😀'.repeat(5000)]) {
      const { calls, fetchFn } = recorder();
      const adapter = createTelegramAdapter({ botToken: 'T', fetchFn });
      const result = await adapter.sendMessage({ chatId: -1, text: body, footer: ASSISTANT_RELEASE_LINE,
        replyToMessageId: 7, markup });
      assert.equal(result.data.message_id, 101);
      assert.ok(calls.length > 1);
      assert.ok(calls.at(-1).body.text.endsWith(`\n\n${ASSISTANT_RELEASE_LINE}`));
      assert.ok(calls.slice(0, -1).every(c => !c.body.text.includes(ASSISTANT_RELEASE_LINE)));
      assert.ok(calls.every(c => c.body.text.length <= TELEGRAM_MESSAGE_LIMIT));
      assert.ok(calls.every(c => !/[\uD800-\uDFFF]/u.test(c.body.text)), 'no unpaired surrogate survives splitting');
      const joined = calls.map(c => c.body.text).join('');
      assert.equal(joined, `${body}\n\n${ASSISTANT_RELEASE_LINE}`, 'no content is dropped');
      assert.equal(calls[0].body.reply_to_message_id, 7);
      assert.ok(calls.slice(1).every(c => c.body.reply_to_message_id === undefined));
    }
  }
});

test('a final-part HTML refusal keeps the footer once and reports degradation on the first receipt', async () => {
  const { calls, fetchFn } = recorder([
    { ok: true, result: { message_id: 101 } },
    { ok: false, description: "Bad Request: can't parse entities" },
    { ok: true, result: { message_id: 102 } },
  ]);
  const adapter = createTelegramAdapter({ botToken: 'T', fetchFn });
  const result = await adapter.sendMessage({ chatId: -1, text: 'x'.repeat(4000), markup: true, footer: ASSISTANT_RELEASE_LINE });
  assert.equal(calls.length, 3);
  assert.equal(result.data.message_id, 101);
  assert.equal(result.degraded, 'markup_stripped');
  assert.ok(calls[1].body.text.endsWith(ASSISTANT_RELEASE_LINE));
  assert.ok(calls[2].body.text.endsWith(ASSISTANT_RELEASE_LINE));
  assert.equal('parse_mode' in calls[2].body, false);
  assert.equal(calls[2].body.text.split(ASSISTANT_RELEASE_LINE).length, 2);
});

test('the release line is outside Markdown formatting and HTML-escaped independently', async () => {
  const { calls, fetchFn } = recorder();
  await createTelegramAdapter({ botToken: 'T', fetchFn }).sendMessage({ chatId: -1,
    text: '```js\nconst version = 1;\n```', markup: true, footer: 'Версия <2> & дата' });
  assert.equal(calls[0].body.text, '<pre>const version = 1;</pre>\n\nВерсия &lt;2&gt; &amp; дата');
});

test('failed or ambiguous final parts never trigger a footer-only retry', async () => {
  for (const ambiguous of [false, true]) {
    let calls = 0;
    const adapter = createTelegramAdapter({ botToken: 'T', fetchFn: async () => {
      calls++;
      if (calls === 2 && ambiguous) throw new Error('timeout');
      return { ok: calls === 1, async json() { return calls === 1
        ? { ok: true, result: { message_id: 101 } } : { ok: false, description: 'Forbidden' }; } };
    } });
    const promise = adapter.sendMessage({ chatId: -1, text: 'x'.repeat(9000), markup: true, footer: ASSISTANT_RELEASE_LINE });
    if (ambiguous) await assert.rejects(promise, /timeout/);
    else assert.equal((await promise).partial, true);
    assert.equal(calls, 2);
  }
});

test('invalid footer metadata is refused before any Telegram call', async () => {
  const { calls, fetchFn } = recorder();
  const adapter = createTelegramAdapter({ botToken: 'T', fetchFn });
  for (const footer of ['x'.repeat(257), 'two\nlines', null]) {
    await assert.rejects(adapter.sendMessage({ chatId: -1, text: 'body', footer }), /footer/);
  }
  assert.equal(calls.length, 0);
});
