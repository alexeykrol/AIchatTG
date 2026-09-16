/**
 * Учёт затрат модели в рантайме.
 *
 * Зачем: рантайм писал ИМЯ модели каждого вызова и не писал токены. По боевому
 * прогону 2026-08-17 это дало «30 вызовов анализатора, 28 вызовов ответа» —
 * и ни одной цифры о стоимости. Бюджет мы не экономим, но обязаны знать.
 *
 * Три контракта держит этот файл:
 *   1. расход провайдера доезжает до обеих записей хода (журнал наблюдений —
 *      анализатор и роутер, стенограмма — ответ);
 *   2. НЕназванный расход пишется как NULL, а не ноль: ноль сделал бы
 *      неучтённый вызов неотличимым от бесплатного, и пробел учёта выглядел бы
 *      экономией;
 *   3. учёт — сенсор, и он не имеет права стоить человеку ответа: старая база
 *      без колонок открывается, отказ записи не отменяет доставку.
 *
 * Имена полей повторяют лабораторные (`dialogue_eval/judge.py`), чтобы цифры
 * боя и лаборатории складывались одной линейкой.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ANALYZER_MODES, createAnalyzerAdapter } from '../src/analyzer-adapter.mjs';
import { loadAnalyzerSpec } from '../src/analyzer-spec.mjs';
import {
  createRuntimeStore,
  ensureRuntimeDatabaseSchema,
  openRuntimeDatabase,
  openRuntimeDatabaseForImport,
} from '../src/database.mjs';
import { providerCallUsage } from '../src/provider-adapter.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import { safetyVerdict } from './safety-fixture.mjs';

const RUNTIME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const JOURNAL_READER = join(RUNTIME_DIR, '..', '..', 'scripts', 'aichattg', 'analyzer-journal.cjs');
const SPEC = loadAnalyzerSpec(join(RUNTIME_DIR, 'src', 'analyzer-spec.json'));

const VERDICT = JSON.stringify({
  topics: ['content'],
  topics_evidence: 'что такое агент',
  context_dependent: false,
  level: { hypothesis: 'L1', confidence: 'medium', evidence: 'что такое агент' },
  intent: { kind: 'explicit', confidence: 'high', evidence: '', hidden_premise: null },
});

function receipt(modelId, inputTokens, outputTokens) {
  return { modelId, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

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

function availableKnowledge() {
  return {
    forSource(sourceId) {
      return ['course-content-v1', 'course-operations-v1', 'course-value-v1'].includes(sourceId)
        ? { available: true, snapshot: { sourceId, entries: [{ id: 'lesson:1:001', content: 'offline fixture' }] } }
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

/**
 * Расход двухступенчатой модерации так, как его отдаёт контракт safety v3:
 * агрегатом по обеим ступеням, а не квитанцией последнего вызова.
 */
function safetyUsage(inputTokens, outputTokens, calls = 2) {
  return {
    calls,
    failed: 0,
    modelId: 'safety-model',
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: null,
  };
}

/** Провайдер, называющий расход каждого вызова — как настоящий. */
function billedProvider() {
  return {
    async moderate(input) {
      const verdict = await safetyVerdict({ message: input.text, confidence: 0.98 });
      return {
        ...verdict, modelId: 'safety-model',
        safetyTrace: { ...verdict.safetyTrace, usage: safetyUsage(640, 44) },
      };
    },
    async routeAssistant() {
      return { action: 'teach', sourceId: 'course-content-v1', receipt: receipt('router-model', 120, 8) };
    },
    async answer(input) {
      return {
        text: `ответ на «${input.text}»`, modelId: 'answer-model',
        receipt: receipt('answer-model', 3_100, 240),
      };
    },
  };
}

/** Провайдер, не назвавший расход ни разу: тело ответа пришло без usage. */
function silentProvider() {
  return {
    async moderate(input) { return { ...await safetyVerdict({ message: input.text, confidence: 0.98 }), modelId: 'safety-model' }; },
    async routeAssistant() { return { action: 'teach', sourceId: 'course-content-v1' }; },
    async answer(input) { return { text: `ответ на «${input.text}»`, modelId: 'answer-model' }; },
  };
}

function stubAnalyzer({
  mode = ANALYZER_MODES.OBSERVE, chatIds = ['-100'], analyzerReceipt = receipt('analyzer-model', 900, 60),
  fail = null,
} = {}) {
  return createAnalyzerAdapter({
    config: { mode, chatIds },
    provider: {
      async analyze() {
        if (fail) throw Object.assign(new Error('provider rejected the verdict'), fail);
        return { text: VERDICT, modelId: 'analyzer-model', receipt: analyzerReceipt };
      },
    },
    spec: SPEC.spec,
    digest: SPEC.digest,
  });
}

async function runQuestion(runtime, text, { updateId = 40, messageId = 70 } = {}) {
  await runtime.handleUpdate('moderator', update(updateId, messageId, text));
  return runtime.handleUpdate('assistant', update(updateId + 1, messageId, text));
}

/**
 * Последняя запись модерации. Читаем SQL напрямую: у стора читалки для этой
 * таблицы нет — её единственный потребитель консоль оператора, и она берёт
 * строку целиком.
 */
function moderationRow(db) {
  return db.prepare(`SELECT verdict, reason, model_id, input_tokens, output_tokens, total_tokens
    FROM runtime_moderation_records ORDER BY created_at DESC, id DESC LIMIT 1`).get() || null;
}

function moderationCost(db) {
  const row = moderationRow(db);
  return row && {
    modelId: row.model_id, inputTokens: row.input_tokens,
    outputTokens: row.output_tokens, totalTokens: row.total_tokens,
  };
}

function withRuntime(name, body) {
  test(name, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'aichattg-usage-'));
    const db = openRuntimeDatabase(join(folder, 'runtime.db'));
    try { await body({ db, store: createRuntimeStore(db), folder }); } finally {
      db.close(); rmSync(folder, { recursive: true, force: true });
    }
  });
}

// ── Контракт полей ──────────────────────────────────────────────────────────

test('provider usage is normalised into one contract, and an unnamed cost stays null', () => {
  assert.deepEqual(providerCallUsage(receipt('answer-model', 10, 4)), {
    modelId: 'answer-model', inputTokens: 10, outputTokens: 4, totalTokens: 14,
  });
  // Ноль здесь был бы выдумкой: «провайдер не назвал» и «вызов был бесплатным»
  // обязаны остаться различимыми.
  const unmeasured = { modelId: null, inputTokens: null, outputTokens: null, totalTokens: null };
  assert.deepEqual(providerCallUsage(null), unmeasured);
  assert.deepEqual(providerCallUsage({ modelId: 'm' }), { ...unmeasured, modelId: 'm' });
  assert.deepEqual(providerCallUsage({ inputTokens: -1, outputTokens: 1.5, totalTokens: '20' }), unmeasured);
});

// ── Расход доезжает до записей ──────────────────────────────────────────────

withRuntime('every paid call of a turn is recorded with its tokens and its model', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store, provider: billedProvider(), knowledge: availableKnowledge(),
    analyzer: stubAnalyzer(), ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.equal(result.kind, 'answered');

  const [observation] = store.listAnalyzerObservations();
  assert.equal(observation.modelId, 'analyzer-model');
  assert.deepEqual(observation.usage, { inputTokens: 900, outputTokens: 60, totalTokens: 960 });
  // Роутер — второй платный вызов того же хода, и он свой: складывать его
  // токены с анализаторскими значило бы потерять, чем сумма оплачена.
  assert.deepEqual(observation.routeUsage, {
    modelId: 'router-model', inputTokens: 120, outputTokens: 8, totalTokens: 128,
  });

  const [answer] = store.listAssistantAnswers();
  assert.equal(answer.modelId, 'answer-model');
  assert.deepEqual(answer.usage, { inputTokens: 3_100, outputTokens: 240, totalTokens: 3_340 });
  assert.equal(answer.eventId, observation.eventId, 'обе записи — про один ход');
});

// Модерация — самый частый платный вызов: он идёт на КАЖДОМ сообщении чата,
// а не только на вопросах ассистенту. Её расход не хранился нигде, и по бою
// нельзя было назвать цену защиты чата.
withRuntime('the moderation call every message pays for is recorded with its tokens and its model', async ({ db, store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store, provider: billedProvider(), knowledge: availableKnowledge(),
    analyzer: stubAnalyzer(), ...adapters(actions),
  });
  await runQuestion(runtime, '/ask В курсе что такое агент?');

  assert.equal(moderationRow(db).verdict, 'clean');
  // Счётчики — агрегат обеих ступеней контракта, а не квитанция последнего
  // вызова: та занизила бы счёт ровно на целый оплаченный вызов.
  assert.deepEqual(moderationCost(db), {
    modelId: 'safety-model', inputTokens: 640, outputTokens: 44, totalTokens: 684,
  });
});

// Вызова не было вовсе: освобождённый отправитель судится преflight-ом Guard.
// Пустые счётчики здесь — правда о ходе; ноль означал бы «модель звали, и она
// оказалась бесплатной».
withRuntime('an exempt sender is judged without a call, so nothing is billed to it', async ({ db, store }) => {
  const actions = [];
  let calls = 0;
  const provider = { ...billedProvider(), async moderate(input) { calls++; return safetyVerdict({ message: input.text, confidence: 1 }); } };
  const exempt = adapters(actions);
  exempt.guard = { ...exempt.guard, async senderDisposition() { return { proven: true, exempt: true, reason: 'exempt_admin' }; } };
  const runtime = createTelegramRuntime({
    config: config(), store, provider, knowledge: availableKnowledge(), analyzer: stubAnalyzer(), ...exempt,
  });
  await runtime.handleUpdate('moderator', update(44, 74, 'сообщение админа'));

  assert.equal(calls, 0, 'освобождение доказано до границы провайдера');
  assert.equal(moderationRow(db).reason, 'exempt_admin');
  assert.deepEqual(moderationCost(db), {
    modelId: null, inputTokens: null, outputTokens: null, totalTokens: null,
  });
});

// Режим dispatch: вердикт ЗАМЕНЯЕТ вызов роутера, значит роутерного расхода
// нет вовсе. Пустые счётчики здесь — правда о ходе, а не пробел учёта.
withRuntime('in dispatch there is no router call, so its cost stays empty', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store, provider: billedProvider(), knowledge: availableKnowledge(),
    analyzer: stubAnalyzer({ mode: ANALYZER_MODES.DISPATCH }), ...adapters(actions),
  });
  await runQuestion(runtime, '/ask В курсе что такое агент?');

  const [observation] = store.listAnalyzerObservations();
  assert.deepEqual(observation.usage, { inputTokens: 900, outputTokens: 60, totalTokens: 960 });
  assert.deepEqual(observation.routeUsage, {
    modelId: null, inputTokens: null, outputTokens: null, totalTokens: null,
  });
});

// ── Провайдер не назвал расход ──────────────────────────────────────────────

withRuntime('a provider that names no usage is recorded as null and still answers', async ({ db, store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store, provider: silentProvider(), knowledge: availableKnowledge(),
    analyzer: stubAnalyzer({ analyzerReceipt: null }), ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.equal(result.kind, 'answered', 'учёт — сенсор, ответ человеку он не отменяет');
  assert.equal(actions.length, 1);

  const [observation] = store.listAnalyzerObservations();
  assert.deepEqual(observation.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
  assert.deepEqual(observation.routeUsage, {
    modelId: null, inputTokens: null, outputTokens: null, totalTokens: null,
  });
  assert.equal(observation.modelId, 'analyzer-model', 'имя модели известно и без токенов');
  const [answer] = store.listAssistantAnswers();
  assert.deepEqual(answer.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
  assert.equal(answer.modelId, 'answer-model');
  // Модерация того же хода: вызов состоялся, цену никто не назвал. В строке
  // NULL, а не ноль, — иначе пробел учёта читался бы как бесплатная модерация.
  assert.deepEqual(moderationCost(db), {
    modelId: 'safety-model', inputTokens: null, outputTokens: null, totalTokens: null,
  });
});

/**
 * Падение между решением и записью — единственное место, где оплаченный вызов
 * мог не оставить следа: восстанавливающий процесс модель не зовёт и цену
 * назвать не может. Поэтому счётчики едут в долговечном решении и доезжают до
 * записи вместе с вердиктом.
 */
withRuntime('a moderation call paid before a crash keeps its cost in the recovered record', async ({ db, store }) => {
  const actions = [];
  let calls = 0;
  const paid = {
    async moderate(input) {
      calls++;
      const verdict = await safetyVerdict({ message: input.text, confidence: 0.99 });
      return {
        ...verdict, modelId: 'safety-model',
        safetyTrace: { ...verdict.safetyTrace, usage: safetyUsage(512, 33, 1) },
      };
    },
  };
  const crashing = createTelegramRuntime({
    config: config(), store, provider: paid, knowledge: availableKnowledge(), analyzer: stubAnalyzer(),
    ...adapters(actions),
    testHooks: { async afterDecisionReady() { throw new Error('crash_after_decision_ready'); } },
  });
  await crashing.handleUpdate('moderator', update(60, 90, 'сообщение до падения'));
  assert.equal(calls, 1);
  assert.equal(moderationRow(db), null, 'до восстановления записи ещё нет');

  const recovering = createTelegramRuntime({
    config: config(), store, knowledge: availableKnowledge(), analyzer: stubAnalyzer(), ...adapters(actions),
    provider: { async moderate() { calls++; throw new Error('provider_must_not_be_called'); } },
  });
  assert.equal((await recovering.recoverModeratorJudgements({ limit: 2 })).recovered, 1);
  assert.equal(calls, 1, 'восстановление не оплачивает второй вызов');
  assert.deepEqual(moderationCost(db), {
    modelId: 'safety-model', inputTokens: 512, outputTokens: 33, totalTokens: 545,
  });
});

// Оплаченный, но негодный вызов — самый дорогой класс ходов: результата нет,
// счёт есть. Списать его в «ничего не потратили» значило бы занижать учёт
// ровно там, где он важнее всего.
withRuntime('a paid but failed analyzer call keeps its cost in the journal', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(),
    store,
    provider: billedProvider(),
    knowledge: availableKnowledge(),
    analyzer: stubAnalyzer({
      fail: { code: 'provider_response_invalid', receipt: receipt('analyzer-model', 870, 1_536) },
    }),
    ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.equal(result.kind, 'answered', 'сбой анализатора не отменяет ответ');

  const [observation] = store.listAnalyzerObservations();
  assert.equal(observation.status, 'error');
  assert.equal(observation.error, 'provider_response_invalid');
  assert.deepEqual(observation.usage, { inputTokens: 870, outputTokens: 1_536, totalTokens: 2_406 });
  assert.equal(observation.modelId, 'analyzer-model');
  // Роутер при этом отработал (откат dispatch → прежний путь либо observe),
  // и его расход тоже записан.
  assert.equal(observation.routeUsage.inputTokens, 120);
});

withRuntime('a failing usage write does not cost the person an answer', async ({ store }) => {
  const actions = [];
  const broken = {
    ...store,
    recordAssistantAnswer() { throw new Error('disk full'); },
    recordAnalyzerObservation() { throw new Error('disk full'); },
  };
  const runtime = createTelegramRuntime({
    config: config(), store: broken, provider: billedProvider(), knowledge: availableKnowledge(),
    analyzer: stubAnalyzer(), ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.equal(result.kind, 'answered');
  assert.equal(actions.length, 1);
});

// ── Старая база ─────────────────────────────────────────────────────────────

// Схема пополнена аддитивно: боевая база, накопившая ходы без счётчиков,
// открывается как есть. Старые строки читаются как «не измерено» — выдумывать
// их расход нечем и незачем.
const LEGACY_OBSERVATIONS = `CREATE TABLE runtime_assistant_analyzer_observations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok', 'invalid', 'error')),
  topics TEXT,
  level TEXT,
  level_confidence TEXT,
  intent TEXT,
  intent_confidence TEXT,
  hints TEXT,
  route_action TEXT,
  route_source_id TEXT,
  verdict_json TEXT,
  model_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);`;
const LEGACY_ANSWERS = `CREATE TABLE runtime_assistant_answer_records (
  event_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  route_action TEXT,
  route_source_id TEXT,
  knowledge_source_id TEXT,
  served_unit_ids TEXT,
  model_id TEXT,
  delivery TEXT,
  created_at INTEGER NOT NULL
);`;
// Записей модерации в боевой базе больше всего — вызов идёт на каждом
// сообщении. Перестройка этой таблицы недопустима, поэтому колонки учёта
// дописываются к ней тем же ALTER-ом.
const LEGACY_MODERATION = `CREATE TABLE runtime_moderation_records (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT,
  verdict TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  mode TEXT NOT NULL,
  action_json TEXT,
  created_at INTEGER NOT NULL
);`;

/** Снимок боевой базы до этой правки: журнал и стенограмма без счётчиков. */
function legacyDatabase(folder, { at = 1_700_000_000 } = {}) {
  const path = join(folder, 'legacy.db');
  const db = openRuntimeDatabaseForImport(path);
  db.exec(LEGACY_OBSERVATIONS);
  db.exec(LEGACY_ANSWERS);
  db.exec(LEGACY_MODERATION);
  db.prepare(`INSERT INTO runtime_assistant_analyzer_observations
    (id, event_id, chat_id, user_id, question, status, model_id, created_at)
    VALUES ('old-1', 'assistant:1', '-100', '7', 'старый вопрос', 'ok', 'analyzer-model', ?)`).run(at);
  db.prepare(`INSERT INTO runtime_assistant_answer_records
    (event_id, chat_id, user_id, question, answer, model_id, created_at)
    VALUES ('assistant:1', '-100', '7', 'старый вопрос', 'старый ответ', 'answer-model', ?)`).run(at);
  db.prepare(`INSERT INTO runtime_moderation_records
    (id, event_id, chat_id, message_id, user_id, verdict, confidence, reason, mode, action_json, created_at)
    VALUES ('old-mod-1', 'moderator:1', '-100', '70', '7', 'clean', 1, 'safety:clean', 'live', '[]', ?)`).run(at);
  db.close();
  return path;
}

test('an old database without the accounting columns opens, migrates and reads as unmeasured', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-usage-legacy-'));
  try {
    const path = legacyDatabase(folder);
    const db = openRuntimeDatabaseForImport(path);
    try {
      ensureRuntimeDatabaseSchema(db);
      const columns = new Set(db.prepare('PRAGMA table_info(runtime_assistant_analyzer_observations)')
        .all().map((row) => row.name));
      for (const column of ['detector_debt', 'input_tokens', 'output_tokens', 'total_tokens',
        'route_model_id', 'route_input_tokens', 'route_output_tokens', 'route_total_tokens']) {
        assert.equal(columns.has(column), true, `колонка ${column} дописана аддитивно`);
      }
      const store = createRuntimeStore(db);
      const [old] = store.listAnalyzerObservations();
      assert.equal(old.question, 'старый вопрос', 'прежняя строка на месте');
      assert.deepEqual(old.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
      assert.deepEqual(store.listAssistantAnswers()[0].usage,
        { inputTokens: null, outputTokens: null, totalTokens: null });

      // Новая строка в той же базе уже пишется со счётчиками.
      store.recordAnalyzerObservation({
        eventId: 'assistant:2', chatId: '-100', userId: '7', question: 'новый вопрос', status: 'ok',
        modelId: 'analyzer-model', usage: receipt('analyzer-model', 5, 2),
        routeUsage: receipt('router-model', 3, 1),
      });
      const [fresh] = store.listAnalyzerObservations();
      assert.deepEqual(fresh.usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
      assert.equal(fresh.routeUsage.modelId, 'router-model');

      // То же для записей модерации: таблица не перестраивается, прежняя
      // строка на месте и читается как «не измерено», новая пишется с ценой.
      const moderationColumns = new Set(db.prepare('PRAGMA table_info(runtime_moderation_records)')
        .all().map((row) => row.name));
      for (const column of ['model_id', 'input_tokens', 'output_tokens', 'total_tokens']) {
        assert.equal(moderationColumns.has(column), true, `колонка ${column} дописана аддитивно`);
      }
      assert.deepEqual(moderationCost(db), {
        modelId: null, inputTokens: null, outputTokens: null, totalTokens: null,
      });
      store.recordModeration({
        eventId: 'moderator:2', chatId: '-100', messageId: '71', userId: '7', verdict: 'clean',
        confidence: 1, reason: 'safety:clean', mode: 'live', actions: [],
        modelId: 'safety-model', usage: receipt('safety-model', 640, 44),
      });
      assert.deepEqual(moderationCost(db), {
        modelId: 'safety-model', inputTokens: 640, outputTokens: 44, totalTokens: 684,
      });
    } finally { db.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

// ── Читалка ─────────────────────────────────────────────────────────────────

/**
 * Читалка живёт в `scripts/`, а тест — здесь: драйвер SQLite установлен именно
 * в этом пакете, и запуск скрипта в бою идёт с тем же разрешением (cwd
 * контейнера). Тест повторяет боевой способ запуска, а не удобный.
 */
function readJournal(dbPath, args = []) {
  return execFileSync(process.execPath, [JOURNAL_READER, '--db', dbPath, ...args], {
    cwd: RUNTIME_DIR, encoding: 'utf8',
  });
}

test('the journal reader sums the spend over its window', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-usage-reader-'));
  const path = join(folder, 'runtime.db');
  const db = openRuntimeDatabase(path);
  try {
    const older = createRuntimeStore(db, { now: () => 1_700_000_000 });
    const newer = createRuntimeStore(db, { now: () => 1_700_009_000 });
    for (const [index, store] of [older, older, newer].entries()) {
      store.recordAnalyzerObservation({
        eventId: `assistant:${index}`, chatId: '-100', userId: '7', question: `вопрос ${index}`,
        status: 'ok', modelId: 'analyzer-model',
        verdict: { topics: ['content'], level: { hypothesis: 'L1', confidence: 'medium' }, intent: { kind: 'explicit', confidence: 'high' } },
        route: { action: 'teach', sourceId: 'course-content-v1' },
        usage: receipt('analyzer-model', 100, 10),
        routeUsage: receipt('router-model', 20, 2),
      });
      store.recordAssistantAnswer({
        eventId: `assistant:${index}`, chatId: '-100', userId: '7', question: `вопрос ${index}`,
        answer: 'ответ', modelId: 'answer-model', usage: receipt('answer-model', 1_000, 200),
      });
    }
    // Ход без учёта: вызовы были, цену провайдер не назвал. Он обязан быть
    // виден отдельным числом, а не растворяться нулями в сумме.
    newer.recordAnalyzerObservation({
      eventId: 'assistant:9', chatId: '-100', userId: '7', question: 'вопрос без учёта',
      status: 'ok', modelId: 'analyzer-model',
      verdict: { topics: ['content'], level: { hypothesis: 'L1', confidence: 'low' }, intent: { kind: 'explicit', confidence: 'low' } },
      route: { action: 'teach', sourceId: 'course-content-v1' },
    });
    db.close();

    const all = readJournal(path);
    assert.match(all, /расход за окно: вызовов 10 · вход 3360 · выход 636 · всего 3996 · без учёта вызовов: 1/);
    assert.match(all, /· анализатор: вызовов 4 · вход 300 · выход 30 · всего 330 · без учёта: 1/);
    assert.match(all, /· роутер: вызовов 3 · вход 60 · выход 6 · всего 66/);
    assert.match(all, /· ответ: вызовов 3 · вход 3000 · выход 600 · всего 3600/);

    // Окно режет и расход тоже: `--limit` режет вывод, окно — прогон.
    const window = readJournal(path, ['--since', '1700005000']);
    assert.match(window, /расход за окно: вызовов 4 · вход 1120 · выход 212 · всего 1332 · без учёта вызовов: 1/);
    assert.match(window, /· анализатор: вызовов 2 · вход 100 · выход 10 · всего 110 · без учёта: 1/);
    assert.match(window, /· ответ: вызовов 1 · вход 1000 · выход 200 · всего 1200/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the journal reader still works on a snapshot taken before the accounting columns', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-usage-reader-legacy-'));
  try {
    const output = readJournal(legacyDatabase(folder));
    assert.match(output, /ходов: 1/, 'старый снимок по-прежнему читается');
    assert.match(output, /расход за окно: в этом снимке базы учёт затрат не записан/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
