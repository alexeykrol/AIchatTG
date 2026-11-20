import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSystemPrompt } from '../../../apps/telegram-runtime/src/provider-adapter.mjs';
import { DEFAULT_DOMAIN_CATALOG } from '../../../apps/telegram-runtime/src/assistant-domains.mjs';
import { createHash } from 'node:crypto';
import {
  buildProviderStack, fakeAnthropicTransport, parseArgs, priceFor, rewritePriceFor, DEFAULT_MODEL, DEFAULT_EFFORT,
  DEFAULT_REWRITE_EFFORT,
} from '../ask-offline.mjs';
import { REWRITE_SYSTEM_PROMPT } from '../../../apps/telegram-runtime/src/rewriter-adapter.mjs';
import { PUBLISHED_PRICES } from '../lib/spend-guard.mjs';
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

const ADDENDUM = join(REPO, 'scripts/eval/addenda/conflicts.md');

test('lever flags: parsing, rewrite price, retrieval mode refuses them', () => {
  const a = parseArgs(['--mode', 'mock', '--rewrite', 'claude-haiku-5-5', '--prompt-addendum', ADDENDUM]);
  assert.equal(a.rewrite, 'claude-haiku-5-5');
  assert.equal(a.rewriteEffort, DEFAULT_REWRITE_EFFORT);
  assert.equal(a.promptAddendum, ADDENDUM);
  assert.deepEqual({ input: rewritePriceFor(a).input, output: rewritePriceFor(a).output },
    { input: PUBLISHED_PRICES['claude-haiku-5-5'].input, output: PUBLISHED_PRICES['claude-haiku-5-5'].output });
  assert.throws(() => rewritePriceFor(parseArgs(['--mode', 'mock', '--rewrite', 'claude-unknown-9'])), /--rewrite-price-input/);
  assert.equal(rewritePriceFor(parseArgs(['--mode', 'mock', '--rewrite', 'x', '--rewrite-price-input', '1',
    '--rewrite-price-output', '2'])).source, 'command line');
  assert.throws(() => parseArgs(['--rewrite', 'claude-haiku-5-5']), /mock or live/);
  assert.throws(() => parseArgs(['--prompt-addendum', ADDENDUM]), /mock or live/);
  const plain = parseArgs([]);
  assert.equal(plain.rewrite, null);
  assert.equal(plain.promptAddendum, null);
});

test('default stack has no rewriter and no addendum; shim leaves the system prompt alone', async () => {
  const calls = [];
  const stack = buildProviderStack(parseArgs(['--mode', 'mock']), { transport: fakeAnthropicTransport({ calls }) });
  assert.equal(stack.rewriteQuestion, null);
  assert.equal(stack.addendum, null);
  const chat = { model: 'm', max_completion_tokens: 10,
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: '{"question":"q"}' }] };
  const shim = createAnthropicChatShim({ apiKey: 'k', fetchFn: fakeAnthropicTransport({ calls }) });
  await shim('https://api.anthropic.com/v1/chat/completions', { body: JSON.stringify(chat) });
  assert.equal(JSON.stringify(calls.at(-1).body), JSON.stringify(messagesRequestFromChat(chat)));
  assert.throws(() => createAnthropicChatShim({ apiKey: 'k', systemAddendum: '   ' }), /addendum/);
});

test('rewrite goes to its model through the shim and the guard, cost journaled apart', async () => {
  const calls = [];
  const stack = buildProviderStack(parseArgs(['--mode', 'mock', '--rewrite', 'claude-haiku-5-5']),
    { transport: fakeAnthropicTransport({ calls }) });
  stack.setTag('Q1');
  const out = await stack.rewriteQuestion({ question: 'как платят специалисту', conceptMatches: ['Специалист'] });
  assert.equal(out, 'как платят специалисту определение термины');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'eval-shim-holds-the-real-key');
  const body = calls[0].body;
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.system, REWRITE_SYSTEM_PROMPT);
  assert.equal(body.max_tokens, 128);
  assert.deepEqual(body.output_config, { effort: 'low' }, 'production minimal -> Anthropic low');
  assert.match(body.messages[0].content, /Термины, уже найденные в базе: Специалист/);
  const j = stack.guard.journal();
  assert.equal(j.length, 1);
  assert.equal(j[0].kind, 'rewrite');
  assert.equal(j[0].tag, 'Q1');
  const p = PUBLISHED_PRICES['claude-haiku-5-5'];
  assert.ok(Math.abs(j[0].costUsd - (j[0].usage.input_tokens * p.input + j[0].usage.output_tokens * p.output) / 1e6) < 1e-15);
  // the guard refuses a rewrite whose ceiling would cross the cap, before the transport
  const tight = buildProviderStack(parseArgs(['--mode', 'mock', '--rewrite', 'claude-haiku-5-5', '--cap-usd', '0.0000001']),
    { transport: fakeAnthropicTransport({ calls }) });
  await assert.rejects(tight.rewriteQuestion({ question: 'вопрос' }), /spend cap reached/);
  assert.equal(calls.length, 1);
  assert.equal(tight.guard.journal()[0].event, 'refused');
  assert.equal(tight.guard.journal()[0].kind, 'rewrite');
});

test('addendum lands at the end of the answer system prompt; its hash is the file hash', { skip: skipBook }, async () => {
  const calls = [];
  const stack = buildProviderStack(parseArgs(['--mode', 'mock', '--prompt-addendum', ADDENDUM]),
    { transport: fakeAnthropicTransport({ calls }) });
  const text = readFileSync(ADDENDUM, 'utf8').trimEnd();
  assert.equal(stack.addendum.sha256, createHash('sha256').update(readFileSync(ADDENDUM)).digest('hex'));
  const assistant = createOfflineAssistant({ databasePath: database, provider: stack.provider });
  try {
    const q = 'А что делает Специалист, если ему мало платят? Уходит в другую сферу?';
    await assistant.ask(q, { userId: 'a1' });
    const routing = await assistant.routeQuestion(q, { userId: 'a2' });
    const prod = answerSystemPrompt({ route: routing.route, knowledge: routing.knowledge,
      domainRoutes: routing.domainRoutes, domainCoverage: routing.domainCoverage,
      missingDomains: routing.missingDomains, registryDigest: routing.registryDigest }, DEFAULT_DOMAIN_CATALOG);
    assert.equal(calls[0].body.system, `${prod}\n\n${text}`);
    assert.ok(calls[0].body.system.endsWith(text));
  } finally { assistant.close(); }
});

test('mock run with --rewrite: production wiring, no-signal skips, zero network', { skip: skipBook }, async () => {
  const realFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = async () => { outbound += 1; throw new Error('network_forbidden'); };
  const calls = [];
  const stack = buildProviderStack(parseArgs(['--mode', 'mock', '--rewrite', 'claude-haiku-5-5']),
    { transport: fakeAnthropicTransport({ calls }) });
  const assistant = createOfflineAssistant({ databasePath: database, provider: stack.provider,
    rewriteQuestion: stack.rewriteQuestion });
  try {
    let noSignal = 0; let attempted = 0;
    for (const q of loadQuestions(DONOR)) {
      stack.setTag(q.q);
      const r = await assistant.ask(q.question, { userId: q.q });
      if (r.trace?.domain === 'domain_no_signal') {
        noSignal += 1;
        assert.notEqual(r.trace?.rewrite?.attempted, true, `${q.q}: no-signal question must not be rewritten`);
      }
      if (r.trace?.rewrite?.attempted) attempted += 1;
    }
    assert.equal(outbound, 0);
    const rewriteRows = stack.guard.journal().filter((j) => j.kind === 'rewrite');
    assert.equal(rewriteRows.length, attempted);
    assert.ok(attempted > 0, 'at least one question triggered the rewrite');
    assert.ok(noSignal > 0);
    assert.equal(calls.filter((c) => c.body.model === 'claude-haiku-5-5').length, attempted);
  } finally {
    assistant.close();
    globalThis.fetch = realFetch;
  }
});

test('--rewrite-no-signal: boolean flag, valid only with --rewrite', () => {
  const a = parseArgs(['--mode', 'mock', '--rewrite', 'claude-haiku-5-5', '--rewrite-no-signal']);
  assert.equal(a.rewriteNoSignal, true);
  assert.equal(a.rewrite, 'claude-haiku-5-5');
  assert.equal(parseArgs(['--mode', 'mock']).rewriteNoSignal, false);
  assert.throws(() => parseArgs(['--mode', 'mock', '--rewrite-no-signal']), /only together with --rewrite/);
  assert.throws(() => parseArgs(['--mode', 'mock', '--rewrite', 'x', '--rewrite-no-signal=1']), /takes no value/);
  assert.throws(() => createOfflineAssistant({ databasePath: '/nonexistent', rewriteOnNoSignal: true }), /needs a rewriteQuestion/);
});

test('mock run with --rewrite --rewrite-no-signal: no-signal questions may be rewritten, zero network', { skip: skipBook }, async () => {
  const realFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = async () => { outbound += 1; throw new Error('network_forbidden'); };
  const calls = [];
  const args = parseArgs(['--mode', 'mock', '--rewrite', 'claude-haiku-5-5', '--rewrite-no-signal']);
  const stack = buildProviderStack(args, { transport: fakeAnthropicTransport({ calls }) });
  const assistant = createOfflineAssistant({ databasePath: database, provider: stack.provider,
    rewriteQuestion: stack.rewriteQuestion, rewriteOnNoSignal: true });
  try {
    let noSignal = 0; let noSignalAttempted = 0;
    for (const q of loadQuestions(DONOR)) {
      stack.setTag(q.q);
      const r = await assistant.ask(q.question, { userId: q.q });
      if (r.trace?.domain === 'domain_no_signal') {
        noSignal += 1;
        const tagged = stack.guard.journal().filter((j) => j.tag === q.q && j.kind === 'rewrite' && j.event === 'call');
        if (tagged.length > 0) noSignalAttempted += 1;
      }
    }
    assert.equal(outbound, 0);
    assert.ok(noSignal > 0);
    assert.ok(noSignalAttempted > 0, 'at least one no-signal question reached the rewrite');
    const rewriteRows = stack.guard.journal().filter((j) => j.kind === 'rewrite' && j.event === 'call');
    assert.equal(calls.filter((c) => c.body.model === 'claude-haiku-5-5').length, rewriteRows.length);
  } finally {
    assistant.close();
    globalThis.fetch = realFetch;
  }
});

// sha256 over the per-request sha256 lines (URL + headers + body) of the 100-question default mock
// run, against this exact book database. First pinned before the levers were added (2026-11-19:
// 81 requests, 34ed7345…). Re-pinned deliberately on 2026-11-20 for the owner's never-refuse and
// paradox rules: the answer system prompt changed, and the 19 former abstentions now reach the model
// as knowledge gaps (100 requests). The levers themselves still add nothing to the default run.
const PINNED_DB_SHA256 = 'cb57b2ae9ccf2a5960328c770c44428921b98a11121b2c168b511c0eb0976992';
const PINNED_DEFAULT_REQUESTS_SHA256 = '333b81998a5c7197aafa07a17863ca94b89d4ccd0a95a5b2dd2f86cd0547c753';
const sameBook = haveBook && createHash('sha256').update(readFileSync(database)).digest('hex') === PINNED_DB_SHA256;

test('default run (no lever flags) sends byte-identical requests to the pre-lever code', {
  skip: sameBook ? false : 'book database differs from the one the digest was pinned on',
}, async () => {
  const fake = fakeAnthropicTransport();
  const lines = [];
  const transport = async (url, init) => {
    lines.push(createHash('sha256').update(`${url}\n${JSON.stringify(init.headers)}\n${init.body}`).digest('hex'));
    return fake(url, init);
  };
  const stack = buildProviderStack(parseArgs(['--mode', 'mock']), { transport });
  const assistant = createOfflineAssistant({ databasePath: database, provider: stack.provider,
    rewriteQuestion: stack.rewriteQuestion });
  try {
    for (const q of loadQuestions(DONOR)) { stack.setTag(q.q); await assistant.ask(q.question, { userId: `eval-${q.q}` }); }
  } finally { assistant.close(); }
  assert.equal(lines.length, 100);
  assert.equal(createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex'), PINNED_DEFAULT_REQUESTS_SHA256);
});

test('knowledge gaps go to the model with the gap flag; neverRefuse:false restores the abstention', { skip: skipBook }, async () => {
  const calls = [];
  const stack = buildProviderStack(parseArgs(['--mode', 'mock']), { transport: fakeAnthropicTransport({ calls }) });
  const assistant = createOfflineAssistant({ databasePath: database, provider: stack.provider });
  const rollback = createOfflineAssistant({ databasePath: database, provider: stack.provider, neverRefuse: false });
  try {
    let gaps = 0;
    for (const q of loadQuestions(DONOR)) {
      const r = await assistant.ask(q.question, { userId: `g-${q.q}` });
      assert.notEqual(r.status, 'abstained', `${q.q}: never refuse`);
      if (!r.knowledgeGap) { assert.equal(r.gapReason, null); continue; }
      gaps += 1;
      assert.equal(r.status, 'answered');
      assert.equal(r.gapReason, 'in_domain_gap');
      assert.ok(r.gapDetail);
      const body = calls.at(-1).body;
      assert.match(body.system, /knowledgeGap\)/u);
      assert.equal(JSON.parse(body.messages[0].content).knowledgeGap, 'in_domain_gap');
      const old = await rollback.ask(q.question, { userId: `r-${q.q}` });
      assert.equal(old.status, 'abstained');
      assert.equal(old.knowledgeGap, false);
    }
    assert.ok(gaps > 0, 'the stand has at least one former abstention');
  } finally { assistant.close(); rollback.close(); }
});
