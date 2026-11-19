import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSystemPrompt } from '../../../apps/telegram-runtime/src/provider-adapter.mjs';
import { DEFAULT_DOMAIN_CATALOG } from '../../../apps/telegram-runtime/src/assistant-domains.mjs';
import {
  buildProviderStack, fakeAnthropicTransport, parseArgs, priceFor, DEFAULT_MODEL, DEFAULT_EFFORT,
} from '../ask-offline.mjs';
import { createOfflineAssistant, RETRIEVAL_MAX_CONTEXT_TOKENS, RETRIEVAL_MAX_ENTRIES, usedIds } from '../lib/answer-path.mjs';
import { chatResponseFromMessages, createAnthropicChatShim, messagesRequestFromChat } from '../lib/anthropic-shim.mjs';
import { SpendCapReached, createSpendGuard, inputTokenCeiling } from '../lib/spend-guard.mjs';
import { loadQuestions, renderAnswersMarkdown } from '../lib/eval-io.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BUILD = join(REPO, 'output/eval/tcr-book/build.json');
const DONOR = process.env.AICHATTG_EVAL_DONOR || join(homedir(), 'Code/agi2claude');
const haveBook = existsSync(BUILD) && existsSync(join(DONOR, 'evals/baseline/id_map.json'));
const skipBook = haveBook ? false : 'book package or donor missing: run scripts/eval/book_to_master.py';
const database = haveBook ? JSON.parse(readFileSync(BUILD, 'utf8')).database : null;
const PRICE = { input: 2, output: 10 };

test('shim maps the adapter request to the Messages API and back', () => {
  const chat = {
    model: 'claude-sonnet-5-5', max_completion_tokens: 2000, reasoning_effort: 'low',
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: '{"question":"q"}' }],
  };
  assert.deepEqual(messagesRequestFromChat(chat), {
    model: 'claude-sonnet-5-5', max_tokens: 2000, system: 'SYS',
    messages: [{ role: 'user', content: '{"question":"q"}' }], output_config: { effort: 'low' },
  });
  assert.deepEqual(messagesRequestFromChat({ ...chat, reasoning_effort: 'none' }).thinking, { type: 'between_tools' });
  assert.deepEqual(messagesRequestFromChat({ ...chat, reasoning_effort: 'minimal' }).output_config, { effort: 'low' });
  assert.throws(() => messagesRequestFromChat({ ...chat, response_format: { type: 'json_object' } }));
  const back = chatResponseFromMessages({ model: 'm', stop_reason: 'max_tokens',
    content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } });
  assert.equal(back.choices[0].message.content, 'AB');
  assert.equal(back.choices[0].finish_reason, 'length');
  assert.deepEqual(back.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
});

test('shim sends the key only as x-api-key and refuses foreign URLs', async () => {
  const calls = [];
  const shim = createAnthropicChatShim({ apiKey: 'sk-test', fetchFn: fakeAnthropicTransport({ calls }) });
  await assert.rejects(shim('https://example.com/v1/chat/completions', { body: '{}' }), /shim_unexpected_url/);
  await shim('https://api.anthropic.com/v1/chat/completions', { headers: { authorization: 'Bearer placeholder' },
    body: JSON.stringify({ model: 'm', max_completion_tokens: 10, messages: [{ role: 'user', content: '{"question":"q"}' }] }) });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'sk-test');
  assert.equal(calls[0].headers.authorization, undefined);
});

test('spend guard reserves a byte-bound ceiling and stops before the cap', async () => {
  const req = { model: 'm', max_tokens: 1000, system: 'сис', messages: [{ role: 'user', content: 'вопрос' }] };
  assert.equal(inputTokenCeiling(req), Buffer.byteLength('сис') + Buffer.byteLength('вопрос') + 64);
  const ceiling = (inputTokenCeiling(req) * 2 + 1000 * 10) / 1e6;
  let network = 0;
  const transport = async () => { network += 1; return { ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ usage: { input_tokens: 50, output_tokens: 100 }, stop_reason: 'end_turn', model: 'm' }) }; };
  const guard = createSpendGuard({ capUsd: ceiling * 1.9, price: PRICE });
  const f = guard.wrapFetch(transport, { tagOf: () => 'Q' });
  for (let i = 0; i < 2; i += 1) await f('u', { body: JSON.stringify(req) });
  assert.equal(network, 2);
  const actual = (50 * 2 + 100 * 10) / 1e6;
  assert.ok(Math.abs(guard.spentUsd() - 2 * actual) < 1e-12);
  // an unknown-usage failure is charged its full ceiling; after it the next ceiling no longer fits
  const failing = guard.wrapFetch(async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) }));
  await failing('u', { body: JSON.stringify(req) });
  assert.ok(Math.abs(guard.spentUsd() - (2 * actual + ceiling)) < 1e-12);
  await assert.rejects(f('u', { body: JSON.stringify(req) }), SpendCapReached);
  assert.equal(network, 2, 'the refused call never reached the transport');
  assert.ok(guard.stopped());
  await assert.rejects(f('u', { body: JSON.stringify({ ...req, max_tokens: 1 }) }), SpendCapReached, 'stays stopped');
  const events = guard.journal().map((j) => j.event);
  assert.deepEqual(events, ['call', 'call', 'call', 'refused']);
  assert.equal(guard.journal()[2].costKnown, false);
});

test('live mode requires a key env name, a cap and a price', () => {
  assert.throws(() => buildProviderStack({ ...parseArgs(['--mode', 'live', '--cap-usd', '5']) }, { transport: async () => {} }),
    /--key-env/);
  assert.throws(() => priceFor({ ...parseArgs(['--model', 'claude-unknown-9']) }), /--price-input/);
  assert.equal(parseArgs([]).model, DEFAULT_MODEL);
  assert.equal(parseArgs([]).effort, DEFAULT_EFFORT);
});

test('answers markdown matches the stand format', () => {
  const md = renderAnswersMarkdown([{ q: 'Q001', question: 'Вопрос?', answer: 'Ответ.\n\n## Q999 не раздел' }]);
  assert.match(md, /^## Q001\n\n\*\*Вопрос\.\*\* Вопрос\?\n\n\*\*Ответ\.\*\* Ответ\./m);
  assert.doesNotMatch(md, /^## Q999/m);
});

test('answer path: model, production prompt, book records, 6000-token retrieval budget', { skip: skipBook }, async () => {
  const calls = [];
  const args = parseArgs(['--mode', 'mock']);
  const stack = buildProviderStack(args, { transport: fakeAnthropicTransport({ calls }) });
  const assistant = createOfflineAssistant({ databasePath: database, provider: stack.provider });
  try {
    const q = 'А что делает Специалист, если ему мало платят? Уходит в другую сферу?';
    const r = await assistant.ask(q, { userId: 't1' });
    assert.equal(r.status, 'answered');
    assert.equal(calls.length, 1);
    const body = calls[0].body;
    assert.equal(body.model, 'claude-sonnet-5-5');
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.max_tokens, 2000);
    const routing = await assistant.routeQuestion(q, { userId: 't2' });
    assert.equal(body.system, answerSystemPrompt({ route: routing.route, knowledge: routing.knowledge,
      domainRoutes: routing.domainRoutes, domainCoverage: routing.domainCoverage,
      missingDomains: routing.missingDomains, registryDigest: routing.registryDigest }, DEFAULT_DOMAIN_CATALOG));
    const input = JSON.parse(body.messages[0].content);
    assert.equal(input.question, q);
    assert.ok(input.knowledge.entries.length >= 1 && input.knowledge.entries.length <= RETRIEVAL_MAX_ENTRIES);
    const book = new Set(['0955148bf523-01', '0955148bf523-02', '3a91d6694e94-02', '1620c40359b4-01',
      'fab347d86cf7-01', 'e211a2881a1f-01', 'a84ce2b25fcd-02']);
    assert.ok(usedIds(input.knowledge).unitIds.every((u) => /^[0-9a-f]{12}(-\d{2})?$/.test(u)));
    assert.ok(usedIds(input.knowledge).unitIds.some((u) => book.has(u)));
    assert.deepEqual(r.unitIds, usedIds(input.knowledge).unitIds);
    const diag = await assistant.diagnose(q, { userId: 't3' });
    assert.equal(diag.tokenBudget.requested, RETRIEVAL_MAX_CONTEXT_TOKENS);
    assert.equal(RETRIEVAL_MAX_CONTEXT_TOKENS, 6000);
  } finally { assistant.close(); }
});

test('100 questions in mock mode make zero outbound network calls', { skip: skipBook }, async () => {
  const realFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = async () => { outbound += 1; throw new Error('network_forbidden'); };
  const calls = [];
  const stack = buildProviderStack(parseArgs(['--mode', 'mock']), { transport: fakeAnthropicTransport({ calls }) });
  const assistant = createOfflineAssistant({ databasePath: database, provider: stack.provider });
  try {
    const qs = loadQuestions(DONOR);
    assert.equal(qs.length, 100);
    const statuses = {};
    for (const q of qs) {
      const r = await assistant.ask(q.question, { userId: q.q });
      statuses[r.status] = (statuses[r.status] || 0) + 1;
    }
    assert.equal(outbound, 0);
    assert.equal(calls.length, statuses.answered || 0, 'every model call went to the fake transport');
    assert.equal((statuses.answered || 0) + (statuses.abstained || 0), 100);
    assert.equal(stack.guard.journal().filter((j) => j.event === 'call').length, calls.length);
  } finally {
    assistant.close();
    globalThis.fetch = realFetch;
  }
});
