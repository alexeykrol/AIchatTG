import assert from 'node:assert/strict';
import { safetyVerdict } from './safety-fixture.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_DOMAIN_CATALOG as catalog } from '../src/assistant-domains.mjs';
import {
  diagnosticDomainDecision, diagnosticDomainTopics, domainQuestionHints,
  normalizeDomainSelection, selectDomainRoutes,
} from '../src/assistant-domain-routing.mjs';
import { openRuntimeDatabase, createRuntimeStore } from '../src/database.mjs';
import { ProviderUnavailableError } from '../src/provider-adapter.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';

function rig(t, { route = { domains: ['operations'] }, observation = null, mode = 'dispatch', rules = [],
  sourceReason = 'knowledge_identity_missing', routeError = null } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-routing-diagnosis-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const store = createRuntimeStore(db);
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  const calls = { route: 0, analyze: 0, source: 0, answer: 0, send: 0 };
  const bot = { chatIds: ['-100'], botToken: '', botUsername: 'assistant_bot', exemptBotIds: [] };
  const runtime = createTelegramRuntime({
    config: { moderationMode: 'live', assistantModerationWaitMs: 0, assistantModerationPollMs: 1,
      assistantKnowledgeEnabled: true, assistantCooldownSec: 0, moderator: bot, assistant: bot },
    store, domainCatalog: catalog,
    provider: {
      async moderate({ text }) { return safetyVerdict({ message: text, confidence: 0.99 }); },
      async routeAssistant(input) {
        calls.route++;
        if (routeError) throw routeError;
        return typeof route === 'function' ? route(input) : route;
      },
      async answer() {
        calls.answer++;
        return { text: 'ANSWER_PRIVATE_SENTINEL', modelId: 'offline-answer' };
      },
    },
    knowledge: { forSource() { calls.source++; return { available: false, reason: sourceReason }; } },
    ...(observation ? { analyzer: { enabled: true, mode, appliesTo: () => true,
      domainCatalogDigest: catalog.digest, domainPrimacyRules: rules,
      async analyze() { calls.analyze++; return observation; } } } : {}),
    moderatorTelegram: {},
    guard: { async verifyEnforcement() { return { proven: true, status: 'administrator' }; },
      async senderDisposition() { return { proven: true, exempt: false, reason: null }; } },
    assistantTelegram: { async sendMessage() { calls.send++; return { ok: true, data: { message_id: 90 } }; } },
    notifier: { async notify() { return { delivered: true }; } },
  });
  function update(id, messageId, text) {
    return { update_id: id, message: { message_id: messageId, chat: { id: -100 },
      from: { id: 7, first_name: 'Reader', is_bot: false }, text: `/ask ${text}` } };
  }
  return { db, store, calls,
    async ask(text = 'USER_PRIVATE_SENTINEL: explain my question', id = 2) {
      await runtime.handleUpdate('moderator', update(id - 1, id, text));
      return runtime.handleUpdate('assistant', update(id, id, text));
    },
    replay(text, id = 2) { return runtime.handleUpdate('assistant', update(id, id, text)); },
    receipt(id = 2) {
      return JSON.parse(db.prepare('SELECT result_json FROM runtime_inbound_update_receipts WHERE receipt_id = ?').get(`assistant:${id}`).result_json);
    },
  };
}

test('pure route decision retains raw input while reporting the exact-example override', () => {
  const text = 'Кто ты и где найти урок про RAG?';
  const selection = normalizeDomainSelection({ domains: ['content'], riskFlags: ['privacy'] }, catalog);
  const before = structuredClone(selection);
  const hints = domainQuestionHints(text, catalog);
  const result = selectDomainRoutes(selection, { catalog, hints });
  assert.deepEqual(selection, before);
  assert.deepEqual(result.routes.map((route) => route.domainId), hints.domains);
  assert.ok(hints.domains.includes('navigation') && hints.domains.includes('assistant-self'));
  assert.equal(result.arbitration.debt.kind, 'domain_conflict');
  assert.equal(result.arbitration.debt.detectorName, 'registry_exact_example');
  assert.equal(selectDomainRoutes(selection, { catalog }).arbitration, null);
});

test('pure diagnostic decision exposes the applied rule without changing legacy topic projection', () => {
  const verdict = { topics: ['content', 'navigation'], level: { hypothesis: 'L3' } };
  const rules = [{ id: 'prefer-operations', when: { level: ['L3'] }, then: { main_topic: 'operations' } }];
  const decision = diagnosticDomainDecision(verdict, rules, catalog);
  assert.deepEqual(decision, { topics: ['operations', 'navigation'],
    primacy: { ruleId: 'prefer-operations', from: 'content', to: 'operations' } });
  assert.deepEqual(diagnosticDomainTopics(verdict, rules, catalog), decision.topics);
  assert.deepEqual(verdict.topics, ['content', 'navigation']);
  assert.deepEqual(diagnosticDomainDecision(null, rules, catalog), { topics: null, primacy: null });
});

test('analyzer-off receipts persist full compound routing, exclude prose, and replay without new calls', async (t) => {
  const question = 'USER_PRIVATE_SENTINEL: two-part question';
  const r = rig(t, { route: { domains: ['operations', 'content'], riskFlags: ['privacy'],
    reasoning: 'MODEL_PRIVATE_SENTINEL', unexpected: { secret: 'SECRET_SENTINEL' } } });
  const first = await r.ask(question);
  const diagnosis = first.routingDiagnosis;
  assert.equal(diagnosis.origin, 'router');
  assert.equal(diagnosis.selectionStatus, 'valid');
  assert.deepEqual(diagnosis.rawModelChoice.domains, ['operations', 'content']);
  assert.deepEqual(diagnosis.finalDomains, ['operations', 'content']);
  assert.deepEqual(diagnosis.riskFlags, ['privacy']);
  assert.equal(diagnosis.registryDigest, catalog.digest);
  assert.deepEqual(diagnosis.override, { applied: false, debt: null });
  assert.equal(first.reason, 'domain_knowledge_missing');
  assert.equal(r.calls.answer, 0);
  assert.equal(r.calls.analyze, 0);
  assert.deepEqual(r.receipt(), first);
  const event = JSON.parse(r.db.prepare('SELECT result_json FROM runtime_inbound_events WHERE event_id = ?').get('assistant:2').result_json);
  assert.deepEqual(event.routingDiagnosis, diagnosis);
  const serialized = JSON.stringify(diagnosis);
  assert.ok(serialized.length < 4096);
  assert.doesNotMatch(JSON.stringify(r.receipt()), /USER_PRIVATE_SENTINEL|MODEL_PRIVATE_SENTINEL|SECRET_SENTINEL|ANSWER_PRIVATE_SENTINEL/);
  const beforeReplay = { ...r.calls };
  assert.deepEqual(await r.replay(question), first);
  assert.deepEqual(r.calls, beforeReplay);
});

test('receipt records all domains before and after a compound exact-example override', async (t) => {
  const question = 'Кто ты и где найти урок про RAG?';
  const r = rig(t, { route: { domains: ['content'], riskFlags: ['prompt_injection'] } });
  const { routingDiagnosis: diagnosis } = await r.ask(question);
  assert.deepEqual(diagnosis.rawModelChoice.domains, ['content']);
  assert.deepEqual(diagnosis.afterPrimacyDomains, ['content']);
  assert.deepEqual(diagnosis.finalDomains, domainQuestionHints(question, catalog).domains);
  assert.deepEqual(diagnosis.exactExampleDomains, diagnosis.finalDomains);
  assert.equal(diagnosis.override.applied, true);
  assert.equal(diagnosis.override.debt.kind, 'domain_conflict');
  assert.deepEqual(diagnosis.riskFlags, ['prompt_injection']);
  assert.deepEqual(r.receipt().routingDiagnosis, diagnosis);
  assert.doesNotMatch(JSON.stringify(r.receipt()), /ANSWER_PRIVATE_SENTINEL/);
});

test('technical source failure still retains pre-knowledge routing diagnosis', async (t) => {
  const r = rig(t, { sourceReason: 'knowledge_manifest_missing' });
  const result = await r.ask();
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'knowledge_manifest_missing');
  assert.deepEqual(result.routingDiagnosis.finalDomains, ['operations']);
  assert.equal(result.routingDiagnosis.error, 'source_resolution_failed');
  assert.equal(result.routingDiagnosis.registryDigest, catalog.digest);
  assert.deepEqual(r.receipt(), result);
  assert.equal(r.calls.answer, 0);
  assert.equal(r.calls.send, 0);
});

test('analyzer dispatch persists pre-primacy choice and rule while avoiding the router', async (t) => {
  const r = rig(t, {
    observation: { status: 'ok', verdict: { topics: ['content', 'navigation'],
      level: { hypothesis: 'L3', evidence: 'ANALYZER_PRIVATE_SENTINEL' }, riskFlags: ['privacy'] } },
    rules: [{ id: 'prefer-operations', when: { level: ['L3'] }, then: { main_topic: 'operations' } }],
  });
  const { routingDiagnosis: diagnosis } = await r.ask();
  assert.equal(diagnosis.origin, 'analyzer_dispatch');
  assert.deepEqual(diagnosis.rawModelChoice.domains, ['content', 'navigation']);
  assert.deepEqual(diagnosis.finalDomains, ['operations', 'navigation']);
  assert.deepEqual(diagnosis.primacy, { ruleId: 'prefer-operations', from: 'content', to: 'operations' });
  assert.deepEqual(diagnosis.riskFlags, ['privacy']);
  assert.equal(r.calls.route, 0);
  assert.equal(r.calls.analyze, 1);
  assert.doesNotMatch(JSON.stringify(r.receipt()), /ANALYZER_PRIVATE_SENTINEL/);
});

test('analyzer fallback and observe mode retain the effective router origin without copying observer prose into receipts', async (t) => {
  const fallback = rig(t, { observation: { status: 'invalid', raw: 'MODEL_PRIVATE_SENTINEL', error: 'PRIVATE_ERROR_SENTINEL' } });
  const { routingDiagnosis: diagnosis } = await fallback.ask();
  assert.equal(diagnosis.origin, 'router_fallback');
  assert.deepEqual(diagnosis.analyzerAttempt, { status: 'invalid', rawModelChoice: null, primacy: null, error: 'analyzer_invalid' });
  assert.deepEqual(diagnosis.rawModelChoice.domains, ['operations']);
  assert.equal(fallback.calls.route, 1);
  assert.equal(fallback.calls.analyze, 1);
  assert.doesNotMatch(JSON.stringify(fallback.receipt()), /MODEL_PRIVATE_SENTINEL|PRIVATE_ERROR_SENTINEL/);
  const observe = rig(t, { mode: 'observe', observation: { status: 'ok', verdict: { topics: ['content'], riskFlags: [] } } });
  const observed = await observe.ask();
  assert.equal(observed.routingDiagnosis.origin, 'router');
  assert.deepEqual(observed.routingDiagnosis.rawModelChoice.domains, ['operations']);
  assert.equal(observed.routingDiagnosis.analyzerAttempt, null);
});

test('invalid model selections are bounded and distinguish malformed output from an unavailable router', async (t) => {
  const invalid = rig(t, { route: { domains: ['MODEL_PRIVATE_SENTINEL'.repeat(10_000)], riskFlags: ['secret'] } });
  const result = await invalid.ask();
  assert.equal(result.routingDiagnosis.selectionStatus, 'invalid');
  assert.equal(result.routingDiagnosis.rawModelChoice, null);
  assert.deepEqual(result.routingDiagnosis.finalDomains, []);
  assert.equal(result.routingDiagnosis.error, 'selection_invalid');
  assert.ok(JSON.stringify(result.routingDiagnosis).length < 1024);
  assert.doesNotMatch(JSON.stringify(invalid.receipt()), /MODEL_PRIVATE_SENTINEL/);
  const unavailable = rig(t, { routeError: new ProviderUnavailableError('provider_transport_unknown') });
  const failed = await unavailable.ask();
  assert.equal(failed.routingDiagnosis.selectionStatus, 'unavailable');
  assert.equal(failed.routingDiagnosis.error, 'router_unavailable');
  assert.equal(unavailable.calls.source, 0);
});

test('concurrent invocations do not share routing diagnosis state', async (t) => {
  const r = rig(t, { route: async ({ text }) => {
    await Promise.resolve();
    return { domains: [text.includes('FIRST') ? 'operations' : 'content'] };
  } });
  const [first, second] = await Promise.all([r.ask('FIRST_PRIVATE_SENTINEL', 10), r.ask('SECOND_PRIVATE_SENTINEL', 20)]);
  assert.deepEqual(first.routingDiagnosis.finalDomains, ['operations']);
  assert.deepEqual(second.routingDiagnosis.finalDomains, ['content']);
  assert.deepEqual(r.receipt(10).routingDiagnosis, first.routingDiagnosis);
  assert.deepEqual(r.receipt(20).routingDiagnosis, second.routingDiagnosis);
});
