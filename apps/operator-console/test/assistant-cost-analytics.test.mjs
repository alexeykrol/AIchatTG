import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { assistantCostAnalytics } from '../src/assistant-cost-analytics.mjs';

const NOW = Math.floor(Date.parse('2026-09-15T12:00:00Z') / 1000);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

function fixture(t, { schema = true, receipts = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aichattg-assistant-cost-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeDatabasePath = join(root, 'runtime.sqlite');
  const db = new Database(runtimeDatabasePath);
  if (schema) db.exec(`
    CREATE TABLE runtime_assistant_answer_records (
      event_id TEXT PRIMARY KEY, chat_id TEXT, question TEXT, model_id TEXT, input_tokens INTEGER,
      output_tokens INTEGER, total_tokens INTEGER, delivery TEXT, created_at INTEGER
    );
    CREATE TABLE runtime_assistant_analyzer_observations (
      event_id TEXT UNIQUE, status TEXT, model_id TEXT, input_tokens INTEGER,
      output_tokens INTEGER, total_tokens INTEGER, route_model_id TEXT,
      route_input_tokens INTEGER, route_output_tokens INTEGER, route_total_tokens INTEGER,
      created_at INTEGER
    );
  `);
  if (schema && receipts) db.exec(`
    CREATE TABLE runtime_inbound_update_receipts (
      receipt_id TEXT PRIMARY KEY, bot_role TEXT, status TEXT, result_json TEXT
    );
  `);
  return { db, config: { runtimeDatabasePath } };
}

function answer(db, id, at, { model = 'gpt-5.6-terra', input = 1000, output = 100, total = 1100,
  delivery = 'ok', chat = '-100', question = `Вопрос ${id}` } = {}) {
  db.prepare(`INSERT INTO runtime_assistant_answer_records
    (event_id, chat_id, question, model_id, input_tokens, output_tokens, total_tokens, delivery, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, chat, question, model, input, output, total, delivery, at);
}

function receipt(db, id, { status = 'completed', botRole = 'assistant', origin = 'analyzer_dispatch',
  eventId = id, schemaVersion = 'assistant-routing-diagnosis-v1', kind = 'answered' } = {}) {
  db.prepare(`INSERT INTO runtime_inbound_update_receipts
    (receipt_id, bot_role, status, result_json) VALUES (?, ?, ?, ?)`).run(
    id, botRole, status, JSON.stringify({ eventId, kind,
      routingDiagnosis: { schemaVersion, origin } }),
  );
}

function observation(db, id, at, { model = 'gpt-5.6-luna', input = 500, output = 50, total = 550,
  router = null, routerInput = null, routerOutput = null, routerTotal = null, status = 'ok' } = {}) {
  db.prepare(`INSERT INTO runtime_assistant_analyzer_observations
    (event_id, status, model_id, input_tokens, output_tokens, total_tokens,
     route_model_id, route_input_tokens, route_output_tokens, route_total_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, status, model, input, output, total, router, routerInput, routerOutput, routerTotal, at,
  );
}

test('one durable Q&A event prices analyzer, router and answer once across rolling windows', (t) => {
  const { db, config } = fixture(t);
  answer(db, 'today', NOW - 60);
  observation(db, 'today', NOW - 61, {
    router: 'gpt-5.6-luna', routerInput: 200, routerOutput: 20, routerTotal: 220,
  });
  answer(db, 'week', NOW - 2 * 86_400, { model: null, input: null, output: null, total: null, chat: '-200' });
  observation(db, 'week', NOW - 2 * 86_400 - 1, {
    input: 100, output: 10, total: 110,
    router: 'gpt-5.6-luna', routerInput: 200, routerOutput: 20, routerTotal: 220,
  });
  db.close();

  const analytics = assistantCostAnalytics(config, { nowSeconds: NOW });
  assert.equal(analytics.status, 'available');
  assert.equal(analytics.pricing.version, 'assistant-standard-text-prices-v1');
  assert.deepEqual([analytics.today.count, analytics.week.count, analytics.total.count], [1, 2, 2]);
  assert.deepEqual([analytics.today.pricedCount, analytics.week.pricedCount, analytics.total.pricedCount], [1, 2, 2]);
  assert.equal(analytics.coverage.scope, 'analyzer_chat_subset');
  assert.equal(analytics.coverage.allChats, false);
  assert.equal(analytics.coverage.observedChatCount, 2);
  // Terra answer .0032; Luna analyzer .00016; Luna router .000064.
  near(analytics.today.cost, 0.003424);
  // A model-less deterministic answer is a zero-call stage; router is paid.
  near(analytics.week.cost, 0.003424 + 0.000032 + 0.000064);
  near(analytics.total.averageCostUsd, (0.003424 + 0.000032 + 0.000064) / 2);
});

test('unknown usage, missing observation and unverified delivery stay outside the priced mean', (t) => {
  const { db, config } = fixture(t);
  answer(db, 'known', NOW - 10);
  observation(db, 'known', NOW - 11, {
    router: 'gpt-5.6-luna', routerInput: 200, routerOutput: 20, routerTotal: 220,
  });
  answer(db, 'unknown-tokens', NOW - 20, { input: null, output: null, total: null });
  observation(db, 'unknown-tokens', NOW - 21);
  answer(db, 'missing-observation', NOW - 30);
  answer(db, 'unverified-delivery', NOW - 40, { delivery: null });
  observation(db, 'unverified-delivery', NOW - 41);
  db.close();

  const result = assistantCostAnalytics(config, { nowSeconds: NOW });
  assert.equal(result.today.count, 4);
  assert.equal(result.today.pricedCount, 1);
  assert.equal(result.today.unknownCount, 3);
  assert.equal(result.today.cost, null, 'a partial known sum cannot masquerade as total');
  near(result.today.knownEstimatedUsd, 0.003424);
  near(result.today.averageCostUsd, 0.003424);
});

test('unknown model, pre-version record, large-input tier and model-less analyzer are unpriced', (t) => {
  const { db, config } = fixture(t);
  answer(db, 'other-model', NOW - 10, { model: 'unpriced-model' });
  observation(db, 'other-model', NOW - 11);
  answer(db, 'older', Math.floor(Date.parse('2026-07-29T23:00:00Z') / 1000));
  observation(db, 'older', Math.floor(Date.parse('2026-07-29T22:59:00Z') / 1000));
  answer(db, 'large', NOW - 30, { input: 272_001, output: 100, total: 272_101 });
  observation(db, 'large', NOW - 31);
  answer(db, 'missing-analyzer-model', NOW - 40);
  observation(db, 'missing-analyzer-model', NOW - 41, { model: null, input: null, output: null, total: null });
  db.close();

  const result = assistantCostAnalytics(config, { nowSeconds: NOW });
  assert.equal(result.total.count, 4);
  assert.equal(result.total.pricedCount, 0);
  assert.equal(result.total.unknownCount, 4);
  assert.equal(result.total.knownEstimatedUsd, null);
  assert.equal(result.total.averageCostUsd, null);
});

test('failed analysis with an absent router receipt is not priced as a no-call fallback', (t) => {
  const { db, config } = fixture(t);
  answer(db, 'fallback', NOW - 10);
  observation(db, 'fallback', NOW - 11, { status: 'invalid' });
  db.close();
  const result = assistantCostAnalytics(config, { nowSeconds: NOW });
  assert.equal(result.today.count, 1);
  assert.equal(result.today.pricedCount, 0);
  assert.equal(result.today.unknownCount, 1);
  assert.equal(result.today.cost, null);
});

test('an absent router receipt stays unknown even after an okay analyzer verdict', (t) => {
  const { db, config } = fixture(t);
  answer(db, 'analyzer-dispatch', NOW - 10);
  observation(db, 'analyzer-dispatch', NOW - 11);
  db.close();
  const result = assistantCostAnalytics(config, { nowSeconds: NOW });
  assert.equal(result.today.count, 1);
  assert.equal(result.today.pricedCount, 0);
  assert.equal(result.today.unknownCount, 1);
  assert.equal(result.today.cost, null);
});

test('missing database or required durable schema reports unavailable rather than zero', (t) => {
  const missing = assistantCostAnalytics({ runtimeDatabasePath: join(tmpdir(), `missing-assistant-cost-${Date.now()}.sqlite`) }, { nowSeconds: NOW });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.total, null);
  const { db, config } = fixture(t, { schema: false });
  db.close();
  const schemaMissing = assistantCostAnalytics(config, { nowSeconds: NOW });
  assert.equal(schemaMissing.status, 'unavailable');
  assert.equal(schemaMissing.reason, 'schema_unavailable');
  assert.equal(schemaMissing.today, null);
});

test('an empty compatible journal has no fabricated dollar average', (t) => {
  const { db, config } = fixture(t);
  db.close();
  const result = assistantCostAnalytics(config, { nowSeconds: NOW });
  assert.equal(result.status, 'available');
  assert.equal(result.total.count, 0);
  assert.equal(result.total.cost, null);
  assert.equal(result.total.averageCostUsd, null);
  assert.deepEqual(result.lastFive.rows, []);
  assert.equal(result.lastFive.averageCostUsd, null);
});

test('completed event-level analyzer dispatch proves router no-call and prices the newest five', (t) => {
  const { db, config } = fixture(t);
  for (let number = 1; number <= 6; number += 1) {
    const at = number < 5 ? NOW - 10 + number : NOW - 1;
    answer(db, `event-${number}`, at, { question: `  Вопрос   ${number}  ` });
    observation(db, `event-${number}`, at - 1);
    receipt(db, `event-${number}`);
  }
  db.close();
  const result = assistantCostAnalytics(config, { nowSeconds: NOW });
  assert.equal(result.status, 'available');
  assert.equal(result.total.pricedCount, 6);
  assert.deepEqual(result.lastFive.rows.map((row) => row.question),
    ['Вопрос 6', 'Вопрос 5', 'Вопрос 4', 'Вопрос 3', 'Вопрос 2']);
  assert.equal(result.lastFive.count, 5);
  assert.equal(result.lastFive.pricedCount, 5);
  assert.equal(result.lastFive.unknownCount, 0);
  near(result.lastFive.cost, 5 * 0.00336);
  near(result.lastFive.averageCostUsd, 0.00336);
  for (const row of result.lastFive.rows) {
    near(row.estimatedUsd, 0.00336);
    assert.equal(row.stages.router.noCall, true);
    assert.equal(row.stages.router.usd, 0);
  }
});

test('one missing routing proof keeps the full-five mean unknown and exposes only known stages', (t) => {
  const { db, config } = fixture(t);
  for (let number = 1; number <= 5; number += 1) {
    const id = `event-${number}`;
    answer(db, id, NOW - number);
    observation(db, id, NOW - number - 1);
    if (number !== 1) receipt(db, id);
  }
  db.close();
  const result = assistantCostAnalytics(config, { nowSeconds: NOW });
  assert.equal(result.lastFive.pricedCount, 4);
  assert.equal(result.lastFive.unknownCount, 1);
  assert.equal(result.lastFive.partiallyPricedCount, 1);
  assert.equal(result.lastFive.cost, null);
  near(result.lastFive.averageCostUsd, 0.00336);
  near(result.lastFive.knownEstimatedUsd, 4 * 0.00336);
  near(result.lastFive.knownStagesUsd, 5 * 0.00336);
  assert.equal(result.lastFive.rows[0].estimatedUsd, null);
  near(result.lastFive.rows[0].knownStagesUsd, 0.00336);
  assert.equal(result.lastFive.rows[0].stages.router.known, false);
});

test('invalid, mismatched and conflicting dispatch receipts never turn absent router usage into zero', (t) => {
  const { db, config } = fixture(t);
  const cases = [
    { id: 'wrong-event', receipt: { eventId: 'someone-else' } },
    { id: 'wrong-schema', receipt: { schemaVersion: 'unknown' } },
    { id: 'not-completed', receipt: { status: 'processing' } },
    { id: 'other-role', receipt: { botRole: 'moderator' } },
    { id: 'fallback', receipt: { origin: 'router_fallback' } },
  ];
  for (const [index, item] of cases.entries()) {
    answer(db, item.id, NOW - index);
    observation(db, item.id, NOW - index - 1);
    receipt(db, item.id, item.receipt);
  }
  db.close();
  const result = assistantCostAnalytics(config, { nowSeconds: NOW });
  assert.equal(result.lastFive.pricedCount, 0);
  assert.equal(result.lastFive.unknownCount, 5);
  assert.equal(result.lastFive.cost, null);
  assert.equal(result.lastFive.averageCostUsd, null);
  for (const row of result.lastFive.rows) {
    assert.equal(row.estimatedUsd, null);
    assert.equal(row.stages.router.known, false);
    near(row.knownStagesUsd, 0.00336);
  }
});

test('missing receipt table and conflicting route tokens fail closed; excerpts are bounded', (t) => {
  const { db, config } = fixture(t, { receipts: false });
  answer(db, 'legacy', NOW - 2, { question: 'я'.repeat(300) });
  observation(db, 'legacy', NOW - 3);
  db.close();
  const legacy = assistantCostAnalytics(config, { nowSeconds: NOW });
  assert.equal(legacy.status, 'available');
  assert.equal(legacy.lastFive.rows[0].estimatedUsd, null);
  assert.equal([...legacy.lastFive.rows[0].question].length, 240);
  assert.equal(legacy.lastFive.rows[0].question.endsWith('…'), true);

  const second = fixture(t);
  answer(second.db, 'contradiction', NOW - 1);
  observation(second.db, 'contradiction', NOW - 2, {
    router: 'gpt-5.6-luna', routerInput: 200, routerOutput: 20, routerTotal: 220,
  });
  receipt(second.db, 'contradiction');
  second.db.close();
  const result = assistantCostAnalytics(second.config, { nowSeconds: NOW });
  assert.equal(result.lastFive.pricedCount, 0);
  assert.equal(result.lastFive.rows[0].stages.router.known, false);
});
