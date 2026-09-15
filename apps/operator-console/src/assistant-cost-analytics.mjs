import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const PRICE_CATALOG = Object.freeze(JSON.parse(readFileSync(new URL('./model-prices-v1.json', import.meta.url), 'utf8')));
const RATES = new Map(PRICE_CATALOG.models.map((model) => [model.id, model]));
const PRICE_EFFECTIVE_AT = Date.parse(PRICE_CATALOG.effectiveFrom) / 1000;
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 604_800;

const ANSWER_COLUMNS = Object.freeze([
  'event_id', 'chat_id', 'model_id', 'input_tokens', 'output_tokens', 'total_tokens', 'delivery', 'created_at',
]);
const OBSERVATION_COLUMNS = Object.freeze([
  'event_id', 'status', 'model_id', 'input_tokens', 'output_tokens', 'total_tokens',
  'route_model_id', 'route_input_tokens', 'route_output_tokens', 'route_total_tokens', 'created_at',
]);

function emptyBucket() {
  return { count: 0, pricedCount: 0, unknownCount: 0, knownEstimatedUsd: null, cost: null, averageCostUsd: null };
}

function unavailable(reason) {
  return {
    status: 'unavailable', reason,
    total: null, today: null, week: null,
    coverage: { scope: 'analyzer_chat_subset', allChats: false, observedChatCount: null },
    pricing: { version: PRICE_CATALOG.version, basis: 'standard_uncached_estimate', invoice: false },
    readOnly: true,
  };
}

function tableColumns(db, table) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return null;
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function hasColumns(db, table, required) {
  const actual = tableColumns(db, table);
  return actual != null && required.every((column) => actual.has(column));
}

function token(value) { return Number.isSafeInteger(value) && value >= 0; }

// A model-less answer with no counters is a deterministic no-call answer.
// The current observation table does not say whether the router was attempted,
// so an absent router receipt must remain unknown, even in analyzer chats.
function priceStage({ modelId, inputTokens, outputTokens, totalTokens, recordedAt }, { allowNoCall = false } = {}) {
  if (modelId == null) {
    return allowNoCall && inputTokens == null && outputTokens == null && totalTokens == null
      ? { known: true, usd: 0, noCall: true }
      : { known: false, usd: null, noCall: false };
  }
  const rate = RATES.get(modelId);
  if (!rate || !token(inputTokens) || !token(outputTokens) || !token(totalTokens)
    || totalTokens < inputTokens + outputTokens || !token(recordedAt)
    || recordedAt < PRICE_EFFECTIVE_AT || inputTokens > PRICE_CATALOG.maxStandardInputTokens) {
    return { known: false, usd: null, noCall: false };
  }
  return {
    known: true,
    usd: (inputTokens * rate.inputUsdPerMillion + outputTokens * rate.outputUsdPerMillion) / 1_000_000,
    noCall: false,
  };
}

function questionEstimate(row) {
  if (row.delivery !== 'ok' && row.delivery !== 'partial' && !String(row.delivery || '').startsWith('degraded:')) {
    return { known: false, usd: null };
  }
  if (row.observation_event_id == null) return { known: false, usd: null };
  const answer = priceStage({
    modelId: row.answer_model_id, inputTokens: row.answer_input_tokens,
    outputTokens: row.answer_output_tokens, totalTokens: row.answer_total_tokens,
    recordedAt: row.answer_created_at,
  }, { allowNoCall: true });
  const analyzer = priceStage({
    modelId: row.analyzer_model_id, inputTokens: row.analyzer_input_tokens,
    outputTokens: row.analyzer_output_tokens, totalTokens: row.analyzer_total_tokens,
    recordedAt: row.observation_created_at,
  });
  const router = priceStage({
    modelId: row.router_model_id, inputTokens: row.router_input_tokens,
    outputTokens: row.router_output_tokens, totalTokens: row.router_total_tokens,
    recordedAt: row.observation_created_at,
  });
  if (![answer, analyzer, router].every((stage) => stage.known)) return { known: false, usd: null };
  return { known: true, usd: answer.usd + analyzer.usd + router.usd };
}

function addQuestion(bucket, estimate) {
  bucket.count += 1;
  if (!estimate.known) {
    bucket.unknownCount += 1;
    return;
  }
  bucket.pricedCount += 1;
  bucket.knownEstimatedUsd = (bucket.knownEstimatedUsd ?? 0) + estimate.usd;
}

function finishBucket(bucket) {
  bucket.cost = bucket.count > 0 && bucket.unknownCount === 0 ? bucket.knownEstimatedUsd : null;
  bucket.averageCostUsd = bucket.pricedCount > 0 ? bucket.knownEstimatedUsd / bucket.pricedCount : null;
  return bucket;
}

/**
 * Read-only Assistant Q&A estimates for the analyzer-chat answer journal.
 * Question grain is the unique answer event_id; the observation join is unique.
 * A missing observation or unpriced attempted stage never becomes a zero cost.
 */
export function assistantCostAnalytics(config, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (!config?.runtimeDatabasePath || !token(nowSeconds)) return unavailable('configuration_unavailable');
  let db;
  try {
    db = new Database(config.runtimeDatabasePath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    db.pragma('busy_timeout = 1000');
    if (!hasColumns(db, 'runtime_assistant_answer_records', ANSWER_COLUMNS)
      || !hasColumns(db, 'runtime_assistant_analyzer_observations', OBSERVATION_COLUMNS)) {
      return unavailable('schema_unavailable');
    }

    const query = db.prepare(`
      SELECT a.event_id, a.chat_id, a.created_at AS answer_created_at, a.delivery,
        a.model_id AS answer_model_id, a.input_tokens AS answer_input_tokens,
        a.output_tokens AS answer_output_tokens, a.total_tokens AS answer_total_tokens,
        o.event_id AS observation_event_id, o.status AS analyzer_status,
        o.created_at AS observation_created_at,
        o.model_id AS analyzer_model_id, o.input_tokens AS analyzer_input_tokens,
        o.output_tokens AS analyzer_output_tokens, o.total_tokens AS analyzer_total_tokens,
        o.route_model_id AS router_model_id, o.route_input_tokens AS router_input_tokens,
        o.route_output_tokens AS router_output_tokens, o.route_total_tokens AS router_total_tokens
      FROM runtime_assistant_answer_records a
      LEFT JOIN runtime_assistant_analyzer_observations o ON o.event_id = a.event_id
      ORDER BY a.created_at DESC, a.event_id DESC`);
    const total = emptyBucket(), today = emptyBucket(), week = emptyBucket();
    const observedChats = new Set();
    for (const row of query.iterate()) {
      observedChats.add(row.chat_id);
      const estimate = questionEstimate(row);
      addQuestion(total, estimate);
      if (row.answer_created_at >= nowSeconds - WEEK_SECONDS && row.answer_created_at <= nowSeconds) {
        addQuestion(week, estimate);
      }
      if (row.answer_created_at >= nowSeconds - DAY_SECONDS && row.answer_created_at <= nowSeconds) {
        addQuestion(today, estimate);
      }
    }
    return {
      status: 'available', reason: null,
      total: finishBucket(total), today: finishBucket(today), week: finishBucket(week),
      coverage: {
        scope: 'analyzer_chat_subset', allChats: false, observedChatCount: observedChats.size,
        description: 'Durable answer receipts in normal server runtime are gated to analyzer-enabled chat IDs.',
      },
      pricing: {
        version: PRICE_CATALOG.version, effectiveFrom: PRICE_CATALOG.effectiveFrom,
        verifiedAt: PRICE_CATALOG.verifiedAt, basis: 'standard_uncached_estimate', invoice: false,
      },
      readOnly: true,
    };
  } catch {
    return unavailable('database_unavailable');
  } finally {
    db?.close();
  }
}
