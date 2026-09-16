#!/usr/bin/env node
/**
 * Локальный стенд ассистента: задать вопрос и получить ответ БЕЗ Telegram и без
 * боевого сервера.
 *
 * Зачем: прогонять диалоги синтетического пользователя в лаборатории — дёшево,
 * повторяемо и без риска для боевого чата. Это ПОТРЕБИТЕЛЬ боевых фабрик, а не
 * их копия: путь ответа тот же самый (домен → вето → ретривер → гейт молчания →
 * отбор фрагментов → модель), потому что вопрос входит через настоящий
 * `runtime.handleUpdate('assistant', …)`, а не через сокращённую ветку.
 *
 * Подменены ровно три вещи на границах, и каждая помечена в отчёте как
 * `substitutions`, чтобы никто не принял стенд за бой:
 *   1. Telegram-транспорт — поддельный: пишет исходящее в память и возвращает
 *      правдоподобную квитанцию вместо сети.
 *   2. Модератор — лабораторный: безопасность живого чата здесь не измеряется,
 *      а без вердикта `allowed` ассистент по конструкции молчит. Вызывается
 *      настоящий `handleUpdate('moderator', …)`, вердикт выносит локальный
 *      судья вместо safety-модели.
 *   3. Хранилище — временная SQLite во временном каталоге: прогон не трогает
 *      боевые данные и каждый запуск начинается с чистого листа.
 *
 * Всё остальное настоящее, включая допуск пакета знания с пересчётом sha256
 * каждого файла (это гард, а не формальность: подменённый ai.db не пройдёт).
 *
 * Режимы провайдера:
 *   --dry   (по умолчанию) модель НЕ вызывается. Показывает, что нашёл ретривер
 *           и что ушло БЫ в модель. Бесплатно.
 *   --live  настоящий вызов провайдера; ключ и эндпоинт из окружения. Без ключа
 *           стенд честно говорит об этом и выходит, а не выдумывает ответ.
 *
 * Запуск:
 *   node apps/telegram-runtime/scripts/local-assistant.mjs \
 *     --package <dir с knowledge.manifest.json> --ask "Что такое промптинг?"
 *   … --dialogue вопросы.txt --out стенограмма.json
 *   … --live
 *   … --org-slice <org_slice.json>   операционный домен (или AICHATTG_ORG_SLICE_PATH)
 *   … --value-slice <value_slice.json>   домен пользы (или AICHATTG_VALUE_SLICE_PATH)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ASSISTANT_SOURCE_PACKAGES,
} from '@aichattg/telegram-core';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';
import { createKnowledgeAdapter } from '../src/knowledge-adapter.mjs';
import { createKnowledgeRetrieval } from '../src/knowledge-retrieval.mjs';
import { createOrgSliceKnowledge, withOrgSlice } from '../src/org-slice.mjs';
import { createValueSliceKnowledge, withValueSlice } from '../src/value-slice.mjs';
import { createProviderAdapter } from '../src/provider-adapter.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import { createAnalyzerAdapter } from '../src/analyzer-adapter.mjs';
import { runtimeAnalyzerSpec } from '../src/analyzer-spec.mjs';
import { DEFAULT_DOMAIN_CATALOG } from '../src/assistant-domains.mjs';

const LAB_CHAT_ID = '-100';
const LAB_USER_ID = '7';
const DEFAULT_MAX_ENTRIES = 12;
const DEFAULT_MAX_CONTEXT_TOKENS = 6_000;

export const LAB_SUBSTITUTIONS = Object.freeze([
  'telegram_transport_recorded_in_memory',
  'moderator_verdict_decided_locally_without_safety_model',
  'store_is_a_temporary_sqlite_file',
]);

export const DRY_SUBSTITUTIONS = Object.freeze([
  'router_is_fake_catalog_hints_else_first_retrieval_domain_not_semantic_measurement',
  'answer_model_not_called_input_count_only',
]);

function parseArgs(argv) {
  const args = {
    mode: 'dry', questions: [], out: null, maxEntries: DEFAULT_MAX_ENTRIES,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS, packageDir: null, json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].split('=');
    // Флаги без значения не должны съедать следующий аргумент — на этом ломался
    // разбор `--dry --ask "…"`.
    if (key === '--dry') { args.mode = 'dry'; continue; }
    if (key === '--live') { args.mode = 'live'; continue; }
    if (key === '--json') { args.json = true; continue; }
    const value = inline ?? argv[i + 1];
    if (inline === undefined) i += 1;
    if (key === '--ask') args.questions.push(String(value ?? ''));
    else if (key === '--dialogue') args.dialogue = value;
    else if (key === '--package') args.packageDir = value;
    else if (key === '--org-slice') args.orgSlicePath = value;
    else if (key === '--value-slice') args.valueSlicePath = value;
    else if (key === '--out') args.out = value;
    else if (key === '--max-entries') args.maxEntries = Number(value);
    else if (key === '--max-context-tokens') args.maxContextTokens = Number(value);
  }
  return args;
}

/** Один вопрос на строку; пустые строки и `#`-комментарии игнорируются. */
export function parseDialogueFile(raw) {
  return String(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * Поддельный Telegram: записывает исходящее и возвращает квитанцию той же формы,
 * что настоящий адаптер (`{ ok, data.message_id }`), потому что рантайм читает
 * из неё message_id и без него считает доставку несостоявшейся.
 */
export function createRecordingTelegram() {
  const sent = [];
  let nextMessageId = 1_000;
  return {
    sent,
    async sendMessage(input) {
      nextMessageId += 1;
      sent.push({ ...input, text: input.footer ? `${input.text}\n\n${input.footer}` : input.text,
        messageId: String(nextMessageId) });
      return { ok: true, data: { message_id: nextMessageId } };
    },
  };
}

/**
 * Лабораторный модератор. Безопасность здесь не измеряется, но ассистент по
 * конструкции не отвечает без терминального вердикта, поэтому конструкция его
 * требует. Судья локальный и всегда `clean`: подменять его моделью значит
 * платить за то, что стенд не проверяет.
 */
function createLabModeratorGuard() {
  return {
    async verifyEnforcement() { return { proven: true, status: 'administrator' }; },
    async senderDisposition() { return { proven: true, exempt: false, reason: null }; },
    async deleteMessage() { return { ok: true }; },
    async unpinMessage() { return { ok: true }; },
    async sendWarning() { return { ok: true }; },
    async banAuthor() { return { ok: true }; },
  };
}

/**
 * Локальная подстановка, НЕ измерение понимания вопроса моделью. Берёт все
 * готовые подсказки доменов из контракта рантайма; без них выбирает первый
 * retrieval-домен каталога только для проверки проводки поиска. Ни словарей
 * предметных маркеров, ни самостоятельного классификатора здесь нет.
 * `answer` фиксирует то, что ушло БЫ в модель, не вызывая сеть.
 */
export function createDryProvider({ captured, domainCatalog = DEFAULT_DOMAIN_CATALOG }) {
  return {
    async moderate(input) {
      const { labSafetyVerdict } = await import('./lib/lab-safety.mjs');
      return labSafetyVerdict(input);
    },
    async routeAssistant({ domainHints }) {
      if (Array.isArray(domainHints?.domains) && domainHints.domains.length) {
        return { domains: [...domainHints.domains] };
      }
      const fallback = domainCatalog.domains.find((domain) => domain.sourceKind === 'retrieval');
      return { domains: fallback ? [fallback.id] : [] };
    },
    async answer(input) {
      const entries = input.knowledge?.entries || [];
      captured.push({ question: input.text, route: input.route, entries, dialogue: input.dialogue || [] });
      return {
        // Ответа модели в dry-режиме не существует. Отдаём явную метку вместо
        // правдоподобного текста: подделанный ответ обесценил бы весь прогон.
        text: `[dry-run: модель не вызывалась; в неё ушло бы ${entries.length} записей]`,
        modelId: 'dry-run',
        receipt: null,
      };
    },
  };
}

/**
 * Живой режим. Роутер и ответ идут через настоящий провайдерский адаптер;
 * модерацию по-прежнему судит лаборатория, чтобы прогон диалога не оплачивал
 * safety-вызовы, которых он не измеряет.
 */
function createLiveProvider(env) {
  const endpoint = String(env.TELEGRAM_RUNTIME_PROVIDER_ENDPOINT || '');
  const apiKey = String(env.TELEGRAM_RUNTIME_PROVIDER_API_KEY || '');
  const provider = createProviderAdapter({
    enabled: true,
    vendor: 'openai',
    endpoint,
    apiKey,
    modelTuples: {
      // Safety-кортеж обязан быть валидным для конструктора адаптера, но
      // `moderate` ниже перехвачен лабораторным судьёй и никогда не вызывается.
      moderatorSafety: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', maxOutputTokens: 1_024 },
      assistantRouter: {
        model: String(env.TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MODEL || 'gpt-5.6-terra'),
        reasoningEffort: String(env.TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_REASONING_EFFORT || 'low'),
        maxOutputTokens: Number(env.TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MAX_OUTPUT_TOKENS || 1_024),
      },
      assistantAnswer: {
        model: String(env.TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MODEL || 'gpt-5.6-terra'),
        reasoningEffort: String(env.TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_REASONING_EFFORT || 'medium'),
        maxOutputTokens: Number(env.TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MAX_OUTPUT_TOKENS || 2_048),
      },
    },
  });
  const receipts = [];
  return {
    receipts,
    provider: {
      async moderate(input) {
        const { labSafetyVerdict } = await import('./lib/lab-safety.mjs');
        return labSafetyVerdict(input);
      },
      async routeAssistant(payload) {
        const route = await provider.routeAssistant(payload);
        if (route?.receipt) receipts.push(route.receipt);
        return route;
      },
      async answer(payload) {
        const answer = await provider.answer(payload);
        if (answer?.receipt) receipts.push(answer.receipt);
        return answer;
      },
    },
  };
}

function labConfig({ maxEntries, maxContextTokens, packageManifestPath, packageDigest, packageRoot }) {
  return {
    ingressEnabled: false,
    moderationMode: 'shadow',
    moderationBanLinks: false,
    moderationAntichannelPin: false,
    // Ноль ожидания: модератор в лаборатории отрабатывает синхронно до вопроса,
    // поэтому опрос диспозиции не должен упираться в боевой 30-секундный таймаут.
    assistantModerationWaitMs: 0,
    assistantModerationPollMs: 1,
    assistantKnowledgeEnabled: true,
    // Лимиты боевого чата в лаборатории только мешают: синтетический диалог
    // идёт подряд и упёрся бы в кулдаун на втором же вопросе.
    assistantCooldownSec: 0,
    assistantDailyPerUser: 10_000,
    assistantDialogueTtlSec: 604_800,
    assistantDialogueTurnLimit: 3,
    assistantRetrieval: {
      enabled: true, maxEntries, maxContextTokens, rewriteEnabled: false, validatePacks: true,
    },
    knowledge: {
      root: packageRoot,
      admissions: {
        [ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE]: {
          manifestPath: packageManifestPath,
          packageRoot,
          expectedIdentity: {
            sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE,
            packageDigest,
          },
        },
      },
    },
    moderator: {
      chatIds: [LAB_CHAT_ID], botToken: '', botUsername: '', webhookSecret: 'lab', exemptBotIds: [], syntheticBotIds: [],
    },
    assistant: {
      chatIds: [LAB_CHAT_ID], botToken: '', botUsername: 'lab_assistant_bot', webhookSecret: 'lab',
      exemptBotIds: [], syntheticBotIds: [],
    },
    moderatorRecoverySnapshotTtlSec: 604_800,
    moderatorRecoveryLeaseSec: 90,
    moderatorRecoveryMaxSafeRetries: 3,
    moderatorRecoveryBackoffSec: 60,
  };
}

function labUpdate(updateId, messageId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: Number(LAB_CHAT_ID) },
      from: { id: Number(LAB_USER_ID), first_name: 'Lab', is_bot: false },
      text,
    },
  };
}

/**
 * Единицы (уроки) со ссылками — то, ради чего вообще нужен ретривер. Берутся из
 * записей, которые ушли в модель, а не из всего пака: отчёт должен показывать
 * то, что реально видела модель.
 */
function unitsOf(entries) {
  const seen = new Map();
  for (const entry of entries || []) {
    const url = entry?.canonicalUrl || null;
    const title = entry?.title || null;
    if (!title && !url) continue;
    const key = `${title}|${url}`;
    if (!seen.has(key)) seen.set(key, { title, url });
  }
  return [...seen.values()];
}

/**
 * Рантайм отдаёт маршрут двумя разными формами: строкой для детерминированных и
 * граничных ответов (`boundary:not_in_materials:…`) и объектом роутера для
 * содержательных (`{ action, sourceId }`). Отчёт для внешнего оценщика должен
 * быть плоским, поэтому обе формы сводятся к одной строке здесь, а не у
 * читателя стенограммы.
 */
function routeLabel(route) {
  if (route == null) return null;
  if (typeof route === 'string') return route;
  const action = String(route.action || '');
  const sourceId = route.sourceId == null ? '' : String(route.sourceId);
  return sourceId ? `${action}:${sourceId}` : action;
}

/**
 * Неизвестный домен и известный домен с недостающим материалом — разные
 * вердикты. Старый not_in_materials остаётся читаемым для прежних маршрутов.
 * В dry-режиме эти метки описывают проводку после подставленного маршрута,
 * а не качество модельной классификации.
 */
function abstentionVerdict(routeString) {
  if (typeof routeString !== 'string') return null;
  if (routeString.startsWith('boundary:out_of_coverage:')) return 'out_of_coverage';
  if (routeString === 'boundary:domain_knowledge_missing') return 'domain_knowledge_missing';
  if (routeString.startsWith('boundary:not_in_materials:')) return 'not_in_materials';
  return null;
}

function costOf(receipt) {
  if (!receipt) return null;
  return {
    model: receipt.modelId || null,
    reasoningEffort: receipt.reasoningEffort || null,
    inputTokens: receipt.inputTokens ?? null,
    outputTokens: receipt.outputTokens ?? null,
    totalTokens: receipt.totalTokens ?? null,
    // Провайдерская квитанция намеренно не считает деньги: цена зависит от
    // тарифа, который рантайм не знает. Оставляем токены как измеренный факт.
    costUsd: receipt.costUsd ?? null,
  };
}

/** Shared real Assistant factories. Managed mode changes only storage, identity and explicit providers. */
export function createLocalAssistantSession({
  databasePath, packageDir, orgSlicePath = null, valueSlicePath = null,
  mode = 'dry', maxEntries = DEFAULT_MAX_ENTRIES, maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS,
  env = {}, provider: injectedProvider = null, workingStateProvider = null, durableAnswerReceipts = false,
  identity = { chatId: LAB_CHAT_ID, userId: LAB_USER_ID }, analyzerMode = 'off',
  now = () => Math.floor(Date.now() / 1000),
}) {
  const packageRoot = resolve(packageDir);
  const manifestPath = join(packageRoot, 'knowledge.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const database = openRuntimeDatabase(databasePath);
  const store = createRuntimeStore(database, { now });
  const captured = [];
  const live = mode === 'live' ? createLiveProvider(env) : null;
  const provider = injectedProvider || (live ? live.provider : createDryProvider({ captured }));

  const config = labConfig({
    maxEntries,
    maxContextTokens,
    packageManifestPath: manifestPath,
    packageDigest: String(manifest.packageDigest || ''),
    packageRoot,
  });

  config.moderator.chatIds = [identity.chatId];
  config.assistant.chatIds = [identity.chatId];
  const analyzer = createAnalyzerAdapter({
    config: { mode: analyzerMode, chatIds: [identity.chatId] },
    provider, spec: runtimeAnalyzerSpec().spec,
  });

  // Настоящий допуск: манифест читается, sha256 каждого файла пересчитывается.
  const baseKnowledge = createKnowledgeAdapter(config.knowledge);
  // Каждый срез подменяет ровно свой источник (org — операционный, value —
  // пользу); содержательный пакет и его ретривер остаются нетронутыми, и оба
  // среза могут быть подключены одновременно.
  const orgSlice = orgSlicePath ? createOrgSliceKnowledge(orgSlicePath) : null;
  const valueSlice = valueSlicePath ? createValueSliceKnowledge(valueSlicePath) : null;
  const knowledge = withValueSlice(withOrgSlice(baseKnowledge, orgSlice), valueSlice);
  const contentRetrieval = createKnowledgeRetrieval(config.assistantRetrieval, { knowledge: baseKnowledge });
  const assistantTelegram = createRecordingTelegram();
  const runtime = createTelegramRuntime({
    config,
    store,
    analyzer,
    workingStateProvider,
    durableAnswerReceipts,
    provider,
    knowledge,
    contentRetrieval,
    moderatorTelegram: createRecordingTelegram(),
    guard: createLabModeratorGuard(),
    assistantTelegram,
    notifier: { async notify() { return { delivered: false, skipped: 'lab' }; } },
  });

  return { runtime, store, database, config, captured, live, assistantTelegram,
    manifest, packageRoot, contentRetrieval, orgSlice, valueSlice,
    async ask(index, text) {
      const message = { message_id: index + 1, chat: { id: Number(identity.chatId) },
        from: { id: Number(identity.userId), first_name: 'Lab', is_bot: false }, text: `/ask ${text}` };
      await runtime.handleUpdate('moderator', { update_id: index * 2 + 1, message });
      return runtime.handleUpdate('assistant', { update_id: index * 2 + 2, message });
    },
    completedPair(index, pairId, expectedQuestion) {
      const eventId = `assistant:${index * 2 + 2}`;
      const row = database.prepare('SELECT * FROM runtime_assistant_answer_records WHERE event_id = ?').get(eventId);
      const receipt = database.prepare('SELECT * FROM runtime_inbound_update_receipts WHERE receipt_id = ?').get(eventId);
      if (!row || receipt?.status !== 'completed' || JSON.parse(receipt.result_json || '{}').kind !== 'answered'
        || row.chat_id !== identity.chatId || row.user_id !== identity.userId || row.question !== expectedQuestion) return null;
      return { id: pairId, event_id: eventId,
        user: { turn_id: `${pairId}:user`, text: row.question, timestamp: receipt.received_at },
        assistant: { turn_id: `${pairId}:assistant`, text: row.answer, timestamp: row.created_at },
        answer_usage: { modelId: row.model_id, inputTokens: row.input_tokens, outputTokens: row.output_tokens, totalTokens: row.total_tokens },
        delivery: row.delivery };
    },
    close() { contentRetrieval.close?.(); database.close(); },
  };
}

/**
 * Один прогон стенда. Вынесен из main отдельной функцией, чтобы тест мог
 * вызвать ровно то же самое без подмены аргументов процесса.
 */
export async function runLocalAssistant({
  questions,
  packageDir,
  orgSlicePath = null,
  valueSlicePath = null,
  mode = 'dry',
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS,
  env = process.env,
} = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-local-assistant-'));
  const session = createLocalAssistantSession({ packageDir, orgSlicePath, valueSlicePath,
    mode, maxEntries, maxContextTokens, env, databasePath: join(folder, 'lab-runtime.db') });
  const { database, store, captured, live, runtime, manifest, packageRoot, contentRetrieval,
    assistantTelegram, orgSlice, valueSlice } = session;

  const transcript = {
    dialogue_id: `lab:${Date.now()}`,
    mode,
    package: {
      root: packageRoot,
      domainId: manifest.domainId || null,
      packageName: manifest.packageName || null,
      packageDigest: manifest.packageDigest || null,
      admitted: contentRetrieval.available === true,
      admissionReason: contentRetrieval.reason || null,
    },
    org_slice: orgSlicePath
      ? {
        path: orgSlicePath,
        admitted: orgSlice?.available === true,
        admissionReason: orgSlice?.reason || null,
        entries: orgSlice?.snapshot?.entries?.length ?? 0,
      }
      : null,
    value_slice: valueSlicePath
      ? {
        path: valueSlicePath,
        admitted: valueSlice?.available === true,
        admissionReason: valueSlice?.reason || null,
        entries: valueSlice?.snapshot?.entries?.length ?? 0,
      }
      : null,
    substitutions: [...LAB_SUBSTITUTIONS, ...(mode === 'dry' ? DRY_SUBSTITUTIONS : [])],
    turns: [],
    coverage_deficits: [],
  };

  if (!contentRetrieval.available) {
    contentRetrieval.close?.();
    database.close();
    rmSync(folder, { recursive: true, force: true });
    return transcript;
  }

  let updateId = 1;
  let messageId = 1;
  for (const [index, question] of questions.entries()) {
    const askText = question.startsWith('/ask') ? question : `/ask ${question}`;
    messageId += 1;
    const capturedBefore = captured.length;
    const receiptsBefore = live ? live.receipts.length : 0;
    const sentBefore = assistantTelegram.sent.length;

    // Настоящий путь: сперва модератор выносит терминальный вердикт по этому же
    // сообщению, иначе ассистент по конструкции не отвечает.
    await runtime.handleUpdate('moderator', labUpdate(updateId++, messageId, askText));
    const result = await runtime.handleUpdate('assistant', labUpdate(updateId++, messageId, askText));

    const sent = assistantTelegram.sent.slice(sentBefore);
    const call = captured.slice(capturedBefore).at(-1) || null;
    const receipt = live ? live.receipts.slice(receiptsBefore).at(-1) || null : null;
    const entries = call?.entries || null;

    const turnRoute = routeLabel(result.route ?? null);
    transcript.turns.push({
      n: index + 1,
      question,
      answer: sent.at(-1)?.text ?? null,
      kind: result.kind,
      route: turnRoute,
      abstained: result.abstained === true,
      verdict: abstentionVerdict(turnRoute),
      reason: result.reason ?? null,
      entries: entries == null ? 0 : entries.length,
      // Сколько предыдущих ходов ушло в модель вместе с вопросом. Это
      // наблюдаемое доказательство того, что диалоговая память работает: без
      // него «одна сессия» осталась бы утверждением, а не фактом.
      dialogueTurnsSent: call?.dialogue?.length ?? 0,
      units: unitsOf(entries),
      cost: costOf(receipt),
      // В dry-режиме модели не было — null здесь означает «вызова не было», а не
      // «модель неизвестна».
      model: receipt?.modelId ?? null,
    });
  }

  // Журнал дефицитов из tmp-БД прогона: рантайм записал его тем же кодом, что
  // и бой, а стенограмма выносит его наружу, потому что сама БД сейчас умрёт.
  transcript.coverage_deficits = store.listCoverageDeficits({ limit: 1_000 });

  contentRetrieval.close?.();
  database.close();
  rmSync(folder, { recursive: true, force: true });
  return transcript;
}

function printTranscript(transcript) {
  console.log(`пакет: ${transcript.package.packageName} (домен ${transcript.package.domainId})`);
  console.log(`допуск: ${transcript.package.admitted ? 'пройден (sha256 пересчитан)' : `ОТКАЗ — ${transcript.package.admissionReason}`}`);
  if (transcript.org_slice) {
    console.log(`орг-срез: ${transcript.org_slice.admitted
      ? `подключён, записей ${transcript.org_slice.entries}`
      : `ОТКАЗ — ${transcript.org_slice.admissionReason}`} (${transcript.org_slice.path})`);
  }
  if (transcript.value_slice) {
    console.log(`value-срез: ${transcript.value_slice.admitted
      ? `подключён, записей ${transcript.value_slice.entries}`
      : `ОТКАЗ — ${transcript.value_slice.admissionReason}`} (${transcript.value_slice.path})`);
  }
  console.log(`режим: ${transcript.mode}`);
  console.log(`подменено: ${transcript.substitutions.join(', ')}`);
  for (const turn of transcript.turns) {
    console.log('');
    console.log(`--- ход ${turn.n} ---`);
    console.log(`вопрос:      ${turn.question}`);
    console.log(`исход:       ${turn.kind}${turn.reason ? ` (${turn.reason})` : ''}`);
    console.log(`маршрут:     ${turn.route ?? '—'}`);
    console.log(`воздержание: ${turn.abstained ? `ДА (${turn.verdict ?? 'без вердикта'})` : 'нет'}`);
    console.log(`записей в модель: ${turn.entries}`);
    for (const unit of turn.units) {
      console.log(`  • ${unit.title ?? '(без заголовка)'}${unit.url ? ` — ${unit.url}` : ''}`);
    }
    if (turn.cost) {
      console.log(`стоимость:   модель ${turn.cost.model} effort=${turn.cost.reasoningEffort} `
        + `токены ${turn.cost.inputTokens}/${turn.cost.outputTokens} (всего ${turn.cost.totalTokens})`);
    }
    console.log(`ответ:       ${turn.answer ?? '—'}`);
  }
  if (transcript.coverage_deficits.length) {
    console.log('');
    console.log(`журнал дефицитов (${transcript.coverage_deficits.length}):`);
    for (const deficit of transcript.coverage_deficits) {
      console.log(`  • [${deficit.candidateLevel ?? '—'}] ${deficit.question} (${deficit.reason})`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageDir = args.packageDir || process.env.AICHATTG_KNOWLEDGE_PACKAGE_DIR || '';
  if (!packageDir) {
    console.error('нужен --package <каталог с knowledge.manifest.json> (или AICHATTG_KNOWLEDGE_PACKAGE_DIR)');
    return 2;
  }
  const questions = [
    ...args.questions,
    ...(args.dialogue ? parseDialogueFile(readFileSync(args.dialogue, 'utf8')) : []),
  ];
  if (!questions.length) {
    console.error('нужен хотя бы один --ask "вопрос" или --dialogue <файл>');
    return 2;
  }
  if (args.mode === 'live' && !String(process.env.TELEGRAM_RUNTIME_PROVIDER_API_KEY || '').trim()) {
    // Честный выход вместо выдуманного ответа: без ключа живого вызова нет.
    console.error('режим --live требует TELEGRAM_RUNTIME_PROVIDER_API_KEY (и TELEGRAM_RUNTIME_PROVIDER_ENDPOINT вида https://host/v1)');
    return 2;
  }

  const transcript = await runLocalAssistant({
    questions, packageDir, mode: args.mode,
    orgSlicePath: args.orgSlicePath || process.env.AICHATTG_ORG_SLICE_PATH || null,
    valueSlicePath: args.valueSlicePath || process.env.AICHATTG_VALUE_SLICE_PATH || null,
    maxEntries: args.maxEntries, maxContextTokens: args.maxContextTokens,
  });

  if (args.json) console.log(JSON.stringify(transcript, null, 2));
  else printTranscript(transcript);
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(transcript, null, 2), 'utf8');
    console.log(`\nстенограмма: ${args.out}`);
  }
  return transcript.package.admitted ? 0 : 1;
}

// Запуск как скрипта; при импорте из теста main не выполняется.
if (process.argv[1] && process.argv[1].endsWith('local-assistant.mjs')) {
  process.exit(await main());
}
