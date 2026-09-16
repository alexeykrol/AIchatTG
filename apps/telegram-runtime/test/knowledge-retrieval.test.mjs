import assert from 'node:assert/strict';
import { safetyVerdict } from './safety-fixture.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ASSISTANT_SOURCE_PACKAGES, GROUNDING_REASONS } from '@aichattg/telegram-core';
import { loadRuntimeConfig } from '../src/config.mjs';
import { openRuntimeDatabase, createRuntimeStore } from '../src/database.mjs';
import { createKnowledgeRetrieval } from '../src/knowledge-retrieval.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import { ASSISTANT_OUT_OF_COVERAGE_TEXT } from '../src/assistant-policy.mjs';

/**
 * The whole answer path on hand-built ports: an admitted package, a retriever
 * that returns a pack, and the runtime around them. Nothing here touches SQLite
 * or a provider, so what is under test is the wiring — which question reaches
 * the model, carrying what, and which one is refused before it.
 */

const PACKAGE_SOURCE = ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE;

function admittedKnowledge({ domainId = 'ai', reason = null } = {}) {
  return {
    forSource(sourceId) {
      return sourceId === ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS
        ? {
          available: true,
          snapshot: { sourceId, entries: [{ id: 'ops', content: 'operations fixture' }] },
        }
        : { available: false, reason: 'knowledge_source_unavailable' };
    },
    forPackage(sourceId) {
      if (sourceId !== PACKAGE_SOURCE || reason) {
        return { available: false, reason: reason || 'knowledge_source_invalid', package: null };
      }
      return {
        available: true,
        reason: null,
        package: {
          sourceId, domainId, databasePath: '/fixture/ai.db', packageDigest: 'f'.repeat(64),
        },
      };
    },
  };
}

const LESSON_CHUNK = 'ии-агент это программа которая сама решает задачи в цикле';

/**
 * A retriever port whose dictionary and pack are stated by the test. It stands
 * in for the package so the veto, the projection and the runtime can be proved
 * independently of ranking behaviour, which the gold set measures separately.
 */
function fakeRetriever({
  concepts = ['ии-агент'],
  status = 'ready',
  entries = [{ id: 'lesson:162630:a:001', content: LESSON_CHUNK }],
  citations = {
    'lesson:162630:a:001': {
      unitId: 'lesson:162630',
      title: 'Как устроен ИИ-агент',
      canonicalUrl: 'https://alexeykrol.com/courses/ai_full/lessons/162630/',
    },
  },
  unavailableReason = null,
  onQuestion = null,
} = {}) {
  const asked = [];
  const dictionary = new Map(concepts.map((form) => [form, {
    canonical: form, domainId: 'ai', nUnits: 3, nLinked: 3,
  }]));
  return {
    asked,
    adapter: {
      unavailableReason: () => unavailableReason,
      contractStatus: () => 'enforced',
      dictionary: () => ({
        concepts: dictionary,
        conceptsStem: new Map(),
        maxConceptLen: 2,
      }),
      forQuestion(input) {
        asked.push(input);
        onQuestion?.(input);
        return {
          available: true,
          reason: null,
          pack: {
            schema_version: 'kb_retrieval_pack_v1',
            pack_id: 'p1',
            status,
            confidence: status === 'ready' ? 'high' : 'low',
            package_version: 'pkgv1',
            entries: status === 'not_found' ? [] : entries,
            selected: (status === 'not_found' ? [] : entries).map((entry) => ({
              chunk_id: entry.id, score: 0.9, selection_reason: 'fts',
            })),
            gaps: [],
            citations,
            retrieval_trace: { concept_matches: concepts },
          },
        };
      },
      forQuestionWithRewrite(input) { return Promise.resolve(this.forQuestion(input)); },
      close() {},
    },
  };
}

function retrieval(overrides = {}, { knowledge = admittedKnowledge(), retriever = fakeRetriever() } = {}) {
  return createKnowledgeRetrieval(overrides, {
    knowledge,
    buildRetriever: () => retriever.adapter,
  });
}

test('the domain is taken from the admitted package, never from the model', async () => {
  const retriever = fakeRetriever();
  const layer = retrieval({}, { knowledge: admittedKnowledge({ domainId: 'ai' }), retriever });
  assert.equal(layer.available, true);
  assert.equal(layer.domainId, 'ai');

  const grounded = await layer.forQuestion({ question: 'что такое ии-агент' });
  assert.equal(grounded.grounded, true);
  assert.equal(grounded.domainId, 'ai');
  // The search was asked for exactly the domain the package declares.
  assert.equal(retriever.asked[0].domainId, 'ai');
});

test('a question naming no concept is out of coverage only when the corpus also finds nothing', async () => {
  const retriever = fakeRetriever({ status: 'not_found' });
  const layer = retrieval({}, { retriever });
  const refused = await layer.forQuestion({ question: 'как приготовить борщ' });

  assert.equal(refused.grounded, false);
  assert.equal(refused.reason, 'domain_no_signal');
  assert.equal(refused.domainId, 'out_of_scope');
  // The dictionary's no-signal is a hypothesis, not a verdict: the search runs
  // anyway (free and local) and only its agreeing refusal makes out-of-coverage.
  assert.equal(retriever.asked.length, 1, 'the corpus is consulted before the verdict');
  assert.equal(refused.trace.domain, 'domain_no_signal');
  assert.equal(refused.trace.status, 'not_found');
});

test('a no-signal question the corpus can serve is answered, not refused', async () => {
  // Dictionary blindness, measured on the gold set: an in-domain question can
  // name zero dictionary concepts ("что такое репозиторий") and still retrieve.
  const retriever = fakeRetriever();
  const layer = retrieval({}, { retriever });
  const served = await layer.forQuestion({ question: 'как приготовить борщ' });

  assert.equal(served.grounded, true);
  assert.equal(served.domainId, 'ai');
  assert.equal(served.trace.domain, 'domain_no_signal');
});

test('an empty dictionary is a deployment defect, not an out-of-domain verdict', async () => {
  const retriever = fakeRetriever({ concepts: [] });
  const layer = retrieval({}, { retriever });
  const refused = await layer.forQuestion({ question: 'что такое ии-агент' });

  assert.equal(refused.grounded, false);
  assert.equal(refused.reason, 'domain_evidence_unavailable');
  assert.equal(retriever.asked.length, 0);
});

test('a no-signal confirmation pass stays local: the paid rewrite step is never invoked', async () => {
  const retriever = fakeRetriever({ status: 'not_found' });
  let rewriteCalls = 0;
  const adapter = {
    ...retriever.adapter,
    forQuestionWithRewrite(input) { rewriteCalls += 1; return retriever.adapter.forQuestionWithRewrite(input); },
  };
  const layer = createKnowledgeRetrieval({ rewriteEnabled: true }, {
    knowledge: admittedKnowledge(),
    buildRetriever: () => adapter,
  });
  const refused = await layer.forQuestion({ question: 'как приготовить борщ' });
  assert.equal(refused.reason, 'domain_no_signal');
  assert.equal(rewriteCalls, 0, 'no money is spent before a positive domain signal');
  // A question with a signal keeps the rewrite-enabled path.
  await layer.forQuestion({ question: 'что такое ии-агент' });
  assert.equal(rewriteCalls, 1);
});

test('a not_found pack is reported as an abstention, not as a failure', async () => {
  const retriever = fakeRetriever({ status: 'not_found' });
  const layer = retrieval({}, { retriever });
  const answer = await layer.forQuestion({ question: 'что такое ии-агент' });

  assert.equal(answer.grounded, false);
  assert.equal(answer.reason, GROUNDING_REASONS.NOT_FOUND);
  assert.equal(answer.trace.grounding.status, 'not_found');
});

test('an unadmitted package leaves the layer unavailable with its admission reason', async () => {
  const layer = retrieval({}, { knowledge: admittedKnowledge({ reason: 'knowledge_identity_mismatch' }) });
  assert.equal(layer.available, false);
  assert.equal(layer.reason, 'knowledge_identity_mismatch');
  assert.equal((await layer.forQuestion({ question: 'что такое ии-агент' })).reason, 'knowledge_identity_mismatch');
});

test('an admitted package whose database will not open reports the retriever reason', async () => {
  const retriever = fakeRetriever({ unavailableReason: 'retriever_package_unreadable' });
  const layer = retrieval({}, { retriever });
  assert.equal(layer.available, false);
  assert.equal(layer.reason, 'retriever_package_unreadable');
});

test('one retrieval session per user per chat keeps two students apart', async () => {
  const retriever = fakeRetriever();
  const layer = retrieval({}, { retriever });
  await layer.forQuestion({ question: 'что такое ии-агент', sessionId: '-100:7' });
  await layer.forQuestion({ question: 'что такое ии-агент', sessionId: '-100:8' });
  assert.deepEqual(retriever.asked.map((input) => input.sessionId), ['-100:7', '-100:8']);
});

// --- The runtime around it ---------------------------------------------------

function config(overrides = {}) {
  return {
    ingressEnabled: false,
    moderationMode: 'live',
    moderationAntichannelPin: true,
    assistantModerationWaitMs: 0,
    assistantModerationPollMs: 1,
    assistantKnowledgeEnabled: true,
    moderator: { chatIds: ['-100'], botToken: '', botUsername: '', webhookSecret: 'm', exemptBotIds: [] },
    assistant: { chatIds: ['-100'], botToken: '', botUsername: 'assistant_bot', webhookSecret: 'a', exemptBotIds: [] },
    ...overrides,
  };
}

function update(updateId, messageId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId, chat: { id: -100 },
      from: { id: 7, first_name: 'Student', is_bot: false }, text,
    },
  };
}

function adapters(actions) {
  const moderatorTelegram = {
    async getChatMember() { return { ok: true, data: { status: 'administrator', can_delete_messages: true, can_restrict_members: true } }; },
    async banMember(input) { actions.push(['ban', input]); return { ok: true }; },
    async banSenderChat(input) { actions.push(['ban_sender_chat', input]); return { ok: true }; },
    async deleteMessage(input) { actions.push(['delete', input]); return { ok: true }; },
    async unpinMessage(input) { actions.push(['unpin', input]); return { ok: true }; },
    async sendMessage(input) { actions.push(['warn', input]); return { ok: true }; },
  };
  return {
    moderatorTelegram,
    guard: {
      async verifyEnforcement() { return { proven: true, status: 'administrator' }; },
      async senderDisposition() { return { proven: true, exempt: false, reason: null }; },
      deleteMessage: (input) => moderatorTelegram.deleteMessage(input),
      unpinMessage: (input) => moderatorTelegram.unpinMessage(input),
      sendWarning: (input) => moderatorTelegram.sendMessage(input),
      banAuthor: (input) => moderatorTelegram.banMember(input),
    },
    assistantTelegram: {
      async sendMessage(input) { actions.push(['send', input]); return { ok: true, data: { message_id: 90 } }; },
    },
    notifier: { async notify() { return { delivered: true }; } },
  };
}

function provider({ onAnswer = null, sourceId = 'course-content-v1', action = 'teach' } = {}) {
  return {
    async moderate({ text }) { return safetyVerdict({ message: text }); },
    async routeAssistant({ domainHints }) {
      return domainHints?.domains.includes('operations')
        ? { action: 'support', sourceId: 'course-operations-v1' }
        : { action, sourceId };
    },
    async answer(input) { onAnswer?.(input); return { text: 'grounded answer', modelId: 'fake' }; },
  };
}

async function runOnce({ question, contentRetrieval, onAnswer, messageId = 300, providerRoute = {} }) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-retrieval-runtime-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  const answers = [];
  const runtime = createTelegramRuntime({
    config: config(),
    store: createRuntimeStore(db),
    provider: provider({ ...providerRoute, onAnswer: (input) => { answers.push(input); onAnswer?.(input); } }),
    knowledge: admittedKnowledge(),
    contentRetrieval,
    ...adapters(actions),
  });
  try {
    await runtime.handleUpdate('moderator', update(messageId, messageId, question));
    const result = await runtime.handleUpdate('assistant', update(messageId + 1, messageId, question));
    const reservation = db.prepare(
      'SELECT status FROM runtime_assistant_request_reservations WHERE event_id = ?',
    ).get(`assistant:${messageId + 1}`) || null;
    const deficits = db.prepare(
      'SELECT question, reason, candidate_level FROM runtime_assistant_coverage_deficits ORDER BY created_at',
    ).all();
    return { result, actions, answers, reservation, deficits };
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
}

test('a course question reaches the model with retrieved entries carrying title and link', async () => {
  const layer = retrieval({}, { retriever: fakeRetriever() });
  const { result, answers, actions } = await runOnce({
    question: '/ask что такое ии-агент',
    contentRetrieval: layer,
  });

  assert.equal(result.kind, 'answered');
  assert.equal(answers.length, 1);
  const knowledge = answers[0].knowledge;
  assert.equal(knowledge.sourceId, PACKAGE_SOURCE);
  assert.equal(knowledge.entries.length, 1);
  assert.deepEqual(knowledge.entries[0], {
    id: 'lesson:162630:a:001',
    content: LESSON_CHUNK,
    title: 'Как устроен ИИ-агент',
    canonicalUrl: 'https://alexeykrol.com/courses/ai_full/lessons/162630/',
  });
  assert.equal(actions.at(-1)[0], 'send');
});

test('a router-unknown question delivers the exact approved copy and journals it without retrieval', async () => {
  // Scope is the router's verdict; empty retrieval is not an unknown domain.
  const retriever = fakeRetriever({ status: 'not_found' });
  const layer = retrieval({}, { retriever });
  const { result, answers, actions, reservation, deficits } = await runOnce({
    question: '/ask посоветуй рецепт борща',
    contentRetrieval: layer,
    messageId: 320,
    providerRoute: { action: 'redirect', sourceId: null },
  });

  assert.equal(result.kind, 'answered');
  assert.equal(result.abstained, true);
  assert.equal(result.reason, 'domain_no_signal');
  assert.equal(answers.length, 0, 'an ungrounded question costs no answer call');
  // Check the actual Telegram port, not just the standalone policy constant:
  // domainBoundaryReply must not shadow the owner's exact three paragraphs.
  assert.equal(actions.at(-1)[0], 'send');
  assert.equal(actions.at(-1)[1].text, ASSISTANT_OUT_OF_COVERAGE_TEXT);
  assert.equal(actions.at(-1)[1].text.split('\n\n').length, 3);
  assert.deepEqual(actions.map(([kind]) => kind), ['send'], 'boundary copy adds no moderation action');
  assert.equal(retriever.asked.length, 0);
  assert.match(result.route, /^boundary:out_of_coverage:/);
  // A delivered answer is what the quota pays for, so the reservation completes.
  assert.equal(reservation.status, 'completed');
  // Every out-of-coverage answer is also a deficit signal for the lab.
  assert.equal(deficits.length, 1);
  assert.equal(deficits[0].question, 'посоветуй рецепт борща');
  assert.equal(deficits[0].reason, 'domain_no_signal');
  assert.equal(deficits[0].candidate_level, null);
});

test('an out-of-coverage business question is journaled with the L2 candidate label', async () => {
  const layer = retrieval({}, { retriever: fakeRetriever({ status: 'not_found' }) });
  const { result, deficits } = await runOnce({
    question: '/ask как поднять продажи в моем салоне',
    contentRetrieval: layer,
    messageId: 330,
    providerRoute: { action: 'redirect', sourceId: null },
  });

  assert.equal(result.abstained, true);
  assert.equal(deficits.length, 1);
  // The label is a queue marker for the lab, never a routing decision.
  assert.equal(deficits[0].candidate_level, 'L2');
});

test('a question the corpus cannot ground is abstained rather than answered from nothing', async () => {
  const layer = retrieval({}, { retriever: fakeRetriever({ status: 'not_found' }) });
  const { result, answers, actions, deficits } = await runOnce({
    question: '/ask что такое ии-агент',
    contentRetrieval: layer,
    messageId: 340,
  });

  assert.equal(result.abstained, true);
  assert.equal(result.reason, 'domain_knowledge_missing');
  assert.equal(answers.length, 0);
  // A known-domain gap is distinguished from an unknown domain and journaled
  // with its own reason; it never becomes an ungrounded model answer.
  assert.match(actions.at(-1)[1].text, /Вопрос относится к моей области/);
  assert.match(actions.at(-1)[1].text, /нет достаточных сведений/);
  assert.match(actions.at(-1)[1].text, /не буду заменять.*догадкой/);
  assert.equal(result.route, 'boundary:domain_knowledge_missing');
  assert.equal(deficits.length, 1);
  assert.equal(deficits[0].reason, 'domain_knowledge_missing');
});

test('an operations question keeps the v1 snapshot path and never touches the retriever', async () => {
  const retriever = fakeRetriever();
  const layer = retrieval({}, { retriever });
  const { result, answers } = await runOnce({
    question: '/ask В курсе какая цена?',
    contentRetrieval: layer,
    messageId: 360,
  });

  assert.equal(result.kind, 'answered');
  assert.deepEqual(result.route, { action: 'support', sourceId: 'course-operations-v1' });
  assert.equal(answers[0].knowledge.sourceId, 'course-operations-v1');
  assert.equal(retriever.asked.length, 0, 'the operations snapshot is not a retrieval domain');
});

test('an unavailable retrieval layer is a routing exit that releases the quota', async () => {
  const layer = retrieval({}, { knowledge: admittedKnowledge({ reason: 'knowledge_package_invalid' }) });
  const { result, answers, actions, reservation } = await runOnce({
    question: '/ask что такое ии-агент',
    contentRetrieval: layer,
    messageId: 380,
  });

  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'knowledge_package_invalid');
  assert.equal(answers.length, 0);
  assert.equal(actions.length, 0);
  assert.equal(reservation, null, 'a local refusal before the model returns the quota');
});

/**
 * Billing contract. Every reason this layer can surface to the runtime is either
 * classified as a definitive routing exit (quota returned) or handled as an
 * abstention (a delivered answer). A code that is neither would silently strand
 * a user's request in the uncertain state meant for possibly-paid calls.
 */
test('every reason this layer emits is either definitive or an abstention', async () => {
  const { readFileSync } = await import('node:fs');
  const { isAbstentionReason } = await import('../src/assistant-policy.mjs');
  const { DOMAIN_ROUTE_REASONS } = await import('@aichattg/telegram-core');
  const runtimeSource = readFileSync(new URL('../src/runtime.mjs', import.meta.url), 'utf8');
  const classifier = runtimeSource.slice(
    runtimeSource.indexOf('function isDefinitiveAssistantRoutingExit'),
    runtimeSource.indexOf('function applyTelegramSafetySignals'));

  const surfaced = [
    ...Object.values(DOMAIN_ROUTE_REASONS).filter((reason) => reason !== 'domain_accepted'),
    ...Object.values(GROUNDING_REASONS),
    'retriever_pack_missing',
  ];
  for (const reason of surfaced) {
    const definitive = classifier.includes(`'${reason}'`)
      // The domain reasons are classified as a set by isDefinitiveDomainRouteReason.
      || (reason.startsWith('domain_') && classifier.includes('isDefinitiveDomainRouteReason'))
      || classifier.includes(`GROUNDING_REASONS.${reason.replace('grounding_', '').toUpperCase()}`);
    assert.ok(definitive || isAbstentionReason(reason),
      `${reason} must be classified as a definitive exit or handled as an abstention`);
  }
});

test('retrieval configuration is opt-in and bounded by the provider entry ceiling', () => {
  const loaded = loadRuntimeConfig({}, { cwd: '/tmp/aichattg-test' });
  assert.equal(loaded.assistantRetrieval.enabled, false);
  assert.equal(loaded.assistantRetrieval.rewriteEnabled, false);
  assert.equal(loaded.assistantRetrieval.validatePacks, true);
  assert.equal(loaded.assistantRetrieval.maxEntries, 12);
  assert.equal(loaded.assistantRetrieval.maxContextTokens, 6_000);

  const enabled = loadRuntimeConfig({
    TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_ENABLED: 'true',
    TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_REWRITE_ENABLED: 'true',
    TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_VALIDATE_PACKS: 'false',
    TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_MAX_ENTRIES: '128',
  }, { cwd: '/tmp/aichattg-test' });
  assert.equal(enabled.assistantRetrieval.enabled, true);
  assert.equal(enabled.assistantRetrieval.rewriteEnabled, true);
  assert.equal(enabled.assistantRetrieval.validatePacks, false);
  assert.equal(enabled.assistantRetrieval.maxEntries, 128);

  // 128 is the provider's hard ceiling; configuration may not exceed it.
  assert.throws(() => loadRuntimeConfig({
    TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_MAX_ENTRIES: '129',
  }, { cwd: '/tmp/aichattg-test' }), /MAX_ENTRIES/);
});
