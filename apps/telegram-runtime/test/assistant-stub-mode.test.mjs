import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ASSISTANT_HELP_TEXT,
  ASSISTANT_OUT_OF_COVERAGE_TEXT,
  ASSISTANT_STUB_TEXT,
} from '../src/assistant-policy.mjs';
import { ASSISTANT_RELEASE_LINE, assistantReleaseText } from '../src/assistant-release.mjs';
import { loadRuntimeConfig } from '../src/config.mjs';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';
import { createProviderAdapter } from '../src/provider-adapter.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import { createTelegramAdapter } from '../src/telegram-adapter.mjs';

// Stub mode (PO decision 2026-11-18): every assistant question gets one fixed
// code-owned reply. The real provider parser, runtime and Telegram rendering
// run against scripted transports; only the moderator's safety judgement may
// reach the provider.
const STUB_REPLY = 'Ассистент сейчас обновляется вместе с курсом и временно не отвечает на вопросы.'
  + ' По организационным вопросам пишите на почту курса.';
const ORDER = ['moderator', 'assistant'];

function routerVerdict({ abuse = false, abuseTypes = [], abuseEvidence = [] } = {}) {
  return {
    threat: { match: false, types: [], confidence: 0.99, evidence: [] },
    abuse: { match: abuse, types: abuseTypes, confidence: 0.99, evidence: abuseEvidence },
    target: abuse ? 'assistant' : 'none', context_used: false,
  };
}

const safety = (verdict = routerVerdict()) => ({ stage: 'safety', content: JSON.stringify(verdict) });
const irrelevant = () => ({ stage: 'domain', content: JSON.stringify({ domains: [] }) });

function update(updateId, messageId, text, extra = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId, chat: { id: -100 },
      from: { id: 7, first_name: 'Fixture', is_bot: false }, text, ...extra,
    },
  };
}

function harness(t, scriptedResponses, { stubMode, cooldownSec = 0 }) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-stub-mode-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const store = createRuntimeStore(db);
  const pending = [...scriptedResponses];
  const calls = { provider: [], telegram: [], knowledge: [], retrieval: [], enforcement: [], unexpected: [], network: [] };
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.network.push(args);
    throw new Error('external network forbidden in stub-mode tests');
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
      if (!next || next.stage !== stage) {
        calls.unexpected.push({ stage, expected: next?.stage || null, url });
        throw new Error('unexpected scripted provider operation');
      }
      return {
        ok: true, status: 200, headers: { get() { return null; } },
        async json() {
          return {
            model: request.model,
            choices: [{ finish_reason: 'stop', message: {
              content: next.content,
            } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      };
    },
  });
  const assistantTelegram = createTelegramAdapter({
    botToken: '555444:fixture-only',
    async fetchFn(url, init) {
      calls.telegram.push({ method: url.split('/').at(-1), body: JSON.parse(init.body) });
      return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 900 + calls.telegram.length } }; } };
    },
  });
  const config = {
    ingressEnabled: false, moderationMode: 'live', moderationAntichannelPin: true,
    assistantModerationWaitMs: 0, assistantModerationPollMs: 1,
    assistantKnowledgeEnabled: true, assistantStubMode: stubMode,
    assistantCooldownSec: cooldownSec, assistantDailyPerUser: 100,
    assistantDialogueTurnLimit: 20, assistantDialogueTtlSec: 604800,
    moderator: { chatIds: ['-100'], botToken: '123:fixture-only', botUsername: 'moderator_bot', exemptBotIds: [] },
    assistant: { chatIds: ['-100'], botToken: '555444:fixture-only', botUsername: 'assistant_bot', exemptBotIds: [] },
  };
  const action = (name) => async (input) => { calls.enforcement.push({ name, input }); return { ok: true }; };
  const runtime = createTelegramRuntime({
    config, store, provider, assistantTelegram, durableAnswerReceipts: true,
    knowledge: {
      forSource(sourceId) {
        calls.knowledge.push(sourceId);
        return { available: false, reason: 'fixture_source_must_not_be_read' };
      },
    },
    contentRetrieval: { async retrieve(...args) { calls.retrieval.push(args); return { chunks: [] }; } },
    guard: {
      async verifyEnforcement() { return { proven: true, status: 'administrator' }; },
      async senderDisposition() { return { proven: true, exempt: false, reason: null }; },
      banAuthor: action('ban'), deleteMessage: action('delete'),
      unpinMessage: action('unpin'), sendWarning: action('warning'),
    },
    notifier: { async notify() { return { delivered: true }; } },
  });
  return {
    db, store, calls,
    get sends() { return calls.telegram.filter(({ method }) => method === 'sendMessage').map(({ body }) => body); },
    async deliver(messageId, text, extra = {}, order = ORDER) {
      const results = {};
      for (const [index, role] of order.entries()) {
        results[role] = await runtime.handleUpdate(role, update(messageId * 10 + index, messageId, text, extra));
      }
      return results;
    },
    paidAnswerRows() {
      return db.prepare('SELECT count(*) AS n FROM runtime_assistant_answer_records').get().n;
    },
  };
}

function assertStubSend(h, result, messageId) {
  assert.equal(result.kind, 'answered');
  assert.equal(result.stub, true);
  assert.equal(result.route, 'boundary:assistant_stub');
  const sent = h.sends.at(-1);
  assert.equal(sent.text, `${STUB_REPLY}\n\n${ASSISTANT_RELEASE_LINE}`, 'exact stub text plus footer');
  assert.equal(sent.text, assistantReleaseText(ASSISTANT_STUB_TEXT));
  assert.equal(sent.text.split(ASSISTANT_RELEASE_LINE).length, 2, 'footer appears exactly once');
  assert.equal(sent.reply_to_message_id, String(messageId));
  assert.equal(sent.reply_markup, undefined, 'no forceReply hint or keyboard in stub mode');
}

function assertNoAssistantModelWork(h) {
  assert.deepEqual(h.calls.provider.map(({ stage }) => stage).filter((stage) => stage !== 'safety'), [],
    'stub mode never calls router, analyzer or answer model');
  assert.deepEqual(h.calls.knowledge, [], 'stub mode never reads knowledge');
  assert.deepEqual(h.calls.retrieval, [], 'stub mode never retrieves');
}

test('stub text constant is exactly the Product Owner copy', () => {
  assert.equal(ASSISTANT_STUB_TEXT, STUB_REPLY);
});

test('config flag defaults to false and accepts only true/false', () => {
  const options = { cwd: '/tmp/aichattg-test' };
  assert.equal(loadRuntimeConfig({}, options).assistantStubMode, false);
  assert.equal(loadRuntimeConfig({ TELEGRAM_RUNTIME_ASSISTANT_STUB_MODE: 'true' }, options).assistantStubMode, true);
  assert.equal(loadRuntimeConfig({ TELEGRAM_RUNTIME_ASSISTANT_STUB_MODE: 'false' }, options).assistantStubMode, false);
  assert.throws(() => loadRuntimeConfig({ TELEGRAM_RUNTIME_ASSISTANT_STUB_MODE: 'yes' }, options),
    /TELEGRAM_RUNTIME_ASSISTANT_STUB_MODE must be true or false/);
});

test('stub mode answers /ask, mention, reply, bare /ask and /help with the stub and no model call', async (t) => {
  const h = harness(t, [safety(), safety(), safety(), safety(), safety()], { stubMode: true });
  const asked = await h.deliver(10, '/ask Как подключить базу знаний к агенту?');
  assertStubSend(h, asked.assistant, 10);
  const mentioned = await h.deliver(20, '@assistant_bot что такое RAG?');
  assertStubSend(h, mentioned.assistant, 20);
  const replied = await h.deliver(30, 'А можно подробнее?', {
    reply_to_message: { message_id: 901, from: { id: 555444, is_bot: true, first_name: 'Assistant', username: 'assistant_bot' },
      chat: { id: -100 }, text: 'prior' },
  });
  assertStubSend(h, replied.assistant, 30);
  const bare = await h.deliver(40, '/ask');
  assertStubSend(h, bare.assistant, 40);
  assert.equal(bare.assistant.askPrompt, undefined, 'no 30-second hint job is created');
  const help = await h.deliver(50, '/help');
  assertStubSend(h, help.assistant, 50);

  assert.equal(h.sends.length, 5, 'one message per question, nothing else');
  assert.equal(h.sends.some(({ text }) => text.includes(ASSISTANT_HELP_TEXT)), false);
  assertNoAssistantModelWork(h);
  assert.equal(h.store.recentDialogue('-100', '7', { limit: 20 }).length, 0, 'stub is not dialogue memory');
  assert.equal(h.paidAnswerRows(), 0, 'no answer/usage receipt is recorded');
  assert.deepEqual(h.calls.enforcement, [], 'clean questions are not moderated away');
});

test('stub mode keeps the existing cooldown and sends nothing extra', async (t) => {
  const h = harness(t, [safety(), safety()], { stubMode: true, cooldownSec: 600 });
  const first = await h.deliver(60, '/ask первый вопрос');
  assertStubSend(h, first.assistant, 60);
  const second = await h.deliver(61, '/ask второй вопрос');
  assert.deepEqual({ kind: second.assistant.kind, reason: second.assistant.reason }, { kind: 'skipped', reason: 'cooldown' });
  assert.equal(h.sends.length, 1);
  assertNoAssistantModelWork(h);
});

for (const stubMode of [false, true]) {
  test(`moderator behaviour is unchanged with stub mode ${stubMode ? 'on' : 'off'}`, async (t) => {
    const verdict = routerVerdict({ abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['ничтожество'] });
    const h = harness(t, [safety(verdict), { stage: 'severity', content: JSON.stringify({
      severity: 'strong', confidence: 0.99, basis: 'severe_personal_degradation' }) }], { stubMode });
    const results = await h.deliver(70, '/ask Ты ничтожество', {}, ['assistant', 'moderator']);
    assert.equal(results.assistant.kind, 'skipped');
    assert.equal(results.assistant.reason, 'moderator_blocked');
    assert.equal(h.sends.length, 0, 'a blocked question gets no assistant reply, stub or not');
    assert.deepEqual(h.calls.provider.map(({ stage }) => stage), ['safety', 'severity']);
    assert.ok(h.calls.enforcement.some(({ name }) => name === 'delete'));
    assert.ok(h.calls.enforcement.some(({ name }) => name === 'ban'));
    assert.deepEqual(h.calls.knowledge, []);
  });
}

test('flag off keeps the previous model-routed behaviour', async (t) => {
  const h = harness(t, [safety(), irrelevant()], { stubMode: false });
  const results = await h.deliver(80, '/ask Как приготовить борщ?');
  assert.equal(results.assistant.kind, 'answered');
  assert.equal(results.assistant.stub, undefined);
  assert.equal(results.assistant.abstained, true);
  assert.equal(h.sends.at(-1).text, assistantReleaseText(ASSISTANT_OUT_OF_COVERAGE_TEXT));
  assert.deepEqual(h.calls.provider.map(({ stage }) => stage), ['safety', 'domain'],
    'flag off still routes through the domain model');
});

test('flag off keeps /help as the help text', async (t) => {
  const h = harness(t, [safety()], { stubMode: false });
  const results = await h.deliver(90, '/help');
  assert.equal(results.assistant.command, 'help');
  assert.equal(h.sends.at(-1).text, assistantReleaseText(ASSISTANT_HELP_TEXT));
});
