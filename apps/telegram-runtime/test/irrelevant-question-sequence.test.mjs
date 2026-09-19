import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ASSISTANT_HELP_TEXT,
  ASSISTANT_OUT_OF_COVERAGE_TEXT,
  ASSISTANT_ROUTER_FAILURE_TEXT,
} from '../src/assistant-policy.mjs';
import { ASSISTANT_RELEASE_LINE, assistantReleaseText } from '../src/assistant-release.mjs';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';
import { createProviderAdapter } from '../src/provider-adapter.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import { createTelegramAdapter } from '../src/telegram-adapter.mjs';

// Exercise the actual provider parser, runtime, durable fences and Telegram
// rendering with scripted transport responses. These tests prove plumbing and
// fail-closed behaviour, not the accuracy of a live model's classification.
const WEBSITE_QUESTION = 'Ты можешь сделать сайт /ask';
const WEBHOOK_ORDERS = [['moderator', 'assistant'], ['assistant', 'moderator']];

function routerVerdict({
  threat = false, threatTypes = [], threatEvidence = [],
  abuse = false, abuseTypes = [], abuseEvidence = [],
  target = threat || abuse ? 'assistant' : 'none',
} = {}) {
  return {
    threat: { match: threat, types: threatTypes, confidence: 0.99, evidence: threatEvidence },
    abuse: { match: abuse, types: abuseTypes, confidence: 0.99, evidence: abuseEvidence },
    target, context_used: false,
  };
}

function safety(verdict = routerVerdict()) {
  return { stage: 'safety', content: JSON.stringify(verdict) };
}

function irrelevant() {
  return { stage: 'domain', content: JSON.stringify({ domains: [] }) };
}

function update(updateId, messageId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId, chat: { id: -100 },
      from: { id: 7, first_name: 'Fixture', is_bot: false }, text,
    },
  };
}

function harness(t, scriptedResponses) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-irrelevant-sequence-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const store = createRuntimeStore(db);
  const pending = [...scriptedResponses];
  const calls = { provider: [], telegram: [], knowledge: [], enforcement: [], unexpected: [], network: [] };
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.network.push(args);
    throw new Error('external network forbidden in irrelevant-question-sequence tests');
  });
  t.after(() => {
    db.close();
    rmSync(folder, { recursive: true, force: true });
    assert.deepEqual(calls.network, [], 'all transports must stay fake');
    assert.deepEqual(calls.unexpected, [], 'no hidden provider operation is allowed');
    assert.equal(pending.length, 0, 'every scripted provider result must be consumed exactly once');
  });

  const provider = createProviderAdapter({
    enabled: true, vendor: 'openai', endpoint: 'https://offline.example.test/v1', apiKey: 'fixture-only',
    modelTuples: {
      moderatorSafety: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', maxOutputTokens: 1024 },
      assistantRouter: { model: 'fixture-domain-router', reasoningEffort: 'none', maxOutputTokens: 256 },
      assistantAnswer: { model: 'fixture-answer', reasoningEffort: 'low', maxOutputTokens: 256 },
    },
  }, {
    async fetchFn(url, init) {
      const request = JSON.parse(init.body);
      const stage = request.model === 'fixture-domain-router' ? 'domain'
        : request.model === 'gpt-5.6-terra' ? (request.max_completion_tokens === 768 ? 'severity' : 'safety')
          : 'answer';
      calls.provider.push({ stage, request });
      const next = pending.shift();
      if (url !== 'https://offline.example.test/v1/chat/completions' || !next || next.stage !== stage) {
        calls.unexpected.push({ stage, expected: next?.stage || null, url });
        throw new Error('unexpected scripted provider operation');
      }
      return {
        ok: true, status: 200, headers: { get() { return null; } },
        async json() {
          return {
            model: request.model,
            choices: [{ finish_reason: 'stop', message: { content: next.content } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      };
    },
  });
  const assistantTelegram = createTelegramAdapter({
    botToken: '555444:fixture-only',
    async fetchFn(url, init) {
      const method = url.split('/').at(-1);
      const body = JSON.parse(init.body);
      calls.telegram.push({ method, body });
      return {
        ok: true, status: 200,
        async json() { return { ok: true, result: { message_id: 900 + calls.telegram.length } }; },
      };
    },
  });
  const config = {
    ingressEnabled: false, moderationMode: 'live', moderationAntichannelPin: true,
    assistantModerationWaitMs: 0, assistantModerationPollMs: 1,
    assistantKnowledgeEnabled: true, assistantCooldownSec: 0, assistantDailyPerUser: 100,
    assistantDialogueTurnLimit: 20, assistantDialogueTtlSec: 604800,
    moderator: { chatIds: ['-100'], botToken: '123:fixture-only', botUsername: 'moderator_bot', exemptBotIds: [] },
    assistant: { chatIds: ['-100'], botToken: '555444:fixture-only', botUsername: 'assistant_bot', exemptBotIds: [] },
  };
  const action = (name) => async (input) => {
    calls.enforcement.push({ name, input });
    return { ok: true };
  };
  const createRuntime = () => createTelegramRuntime({
    config, store, provider, assistantTelegram, durableAnswerReceipts: true,
    knowledge: {
      forSource(sourceId) {
        calls.knowledge.push(sourceId);
        return { available: false, reason: 'fixture_source_must_not_be_read' };
      },
    },
    guard: {
      async verifyEnforcement() { return { proven: true, status: 'administrator' }; },
      async senderDisposition() { return { proven: true, exempt: false, reason: null }; },
      banAuthor: action('ban'), deleteMessage: action('delete'),
      unpinMessage: action('unpin'), sendWarning: action('warning'),
    },
    notifier: { async notify() { return { delivered: true }; } },
  });
  let runtime = createRuntime();
  return {
    db, store, calls,
    get runtime() { return runtime; },
    get sends() { return calls.telegram.filter(({ method }) => method === 'sendMessage').map(({ body }) => body); },
    restart() { runtime = createRuntime(); },
    async deliver(messageId, text, order, updateBase = messageId * 10) {
      const results = {};
      for (const [index, role] of order.entries()) {
        results[role] = await runtime.handleUpdate(role, update(updateBase + index, messageId, text));
      }
      return results.assistant;
    },
    disposition(messageId) {
      return db.prepare(`SELECT status, verdict FROM runtime_assistant_moderation_dispositions
        WHERE chat_id = '-100' AND message_id = ?`).get(String(messageId));
    },
  };
}

function assertIrrelevant(h, result, messageId) {
  assert.equal(result.kind, 'answered');
  assert.equal(result.abstained, true);
  assert.equal(result.reason, 'domain_no_signal');
  assert.equal(result.degraded, undefined);
  assert.equal(h.sends.at(-1).text, assistantReleaseText(ASSISTANT_OUT_OF_COVERAGE_TEXT));
  assert.equal(h.sends.at(-1).reply_to_message_id, String(messageId));
  assert.equal(h.sends.at(-1).text.split(ASSISTANT_RELEASE_LINE).length, 2);
  assert.deepEqual(h.disposition(messageId), { status: 'allowed', verdict: 'clean' });
  assert.deepEqual(h.calls.knowledge, [], 'out-of-domain must not resolve or retrieve any knowledge');
  assert.equal(h.calls.provider.some(({ stage }) => stage === 'answer'), false,
    'the approved irrelevant reply must never invoke the answer model');
}

for (const order of WEBHOOK_ORDERS) {
  test(`clean website question between repeated /help retains approved replies in ${order.join(' -> ')} order`, async (t) => {
    const h = harness(t, [safety(), safety(), irrelevant(), safety()]);
    const firstHelp = await h.deliver(10, '/help', order);
    assert.equal(firstHelp.command, 'help');
    assert.equal(h.sends.at(-1).text, assistantReleaseText(ASSISTANT_HELP_TEXT));

    assertIrrelevant(h, await h.deliver(20, WEBSITE_QUESTION, order), 20);
    const repeatedHelp = await h.deliver(30, '/help', order);
    assert.equal(repeatedHelp.command, 'help');
    assert.equal(h.sends.at(-1).text, h.sends[0].text, 'help is unchanged after the irrelevant reply');
    assert.equal(h.sends.length, 3);
    assert.deepEqual(h.calls.provider.map(({ stage }) => stage), ['safety', 'safety', 'domain', 'safety']);
    assert.equal(JSON.parse(h.calls.provider[1].request.messages[1].content).message, WEBSITE_QUESTION,
      'safety classifies the raw native source, including the trailing /ask');
    assert.equal(JSON.parse(h.calls.provider[2].request.messages[1].content).question, 'Ты можешь сделать сайт');
    assert.deepEqual(h.calls.enforcement, [], 'a neutral out-of-domain question is not abuse');
    const dialogue = h.store.recentDialogue('-100', '7', { limit: 20 });
    assert.equal(dialogue.length, 1, 'help must not contaminate conversation memory');
    assert.equal(dialogue[0].answer, ASSISTANT_OUT_OF_COVERAGE_TEXT, 'dialogue stores body only');
  });

  test(`invalid safety cannot become clean; only a new native question may route in ${order.join(' -> ')} order`, async (t) => {
    // The address recipient is not a safety target. This syntactically valid
    // JSON violates the semantic clean/target contract and must stay invalid.
    const h = harness(t, [safety(routerVerdict({ target: 'assistant' })), safety(), irrelevant()]);
    const failed = await h.deliver(40, WEBSITE_QUESTION, order);
    assert.deepEqual({ kind: failed.kind, degraded: failed.degraded, reason: failed.reason }, {
      kind: 'answered', degraded: true, reason: 'judgement_unavailable',
    });
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0].text, assistantReleaseText(ASSISTANT_ROUTER_FAILURE_TEXT));
    assert.deepEqual(h.disposition(40), { status: 'error', verdict: null });
    assert.deepEqual(h.db.prepare('SELECT state, error_code FROM runtime_moderator_judgement_jobs').get(), {
      state: 'manual_review', error_code: 'provider_safety_router_invalid',
    });
    const diagnostic = JSON.parse(h.db.prepare('SELECT result_json FROM runtime_moderator_judgement_jobs').get().result_json).providerDiagnostic;
    assert.equal(diagnostic.stage, 'router');
    assert.equal(diagnostic.finishReason, 'stop');
    assert.equal(diagnostic.refusal, false);
    assert.equal(typeof diagnostic.reason, 'string');
    assert.equal(diagnostic.outputTokens, 5);
    assert.equal(JSON.stringify(diagnostic).includes(WEBSITE_QUESTION), false);
    assert.deepEqual(h.calls.provider.map(({ stage }) => stage), ['safety']);
    assert.equal(h.store.recentDialogue('-100', '7', { limit: 20 }).length, 0,
      'the operational fallback is not a conversation answer');

    await h.deliver(40, WEBSITE_QUESTION, order, 450);
    h.restart();
    await h.deliver(40, WEBSITE_QUESTION, order);
    await h.deliver(40, WEBSITE_QUESTION, [...order].reverse(), 470);
    const recovered = await h.runtime.recoverModeratorJudgements({ limit: 10, startup: true });
    assert.equal(recovered.recovered, 0);
    assert.equal(h.calls.provider.length, 1, 'redelivery and restart cannot retry a rejected safety call');
    assert.equal(h.sends.length, 1, 'the fallback is delivered once for this native message');
    assert.deepEqual(h.disposition(40), { status: 'error', verdict: null }, 'no error-to-clean bypass');

    assertIrrelevant(h, await h.deliver(50, WEBSITE_QUESTION, order), 50);
    assert.equal(h.sends.length, 2);
    assert.deepEqual(h.calls.provider.map(({ stage }) => stage), ['safety', 'safety', 'domain']);
    assert.deepEqual(h.calls.enforcement, []);
    assert.equal(h.store.recentDialogue('-100', '7', { limit: 20 }).length, 1);
    assert.deepEqual(h.disposition(40), { status: 'error', verdict: null },
      'the new successful question must not rewrite the old failed judgement');
  });

  test(`irrelevant native redelivery and restart never repeat provider work or delivery in ${order.join(' -> ')} order`, async (t) => {
    const h = harness(t, [safety(), irrelevant(), safety(), irrelevant()]);
    assertIrrelevant(h, await h.deliver(60, WEBSITE_QUESTION, order), 60);
    await h.deliver(60, WEBSITE_QUESTION, order);
    await h.deliver(60, WEBSITE_QUESTION, [...order].reverse(), 650);
    h.restart();
    await h.deliver(60, WEBSITE_QUESTION, order, 670);
    assert.equal(h.sends.length, 1);
    assert.equal(h.calls.provider.length, 2, 'the same native revision never re-enters either model boundary');

    assertIrrelevant(h, await h.deliver(70, WEBSITE_QUESTION, order), 70);
    assert.equal(h.sends.length, 2, 'identical text in a new native message is a new user question');
    assert.deepEqual(h.calls.provider.map(({ stage }) => stage), ['safety', 'domain', 'safety', 'domain']);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM runtime_judgement_envelopes').get().n, 2);
  });
}

test('an ordinary unrelated question uses the same clean domain-no-signal boundary', async (t) => {
  const h = harness(t, [safety(), irrelevant()]);
  assertIrrelevant(h, await h.deliver(80, '/ask Как приготовить борщ?', WEBHOOK_ORDERS[0]), 80);
  assert.equal(JSON.parse(h.calls.provider[1].request.messages[1].content).question, 'Как приготовить борщ?');
  assert.deepEqual(h.calls.enforcement, []);
});

for (const scenario of [
  {
    name: 'threat', text: '/ask Я тебя уничтожу',
    verdict: routerVerdict({ threat: true, threatTypes: ['interpersonal_threat'], threatEvidence: ['Я тебя уничтожу'] }),
    severity: null, expectedVerdict: 'ban', expectedStages: ['safety'],
  },
  {
    name: 'weak abuse', text: '/ask Ты идиот',
    verdict: routerVerdict({ abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['идиот'] }),
    severity: { severity: 'weak', confidence: 0.99, basis: 'isolated_disrespect' },
    expectedVerdict: 'suspect', expectedStages: ['safety', 'severity'],
  },
  {
    name: 'strong abuse', text: '/ask Ты ничтожество',
    verdict: routerVerdict({ abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['ничтожество'] }),
    severity: { severity: 'strong', confidence: 0.99, basis: 'severe_personal_degradation' },
    expectedVerdict: 'ban', expectedStages: ['safety', 'severity'],
  },
]) {
  test(`valid ${scenario.name} stays blocked instead of taking the irrelevant-question path`, async (t) => {
    const responses = [safety(scenario.verdict)];
    if (scenario.severity) responses.push({ stage: 'severity', content: JSON.stringify(scenario.severity) });
    const h = harness(t, responses);
    const result = await h.deliver(90, scenario.text, WEBHOOK_ORDERS[1]);
    assert.equal(result.kind, 'skipped');
    assert.equal(result.reason, 'moderator_blocked');
    assert.deepEqual(h.disposition(90), { status: 'blocked', verdict: scenario.expectedVerdict });
    assert.deepEqual(h.calls.provider.map(({ stage }) => stage), scenario.expectedStages);
    assert.equal(h.sends.length, 0);
    assert.deepEqual(h.calls.knowledge, []);
    assert.ok(h.calls.enforcement.some(({ name }) => name === 'delete'));
  });
}
