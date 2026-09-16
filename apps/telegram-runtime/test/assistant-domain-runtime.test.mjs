import assert from 'node:assert/strict';
import { safetyVerdict } from './safety-fixture.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_DOMAIN_CATALOG, loadDomainCatalog } from '../src/assistant-domains.mjs';
import { openRuntimeDatabase, createRuntimeStore } from '../src/database.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import { ProviderUnavailableError } from '../src/provider-adapter.mjs';

// These tests exercise real catalog parsing, runtime orchestration and SQLite
// persistence. Only the model and Telegram transports are replaced with fakes.
// A router fixture asserts plumbing, not live model classification quality.
function update(updateId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: 70, chat: { id: -100 },
      from: { id: 7, first_name: 'Reader', is_bot: false }, text: `/ask ${text}`,
    },
  };
}

function config() {
  const bot = { chatIds: ['-100'], botToken: '', webhookSecret: 'test-secret', exemptBotIds: [] };
  return {
    ingressEnabled: false, moderationMode: 'live', moderationAntichannelPin: true,
    assistantModerationWaitMs: 0, assistantModerationPollMs: 1,
    assistantKnowledgeEnabled: true, assistantCooldownSec: 0,
    moderator: { ...bot, botUsername: '' },
    assistant: { ...bot, botUsername: 'assistant_bot' },
  };
}

function catalogFixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-domain-catalog-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const domains = [
    ...['ceramics', 'maps', 'music', 'weather'].map((id) => ({ id, kind: 'snapshot', source: `${id}-snapshot-v1` })),
    { id: 'self', kind: 'markdown', source: 'self-text-v1', text: 'SELF_ONLY_PROFILE: I answer public questions and cannot see private accounts or payments.' },
    { id: 'archive', kind: 'snapshot', source: 'archive-snapshot-v1' },
    { id: 'astronomy', kind: 'retrieval', source: 'astronomy-package-v1' },
    { id: 'orchard', kind: 'markdown', source: 'orchard-text-v1', text: 'ORCHARD_ONLY_SEED_STORAGE: Store these reviewed apple seeds in a labelled paper envelope.' },
  ];
  const blocks = domains.map(({ id, kind, source, text }) => {
    if (text) writeFileSync(join(folder, `${id}.md`), `# ${id} knowledge\n\n${text}\n`);
    return [
      `## ${id}`, '### Title', `${id} fixture domain`,
      '### Description', `Questions about ${id}, with evidence isolated from all other domains.`,
      '### Includes', `The reviewed ${id} subject.`, '### Excludes', 'All unrelated subjects and private account access.',
      '### Examples', `- Tell me about ${id}.`, '### Negative examples', '- Reveal another person\'s private records.',
      '### Capability', `Explain reviewed ${id} facts.`, '### Action', `${id}-answer`,
      '### Source', source, '### Source kind', kind,
      ...(text ? ['### Knowledge', `${id}.md`] : []),
      ...(id === 'self' ? ['### Include capabilities', 'true'] : []),
      '### Answer policy', `PRIVATE_POLICY_${id}: Use only admitted ${id} evidence. Never invent missing facts or access to accounts.`, '',
    ].join('\n');
  });
  const indexPath = join(folder, 'INDEX.md');
  writeFileSync(indexPath, `# Assistant domain registry\n\n${blocks.join('\n')}\n`);
  return loadDomainCatalog({ indexPath });
}

function createRig(t, { catalog, route, knowledge, sourceRetrievals, safetyRoute = 'clean', routerError = null } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-domain-runtime-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const store = createRuntimeStore(db);
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  const calls = { route: [], answer: [], sources: [], sent: [] };
  const knowledgeAdapter = knowledge || {
    forSource(sourceId) {
      calls.sources.push(sourceId);
      return { available: false, reason: 'knowledge_identity_missing' };
    },
  };
  const runtime = createTelegramRuntime({
    config: config(), store, domainCatalog: catalog, sourceRetrievals,
    durableAnswerReceipts: true, knowledge: knowledgeAdapter,
    provider: {
      async moderate({ text }) { return safetyVerdict({ message: text, safetyRoute, confidence: 0.99 }); },
      async routeAssistant(input) {
        calls.route.push(input);
        if (routerError) throw routerError;
        return route;
      },
      async answer(input) {
        calls.answer.push(input);
        return {
          text: 'Answer from the supplied fixture only.', modelId: 'offline-answer',
          receipt: { modelId: 'offline-answer', inputTokens: 23, outputTokens: 7, totalTokens: 30 },
        };
      },
    },
    moderatorTelegram: {},
    guard: {
      async verifyEnforcement() { return { proven: true, status: 'administrator' }; },
      async senderDisposition() { return { proven: true, exempt: false, reason: null }; },
      async banAuthor() { return { ok: true }; },
      async deleteMessage() { return { ok: true }; },
      async unpinMessage() { return { ok: true }; },
      async sendWarning() { return { ok: true }; },
    },
    assistantTelegram: {
      async sendMessage(input) { calls.sent.push(input); return { ok: true, data: { message_id: 90 } }; },
      async deleteMessage() { return { ok: true }; },
    },
    notifier: { async notify() { return { delivered: true }; } },
  });
  return {
    db, store, calls,
    reservation() {
      return db.prepare('SELECT status FROM runtime_assistant_request_reservations WHERE event_id = ?').get('assistant:2');
    },
    async ask(text) {
      await runtime.handleUpdate('moderator', update(1, text));
      return runtime.handleUpdate('assistant', update(2, text));
    },
  };
}

test('a seventh unrelated Markdown domain answers through the model using only its own source', async (t) => {
  const catalog = catalogFixture(t);
  const rig = createRig(t, { catalog, route: { domainId: 'orchard' } });
  const result = await rig.ask('Как сохранить семена яблони?');
  assert.equal(result.kind, 'answered');
  assert.equal(rig.calls.route.length, 1, 'the domain is selected by the model, not a keyword bypass');
  assert.equal(rig.calls.answer.length, 1);
  const input = rig.calls.answer[0];
  assert.equal(input.route.domainId, 'orchard');
  assert.equal(input.knowledge.sourceId, 'orchard-text-v1');
  assert.ok(input.knowledge.entries.some((entry) => entry.content.includes('ORCHARD_ONLY_SEED_STORAGE')));
  assert.ok(input.knowledge.entries.every((entry) => !entry.content.includes('SELF_ONLY_PROFILE')));
  assert.deepEqual(rig.calls.sources, [], 'Markdown must not read an unrelated admitted course source');
  assert.equal(rig.store.listAssistantAnswers().length, 1);
  const receipt = rig.db.prepare('SELECT input_tokens, output_tokens, total_tokens FROM runtime_assistant_answer_records').get();
  assert.deepEqual(receipt, { input_tokens: 23, output_tokens: 7, total_tokens: 30 });
});

test('a compound self question is routed by the model and answered from self Markdown', async (t) => {
  const catalog = catalogFixture(t);
  const rig = createRig(t, { catalog, route: { domainId: 'self' } });
  const result = await rig.ask('Кто ты, что умеешь и видишь ли мои личные платежи?');
  assert.equal(result.kind, 'answered');
  assert.equal(rig.calls.route.length, 1, 'the old identity regex must not short-circuit registry routing');
  assert.equal(rig.calls.answer.length, 1);
  assert.equal(rig.calls.answer[0].route.domainId, 'self');
  assert.equal(rig.calls.answer[0].knowledge.sourceId, 'self-text-v1');
  assert.ok(rig.calls.answer[0].knowledge.entries.some((entry) => entry.content.includes('SELF_ONLY_PROFILE')));
});

test('partial multi-domain coverage preserves the requested domains and marks missing knowledge', async (t) => {
  const catalog = catalogFixture(t);
  const rig = createRig(t, {
    catalog,
    route: { domains: ['orchard', 'archive'], riskFlags: ['privacy'] },
  });
  const result = await rig.ask('Как хранить семена и что записано в моём архиве?');
  assert.equal(result.kind, 'answered');
  assert.equal(rig.calls.answer.length, 1);
  const input = rig.calls.answer[0];
  assert.deepEqual(input.domainRoutes.map((route) => route.domainId), ['orchard', 'archive']);
  assert.deepEqual(input.missingDomains, ['archive']);
  assert.deepEqual(input.domainCoverage.map(({ domainId, sourceId, status }) => ({ domainId, sourceId, status })), [
    { domainId: 'orchard', sourceId: 'orchard-text-v1', status: 'available' },
    { domainId: 'archive', sourceId: 'archive-snapshot-v1', status: 'missing' },
  ]);
  assert.ok(input.knowledge.entries.length > 0);
  assert.ok(input.knowledge.entries.every((entry) => entry.domainId === 'orchard' && entry.sourceId === 'orchard-text-v1'));
  assert.deepEqual(input.riskFlags, ['privacy']);
});

test('unknown domain and known domain with missing knowledge have distinct safe outcomes', async (t) => {
  const catalog = catalogFixture(t);
  const unknown = createRig(t, { catalog, route: { domainId: 'not-registered' } });
  const missing = createRig(t, { catalog, route: { domainId: 'archive' } });
  const unknownResult = await unknown.ask('Расскажите о неизвестном предмете');
  const missingResult = await missing.ask('Что записано в моём архиве?');
  assert.notEqual(unknownResult.kind, 'uncertain_delivery');
  assert.notEqual(missingResult.kind, 'uncertain_delivery');
  assert.equal(unknown.calls.answer.length, 0);
  assert.equal(missing.calls.answer.length, 0);
  assert.ok(unknownResult.reason);
  assert.ok(missingResult.reason);
  assert.notEqual(unknownResult.reason, missingResult.reason);
  assert.deepEqual(unknown.calls.sources, [], 'an unknown domain must never select a fallback knowledge source');
  assert.deepEqual(missing.calls.sources, ['archive-snapshot-v1']);
});

test('a known domain paired with another source or action cannot unlock knowledge', async (t) => {
  const catalog = catalogFixture(t);
  for (const route of [
    { domainId: 'orchard', action: 'orchard-answer', sourceId: 'self-text-v1' },
    { domainId: 'orchard', action: 'self-answer', sourceId: 'orchard-text-v1' },
  ]) {
    const rig = createRig(t, { catalog, route });
    const result = await rig.ask('Как сохранить семена яблони?');
    assert.equal(rig.calls.answer.length, 0, JSON.stringify(route));
    assert.ok(result.reason);
    assert.notEqual(result.kind, 'uncertain_delivery', 'a rejected route is a definite local outcome, not a crashed turn');
    assert.deepEqual(rig.calls.sources, []);
  }
});

test('snapshot and retrieval domains resolve only their registered source kind', async (t) => {
  const catalog = catalogFixture(t);
  const sourceReads = [];
  const retrievalReads = [];
  const knowledge = {
    forSource(sourceId) {
      sourceReads.push(sourceId);
      return {
        available: true,
        snapshot: { sourceId, entries: [{ id: 'archive-entry', content: 'ARCHIVE_ONLY_REVIEWED_FACT' }] },
      };
    },
  };
  const retrievals = new Map([['astronomy-package-v1', {
    available: true,
    async forQuestion(input) {
      retrievalReads.push(input);
      return {
        grounded: true,
        knowledge: { sourceId: 'astronomy-package-v1', entries: [{ id: 'star-entry', content: 'ASTRONOMY_ONLY_GROUNDED_FACT' }] },
      };
    },
  }]]);
  const snapshotRig = createRig(t, { catalog, route: { domainId: 'archive' }, knowledge, sourceRetrievals: retrievals });
  assert.equal((await snapshotRig.ask('Что записано в архиве?')).kind, 'answered');
  assert.deepEqual(sourceReads, ['archive-snapshot-v1']);
  assert.equal(retrievalReads.length, 0);
  assert.ok(snapshotRig.calls.answer[0].knowledge.entries.some((entry) => entry.content.includes('ARCHIVE_ONLY_REVIEWED_FACT')));
  const retrievalRig = createRig(t, { catalog, route: { domainId: 'astronomy' }, knowledge, sourceRetrievals: retrievals });
  assert.equal((await retrievalRig.ask('Как устроена звезда?')).kind, 'answered');
  assert.deepEqual(sourceReads, ['archive-snapshot-v1'], 'retrieval must never fall back to a whole snapshot');
  assert.equal(retrievalReads.length, 1);
  assert.equal(retrievalReads[0].question, 'Как устроена звезда?');
  assert.ok(retrievalRig.calls.answer[0].knowledge.entries.some((entry) => entry.content.includes('ASTRONOMY_ONLY_GROUNDED_FACT')));
});

test('a mismatched admitted snapshot identity cannot answer for the selected domain', async (t) => {
  const catalog = catalogFixture(t);
  const rig = createRig(t, {
    catalog, route: { domainId: 'archive' },
    knowledge: {
      forSource() {
        return { available: true, snapshot: { sourceId: 'other-private-source', entries: [{ id: 'secret', content: 'MUST_NOT_LEAK' }] } };
      },
    },
  });
  const result = await rig.ask('Что записано в архиве?');
  assert.equal(rig.calls.answer.length, 0);
  assert.ok(result.reason);
  assert.notEqual(result.kind, 'uncertain_delivery');
  assert.ok(rig.calls.sent.every((item) => !item.text.includes('MUST_NOT_LEAK')));
});

test('a moderator denial prevents domain routing, retrieval and answering', async (t) => {
  const catalog = catalogFixture(t);
  const rig = createRig(t, { catalog, route: { domainId: 'orchard' }, safetyRoute: 'threat' });
  const result = await rig.ask('Как сохранить семена яблони?');
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'moderator_blocked');
  assert.equal(rig.calls.route.length, 0);
  assert.equal(rig.calls.answer.length, 0);
  assert.deepEqual(rig.calls.sources, []);
  assert.deepEqual(rig.calls.sent, []);
});

test('an arbitrary retrieval domain without an adapter cannot silently read a snapshot and releases quota', async (t) => {
  const sourceReads = [];
  const rig = createRig(t, {
    catalog: catalogFixture(t), route: { domainId: 'astronomy' }, sourceRetrievals: new Map(),
    knowledge: { forSource(sourceId) {
      sourceReads.push(sourceId);
      return { available: true, snapshot: { sourceId, entries: [{ id: 'whole', content: 'UNAUTHORIZED_WHOLE_SNAPSHOT' }] } };
    } },
  });
  const result = await rig.ask('Как устроена звезда?');
  assert.equal(result.reason, 'domain_retrieval_unavailable');
  assert.equal(result.kind, 'skipped');
  assert.deepEqual(sourceReads, []);
  assert.equal(rig.calls.answer.length, 0);
  assert.equal(rig.reservation(), undefined, 'a missing local adapter is not an ambiguous paid request');
});

test('the explicit built-in retrieval snapshot fallback preserves the admitted legacy content path', async (t) => {
  const reads = [];
  const rig = createRig(t, {
    catalog: DEFAULT_DOMAIN_CATALOG, route: { domains: ['content'] }, sourceRetrievals: new Map(),
    knowledge: { forSource(sourceId) {
      reads.push(sourceId);
      return { available: true, snapshot: { sourceId, entries: [{ id: 'legacy', content: 'ADMITTED_LEGACY_CONTENT' }] } };
    } },
  });
  assert.equal(DEFAULT_DOMAIN_CATALOG.get('content').snapshotFallback, true);
  assert.equal((await rig.ask('Объясни RAG')).kind, 'answered');
  assert.deepEqual(reads, ['course-content-v1']);
  assert.equal(rig.calls.answer[0].knowledge.entries[0].content, 'ADMITTED_LEGACY_CONTENT');
  assert.deepEqual(rig.reservation(), { status: 'completed' });
});

test('content and navigation retrieve once and retain 80 unique entries attributed to both domains', async (t) => {
  const retrievalCalls = [];
  const entries = Array.from({ length: 80 }, (_, i) => ({ id: `lesson-${i}`, content: `REVIEWED_FACT_${i}` }));
  const rig = createRig(t, {
    catalog: DEFAULT_DOMAIN_CATALOG, route: { domains: ['content', 'navigation'] },
    sourceRetrievals: new Map([['course-content-v1', {
      available: true,
      async forQuestion(input) {
        retrievalCalls.push(input);
        return { grounded: true, knowledge: { sourceId: 'course-knowledge-v2', entries } };
      },
    }]]),
  });
  assert.equal((await rig.ask('Объясни RAG и дай ссылку на урок')).kind, 'answered');
  assert.equal(retrievalCalls.length, 1, 'shared source must not duplicate retrieval or paid rewrite work');
  assert.deepEqual(rig.calls.sources, []);
  const answer = rig.calls.answer[0];
  assert.equal(answer.knowledge.entries.length, 80, 'shared evidence must not grow to 160 and exceed the 128-entry bound');
  assert.equal(new Set(answer.knowledge.entries.map((entry) => entry.id)).size, 80);
  assert.ok(answer.knowledge.entries.every((entry) => entry.sourceId === 'course-knowledge-v2'
    && JSON.stringify(entry.domainIds) === JSON.stringify(['content', 'navigation'])));
  assert.deepEqual(answer.domainCoverage.map((entry) => entry.status), ['available', 'available']);
  assert.equal(entries[0].domainIds, undefined, 'resolution must not mutate the admitted source');
  assert.deepEqual(rig.reservation(), { status: 'completed' });
});

test('self capabilities include the appended arbitrary domain but exclude private descriptor fields and its evidence', async (t) => {
  const catalog = catalogFixture(t);
  const rig = createRig(t, { catalog, route: { domainId: 'self' } });
  assert.equal((await rig.ask('Какие темы ты можешь объяснить?')).kind, 'answered');
  const { knowledge } = rig.calls.answer[0];
  const capabilities = knowledge.entries.find((entry) => entry.id === 'registry:public-capabilities');
  assert.ok(capabilities, 'public capabilities must be compiled from the same catalog as domain routing');
  assert.match(capabilities.content, /orchard fixture domain: Explain reviewed orchard facts\./);
  for (const domain of catalog.domains) {
    assert.ok(capabilities.content.includes(`${domain.title}: ${domain.capability}`));
    assert.ok(!capabilities.content.includes(domain.answerPolicy));
    assert.ok(!capabilities.content.includes(domain.sourceId));
    assert.ok(!capabilities.content.includes(domain.description));
  }
  assert.ok(!JSON.stringify(knowledge).includes('PRIVATE_POLICY_'));
  assert.ok(!JSON.stringify(knowledge).includes('ORCHARD_ONLY_SEED_STORAGE'));
  assert.deepEqual(rig.calls.sources, [], 'capability projection is public metadata, not source admission');
});

test('invalid source identity and source bounds are definite local failures that release quota', async (t) => {
  const catalog = catalogFixture(t);
  for (const [label, snapshot] of [
    ['missing snapshot', null],
    ['foreign source', { sourceId: 'private-other-v1', entries: [{ id: 'private', content: 'DO_NOT_DISCLOSE' }] }],
    ['too many entries', { sourceId: 'archive-snapshot-v1', entries: Array.from({ length: 129 }, (_, i) => ({ id: String(i), content: 'REVIEWED_FACT' })) }],
    ['empty entry content', { sourceId: 'archive-snapshot-v1', entries: [{ id: 'empty', content: '   ' }] }],
    ['null entry', { sourceId: 'archive-snapshot-v1', entries: [null] }],
    ['missing entry ID', { sourceId: 'archive-snapshot-v1', entries: [{ content: 'REVIEWED_FACT' }] }],
    ['empty entry ID', { sourceId: 'archive-snapshot-v1', entries: [{ id: '  ', content: 'REVIEWED_FACT' }] }],
    ['duplicate entry IDs', { sourceId: 'archive-snapshot-v1', entries: [{ id: 'same', content: 'FIRST' }, { id: 'same', content: 'SECOND' }] }],
  ]) {
    const rig = createRig(t, { catalog, route: { domainId: 'archive' },
      knowledge: { forSource() { return { available: true, snapshot }; } } });
    const result = await rig.ask('Что записано в архиве?');
    assert.equal(result.reason, 'domain_knowledge_invalid', label);
    assert.equal(result.kind, 'skipped', label);
    assert.equal(rig.calls.answer.length, 0, label);
    assert.equal(rig.reservation(), undefined, label);
  }
});

test('malformed retrieval results and broken admitted sources are not missing-knowledge answers', async (t) => {
  const catalog = catalogFixture(t);
  for (const result of [null, {}, { grounded: 'true' }, { grounded: true, knowledge: null }]) {
    const rig = createRig(t, { catalog, route: { domainId: 'astronomy' },
      sourceRetrievals: new Map([['astronomy-package-v1', { available: true, async forQuestion() { return result; } }]]) });
    assert.equal((await rig.ask('Как устроена звезда?')).reason, 'domain_knowledge_invalid');
    assert.equal(rig.calls.answer.length, 0);
    assert.equal(rig.reservation(), undefined);
  }
  for (const reason of ['knowledge_manifest_missing', 'knowledge_snapshot_empty']) {
    const rig = createRig(t, { catalog, route: { domains: ['archive', 'self'] },
      knowledge: { forSource() { return { available: false, reason }; } } });
    const result = await rig.ask('Что в архиве и кто ты?');
    assert.equal(result.reason, reason);
    assert.equal(result.kind, 'skipped');
    assert.equal(rig.calls.answer.length, 0);
    assert.equal(rig.reservation(), undefined);
  }
});

test('too many distinct combined source entries release quota without calling the answer provider', async (t) => {
  const rig = createRig(t, {
    catalog: catalogFixture(t), route: { domains: ['archive', 'music'] },
    knowledge: { forSource(sourceId) {
      return { available: true, snapshot: { sourceId,
        entries: Array.from({ length: 80 }, (_, i) => ({ id: `entry-${i}`, content: `${sourceId} FACT_${i}` })) } };
    } },
  });
  const result = await rig.ask('Расскажи об архиве и музыке');
  assert.equal(result.reason, 'domain_context_too_large');
  assert.equal(result.kind, 'skipped');
  assert.equal(rig.calls.answer.length, 0);
  assert.equal(rig.reservation(), undefined);
});

test('an ambiguous router transport still retains the reservation as uncertain', async (t) => {
  const rig = createRig(t, { catalog: catalogFixture(t),
    routerError: new ProviderUnavailableError('provider_transport_unknown') });
  const result = await rig.ask('Как хранить семена?');
  assert.equal(result.reason, 'provider_transport_unknown');
  assert.equal(rig.calls.route.length, 1);
  assert.equal(rig.calls.answer.length, 0);
  assert.deepEqual(rig.calls.sources, []);
  assert.deepEqual(rig.reservation(), { status: 'uncertain' }, 'actual provider ambiguity must not be refunded as a local rejection');
});
