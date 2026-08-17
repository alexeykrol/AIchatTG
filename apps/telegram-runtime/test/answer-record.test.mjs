/**
 * Долговечная запись ответа: вторая половина приёмочного контура.
 *
 * Зачем она вообще: судить сегодня можно только маршрут, потому что текст
 * ответа живёт лишь в ОГРАНИЧЕННОЙ памяти диалога (последние N ходов + TTL) и
 * стирается разговором раньше, чем до него доходит судья. Замер, который
 * стирается тем, что он меряет, — не замер.
 *
 * Два контракта держит этот файл, и оба — про то, чего запись НЕ делает:
 *   1. она не выходит за пер-чатный гейт анализатора (в боевом чате не
 *      меняется ни поведение, ни объём записи);
 *   2. она не может стоить человеку ответа — падение сенсора остаётся в логе,
 *      а не в молчании бота.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ANALYZER_MODES, createAnalyzerAdapter } from '../src/analyzer-adapter.mjs';
import { loadAnalyzerSpec } from '../src/analyzer-spec.mjs';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';

const SPEC = loadAnalyzerSpec(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'analyzer-spec.json'));

const VERDICT = JSON.stringify({
  topics: ['content'],
  topics_evidence: 'что такое агент',
  context_dependent: false,
  level: { hypothesis: 'L1', confidence: 'medium', evidence: 'что такое агент' },
  intent: { kind: 'explicit', confidence: 'high', evidence: '', hidden_premise: null },
});

function config(overrides = {}) {
  return {
    ingressEnabled: false,
    moderationMode: 'live',
    moderationAntichannelPin: true,
    assistantModerationWaitMs: 0,
    assistantModerationPollMs: 1,
    assistantKnowledgeEnabled: true,
    assistantDialogueTurnLimit: 3,
    assistantDialogueTtlSec: 604_800,
    moderator: { chatIds: ['-100'], botToken: '', botUsername: '', webhookSecret: 'moderator-secret', exemptBotIds: [] },
    assistant: { chatIds: ['-100'], botToken: '', botUsername: 'assistant_bot', webhookSecret: 'assistant-secret', exemptBotIds: [] },
    ...overrides,
  };
}

function update(updateId, messageId, text) {
  return {
    update_id: updateId,
    message: { message_id: messageId, chat: { id: -100 }, from: { id: 7, first_name: 'Student', is_bot: false }, text },
  };
}

/** Знание с опознаваемыми идентификаторами: их и обязана сохранить запись. */
function availableKnowledge() {
  return {
    forSource(sourceId) {
      return ['course-content-v1', 'course-operations-v1', 'course-value-v1'].includes(sourceId)
        ? {
          available: true,
          snapshot: {
            sourceId,
            entries: [
              { id: 'lesson:158747:netlify:001', content: 'первый кусок' },
              { id: 'lesson:158747:netlify:002', content: 'второй кусок того же урока' },
              { id: 'lesson:148015:agents:001', content: 'кусок другого урока' },
            ],
          },
        }
        : { available: false, reason: 'knowledge_source_unavailable' };
    },
  };
}

function adapters(actions) {
  return {
    moderatorTelegram: {
      async getChatMember() { return { ok: true, data: { status: 'administrator', can_delete_messages: true, can_restrict_members: true } }; },
      async banMember() { return { ok: true }; },
      async banSenderChat() { return { ok: true }; },
      async deleteMessage() { return { ok: true }; },
      async unpinMessage() { return { ok: true }; },
      async sendMessage() { return { ok: true }; },
    },
    guard: {
      async verifyEnforcement() { return { proven: true, status: 'administrator' }; },
      async senderDisposition() { return { proven: true, exempt: false, reason: null }; },
    },
    assistantTelegram: {
      async sendMessage(input) { actions.push(['send', input]); return { ok: true, data: { message_id: 90 } }; },
    },
    notifier: { async notify() { return { ok: true }; } },
  };
}

function fakeProvider({ route = { action: 'teach', sourceId: 'course-content-v1' } } = {}) {
  return {
    async moderate() { return { safetyRoute: 'clean', abuseLevel: null, confidence: 0.98, reason: 'fixture', modelId: 'fake' }; },
    async routeAssistant() { return route; },
    async answer(input) { return { text: `ответ на «${input.text}» (${input.route.action})`, modelId: 'answer-fake' }; },
  };
}

function stubAnalyzer({ chatIds = ['-100'], mode = ANALYZER_MODES.OBSERVE } = {}) {
  return createAnalyzerAdapter({
    config: { mode, chatIds },
    provider: { async analyze() { return { text: VERDICT, modelId: 'analyzer-fake' }; } },
    spec: SPEC.spec,
    digest: SPEC.digest,
  });
}

async function runQuestion(runtime, text, { updateId = 40, messageId = 70 } = {}) {
  await runtime.handleUpdate('moderator', update(updateId, messageId, text));
  return runtime.handleUpdate('assistant', update(updateId + 1, messageId, text));
}

function withRuntime(name, body) {
  test(name, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'aichattg-answers-'));
    const db = openRuntimeDatabase(join(folder, 'runtime.db'));
    try { await body({ db, store: createRuntimeStore(db), folder }); } finally {
      db.close(); rmSync(folder, { recursive: true, force: true });
    }
  });
}

// ── Что записывается ────────────────────────────────────────────────────────

withRuntime('an answered turn is stored with its question, route and served knowledge', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(),
    analyzer: stubAnalyzer(), ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.equal(result.kind, 'answered');

  const [row] = store.listAssistantAnswers();
  assert.equal(row.question, 'В курсе что такое агент?');
  assert.equal(row.answer, actions.at(-1)[1].text, 'в записи стоит ровно доставленный текст');
  assert.equal(row.chatId, '-100');
  assert.equal(row.userId, '7');
  assert.deepEqual(row.route, { action: 'teach', sourceId: 'course-content-v1' });
  assert.equal(row.knowledgeSourceId, 'course-content-v1');
  assert.deepEqual(row.servedUnitIds, [
    'lesson:158747:netlify:001', 'lesson:158747:netlify:002', 'lesson:148015:agents:001',
  ]);
  assert.equal(row.modelId, 'answer-fake');
  assert.equal(row.delivery, 'ok');
  // Одна строка на ход в каждой таблице: журнал вердикта и запись ответа
  // сшиваются по event_id, а не по времени.
  const [observation] = store.listAnalyzerObservations();
  assert.equal(observation.eventId, row.eventId);
});

// Воздержание — настоящий ответ на настоящий вопрос, и именно на нём чаще
// всего ломается форма. Не записывать его значило бы прятать от судьи худший
// класс ходов.
withRuntime('an abstention is recorded too, with its string route and no units', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store, knowledge: availableKnowledge(),
    provider: fakeProvider({ route: { action: 'redirect', sourceId: null } }),
    analyzer: stubAnalyzer(), ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask расскажите про Sora от OpenAI');
  assert.equal(result.abstained, true);

  const [row] = store.listAssistantAnswers();
  assert.equal(row.answer, actions.at(-1)[1].text);
  assert.match(row.route.action, /^boundary:/);
  assert.equal(row.route.sourceId, null);
  assert.equal(row.knowledgeSourceId, null);
  assert.deepEqual(row.servedUnitIds, []);
});

// Главное свойство: запись переживает ту память, вместо которой заведена.
withRuntime('the record outlives the bounded dialogue memory it replaces', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config({ assistantDialogueTurnLimit: 1 }), store, provider: fakeProvider(),
    knowledge: availableKnowledge(), analyzer: stubAnalyzer(), ...adapters(actions),
  });
  await runQuestion(runtime, '/ask первый вопрос', { updateId: 10, messageId: 70 });
  await runQuestion(runtime, '/ask второй вопрос', { updateId: 20, messageId: 71 });
  await runQuestion(runtime, '/ask третий вопрос', { updateId: 30, messageId: 72 });

  const remembered = store.recentDialogue('-100', '7', { limit: 10 });
  assert.equal(remembered.length, 1, 'память диалога обрезана — так и задумано');
  const records = store.listAssistantAnswers();
  assert.equal(records.length, 3, 'записи для судьи не стёрлись вместе с памятью');
  assert.deepEqual(records.map((r) => r.question).sort(),
    ['второй вопрос', 'первый вопрос', 'третий вопрос']);
});

// ── Где НЕ записывается ─────────────────────────────────────────────────────

withRuntime('a chat outside the analyzer list is answered exactly as before and leaves no record', async ({ store }) => {
  const plain = [];
  const plainRuntime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(), ...adapters(plain),
  });
  const first = await runQuestion(plainRuntime, '/ask В курсе что такое агент?', { updateId: 10, messageId: 70 });

  const gated = [];
  const gatedRuntime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(),
    analyzer: stubAnalyzer({ chatIds: ['-999'] }), ...adapters(gated),
  });
  const second = await runQuestion(gatedRuntime, '/ask В курсе что такое агент?', { updateId: 20, messageId: 71 });

  assert.equal(first.kind, 'answered');
  assert.equal(second.kind, 'answered');
  assert.equal(gated.at(-1)[1].text, plain.at(-1)[1].text, 'ответ байт-в-байт прежний');
  assert.deepEqual(store.listAssistantAnswers(), []);
});

withRuntime('no analyzer means no record at all', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(), ...adapters(actions),
  });
  await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.deepEqual(store.listAssistantAnswers(), []);
});

// Служебный текст — реакция интерфейса на пустой ввод, а не ход разговора.
// Судить его нечем: вопроса за ним нет. Та же граница, что у памяти диалога.
withRuntime('service replies are delivered but never enter the transcript', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(),
    analyzer: stubAnalyzer(), ...adapters(actions),
  });
  const empty = await runQuestion(runtime, '/ask', { updateId: 10, messageId: 70 });
  const help = await runQuestion(runtime, '/help', { updateId: 20, messageId: 71 });
  assert.equal(empty.kind, 'answered');
  assert.equal(help.command, 'help');
  assert.equal(actions.length, 2, 'человек получил оба служебных ответа');
  assert.deepEqual(store.listAssistantAnswers(), []);
});

// Замер считает ходы, а не доставки: перевыдача апдейта Telegram не имеет
// права задвоить ход в стенограмме.
withRuntime('a replayed event does not double the record', async ({ store }) => {
  store.recordAssistantAnswer({
    eventId: 'fixed-event', chatId: '-100', userId: '7', question: 'первый', answer: 'ответ',
    route: { action: 'teach', sourceId: 'course-content-v1' },
  });
  store.recordAssistantAnswer({
    eventId: 'fixed-event', chatId: '-100', userId: '7', question: 'повтор', answer: 'другой ответ',
  });
  const rows = store.listAssistantAnswers();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].question, 'первый');
});

// ── Сенсор не важнее ответа ─────────────────────────────────────────────────

withRuntime('a failing record does not cost the person an answer', async ({ store }) => {
  const actions = [];
  const broken = {
    ...store,
    recordAssistantAnswer() { throw new Error('disk full'); },
  };
  const runtime = createTelegramRuntime({
    config: config(), store: broken, provider: fakeProvider(), knowledge: availableKnowledge(),
    analyzer: stubAnalyzer(), ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.equal(result.kind, 'answered');
  assert.equal(actions.length, 1, 'ответ доставлен, несмотря на отказ сенсора');
  assert.deepEqual(store.listAssistantAnswers(), []);
});
