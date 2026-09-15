import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const PRICE_CATALOG = Object.freeze(JSON.parse(readFileSync(new URL('./model-prices-v1.json', import.meta.url), 'utf8')));
const RATES = new Map(PRICE_CATALOG.models.map((model) => [model.id, model]));
const PRICE_EFFECTIVE_AT = Date.parse(PRICE_CATALOG.effectiveFrom) / 1000;
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 604_800;
const LAST_QUESTION_LIMIT = 5;
const QUESTION_EXCERPT_LIMIT = 240;

const ANSWER_COLUMNS = Object.freeze([
  'event_id', 'chat_id', 'question', 'model_id', 'input_tokens', 'output_tokens', 'total_tokens', 'delivery', 'created_at',
]);
const OBSERVATION_COLUMNS = Object.freeze([
  'event_id', 'status', 'model_id', 'input_tokens', 'output_tokens', 'total_tokens',
  'route_model_id', 'route_input_tokens', 'route_output_tokens', 'route_total_tokens', 'created_at',
]);
const RECEIPT_COLUMNS = Object.freeze(['receipt_id', 'bot_role', 'status', 'result_json']);

function emptyBucket() {
  return {
    count: 0, pricedCount: 0, unknownCount: 0, partiallyPricedCount: 0,
    knownEstimatedUsd: null, knownStagesUsd: null, cost: null, averageCostUsd: null,
  };
}

function unavailable(reason) {
  return {
    status: 'unavailable', reason,
    total: null, today: null, week: null, lastFive: null,
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

function unknownStage({ modelId = null, inputTokens = null, outputTokens = null } = {}) {
  return { known: false, usd: null, noCall: false, modelId, inputTokens, outputTokens };
}

// A model-less answer is a deterministic no-call answer. A router no-call
// needs the completed event's code-owned analyzer-dispatch diagnosis as proof.
function priceStage({ modelId, inputTokens, outputTokens, totalTokens, recordedAt }, { allowNoCall = false } = {}) {
  if (modelId == null) {
    return allowNoCall && inputTokens == null && outputTokens == null && totalTokens == null
      ? { known: true, usd: 0, noCall: true, modelId: null, inputTokens: null, outputTokens: null }
      : unknownStage({ modelId, inputTokens, outputTokens });
  }
  const rate = RATES.get(modelId);
  if (!rate || !token(inputTokens) || !token(outputTokens) || !token(totalTokens)
    || totalTokens < inputTokens + outputTokens || !token(recordedAt)
    || recordedAt < PRICE_EFFECTIVE_AT || inputTokens > PRICE_CATALOG.maxStandardInputTokens) {
    return unknownStage({ modelId, inputTokens, outputTokens });
  }
  return {
    known: true,
    usd: (inputTokens * rate.inputUsdPerMillion + outputTokens * rate.outputUsdPerMillion) / 1_000_000,
    noCall: false, modelId, inputTokens, outputTokens,
  };
}

function questionEstimate(row) {
  if (row.delivery !== 'ok' && row.delivery !== 'partial' && !String(row.delivery || '').startsWith('degraded:')) {
    return {
      known: false, usd: null, knownStagesUsd: null,
      stages: { answer: unknownStage(), analyzer: unknownStage(), router: unknownStage() },
    };
  }
  const answer = priceStage({
    modelId: row.answer_model_id, inputTokens: row.answer_input_tokens,
    outputTokens: row.answer_output_tokens, totalTokens: row.answer_total_tokens,
    recordedAt: row.answer_created_at,
  }, { allowNoCall: true });
  const analyzer = row.observation_event_id == null ? unknownStage() : priceStage({
    modelId: row.analyzer_model_id, inputTokens: row.analyzer_input_tokens,
    outputTokens: row.analyzer_output_tokens, totalTokens: row.analyzer_total_tokens,
    recordedAt: row.observation_created_at,
  });
  const dispatchOrigin = row.receipt_origin === 'analyzer_dispatch';
  const routerUsageAbsent = [row.router_model_id, row.router_input_tokens,
    row.router_output_tokens, row.router_total_tokens].every((value) => value == null);
  const routerNoCall = dispatchOrigin && row.observation_event_id != null
    && row.analyzer_status === 'ok' && routerUsageAbsent;
  const router = dispatchOrigin && !routerUsageAbsent ? unknownStage({
    modelId: row.router_model_id, inputTokens: row.router_input_tokens,
    outputTokens: row.router_output_tokens,
  }) : priceStage({
    modelId: row.router_model_id, inputTokens: row.router_input_tokens,
    outputTokens: row.router_output_tokens, totalTokens: row.router_total_tokens,
    recordedAt: row.observation_created_at,
  }, { allowNoCall: routerNoCall });
  const stages = { answer, analyzer, router };
  const known = Object.values(stages).every((stage) => stage.known);
  const sum = Object.values(stages).reduce((usd, stage) => usd + (stage.known ? stage.usd : 0), 0);
  return {
    known, usd: known ? sum : null,
    // A proved zero for one stage must not resemble a zero-priced whole question.
    knownStagesUsd: known || sum > 0 ? sum : null, stages,
  };
}

function addQuestion(bucket, estimate) {
  bucket.count += 1;
  if (estimate.knownStagesUsd != null) {
    bucket.knownStagesUsd = (bucket.knownStagesUsd ?? 0) + estimate.knownStagesUsd;
  }
  if (!estimate.known) {
    bucket.unknownCount += 1;
    if (estimate.knownStagesUsd != null) bucket.partiallyPricedCount += 1;
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

function answerRows(db, { receiptsAvailable } = {}) {
  const receiptProjection = receiptsAvailable ? `,
    CASE WHEN json_valid(r.result_json) = 1 THEN
      CASE WHEN json_extract(r.result_json, '$.eventId') = a.event_id
        AND json_extract(r.result_json, '$.kind') = 'answered'
        AND json_extract(r.result_json, '$.routingDiagnosis.schemaVersion') = 'assistant-routing-diagnosis-v1'
      THEN json_extract(r.result_json, '$.routingDiagnosis.origin') END
    END AS receipt_origin` : ', NULL AS receipt_origin';
  const receiptJoin = receiptsAvailable ? `LEFT JOIN runtime_inbound_update_receipts r
    ON r.receipt_id = a.event_id AND r.bot_role = 'assistant' AND r.status = 'completed'` : '';
  return db.prepare(`
    SELECT a.rowid AS answer_rowid, a.event_id, a.chat_id, a.created_at AS answer_created_at, a.delivery,
      a.model_id AS answer_model_id, a.input_tokens AS answer_input_tokens,
      a.output_tokens AS answer_output_tokens, a.total_tokens AS answer_total_tokens,
      o.event_id AS observation_event_id, o.status AS analyzer_status,
      o.created_at AS observation_created_at,
      o.model_id AS analyzer_model_id, o.input_tokens AS analyzer_input_tokens,
      o.output_tokens AS analyzer_output_tokens, o.total_tokens AS analyzer_total_tokens,
      o.route_model_id AS router_model_id, o.route_input_tokens AS router_input_tokens,
      o.route_output_tokens AS router_output_tokens, o.route_total_tokens AS router_total_tokens
      ${receiptProjection}
    FROM runtime_assistant_answer_records a
    LEFT JOIN runtime_assistant_analyzer_observations o ON o.event_id = a.event_id
    ${receiptJoin}`);
}

function keepRecent(recent, row, estimate) {
  const entry = {
    eventId: row.event_id, answerRowId: row.answer_rowid,
    askedAt: row.answer_created_at, estimate,
  };
  const position = recent.findIndex((item) => entry.askedAt > item.askedAt
    || (entry.askedAt === item.askedAt && entry.answerRowId > item.answerRowId));
  if (position === -1 && recent.length >= LAST_QUESTION_LIMIT) return;
  recent.splice(position === -1 ? recent.length : position, 0, entry);
  if (recent.length > LAST_QUESTION_LIMIT) recent.pop();
}

function questionExcerpt(value) {
  const normalized = String(value ?? '').replace(/\s+/gu, ' ').trim();
  const chars = [...normalized];
  return chars.length <= QUESTION_EXCERPT_LIMIT ? normalized
    : chars.slice(0, QUESTION_EXCERPT_LIMIT - 1).join('') + '…';
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

    const receiptsAvailable = hasColumns(db, 'runtime_inbound_update_receipts', RECEIPT_COLUMNS);
    const query = answerRows(db, { receiptsAvailable });
    const total = emptyBucket(), today = emptyBucket(), week = emptyBucket();
    const observedChats = new Set();
    const recent = [];
    for (const row of query.iterate()) {
      observedChats.add(row.chat_id);
      const estimate = questionEstimate(row);
      addQuestion(total, estimate);
      keepRecent(recent, row, estimate);
      if (row.answer_created_at >= nowSeconds - WEEK_SECONDS && row.answer_created_at <= nowSeconds) {
        addQuestion(week, estimate);
      }
      if (row.answer_created_at >= nowSeconds - DAY_SECONDS && row.answer_created_at <= nowSeconds) {
        addQuestion(today, estimate);
      }
    }
    const lastFiveBucket = emptyBucket(), rows = [];
    const questionByEvent = db.prepare('SELECT question FROM runtime_assistant_answer_records WHERE event_id = ?');
    for (const record of recent) {
      addQuestion(lastFiveBucket, record.estimate);
      rows.push({
        askedAt: record.askedAt,
        question: questionExcerpt(questionByEvent.get(record.eventId)?.question),
        estimatedUsd: record.estimate.usd,
        knownStagesUsd: record.estimate.knownStagesUsd,
        stages: record.estimate.stages,
      });
    }
    return {
      status: 'available', reason: null,
      total: finishBucket(total), today: finishBucket(today), week: finishBucket(week),
      lastFive: { ...finishBucket(lastFiveBucket), rows },
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
