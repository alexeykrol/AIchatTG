import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

function openReadOnly(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 1000');
  return db;
}

function tables(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
}

function isoFromUnix(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : '';
}

function safeJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function safeLimit(value, fallback = 100, maximum = 300) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

function count(db, sql, ...params) {
  return Number(db.prepare(sql).get(...params)?.count) || 0;
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

/**
 * Расход печатается только там, где он измерен. Отсутствующая колонка, ход до
 * появления учёта и детерминированный ответ без вызова модели дают null —
 * консоль покажет «—». Ноль здесь означал бы «вызов был и стоил ноль», а
 * такого не бывает: это выдуманное число в пользовательской поверхности.
 */
function usage(value) {
  // Пустое значение приводится к null ЯВНО: Number(null) === 0, и молчаливое
  // приведение вернуло бы тот самый выдуманный ноль.
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function moderationEvent(row) {
  const action = safeJson(row.action_json);
  const route = row.verdict === 'ban' ? 'threat' : row.verdict === 'suspect' ? 'abuse' : 'clean';
  return {
    id: row.id,
    platform: 'telegram',
    platform_author_id: row.user_id,
    platform_comment_id: `${row.chat_id}:${row.message_id}`,
    post_ref: row.chat_id,
    author_name: null,
    comment_text: '',
    verdict: row.verdict,
    confidence: row.confidence,
    reason: row.reason,
    quote: null,
    prompt_version: 'tg-v3',
    model: null,
    // Расход вызова модерации рантайм сегодня не хранит: счётчики появятся
    // вместе с колонками, и этот же код их подхватит без правки.
    input_tokens: usage(row.input_tokens),
    output_tokens: usage(row.output_tokens),
    cost_usd: null,
    mode: row.mode,
    action_taken: action?.action || action?.status || null,
    owner_verdict: null,
    human_label: null,
    safety_route: route,
    abuse_level: route === 'abuse' ? (String(row.reason || '').includes(':strong:') ? 'strong' : 'weak') : null,
    policy_version: 'telegram-safety-v3',
    classifier_json: null,
    enforcement_receipt_json: row.action_json || null,
    feedback: [],
    created_at: isoFromUnix(row.created_at),
  };
}

function assistantRoute(receipt) {
  const value = safeJson(receipt);
  return typeof value?.route === 'string' ? value.route : null;
}

function assistantEvent(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    author_name: null,
    question: row.question,
    answer: row.answer,
    route: assistantRoute(row.receipt_json),
    model: row.model_id,
    input_tokens: usage(row.input_tokens),
    output_tokens: usage(row.output_tokens),
    cost_usd: null,
    relevance: null,
    error: null,
    created_at: Number(row.created_at) || 0,
  };
}

export function legacyMode(config) {
  const model = config.runtimeModels.moderator;
  const vendor = config.runtimeModels.vendor || 'openai';
  return {
    mode: config.runtimeFlags.moderationMode,
    model,
    vendor,
    modelOverride: model,
    vendorOverride: vendor,
    improverModel: '',
    improverModelOverride: '',
    banThreshold: 0.85,
    hardDelete: false,
    banLinks: true,
    antichannelpin: true,
    telegramConfigured: config.runtimeFlags.ingressEnabled,
    telegramTokenSet: config.runtimeFlags.ingressEnabled,
    telegramChatIdSet: config.runtimeFlags.ingressEnabled,
    telegramAssistantChatCount: config.runtimeFlags.ingressEnabled ? 1 : 0,
    assistantEnabled: config.runtimeFlags.ingressEnabled,
    defaultModel: model,
    defaultVendor: vendor,
    modelCatalog: {
      anthropic: [],
      openai: [model, config.runtimeModels.router, config.runtimeModels.answer]
        .filter(Boolean).filter((value, index, all) => all.indexOf(value) === index)
        .map((id) => ({ id, label: id })),
    },
    telegramSafety: {
      model,
      vendor,
      reasoningEffort: config.runtimeModels.moderatorReasoning,
      policyVersion: 'telegram-safety-v3',
    },
    readOnly: true,
  };
}

export function legacyModerationStats(config) {
  let db;
  try {
    db = openReadOnly(config.runtimeDatabasePath);
    if (!tables(db).has('runtime_moderation_records')) throw new Error('schema unavailable');
    const byVerdict = Object.fromEntries(db.prepare(`SELECT verdict, COUNT(*) AS count
      FROM runtime_moderation_records GROUP BY verdict`).all().map((row) => [row.verdict, Number(row.count) || 0]));
    return {
      totalEvents: Object.values(byVerdict).reduce((sum, value) => sum + value, 0),
      byVerdict,
      cost: { total: null, byMode: { shadow: null, live: null } },
      tokens: { input: 0, output: 0 },
      pending: [],
      outages: [],
      readOnly: true,
    };
  } catch {
    return { totalEvents: 0, byVerdict: {}, cost: { total: null, byMode: {} }, tokens: {}, pending: [], outages: [], readOnly: true };
  } finally { db?.close(); }
}

export function legacyModerationEvents(config, { limit = 300, suspectsOnly = false } = {}) {
  let db;
  try {
    db = openReadOnly(config.runtimeDatabasePath);
    if (!tables(db).has('runtime_moderation_records')) return [];
    const where = suspectsOnly ? "WHERE verdict IN ('ban', 'suspect')" : '';
    return db.prepare(`SELECT * FROM runtime_moderation_records ${where}
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(safeLimit(limit, 300, 300)).map(moderationEvent);
  } catch { return []; } finally { db?.close(); }
}

export function legacyPrompts(config) {
  let text = '';
  try { text = readFileSync(config.safetyPromptPath, 'utf8'); } catch { /* code-owned prompt unavailable */ }
  return {
    platform: 'telegram',
    active: text ? 'tg-v3' : null,
    activeText: text,
    versions: text ? [{ version: 'tg-v3', created_at: null, active: true }] : [],
    readOnly: true,
  };
}

export function legacyAssistantConfig(config) {
  return {
    enabled: config.runtimeFlags.ingressEnabled,
    model: config.runtimeModels.answer,
    vendor: config.runtimeModels.vendor,
    routerModel: config.runtimeModels.router,
    routerVendor: config.runtimeModels.vendor,
    cooldownSec: config.assistantPolicy.cooldownSec,
    dailyPerUser: config.assistantPolicy.dailyPerUser,
    maxTokens: config.runtimeModels.answerMaxTokens,
    prompt: 'Публичная персона и правила ответа принадлежат AIchatTG runtime и изменяются только через проверенный Git-релиз.',
    knowledgeOrg: config.assistantPolicy.knowledgeEnabled ? 'Подключена' : 'Отключена до построения нового индекса.',
    knowledgeContent: config.assistantPolicy.knowledgeEnabled ? 'Подключена' : 'Отключена до построения нового индекса.',
    knowledgeMaxChars: 0,
    readOnly: true,
  };
}

export function legacyAssistantEvents(config, { limit = 100 } = {}) {
  let db;
  try {
    db = openReadOnly(config.runtimeDatabasePath);
    const schema = tables(db);
    if (!schema.has('runtime_assistant_turns') || !schema.has('runtime_assistant_dialogues')) return [];
    // Токены хода лежат в долговечной записи ответа, а не в памяти диалога.
    // База, накопленная до появления учёта, этой таблицы или колонок не имеет —
    // тогда join не строится вовсе, и расход остаётся НЕизмеренным (null),
    // а не обнулённым.
    const metered = schema.has('runtime_assistant_answer_records')
      && ['event_id', 'input_tokens', 'output_tokens']
        .every((name) => columns(db, 'runtime_assistant_answer_records').has(name));
    const usageSelect = metered ? ', answers.input_tokens AS input_tokens, answers.output_tokens AS output_tokens' : '';
    const usageJoin = metered
      ? 'LEFT JOIN runtime_assistant_answer_records answers ON answers.event_id = turns.event_id'
      : '';
    return db.prepare(`SELECT turns.*, dialogues.user_id${usageSelect}
      FROM runtime_assistant_turns turns
      JOIN runtime_assistant_dialogues dialogues ON dialogues.id = turns.dialogue_id
      ${usageJoin}
      ORDER BY turns.created_at DESC, turns.id DESC LIMIT ?`).all(safeLimit(limit, 100, 300)).map(assistantEvent);
  } catch { return []; } finally { db?.close(); }
}

export function legacyAssistantAnalytics(config) {
  let db;
  try {
    db = openReadOnly(config.runtimeDatabasePath);
    if (!tables(db).has('runtime_assistant_turns')) throw new Error('schema unavailable');
    const now = Math.floor(Date.now() / 1000);
    const total = count(db, 'SELECT COUNT(*) AS count FROM runtime_assistant_turns');
    const today = count(db, 'SELECT COUNT(*) AS count FROM runtime_assistant_turns WHERE created_at >= ?', now - 86_400);
    const week = count(db, 'SELECT COUNT(*) AS count FROM runtime_assistant_turns WHERE created_at >= ?', now - 604_800);
    return { total: { count: total, cost: null }, today: { count: today, cost: null }, week: { count: week, cost: null }, readOnly: true };
  } catch {
    return { total: { count: 0, cost: null }, today: { count: 0, cost: null }, week: { count: 0, cost: null }, readOnly: true };
  } finally { db?.close(); }
}

export function legacyEvalStatus() {
  return { state: { status: 'idle', reason: 'eval_not_migrated' }, result: null, readOnly: true };
}
