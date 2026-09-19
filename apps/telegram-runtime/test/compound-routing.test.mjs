import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_DOMAIN_CATALOG } from '../src/assistant-domains.mjs';
import { createAnalyzerAdapter } from '../src/analyzer-adapter.mjs';
import { runtimeAnalyzerSpec } from '../src/analyzer-spec.mjs';
import { createProviderAdapter } from '../src/provider-adapter.mjs';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';

const QUESTION = 'Кто ты и можешь ли объяснить общие правила обучения?';
const EXPECTED_DOMAINS = ['assistant-self', 'operations'];

function telegramUpdate(updateId) {
  return { update_id: updateId, message: {
    message_id: 70, chat: { id: -100 }, from: { id: 7, first_name: 'Reader', is_bot: false },
    text: `/ask ${QUESTION}`,
  } };
}

// Fixed model outputs test preservation through real routing and provider
// boundaries, not semantic classification or answer quality of a live model.
for (const mode of ['router', 'dispatch']) {
  test(`the exact compound self/operations question retains both domains through the real ${mode} provider boundary`, async (t) => {
    const folder = mkdtempSync(join(tmpdir(), 'aichattg-compound-routing-'));
    const db = openRuntimeDatabase(join(folder, 'runtime.db'));
    t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
    const store = createRuntimeStore(db);
    const requests = [];
    const sent = [];
    const sourceReads = [];
    const catalog = DEFAULT_DOMAIN_CATALOG;
    const provider = createProviderAdapter({
      enabled: true, vendor: 'openai', endpoint: 'https://offline.example.test/v1', apiKey: 'fixture-only',
      modelTuples: {
        moderatorSafety: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', maxOutputTokens: 1024 },
        assistantRouter: { model: 'router-fixture', reasoningEffort: 'none', maxOutputTokens: 120 },
        assistantAnswer: { model: 'answer-fixture', reasoningEffort: 'low', maxOutputTokens: 300 },
      },
    }, {
      domainCatalog: catalog,
      async fetchFn(_url, options) {
        const request = JSON.parse(options.body);
        requests.push(request);
        let output;
        if (request.model === 'gpt-5.6-terra') {
          output = { threat: { match: false, types: [], confidence: 0.99, evidence: [] },
            abuse: { match: false, types: [], confidence: 0.99, evidence: [] },
            target: 'none', context_used: false };
        } else if (request.model === 'router-fixture') {
          output = mode === 'router' ? { domains: EXPECTED_DOMAINS, riskFlags: [] } : {
            topics: EXPECTED_DOMAINS, risk_flags: [], topics_evidence: QUESTION, context_dependent: false,
            level: { hypothesis: 'none', confidence: 'high', evidence: '' },
            intent: { kind: 'explicit', confidence: 'high', evidence: QUESTION, hidden_premise: null },
          };
        } else {
          assert.equal(request.model, 'answer-fixture');
          output = 'Offline answer fixture; model quality is not evaluated.';
        }
        return { ok: true, status: 200, headers: { get() { return null; } },
          async json() { return { model: request.model,
            usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
            choices: [{ finish_reason: 'stop', message: { content: typeof output === 'string' ? output : JSON.stringify(output) } }] }; } };
      },
    });
    const analyzer = createAnalyzerAdapter({ domainCatalog: catalog, provider, spec: runtimeAnalyzerSpec().spec,
      config: { mode: mode === 'dispatch' ? 'dispatch' : 'off', chatIds: ['-100'] } });
    const bot = { chatIds: ['-100'], botToken: '', webhookSecret: 'fixture-only', exemptBotIds: [] };
    const runtime = createTelegramRuntime({
      config: { ingressEnabled: false, moderationMode: 'live', moderationAntichannelPin: true,
        assistantModerationWaitMs: 0, assistantModerationPollMs: 1, assistantKnowledgeEnabled: true,
        assistantCooldownSec: 0, moderator: { ...bot, botUsername: '' }, assistant: { ...bot, botUsername: 'assistant_bot' } },
      domainCatalog: catalog, provider, analyzer, store,
      knowledge: { forSource(sourceId) {
        sourceReads.push(sourceId);
        assert.equal(sourceId, 'course-operations-v1');
        return { available: true, snapshot: { sourceId,
          entries: [{ id: 'general-rules-fixture', content: 'OPERATIONS_FIXTURE: General training procedures are documented in the reviewed instructions.' }] } };
      } },
      moderatorTelegram: {},
      guard: {
        async verifyEnforcement() { return { proven: true, status: 'administrator' }; },
        async senderDisposition() { return { proven: true, exempt: false, reason: null }; },
      },
      assistantTelegram: {
        async sendMessage(input) { sent.push(input); return { ok: true, data: { message_id: 90 } }; },
      },
    });
    await runtime.handleUpdate('moderator', telegramUpdate(1));
    const result = await runtime.handleUpdate('assistant', telegramUpdate(2));
    assert.equal(result.kind, 'answered', JSON.stringify(result));
    assert.notEqual(result.degraded, true, 'the provider must accept the full compound envelope');
    assert.deepEqual(sourceReads, ['course-operations-v1']);
    const answerRequests = requests.filter((request) => request.model === 'answer-fixture');
    assert.equal(answerRequests.length, 1);
    assert.equal(requests.filter((request) => request.model === 'router-fixture').length, 1,
      'dispatch substitutes the analyzer call, rather than adding a second routing call');
    const payload = JSON.parse(answerRequests[0].messages[1].content);
    assert.deepEqual(payload.domainRoutes.map((route) => route.domainId).sort(), EXPECTED_DOMAINS);
    assert.deepEqual(payload.domainCoverage.map((coverage) => coverage.domainId).sort(), EXPECTED_DOMAINS);
    assert.ok(payload.domainCoverage.every((coverage) => coverage.status === 'available'));
    assert.deepEqual(payload.missingDomains, []);
    const selfEntries = payload.knowledge.entries.filter((entry) => entry.domainId === 'assistant-self');
    assert.ok(selfEntries.length > 0, 'self evidence must survive source attribution and provider projection');
    assert.ok(selfEntries.every((entry) => entry.sourceId === 'assistant-self-v1'));
    for (const entry of catalog.markdownKnowledge('assistant-self').entries) {
      assert.ok(selfEntries.some((served) => served.content === entry.content), 'the admitted self Markdown is not replaced with operations evidence');
    }
    assert.ok(payload.knowledge.entries.some((entry) => entry.domainId === 'operations'
      && entry.sourceId === 'course-operations-v1' && entry.content.includes('OPERATIONS_FIXTURE')));
    assert.equal(sent.length, 1);
    const observations = store.listAnalyzerObservations();
    assert.equal(observations.length, mode === 'dispatch' ? 1 : 0);
    if (mode === 'dispatch') assert.deepEqual(observations[0].topics.slice().sort(), EXPECTED_DOMAINS);
  });
}
