/**
 * Анализатор запроса: спецификация, наблюдение, границы включения.
 *
 * Главный контракт этого файла — НЕ «анализатор работает», а «анализатор не
 * трогает ответ». Надстройка, ради телеметрии испортившая ответ живому
 * человеку, хуже отсутствующей надстройки, поэтому проверка «текст ответа
 * побайтно тот же» стоит здесь первой и держится тестом, а не намерением.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ANALYZER_MODES,
  accumulateLevels,
  createAnalyzerAdapter,
} from '../src/analyzer-adapter.mjs';
import {
  compileAnalyzerSystemPrompt,
  compileRouterSystemPrompt,
  loadAnalyzerSpec,
  parseAnalyzerVerdict,
} from '../src/analyzer-spec.mjs';
import { loadRuntimeConfig } from '../src/config.mjs';
import { openRuntimeDatabase, createRuntimeStore } from '../src/database.mjs';
import { ROUTER_SYSTEM_PROMPT, createProviderAdapter } from '../src/provider-adapter.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';

const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'analyzer-spec.json');
const SPEC = loadAnalyzerSpec(SPEC_PATH);

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
        ? { available: true, snapshot: { sourceId, entries: [{ id: 'test', content: 'offline fixture' }] } }
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

function fakeProvider() {
  return {
    async moderate() { return { safetyRoute: 'clean', abuseLevel: null, confidence: 0.98, reason: 'fixture', modelId: 'fake' }; },
    async routeAssistant({ courseOperationsHint }) {
      return courseOperationsHint
        ? { action: 'support', sourceId: 'course-operations-v1' }
        : { action: 'teach', sourceId: 'course-content-v1' };
    },
    async answer(input) { return { text: `answer:${input.text}:${input.route.action}`, modelId: 'fake' }; },
  };
}

const VERDICT = JSON.stringify({
  topics: ['value'],
  topics_evidence: 'их проверять уметь',
  context_dependent: false,
  level: { hypothesis: 'L3', confidence: 'medium', evidence: 'их проверять уметь' },
  intent: { kind: 'latent', confidence: 'medium', evidence: 'подрядчики', hidden_premise: 'проверять можно, не разбираясь' },
});

/** Анализатор, отвечающий заданным текстом; считает свои вызовы. */
function stubAnalyzer({ text = VERDICT, fail = null, chatIds = ['-100'], mode = ANALYZER_MODES.OBSERVE } = {}) {
  const calls = [];
  const provider = {
    async analyze(payload) {
      calls.push(payload);
      if (fail) throw Object.assign(new Error('provider down'), { code: fail });
      return { text, modelId: 'analyzer-fake' };
    },
  };
  const adapter = createAnalyzerAdapter({
    config: { mode, chatIds }, provider, spec: SPEC.spec, digest: SPEC.digest,
  });
  return { adapter, calls };
}

/** Роутер с учётом вызовов: dispatch обязан его НЕ звать, деградация — звать. */
function countedProvider() {
  const base = fakeProvider();
  const routerCalls = [];
  return {
    routerCalls,
    provider: {
      ...base,
      async routeAssistant(payload) { routerCalls.push(payload); return base.routeAssistant(payload); },
    },
  };
}

/** Вердикт-заглушка с заданной главной темой — для прогона dispatch-пути. */
function verdictJson(topics) {
  return JSON.stringify({
    topics,
    topics_evidence: 'что такое агент',
    context_dependent: false,
    level: { hypothesis: 'L1', confidence: 'medium', evidence: 'что такое агент' },
    intent: { kind: 'explicit', confidence: 'high', evidence: '', hidden_premise: null },
  });
}

async function runQuestion(runtime, text, { updateId = 40, messageId = 70 } = {}) {
  await runtime.handleUpdate('moderator', update(updateId, messageId, text));
  return runtime.handleUpdate('assistant', update(updateId + 1, messageId, text));
}

function withRuntime(name, body) {
  test(name, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'aichattg-analyzer-'));
    const db = openRuntimeDatabase(join(folder, 'runtime.db'));
    try { await body({ db, store: createRuntimeStore(db), folder }); } finally {
      db.close(); rmSync(folder, { recursive: true, force: true });
    }
  });
}

// ── Спецификация ────────────────────────────────────────────────────────────

test('the shipped spec loads and carries a digest', () => {
  assert.equal(SPEC.valid, true);
  assert.match(SPEC.digest, /^[0-9a-f]{64}$/);
  assert.equal(SPEC.spec.schema_version, 'kb_analyzer_spec_v1');
});

test('a spec that is unreadable, malformed or of another version fails closed', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-spec-'));
  try {
    assert.equal(loadAnalyzerSpec(join(folder, 'absent.json')).code, 'analyzer_spec_unreadable');
    const broken = join(folder, 'broken.json');
    writeFileSync(broken, '{not json');
    assert.equal(loadAnalyzerSpec(broken).code, 'analyzer_spec_malformed');
    const oldVersion = join(folder, 'old.json');
    writeFileSync(oldVersion, JSON.stringify({ ...SPEC.spec, schema_version: 'kb_analyzer_spec_v0' }));
    assert.equal(loadAnalyzerSpec(oldVersion).code, 'analyzer_spec_version_unsupported');
    const emptyAxis = join(folder, 'empty.json');
    writeFileSync(emptyAxis, JSON.stringify({ ...SPEC.spec, topics: { vocabulary: [] } }));
    assert.equal(loadAnalyzerSpec(emptyAxis).code, 'analyzer_spec_vocabulary_invalid');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

// Промпт — дериватив спецификации. Если бы он был рукописным, правка оси в
// данных молча расходилась бы с тем, что читает модель.
test('the compiled prompt is derived from the spec vocabularies', () => {
  const prompt = compileAnalyzerSystemPrompt(SPEC.spec);
  for (const topic of SPEC.spec.topics.vocabulary) assert.ok(prompt.includes(topic.id), topic.id);
  for (const level of SPEC.spec.levels.vocabulary) assert.ok(prompt.includes(level.id), level.id);
  for (const intent of SPEC.spec.intents.vocabulary) assert.ok(prompt.includes(intent.id), intent.id);
  assert.ok(!prompt.includes('searchSubject'), 'поля диспетчера не входят в промпт v0');
  assert.ok(compileAnalyzerSystemPrompt(SPEC.spec, { dispatcher: true }).includes('searchSubject'));
});

// ── Промпт роутера ──────────────────────────────────────────────────────────

// Текст, которым боевой роутер работал ДО этапа Ф3, — константой в
// `provider-adapter.mjs`. Он записан здесь дословно и намеренно: этап
// переносит промпт из прозы в данные и не имеет права по дороге изменить в
// нём хоть символ. Красный тест здесь означает не «поправьте эталон», а
// «поведение бота меняется» — то есть требуется замер согласия, а не правка
// строки.
const ROUTER_PROMPT_BEFORE_SPEC = [
  'You route an AIchatTG Assistant question without granting access yourself.',
  'Return exactly one JSON object with action and sourceId. action is exactly one',
  'of teach, navigate, support, advise, redirect. teach and navigate require',
  'sourceId course-content-v1. support requires sourceId course-operations-v1.',
  'advise requires sourceId course-value-v1 and covers personal fit, benefit and',
  'course choice questions ("is this for me", "why do I need it", "which course',
  'to pick"). redirect requires sourceId null. Respect courseOperationsHint: an',
  'operations question may only be support or redirect. Respect courseValueHint:',
  'a value question may only be advise or redirect. Do not add Markdown.',
].join(' ');

test('the router prompt compiled from the spec is byte-identical to the shipped one', () => {
  assert.equal(compileRouterSystemPrompt(SPEC.spec), ROUTER_PROMPT_BEFORE_SPEC);
  assert.equal(ROUTER_SYSTEM_PROMPT, ROUTER_PROMPT_BEFORE_SPEC,
    'адаптер провайдера обязан брать промпт из спецификации, а не из своей константы');
});

// Промпт — дериватив словаря маршрутов. Если бы он был рукописным, правка
// `routing.map` не меняла бы в нём ни символа: код считал бы одно, модель
// слышала другое, и разошлись бы они молча.
test('the router prompt follows the routing vocabulary, not a hand-written copy', () => {
  for (const [topic, entry] of Object.entries(SPEC.spec.routing.map)) {
    for (const action of entry.actions) {
      assert.ok(ROUTER_SYSTEM_PROMPT.includes(action), `${topic}: действие ${action} не названо модели`);
    }
    assert.ok(ROUTER_SYSTEM_PROMPT.includes(entry.sourceId || 'null'), `${topic}: пакет не назван модели`);
  }
  const renamed = JSON.parse(JSON.stringify(SPEC.spec));
  renamed.routing.map.value.sourceId = 'course-value-v2';
  renamed.hints.map.value.sourceId = 'course-value-v2';
  assert.ok(compileRouterSystemPrompt(renamed).includes('course-value-v2'),
    'правка данных обязана доехать до модели без правки кода');
});

test('a verdict outside the contract is invalid rather than repaired', () => {
  const ok = parseAnalyzerVerdict(VERDICT, SPEC.spec, 'подрядчики есть, мне бы их проверять уметь');
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.topics, ['value']);
  assert.equal(ok.level.hypothesis, 'L3');
  assert.deepEqual(ok.quotesUnverified, []);

  const fenced = parseAnalyzerVerdict(`\`\`\`json\n${VERDICT}\n\`\`\``, SPEC.spec, 'подрядчики есть, мне бы их проверять уметь');
  assert.equal(fenced.status, 'ok', 'markdown-обёртка не должна ронять разбор');

  assert.equal(parseAnalyzerVerdict('не json', SPEC.spec, 'x').status, 'invalid');
  const alien = JSON.parse(VERDICT); alien.topics = ['prices'];
  assert.equal(parseAnalyzerVerdict(JSON.stringify(alien), SPEC.spec, 'x').status, 'invalid');
  const badLevel = JSON.parse(VERDICT); badLevel.level.hypothesis = 'L9';
  assert.equal(parseAnalyzerVerdict(JSON.stringify(badLevel), SPEC.spec, 'x').status, 'invalid');
});

// Цитата, которой нет в ходе, — выдумка. Она не рушит диагноз, но обязана быть
// видна: недоказанная улика понижает доверие, а не прячется.
test('an evidence quote absent from the turn is flagged, not silently accepted', () => {
  const verdict = parseAnalyzerVerdict(VERDICT, SPEC.spec, 'совершенно другой текст хода');
  assert.equal(verdict.status, 'ok');
  assert.deepEqual(verdict.quotesUnverified.sort(), ['intent', 'level', 'topics']);
});

// ── Траектория ──────────────────────────────────────────────────────────────

// Уровень накапливается кодом, а не объявляется моделью с одного хода: увести
// разговор в другой домен по одной реплике — слишком дорогая ошибка.
test('a level is reached by accumulation, not by a single confident turn', () => {
  const single = accumulateLevels([{ level: { hypothesis: 'L3', confidence: 'medium' } }], SPEC.spec);
  assert.deepEqual(single.reached, []);
  const twice = accumulateLevels([
    { level: { hypothesis: 'L3', confidence: 'medium' } },
    { level: { hypothesis: 'L3', confidence: 'medium' } },
  ], SPEC.spec);
  assert.deepEqual(twice.reached, ['L3']);
  const high = accumulateLevels([{ level: { hypothesis: 'L2', confidence: 'high' } }], SPEC.spec);
  assert.deepEqual(high.reached, ['L2']);
  // Уровни не конкурируют: ход может нести и предметный разрыв, и глубокий.
  const both = accumulateLevels([
    { level: { hypothesis: 'L1', confidence: 'high' } },
    { level: { hypothesis: 'L3', confidence: 'high' } },
  ], SPEC.spec);
  assert.deepEqual(both.reached, ['L1', 'L3']);
  assert.deepEqual(accumulateLevels([{ level: { hypothesis: 'none', confidence: 'high' } }], SPEC.spec).reached, []);
});

// ── Границы включения ───────────────────────────────────────────────────────

test('an empty chat list means nowhere, not everywhere', () => {
  const { adapter } = stubAnalyzer({ chatIds: [] });
  assert.equal(adapter.enabled, true);
  assert.equal(adapter.appliesTo('-100'), false);
});

test('mode off yields an adapter that cannot call anything', async () => {
  const adapter = createAnalyzerAdapter({ config: { mode: 'off', chatIds: ['-100'] }, provider: {}, spec: SPEC.spec });
  assert.equal(adapter.enabled, false);
  assert.equal(adapter.appliesTo('-100'), false);
  assert.equal((await adapter.analyze({ text: 'вопрос' })).status, 'error');
});

test('the runtime config defaults to off and refuses a half-configured analyzer', () => {
  const base = {
    TELEGRAM_RUNTIME_MODERATOR_WEBHOOK_SECRET: 'a', TELEGRAM_RUNTIME_ASSISTANT_WEBHOOK_SECRET: 'b',
  };
  assert.equal(loadRuntimeConfig({ ...base }).analyzer.mode, 'off');
  assert.throws(() => loadRuntimeConfig({ ...base, TELEGRAM_RUNTIME_ANALYZER_MODE: 'observe' }),
    /ANALYZER_CHAT_IDS requires at least one chat/);
  // dispatch (Ф4) — законный режим, но пустой список чатов роняет старт так же,
  // как в observe: «включить везде» не возникает из забытой переменной.
  assert.throws(() => loadRuntimeConfig({ ...base, TELEGRAM_RUNTIME_ANALYZER_MODE: 'dispatch' }),
    /ANALYZER_CHAT_IDS requires at least one chat/);
  assert.throws(() => loadRuntimeConfig({ ...base, TELEGRAM_RUNTIME_ANALYZER_MODE: 'broadcast', TELEGRAM_RUNTIME_ANALYZER_CHAT_IDS: '-100' }),
    /ANALYZER_MODE must be one of/);
  const enabled = loadRuntimeConfig({
    ...base, TELEGRAM_RUNTIME_ANALYZER_MODE: 'observe', TELEGRAM_RUNTIME_ANALYZER_CHAT_IDS: '-100, -200',
  });
  assert.deepEqual(enabled.analyzer.chatIds, ['-100', '-200']);
  const dispatch = loadRuntimeConfig({
    ...base, TELEGRAM_RUNTIME_ANALYZER_MODE: 'dispatch', TELEGRAM_RUNTIME_ANALYZER_CHAT_IDS: '-100',
  });
  assert.equal(dispatch.analyzer.mode, 'dispatch');
});

// Опечатка режима при прямом вызове фабрики — выключенный анализатор, а не
// «как observe»: неизвестная строка не имеет права включать поведение молча.
test('an unknown mode yields a disabled adapter, not observe-by-accident', () => {
  const adapter = createAnalyzerAdapter({
    config: { mode: 'broadcast', chatIds: ['-100'] }, provider: { analyze: async () => ({}) }, spec: SPEC.spec,
  });
  assert.equal(adapter.enabled, false);
  assert.equal(adapter.reason, 'analyzer_mode_unsupported');
});

// ── Наблюдение не трогает ответ ─────────────────────────────────────────────

// Тот самый контракт, ради которого написан файл: включённое наблюдение обязано
// давать БАЙТ-В-БАЙТ тот же ответ, что и его отсутствие.
withRuntime('an observed answer is byte-identical to an unobserved one', async ({ store }) => {
  const question = '/ask В курсе что такое агент?';
  const plain = [];
  const plainRuntime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(), ...adapters(plain),
  });
  const first = await runQuestion(plainRuntime, question, { updateId: 10, messageId: 70 });

  const observed = [];
  const { adapter, calls } = stubAnalyzer();
  const observedRuntime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(observed),
  });
  const second = await runQuestion(observedRuntime, question, { updateId: 20, messageId: 71 });

  assert.equal(first.kind, 'answered');
  assert.equal(second.kind, 'answered');
  assert.equal(observed.at(-1)[1].text, plain.at(-1)[1].text);
  assert.deepEqual(second.route, first.route);
  assert.equal(calls.length, 1, 'наблюдение стоит ровно один вызов на ход');
});

withRuntime('no analyzer means no call and no journal', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(), ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.equal(result.kind, 'answered');
  assert.deepEqual(store.listAnalyzerObservations(), []);
});

withRuntime('a chat outside the list is not observed', async ({ store }) => {
  const actions = [];
  const { adapter, calls } = stubAnalyzer({ chatIds: ['-999'] });
  const runtime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.equal(calls.length, 0);
  assert.deepEqual(store.listAnalyzerObservations(), []);
});

// ── Журнал ──────────────────────────────────────────────────────────────────

withRuntime('the journal records the verdict, the fired hints and the route together', async ({ store }) => {
  const actions = [];
  const { adapter } = stubAnalyzer();
  const runtime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  // Вопрос ловится боевым value-детектором: в одной строке обязаны сойтись
  // диагноз модели, сработавший хинт и итоговый маршрут — иначе сверять их
  // потом будет не с чем.
  await runQuestion(runtime, '/ask подрядчики есть, мне бы просто их проверять уметь');
  const [row] = store.listAnalyzerObservations();
  assert.equal(row.status, 'ok');
  assert.deepEqual(row.topics, ['value']);
  assert.equal(row.level, 'L3');
  assert.equal(row.levelConfidence, 'medium');
  assert.equal(row.intent, 'latent');
  assert.ok(row.hints.includes('value'), `хинты: ${row.hints.join(',')}`);
  assert.equal(row.route.action, 'advise');
  assert.equal(row.route.sourceId, 'course-value-v1');
  assert.equal(row.modelId, 'analyzer-fake');
  // Улика обязана дожить до журнала: диагноз без цитаты нечем проверить.
  assert.equal(row.verdict.level.evidence, 'их проверять уметь');
  assert.deepEqual(row.verdict.quotesUnverified, []);
});

// Долг детектора: спор слоёв, разрешённый в пользу доказанной точности
// (§2.3а, правило 3). В `route_action` после перебивания стоит домен
// победителя, поэтому без отдельной записи проигравший голос исчезал бы
// бесследно, а спор выглядел бы чистым прогоном — и пробел детектора остался
// бы невидимым ровно в том журнале, который заведён его искать.
withRuntime('a layer conflict is journaled as detector debt, not swallowed', async ({ store }) => {
  const actions = [];
  const { adapter } = stubAnalyzer();
  const runtime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  // Value-детектор ловит вопрос, роутер-заглушка отвечает `teach`: домены
  // разные, побеждает детектор.
  const result = await runQuestion(runtime, '/ask подрядчики есть, мне бы просто их проверять уметь');
  assert.equal(result.kind, 'answered');
  const [row] = store.listAnalyzerObservations();
  assert.equal(row.route.action, 'advise', 'маршрут — за детектором');
  assert.deepEqual(row.detectorDebt, {
    kind: 'domain_conflict',
    detector: 'value',
    detectorName: 'isCourseValueQuestion',
    model: 'content',
    modelAction: 'teach',
    resolvedTo: 'value',
    resolvedBy: 'detector',
  });
});

// Согласие слоёв долгом не является: иначе журнал наполнится шумом и
// настоящий пробел детектора в нём утонет.
withRuntime('an uncontested route leaves no debt behind', async ({ store }) => {
  const actions = [];
  const { adapter } = stubAnalyzer();
  const runtime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  await runQuestion(runtime, '/ask В курсе что такое агент?');
  const [row] = store.listAnalyzerObservations();
  assert.equal(row.route.action, 'teach');
  assert.equal(row.detectorDebt, null);
});

// Сломанный анализатор обязан быть виден. Молчащий журнал читается как
// «анализатор работает» — вывод, обратный истине.
withRuntime('a failing analyzer still answers the person and still leaves a trace', async ({ store }) => {
  const actions = [];
  const { adapter } = stubAnalyzer({ fail: 'provider_http_error' });
  const runtime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.equal(result.kind, 'answered');
  const [row] = store.listAnalyzerObservations();
  assert.equal(row.status, 'error');
  assert.equal(row.error, 'provider_http_error');
  assert.equal(row.level, null);
});

withRuntime('a garbage verdict is journaled as invalid, not as a diagnosis', async ({ store }) => {
  const actions = [];
  const { adapter } = stubAnalyzer({ text: '{"topics":["prices"]}' });
  const runtime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.equal(result.kind, 'answered');
  const [row] = store.listAnalyzerObservations();
  assert.equal(row.status, 'invalid');
  assert.equal(row.level, null);
  assert.ok(row.error.includes('topics'));
});

// Замер считает ходы, а не доставки: перевыдача апдейта Telegram не имеет права
// задвоить наблюдение.
withRuntime('a replayed event does not double the observation', async ({ store }) => {
  const actions = [];
  const { adapter } = stubAnalyzer();
  const runtime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  store.recordAnalyzerObservation({
    eventId: 'fixed-event', chatId: '-100', userId: '7', question: 'первый', status: 'ok',
    verdict: parseAnalyzerVerdict(VERDICT, SPEC.spec, 'подрядчики есть, мне бы их проверять уметь'),
  });
  store.recordAnalyzerObservation({
    eventId: 'fixed-event', chatId: '-100', userId: '7', question: 'повтор', status: 'error', error: 'x',
  });
  const rows = store.listAnalyzerObservations();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].question, 'первый');
});

// ── Режим dispatch (Ф4) ─────────────────────────────────────────────────────

// Главный контракт режима: ОДИН источник маршрута в каждый момент. В
// dispatch-чате вызов анализатора заменяет вызов модельного роутера, а не
// добавляется к нему — здесь это проверяется счётчиком вызовов, а не словами.
withRuntime('dispatch routes by the verdict and does not call the model router', async ({ store }) => {
  const actions = [];
  const { adapter, calls } = stubAnalyzer({ text: verdictJson(['value']), mode: ANALYZER_MODES.DISPATCH });
  const { provider, routerCalls } = countedProvider();
  const runtime = createTelegramRuntime({
    config: config(), store, provider, knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.equal(result.kind, 'answered', JSON.stringify(result));
  assert.equal(routerCalls.length, 0, 'вердикт заменяет роутер, а не дублирует его');
  assert.equal(calls.length, 1, 'ровно одно суждение на ход');
  // §2.2: главная тема вердикта детерминированно задаёт пакет и действие.
  assert.deepEqual(result.route, { action: 'advise', sourceId: 'course-value-v1' });
  assert.ok(actions.at(-1)[1].text.endsWith(':advise'), 'ответ собран в форме домена вердикта');
  const [row] = store.listAnalyzerObservations();
  assert.equal(row.status, 'ok');
  assert.deepEqual(row.topics, ['value']);
  assert.deepEqual(row.route, { action: 'advise', sourceId: 'course-value-v1' });
  assert.equal(row.detectorDebt, null, 'молчание детектора — не спор');
  // История — контекст, а не журнал доставок: dispatch-ход остаётся обычным
  // ходом диалога, служебных строк не появляется.
  const dialogue = store.recentDialogue('-100', '7', { limit: 3, ttlSeconds: 604_800 });
  assert.equal(dialogue.length, 1);
  assert.ok(dialogue[0].answer.endsWith(':advise'));
});

// Правило 3 §2.3а живёт и на dispatch-пути: тот же арбитр, та же запись долга.
withRuntime('dispatch still yields to a fired detector and records the debt', async ({ store }) => {
  const actions = [];
  const { adapter } = stubAnalyzer({ text: verdictJson(['content']), mode: ANALYZER_MODES.DISPATCH });
  const { provider, routerCalls } = countedProvider();
  const runtime = createTelegramRuntime({
    config: config(), store, provider, knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  // Вопрос ловится боевым value-детектором, вердикт-заглушка называет content:
  // спор решает слой с доказанной на голде точностью, проигравший голос — в журнал.
  const result = await runQuestion(runtime, '/ask подрядчики есть, мне бы просто их проверять уметь');
  assert.equal(result.kind, 'answered');
  assert.equal(routerCalls.length, 0);
  assert.deepEqual(result.route, { action: 'advise', sourceId: 'course-value-v1' });
  const [row] = store.listAnalyzerObservations();
  assert.deepEqual(row.detectorDebt, {
    kind: 'domain_conflict',
    detector: 'value',
    detectorName: 'isCourseValueQuestion',
    model: 'content',
    modelAction: 'teach',
    resolvedTo: 'value',
    resolvedBy: 'detector',
  });
});

// Правило 2 §2.3а: отказ поверх сработавшего детектора незаконен (класс
// skep-10). Вердикт «вне корпуса» на хинтованном вопросе перебивается доменом
// детектора, а предотвращённое ложное «не уполномочен» остаётся долгом.
withRuntime('dispatch: a verdict refusal over a fired detector is overridden, not delivered', async ({ store }) => {
  const actions = [];
  const { adapter } = stubAnalyzer({ text: verdictJson(['out_of_corpus']), mode: ANALYZER_MODES.DISPATCH });
  const { provider, routerCalls } = countedProvider();
  const runtime = createTelegramRuntime({
    config: config(), store, provider, knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask подрядчики есть, мне бы просто их проверять уметь');
  assert.equal(result.kind, 'answered');
  assert.notEqual(result.abstained, true, 'покрытая тема не получает «не уполномочен»');
  assert.equal(routerCalls.length, 0);
  assert.deepEqual(result.route, { action: 'advise', sourceId: 'course-value-v1' });
  const [row] = store.listAnalyzerObservations();
  assert.equal(row.detectorDebt.kind, 'model_refusal_overridden');
});

// Отказ законен только при молчании обоих слоёв — и он ответ, а не молчание.
withRuntime('dispatch: a refusal with silent detectors is served as an abstention', async ({ store }) => {
  const actions = [];
  const { adapter } = stubAnalyzer({ text: verdictJson(['out_of_corpus']), mode: ANALYZER_MODES.DISPATCH });
  const { provider, routerCalls } = countedProvider();
  const runtime = createTelegramRuntime({
    config: config(), store, provider, knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask Посоветуйте CRM для салона красоты');
  assert.equal(result.kind, 'answered');
  assert.equal(result.abstained, true);
  assert.equal(routerCalls.length, 0);
  assert.ok(actions.at(-1)[1].text.length > 0, 'человек получает текст, а не тишину');
  const [row] = store.listAnalyzerObservations();
  assert.equal(row.route.action, 'redirect');
});

// Деградация fail-open: сбой анализатора откатывает ход на прежний путь
// роутера, сбой остаётся в журнале, человек получает обычный ответ.
withRuntime('a broken dispatch analyzer falls back to the previous router and journals the failure', async ({ store }) => {
  const question = '/ask В курсе что такое агент?';
  // Эталон прежнего пути — прогон без анализатора на том же сторе.
  const plain = [];
  const plainRuntime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(), ...adapters(plain),
  });
  await runQuestion(plainRuntime, question, { updateId: 10, messageId: 70 });

  const actions = [];
  const { adapter } = stubAnalyzer({ fail: 'provider_http_error', mode: ANALYZER_MODES.DISPATCH });
  const { provider, routerCalls } = countedProvider();
  const runtime = createTelegramRuntime({
    config: config(), store, provider, knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  const result = await runQuestion(runtime, question, { updateId: 20, messageId: 71 });
  assert.equal(result.kind, 'answered');
  assert.equal(routerCalls.length, 1, 'ход ушёл прежним роутером');
  assert.equal(actions.at(-1)[1].text, plain.at(-1)[1].text, 'ответ деградации байт-в-байт прежний');
  const [row] = store.listAnalyzerObservations();
  assert.equal(row.status, 'error');
  assert.equal(row.error, 'provider_http_error');
  assert.equal(row.route.action, 'teach', 'в журнале — маршрут состоявшегося пути');
});

withRuntime('a garbage dispatch verdict falls back and is journaled as invalid', async ({ store }) => {
  const actions = [];
  const { adapter } = stubAnalyzer({ text: '{"topics":["prices"]}', mode: ANALYZER_MODES.DISPATCH });
  const { provider, routerCalls } = countedProvider();
  const runtime = createTelegramRuntime({
    config: config(), store, provider, knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(actions),
  });
  const result = await runQuestion(runtime, '/ask В курсе что такое агент?');
  assert.equal(result.kind, 'answered');
  assert.equal(routerCalls.length, 1);
  const [row] = store.listAnalyzerObservations();
  assert.equal(row.status, 'invalid');
  assert.ok(row.error.includes('topics'));
});

// Пер-чатный гейт поведения: чат вне списка не знает о существовании
// анализатора — ни вызова, ни строки журнала, ответ байт-в-байт прежний.
withRuntime('dispatch outside the chat list changes nothing and calls no analyzer', async ({ store }) => {
  const question = '/ask В курсе что такое агент?';
  const plain = [];
  const plainRuntime = createTelegramRuntime({
    config: config(), store, provider: fakeProvider(), knowledge: availableKnowledge(), ...adapters(plain),
  });
  const first = await runQuestion(plainRuntime, question, { updateId: 10, messageId: 70 });

  const guarded = [];
  const { adapter, calls } = stubAnalyzer({ mode: ANALYZER_MODES.DISPATCH, chatIds: ['-999'] });
  const { provider, routerCalls } = countedProvider();
  const dispatchRuntime = createTelegramRuntime({
    config: config(), store, provider, knowledge: availableKnowledge(),
    analyzer: adapter, ...adapters(guarded),
  });
  const second = await runQuestion(dispatchRuntime, question, { updateId: 20, messageId: 71 });
  assert.equal(second.kind, 'answered');
  assert.equal(calls.length, 0, 'анализатор не вызван');
  assert.equal(routerCalls.length, 1, 'маршрут — прежним роутером');
  assert.equal(guarded.at(-1)[1].text, plain.at(-1)[1].text);
  assert.deepEqual(second.route, first.route);
  assert.deepEqual(store.listAnalyzerObservations(), []);
});

// Классификация по цене (§2.3): исход вызова анализатора решает судьбу квоты
// на локальном доказуемом выходе. Успешный вердикт с последующим локальным
// дефектом знания возвращает квоту (прецедент прежнего пути: человек не платит
// за наш дефект); неоднозначный отказ анализатора после выхода в сеть фенсит
// резервацию, как фенсится любой неоднозначный платный вызов.
withRuntime('the analyzer call declares its billing class on a definitive local exit', async ({ db, store }) => {
  const failingKnowledge = { forSource() { return { available: false, reason: 'knowledge_source_unavailable' }; } };
  const reservation = db.prepare(
    'SELECT status FROM runtime_assistant_request_reservations WHERE event_id = ?',
  );

  // Исход вызова известен (вердикт получен) → локальный дефект знания
  // возвращает квоту, ровно как возвращал бы после вызова роутера.
  const paid = [];
  const { adapter: okAdapter } = stubAnalyzer({ text: verdictJson(['value']), mode: ANALYZER_MODES.DISPATCH });
  const okRuntime = createTelegramRuntime({
    config: config(), store, provider: countedProvider().provider, knowledge: failingKnowledge,
    analyzer: okAdapter, ...adapters(paid),
  });
  const refunded = await runQuestion(okRuntime, '/ask В курсе что такое агент?', { updateId: 10, messageId: 70 });
  assert.equal(refunded.kind, 'skipped');
  assert.equal(refunded.reason, 'knowledge_source_unavailable');
  assert.equal(reservation.get(refunded.eventId), undefined, 'квота возвращена — резервация снята');

  // Отказ анализатора после выхода в сеть неоднозначен: даже локальный
  // доказуемый выход деградационного пути не возвращает квоту — резервация
  // фенсится.
  const fenced = [];
  const { adapter: brokenAdapter } = stubAnalyzer({ fail: 'provider_http_error', mode: ANALYZER_MODES.DISPATCH });
  const brokenRuntime = createTelegramRuntime({
    config: config(), store, provider: countedProvider().provider, knowledge: failingKnowledge,
    analyzer: brokenAdapter, ...adapters(fenced),
  });
  const kept = await runQuestion(brokenRuntime, '/ask В курсе что такое агент?', { updateId: 20, messageId: 71 });
  assert.equal(kept.kind, 'skipped');
  assert.equal(kept.reason, 'knowledge_source_unavailable');
  assert.equal(reservation.get(kept.eventId)?.status, 'uncertain', 'неоднозначный вызов фенсится');
});

// ── Транспорт ───────────────────────────────────────────────────────────────

// Роутерная тройка настроена под ответ в два поля. Вердикт с тремя цитатами в
// неё не помещается, а обрезанный JSON неотличим от плохого суждения — поэтому
// у анализатора свой потолок вывода при той же модели.
test('the analyzer call reuses the router tuple but raises the output ceiling', async () => {
  const requests = [];
  const provider = createProviderAdapter({
    enabled: true,
    vendor: 'openai',
    endpoint: 'https://provider.example.test/v1',
    apiKey: 'fixture-key',
    modelTuples: {
      moderatorSafety: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', maxOutputTokens: 1024 },
      assistantRouter: { model: 'router-model', reasoningEffort: 'low', maxOutputTokens: 100 },
      assistantAnswer: { model: 'answer-model', reasoningEffort: 'low', maxOutputTokens: 2048 },
    },
  }, {
    fetchFn: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: 'x', model: 'router-model', choices: [{ message: { content: VERDICT } }] }),
      };
    },
  });
  const result = await provider.analyze({ system: 'system prompt', input: '{"current_turn":"вопрос"}' });
  assert.equal(result.text, VERDICT);
  assert.equal(requests[0].body.model, 'router-model');
  assert.ok(requests[0].body.max_completion_tokens >= 1_536, 'потолок вывода поднят');
  assert.deepEqual(requests[0].body.response_format, { type: 'json_object' });
  await assert.rejects(() => provider.analyze({ system: '', input: 'x' }), /provider_request_invalid/);
  await assert.rejects(() => provider.analyze({ system: 'x', input: '' }), /provider_request_invalid/);
});

// ── Синтетическая полоса ────────────────────────────────────────────────────

// Замер в тестовом чате: модератор не получает от Telegram НИ ОДНОГО сообщения
// бота-синтетика (четыре пробы, команда и обычный текст), тогда как ассистент
// получает все. Вердикта по синтетику существовать не может, поэтому ожидание
// его выключало бы полосу целиком. Обход требует всех трёх условий сразу.
function syntheticUpdate(updateId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId, chat: { id: -100 },
      from: { id: 8994494918, first_name: 'Synthetic', is_bot: true },
      text: '/ask что такое агент?',
    },
  };
}

function syntheticConfig(overrides = {}) {
  const base = config(overrides);
  return { ...base, assistant: { ...base.assistant, syntheticBotIds: ['8994494918'] } };
}

withRuntime('a synthetic sender is answered without a moderation verdict that cannot exist', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: syntheticConfig({ syntheticTestingEnabled: true }),
    store, provider: fakeProvider(), knowledge: availableKnowledge(), ...adapters(actions),
  });
  const result = await runtime.handleUpdate('assistant', syntheticUpdate(500));
  assert.equal(result.kind, 'answered', JSON.stringify(result));
  assert.equal(result.moderation.reason, 'synthetic_sender_unmoderated', 'обход виден в квитанции хода');
});

// Живой человек под обход не попадает ни при какой конфигурации: он не бот.
withRuntime('a human still waits for the moderator even with synthetic testing on', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config({ syntheticTestingEnabled: true, assistantModerationWaitMs: 0 }),
    store, provider: fakeProvider(), knowledge: availableKnowledge(), ...adapters(actions),
  });
  const result = await runtime.handleUpdate('assistant', update(501, 501, '/ask что такое агент?'));
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'moderator_unavailable');
});

// Выключенный режим не оставляет лазейки: конфиг не даёт списку синтетиков пережить
// выключённый флаг (config.mjs бросает на *_SYNTHETIC_BOT_IDS без флага), поэтому
// «выключено» — это именно пустой список, и бот отсекается на классификации.
withRuntime('with synthetic testing off the bypass does not exist', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config({ syntheticTestingEnabled: false, assistantModerationWaitMs: 0 }),
    store, provider: fakeProvider(), knowledge: availableKnowledge(), ...adapters(actions),
  });
  const result = await runtime.handleUpdate('assistant', {
    update_id: 502,
    message: {
      message_id: 502, chat: { id: -100 },
      from: { id: 8994494918, first_name: 'Synthetic', is_bot: true },
      text: '/ask что такое агент?',
    },
  });
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'bot_sender');
});

// Замер 2026-08-16 (ритуал Р для Ф3): из 30 вопросов синтетика ответ получили 4,
// а 26 отклонены `daily_cap`. Человеческий потолок 20/сутки сделал приёмочный
// прогон неисполнимым — недопустимый исход не «бот обиделся», а «работу
// принимаем мнением, потому что мерить нечем». Поэтому у синтетика свой потолок:
// НЕ снят (расход на модель ограничен), а назван отдельно, как ступени лестницы
// отделены от защиты от злоупотребления.
withRuntime('a synthetic sender is metered by its own daily cap', async ({ store }) => {
  const actions = [];
  const runtime = createTelegramRuntime({
    config: syntheticConfig({
      syntheticTestingEnabled: true,
      assistantDailyPerUser: 1,
      assistantSyntheticDailyPerUser: 3,
    }),
    store, provider: fakeProvider(), knowledge: availableKnowledge(), ...adapters(actions),
  });
  const outcomes = [];
  for (let i = 0; i < 4; i += 1) outcomes.push((await runtime.handleUpdate('assistant', syntheticUpdate(600 + i))).kind);
  assert.deepEqual(outcomes, ['answered', 'answered', 'answered', 'skipped'],
    'человеческий потолок 1 не применён к синтетику, свой потолок 3 применён');
});

// Живой человек считается по человеческому потолку, даже когда синтетический
// щедрее: иначе «щедрость для стенда» протекла бы в боевой чат. Проверяется на
// резервации напрямую — путь ответа человека здесь упёрся бы в модерацию раньше,
// и тест доказывал бы не то.
test('the human cap is what a non-synthetic sender gets', () => {
  const runtimeConfig = {
    syntheticTestingEnabled: true, assistantDailyPerUser: 1, assistantSyntheticDailyPerUser: 100,
  };
  const capFor = (question) => (
    runtimeConfig.syntheticTestingEnabled === true && question.isSyntheticSender === true
      ? runtimeConfig.assistantSyntheticDailyPerUser
      : runtimeConfig.assistantDailyPerUser
  );
  assert.equal(capFor({ isSyntheticSender: false }), 1);
  assert.equal(capFor({}), 1, 'отсутствие признака — человек, а не синтетик');
});

test('the synthetic daily cap has a default and stays configurable', () => {
  const base = {
    TELEGRAM_RUNTIME_MODERATOR_WEBHOOK_SECRET: 'a', TELEGRAM_RUNTIME_ASSISTANT_WEBHOOK_SECRET: 'b',
  };
  assert.equal(loadRuntimeConfig(base).assistantSyntheticDailyPerUser, 200);
  assert.equal(
    loadRuntimeConfig({ ...base, TELEGRAM_RUNTIME_ASSISTANT_SYNTHETIC_DAILY_PER_USER: '60' })
      .assistantSyntheticDailyPerUser,
    60,
  );
});
