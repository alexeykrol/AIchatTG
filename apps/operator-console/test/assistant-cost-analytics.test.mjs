import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { assistantCostAnalytics } from '../src/assistant-cost-analytics.mjs';

const NOW = Math.floor(Date.parse('2026-09-15T12:00:00Z') / 1000);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

function fixture(t, { schema = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aichattg-assistant-cost-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeDatabasePath = join(root, 'runtime.sqlite');
  const db = new Database(runtimeDatabasePath);
  if (schema) db.exec(`
    CREATE TABLE runtime_assistant_answer_records (
      event_id TEXT PRIMARY KEY, chat_id TEXT, model_id TEXT, input_tokens INTEGER,
      output_tokens INTEGER, total_tokens INTEGER, delivery TEXT, created_at INTEGER
    );
    CREATE TABLE runtime_assistant_analyzer_observations (
      event_id TEXT UNIQUE, status TEXT, model_id TEXT, input_tokens INTEGER,
      output_tokens INTEGER, total_tokens INTEGER, route_model_id TEXT,
      route_input_tokens INTEGER, route_output_tokens INTEGER, route_total_tokens INTEGER,
      created_at INTEGER
    );
  `);
  return { db, config: { runtimeDatabasePath } };
}

function answer(db, id, at, { model = 'gpt-5.6-terra', input = 1000, output = 100, total = 1100, delivery = 'ok', chat = '-100' } = {}) {
  db.prepare(`INSERT INTO runtime_assistant_answer_records
    (event_id, chat_id, model_id, input_tokens, output_tokens, total_tokens, delivery, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, chat, model, input, output, total, delivery, at);
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
});
