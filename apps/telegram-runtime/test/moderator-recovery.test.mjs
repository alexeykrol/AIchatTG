import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { planTelegramSafetyAction } from '@aichattg/telegram-core';
import { ProviderRequestError, ProviderUnavailableError } from '../src/provider-adapter.mjs';
import { openRuntimeDatabase, createRuntimeStore } from '../src/database.mjs';
import { createModeratorRecoveryWorker } from '../src/moderator-recovery.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import { safetyVerdict } from './safety-fixture.mjs';

function config(overrides = {}) {
  return {
    ingressEnabled: false,
    moderationMode: 'shadow',
    moderationAntichannelPin: true,
    moderatorRecoveryBackoffSec: 0,
    moderatorRecoveryLeaseSec: 10,
    moderatorRecoveryMaxSafeRetries: 3,
    moderatorRecoverySnapshotTtlSec: 600,
    moderator: { chatIds: ['-100'], botToken: '', botUsername: '', webhookSecret: 'moderator-secret', exemptBotIds: [] },
    assistant: { chatIds: ['-100'], botToken: '', botUsername: 'assistant_bot', webhookSecret: 'assistant-secret', exemptBotIds: [] },
    ...overrides,
  };
}

function update(updateId, messageId, text) {
  return { update_id: updateId, message: {
    message_id: messageId, chat: { id: -100 }, text,
    from: { id: 7, first_name: 'Student', is_bot: false },
  } };
}

function adapters(actions = []) {
  const moderatorTelegram = {
    async getChatMember() { return { ok: true, data: { status: 'member' } }; },
    async deleteMessage() { actions.push('delete'); return { ok: true }; },
    async sendMessage() { actions.push('warning'); return { ok: true }; },
    async banMember() { actions.push('ban'); return { ok: true }; },
    async banSenderChat() { actions.push('ban_sender_chat'); return { ok: true }; },
    async unpinMessage() { actions.push('unpin'); return { ok: true }; },
  };
  return {
    moderatorTelegram,
    assistantTelegram: { async sendMessage() { actions.push('assistant'); return { ok: true, data: { message_id: 1 } }; } },
    guard: {
      async senderDisposition() { return { proven: true, exempt: false, reason: null }; },
      async verifyEnforcement() { return { proven: true, status: 'administrator' }; },
      async deleteMessage(input) { return moderatorTelegram.deleteMessage(input); },
      async sendWarning(input) { return moderatorTelegram.sendMessage(input); },
      async banAuthor(input) { return moderatorTelegram.banMember(input); },
      async unpinMessage(input) { return moderatorTelegram.unpinMessage(input); },
    },
    notifier: { async notify() { return { delivered: true }; } },
  };
}

function cleanDecision() {
  return { safetyRoute: 'clean', abuseLevel: null, confidence: 1, reason: 'fixture', modelId: 'fixture' };
}

function threatDecision() {
  return { safetyRoute: 'threat', abuseLevel: null, confidence: 1, reason: 'fixture', modelId: 'fixture' };
}

function weakDecision() {
  return { safetyRoute: 'abuse', abuseLevel: 'weak', confidence: 1, reason: 'fixture', modelId: 'fixture' };
}

async function providerDecision(input, decision) {
  return { ...await safetyVerdict({
    message: input.text, safetyRoute: decision.safetyRoute, abuseLevel: decision.abuseLevel,
    confidence: decision.confidence,
    context: { currentWeakStrikes: input.currentWeakStrikes, warningStage: input.warningStage },
  }), modelId: decision.modelId };
}

function assertFirstWeakPolicy(policy) {
  assert.deepEqual({
    safetyRoute: policy.safetyRoute, abuseLevel: policy.abuseLevel,
    strikeBefore: policy.strikeBefore, strikeAfter: policy.strikeAfter,
    policyVersion: policy.policyVersion, verdict: policy.verdict, action: policy.action,
  }, {
    safetyRoute: 'abuse', abuseLevel: 'weak', strikeBefore: 0, strikeAfter: 1,
    policyVersion: 'telegram-safety-v1', verdict: 'suspect', action: 'delete_warn_1',
  });
  assert.equal(typeof policy.warning, 'string');
}

function withRuntime({ provider, now = 100, runtimeConfig = {}, actions = [], testHooks = null } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-moderator-recovery-'));
  const databasePath = join(folder, 'runtime.db');
  const db = openRuntimeDatabase(databasePath);
  const clock = { now };
  const store = createRuntimeStore(db, { now: () => clock.now });
  const runtime = createTelegramRuntime({
    config: config(runtimeConfig), store, provider, ...adapters(actions), testHooks,
  });
  return {
    db, store, runtime, clock, actions,
    close() { db.close(); rmSync(folder, { recursive: true, force: true }); },
  };
}

test('only a pre-request unavailable provider judgement is safely recovered once from its minimal private snapshot', async () => {
  let calls = 0;
  const context = withRuntime({
    provider: { async moderate(input) {
      calls++;
      if (calls === 1) throw new ProviderUnavailableError('provider_disabled');
      return providerDecision(input, cleanDecision());
    } },
  });
  try {
    const first = await context.runtime.handleUpdate('moderator', update(1, 11, 'recoverable private text'));
    assert.deepEqual({ kind: first.kind, reason: first.reason }, { kind: 'moderation_deferred', reason: 'provider_disabled' });
    const pending = context.db.prepare(`SELECT state, provider_boundary, safe_retry_count, snapshot_json
      FROM runtime_moderator_judgement_jobs WHERE event_id = 'moderator:1'`).get();
    assert.deepEqual({ state: pending.state, provider_boundary: pending.provider_boundary, safe_retry_count: pending.safe_retry_count }, {
      state: 'safe_retry', provider_boundary: 'not_started', safe_retry_count: 1,
    });
    assert.equal(pending.snapshot_json.includes('recoverable private text'), true);
    assert.equal(pending.snapshot_json.includes('update_id'), false);
    assert.equal(context.db.prepare(`SELECT result_json FROM runtime_inbound_update_receipts WHERE receipt_id = 'moderator:1'`).get()
      .result_json.includes('recoverable private text'), false);

    const recovered = await context.runtime.recoverModeratorJudgements({ limit: 2 });
    assert.equal(recovered.recovered, 1);
    assert.equal(calls, 2);
    assert.deepEqual(context.db.prepare(`SELECT state, provider_boundary FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:1'`).get(), { state: 'resolved', provider_boundary: 'returned' });
    assert.equal((await context.runtime.recoverModeratorJudgements({ limit: 2 })).recovered, 0);
    assert.equal(calls, 2);
    const enforcement = context.db.prepare(`SELECT receipt_json FROM runtime_moderation_enforcement_receipts
      WHERE event_id = 'moderator:1'`).get().receipt_json;
    assert.equal(enforcement.includes('recoverable private text'), false);
    const decision = context.db.prepare(`SELECT decision_json FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:1'`).get().decision_json;
    assert.equal(decision.includes('recoverable private text'), false);
  } finally { context.close(); }
});

test('a stale calling judgement becomes manual review and is never automatically re-called after restart', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const context = withRuntime({ provider: { async moderate() { calls++; return pending; } } });
  try {
    const first = context.runtime.handleUpdate('moderator', update(2, 12, 'calling text'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(context.db.prepare(`SELECT state, provider_boundary FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:2'`).get(), { state: 'calling', provider_boundary: 'calling' });
    assert.deepEqual(await context.runtime.handleUpdate('moderator', update(2, 12, 'calling text')), {
      kind: 'processing', eventId: 'moderator:2', receiptId: 'moderator:2', reason: 'claim_in_progress',
    });
    const recovery = await context.runtime.recoverModeratorJudgements({ limit: 5, startup: true });
    assert.equal(recovery.callingQuarantined, 1);
    assert.equal(recovery.recovered, 0);
    assert.equal(calls, 1);
    assert.deepEqual(context.db.prepare(`SELECT state, provider_boundary, error_code FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:2'`).get(), {
      state: 'manual_review', provider_boundary: 'unknown', error_code: 'provider_outcome_unknown',
    });
    release(await providerDecision({ text: 'calling text' }, cleanDecision()));
    await first;
  } finally { context.close(); }
});

test('an extra provider quote is rejected without leaking it into receipts or retrying judgement', async () => {
  let calls = 0;
  const providerOnlyQuote = 'provider-only private quote';
  const context = withRuntime({ provider: { async moderate(input) {
    calls++;
    return { ...await providerDecision(input, cleanDecision()), quote: providerOnlyQuote };
  } } });
  try {
    const result = await context.runtime.handleUpdate('moderator', update(3, 13, 'ordinary private input'));
    assert.equal(result.kind, 'moderation_manual_review');
    assert.equal(result.reason, 'invalid_judgement_submission');
    const job = context.store.getModeratorJudgement('moderator:3');
    assert.equal(job.state, 'manual_review');
    assert.equal(job.decision_json, null);
    assert.equal(JSON.stringify(context.store.getInboundDelivery('moderator:3')).includes(providerOnlyQuote), false);
    assert.equal(context.store.getModerationEnforcement('moderator:3'), null);
    assert.equal((await context.runtime.recoverModeratorJudgements({ limit: 2 })).recovered, 0);
    assert.equal(calls, 1);
    assert.deepEqual(context.actions, []);
  } finally { context.close(); }
});

test('transport, HTTP-shaped provider errors and invalid verdicts all require manual review without a second call', async () => {
  const outcomes = [
    () => { throw new ProviderRequestError('provider_transport_failed'); },
    () => { throw new ProviderRequestError('provider_http_error'); },
    () => ({ malformed: true }),
  ];
  let calls = 0;
  const context = withRuntime({ provider: { async moderate() { return outcomes[calls++](); } } });
  try {
    for (const [index, reason] of ['provider_transport_failed', 'provider_http_error', 'invalid_safety_verdict'].entries()) {
      const result = await context.runtime.handleUpdate('moderator', update(10 + index, 20 + index, `manual ${index}`));
      assert.deepEqual({ kind: result.kind, reason: result.reason }, { kind: 'moderation_manual_review', reason });
    }
    assert.equal(calls, 3);
    assert.equal((await context.runtime.recoverModeratorJudgements({ limit: 10 })).recovered, 0);
    assert.equal(calls, 3);
    assert.deepEqual(context.db.prepare(`SELECT state, COUNT(*) AS count FROM runtime_moderator_judgement_jobs GROUP BY state`).all(), [
      { state: 'manual_review', count: 3 },
    ]);
  } finally { context.close(); }
});

test('resolved judgement is never reconsidered, and expiring a bounded snapshot turns pending safe retry into manual review', async () => {
  let calls = 0;
  const context = withRuntime({ provider: { async moderate(input) { calls++; return providerDecision(input, cleanDecision()); } } });
  try {
    await context.runtime.handleUpdate('moderator', update(30, 40, 'resolved exactly once'));
    assert.equal(calls, 1);
    assert.equal((await context.runtime.recoverModeratorJudgements({ limit: 10 })).recovered, 0);
    await context.runtime.handleUpdate('moderator', update(30, 40, 'resolved exactly once'));
    assert.equal(calls, 1);

    context.runtime = createTelegramRuntime({
      config: config({ moderatorRecoverySnapshotTtlSec: 60 }), store: context.store,
      provider: { async moderate() { calls++; throw new ProviderUnavailableError('provider_disabled'); } }, ...adapters(context.actions),
    });
    await context.runtime.handleUpdate('moderator', update(31, 41, 'expires privately'));
    context.clock.now += 61;
    await context.runtime.recoverModeratorJudgements({ limit: 10 });
    assert.deepEqual(context.db.prepare(`SELECT state, error_code, snapshot_sha256 FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:31'`).get(), {
      state: 'manual_review', error_code: 'snapshot_expired', snapshot_sha256: 'expired',
    });
    assert.equal(calls, 2);
  } finally { context.close(); }
});

test('a persisted decision before enforcement recovers its fixed Guard plan without a second provider call', async () => {
  let providerCalls = 0;
  const context = withRuntime({
    runtimeConfig: { moderationMode: 'live' },
    provider: { async moderate(input) { providerCalls++; return providerDecision(input, threatDecision()); } },
    testHooks: { async afterDecisionReady() { throw new Error('crash_after_decision_ready'); } },
  });
  try {
    const first = await context.runtime.handleUpdate('moderator', update(40, 50, 'durable decision first'));
    assert.equal(first.kind, 'uncertain_delivery');
    assert.equal(providerCalls, 1);
    assert.deepEqual(context.db.prepare(`SELECT state, provider_boundary FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:40'`).get(), { state: 'decision_ready', provider_boundary: 'returned' });
    assert.deepEqual(context.db.prepare(`SELECT status FROM runtime_moderation_enforcement_receipts
      WHERE event_id = 'moderator:40'`).get(), { status: 'planned' });

    context.runtime = createTelegramRuntime({
      config: config({ moderationMode: 'live' }), store: context.store,
      provider: { async moderate() { providerCalls++; throw new Error('provider_must_not_be_called'); } },
      ...adapters(context.actions),
    });
    const recovered = await context.runtime.recoverModeratorJudgements({ limit: 2 });
    assert.equal(recovered.recovered, 1);
    assert.equal(providerCalls, 1);
    assert.deepEqual(context.actions, ['ban', 'delete']);
    assert.deepEqual(context.db.prepare(`SELECT state FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:40'`).get(), { state: 'resolved' });
    assert.deepEqual(context.db.prepare(`SELECT status FROM runtime_moderation_enforcement_receipts
      WHERE event_id = 'moderator:40'`).get(), { status: 'completed' });
    assert.equal(context.db.prepare(`SELECT COUNT(*) AS count FROM runtime_moderation_records
      WHERE event_id = 'moderator:40'`).get().count, 1);
    assert.deepEqual(context.store.getAssistantDisposition({ chatId: '-100', messageId: '50' }), {
      chat_id: '-100', message_id: '50', status: 'blocked', moderation_message_id: '-100:50:original', verdict: 'ban',
      reason: 'moderator_decision_recovered', moderation_event_id: 'moderator:40', created_at: 100, updated_at: 100,
    });
  } finally { context.close(); }
});

test('a planned receipt resumes exactly once after a crash before the first Guard action', async () => {
  let providerCalls = 0;
  const context = withRuntime({
    runtimeConfig: { moderationMode: 'live' },
    provider: { async moderate(input) { providerCalls++; return providerDecision(input, threatDecision()); } },
    testHooks: { async afterEnforcementPlanned() { throw new Error('crash_after_enforcement_planned'); } },
  });
  try {
    const first = await context.runtime.handleUpdate('moderator', update(41, 51, 'planned before guard'));
    assert.equal(first.kind, 'uncertain_delivery');
    assert.equal(providerCalls, 1);
    assert.deepEqual(context.db.prepare(`SELECT state FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:41'`).get(), { state: 'decision_ready' });
    assert.deepEqual(context.db.prepare(`SELECT status, claim_generation FROM runtime_moderation_enforcement_receipts
      WHERE event_id = 'moderator:41'`).get(), { status: 'planned', claim_generation: 1 });
    assert.deepEqual(context.actions, []);

    context.runtime = createTelegramRuntime({
      config: config({ moderationMode: 'live' }), store: context.store,
      provider: { async moderate() { providerCalls++; throw new Error('provider_must_not_be_called'); } },
      ...adapters(context.actions),
    });
    const recovered = await context.runtime.recoverModeratorJudgements({ limit: 2 });
    assert.equal(recovered.recovered, 1);
    assert.equal(providerCalls, 1);
    assert.deepEqual(context.actions, ['ban', 'delete']);
    assert.deepEqual(context.db.prepare(`SELECT state FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:41'`).get(), { state: 'resolved' });
    assert.deepEqual(context.db.prepare(`SELECT status, claim_generation FROM runtime_moderation_enforcement_receipts
      WHERE event_id = 'moderator:41'`).get(), { status: 'completed', claim_generation: 2 });
    assert.equal((await context.runtime.recoverModeratorJudgements({ limit: 2 })).recovered, 0);
    assert.deepEqual(context.actions, ['ban', 'delete']);
  } finally { context.close(); }
});

test('a weak decision keeps its atomically reserved first-warning policy after an intervening strike', async () => {
  let providerCalls = 0;
  const context = withRuntime({
    runtimeConfig: { moderationMode: 'live' },
    provider: { async moderate(input) { providerCalls++; return providerDecision(input, weakDecision()); } },
    testHooks: { async afterDecisionReady() { throw new Error('crash_after_atomic_weak_decision'); } },
  });
  try {
    const first = await context.runtime.handleUpdate('moderator', update(44, 54, 'first weak abuse'));
    assert.equal(first.kind, 'uncertain_delivery');
    assert.equal(providerCalls, 1);
    assert.deepEqual(context.store.getWeakStrikeState({ chatId: '-100', userId: '7' }), {
      weakStrikes: 1, warningStage: 'none', warningDeliveredAt: null, lastEventId: 'moderator:44',
    });
    assertFirstWeakPolicy(JSON.parse(context.store.getModerationEnforcement('moderator:44').policy_json));

    const intervening = context.store.reserveWeakStrikeForMessage({
      chatId: '-100', userId: '7', messageId: 'intervening', revisionIdentity: '-100:intervening', eventId: 'fixture:intervening',
    });
    assert.deepEqual({ claimed: intervening.claimed, before: intervening.before, after: intervening.after }, {
      claimed: true, before: 1, after: 2,
    });
    assert.equal(context.store.getWeakStrikeState({ chatId: '-100', userId: '7' }).weakStrikes, 2);

    context.runtime = createTelegramRuntime({
      config: config({ moderationMode: 'live' }), store: context.store,
      provider: { async moderate() { providerCalls++; throw new Error('provider_must_not_be_called'); } },
      ...adapters(context.actions),
    });
    const recovered = await context.runtime.recoverModeratorJudgements({ limit: 2 });
    assert.equal(recovered.recovered, 1);
    assert.equal(providerCalls, 1);
    assert.equal(recovered.outcomes[0].action, 'delete_warn_1');
    assert.deepEqual(context.actions, ['delete', 'warning']);
    assert.equal(context.store.getWeakStrikeState({ chatId: '-100', userId: '7' }).weakStrikes, 2);
    assertFirstWeakPolicy(JSON.parse(context.store.getModerationEnforcement('moderator:44').policy_json));
  } finally { context.close(); }
});

test('a legacy decision-ready weak plan without its receipt and reservation is quarantined', async () => {
  let providerCalls = 0;
  const context = withRuntime({
    runtimeConfig: { moderationMode: 'live' },
    provider: { async moderate(input) { providerCalls++; return providerDecision(input, weakDecision()); } },
    testHooks: { async afterDecisionReady() { throw new Error('simulate_d71_decision_ready'); } },
  });
  try {
    await context.runtime.handleUpdate('moderator', update(45, 55, 'legacy weak plan'));
    assert.equal(providerCalls, 1);
    context.db.prepare(`DELETE FROM runtime_moderation_enforcement_receipts WHERE event_id = 'moderator:45'`).run();
    context.db.prepare(`UPDATE runtime_moderation_message_ledger
      SET weak_strike_event_id = NULL WHERE chat_id = '-100' AND message_id = '55'`).run();
    context.db.prepare(`DELETE FROM runtime_moderation_weak_strikes WHERE chat_id = '-100' AND user_id = '7'`).run();

    context.runtime = createTelegramRuntime({
      config: config({ moderationMode: 'live' }), store: context.store,
      provider: { async moderate() { providerCalls++; throw new Error('provider_must_not_be_called'); } },
      ...adapters(context.actions),
    });
    const recovered = await context.runtime.recoverModeratorJudgements({ limit: 2 });
    assert.equal(recovered.recovered, 1);
    assert.equal(providerCalls, 1);
    assert.deepEqual(context.actions, []);
    assert.deepEqual(context.db.prepare(`SELECT state, error_code FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:45'`).get(), {
      state: 'manual_review', error_code: 'legacy_weak_plan_unreserved',
    });
    assert.equal(context.store.getModerationEnforcement('moderator:45'), null);
  } finally { context.close(); }
});

test('the d71-era SQLite job table migrates a returned weak no-receipt row into a quarantinable decision_ready row', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-legacy-decision-ready-'));
  const databasePath = join(folder, 'runtime.db');
  const legacy = new Database(databasePath);
  try {
    legacy.exec(`
      CREATE TABLE runtime_inbound_events (
        event_id TEXT PRIMARY KEY, bot_role TEXT NOT NULL, update_id INTEGER NOT NULL, status TEXT NOT NULL,
        result_json TEXT, error_text TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE TABLE runtime_inbound_update_receipts (
        receipt_id TEXT PRIMARY KEY, bot_role TEXT NOT NULL, update_id INTEGER NOT NULL,
        revision_identity TEXT NOT NULL, payload_fingerprint TEXT NOT NULL, claim_id TEXT NOT NULL,
        claim_generation INTEGER NOT NULL, status TEXT NOT NULL, result_json TEXT, error_code TEXT,
        recovery_id TEXT, received_at INTEGER NOT NULL, claimed_at INTEGER NOT NULL,
        completed_at INTEGER, recovered_at INTEGER, UNIQUE(bot_role, update_id)
      );
      CREATE TABLE runtime_moderator_judgement_jobs (
        event_id TEXT PRIMARY KEY REFERENCES runtime_inbound_events(event_id),
        receipt_id TEXT NOT NULL UNIQUE REFERENCES runtime_inbound_update_receipts(receipt_id),
        state TEXT NOT NULL CHECK(state IN ('safe_retry', 'calling', 'manual_review', 'resolved')),
        snapshot_json TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL, snapshot_bytes INTEGER NOT NULL,
        snapshot_expires_at INTEGER NOT NULL, provider_boundary TEXT NOT NULL, lease_id TEXT,
        claim_generation INTEGER NOT NULL, lease_expires_at INTEGER, safe_retry_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, decision_json TEXT, result_json TEXT, error_code TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER
      );
    `);
    const eventId = 'moderator:legacy-weak';
    const snapshot = JSON.stringify({ schemaVersion: 'moderator-comment-v1', comment: {
      chatId: '-100', messageId: 'legacy-weak', platformMessageId: '-100:legacy-weak', userId: '7',
      senderChatId: null, isBot: false, hasLink: false, text: 'legacy weak text',
    } });
    const decision = JSON.stringify({
      safetyRoute: 'abuse', abuseLevel: 'weak', confidence: 1, modelId: 'fixture',
      plan: planTelegramSafetyAction(weakDecision(), 0),
    });
    legacy.prepare(`INSERT INTO runtime_inbound_events
      VALUES (?, 'moderator', 46, 'completed', NULL, NULL, 1, 1)`).run(eventId);
    legacy.prepare(`INSERT INTO runtime_inbound_update_receipts
      VALUES (?, 'moderator', 46, '-100:legacy-weak', ?, 'claim', 1, 'completed', NULL, NULL, NULL, 1, 1, 1, NULL)`)
      .run(eventId, 'f'.repeat(64));
    legacy.prepare(`INSERT INTO runtime_moderator_judgement_jobs
      VALUES (?, ?, 'resolved', ?, 'snapshot', ?, 600, 'returned', NULL, 1, NULL, 0, 1, ?, '{}', NULL, 1, 1, 1)`)
      .run(eventId, eventId, snapshot, Buffer.byteLength(snapshot), decision);
  } finally { legacy.close(); }
  const migrated = openRuntimeDatabase(databasePath);
  try {
    assert.deepEqual(migrated.prepare(`SELECT state, resolved_at FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:legacy-weak'`).get(), { state: 'decision_ready', resolved_at: null });
    assert.equal(migrated.prepare(`SELECT * FROM runtime_moderation_enforcement_receipts
      WHERE event_id = 'moderator:legacy-weak'`).get(), undefined);
  } finally { migrated.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('calling and uncertain Guard receipts are terminal recovery boundaries and are never re-issued', async () => {
  let providerCalls = 0;
  let releaseBan;
  const pendingBan = new Promise((resolve) => { releaseBan = resolve; });
  const context = withRuntime({
    runtimeConfig: { moderationMode: 'live' },
    provider: { async moderate(input) { providerCalls++; return providerDecision(input, threatDecision()); } },
  });
  try {
    const service = adapters(context.actions);
    service.guard.banAuthor = async () => {
      context.actions.push('ban');
      return pendingBan;
    };
    context.runtime = createTelegramRuntime({
      config: config({ moderationMode: 'live' }), store: context.store,
      provider: { async moderate(input) { providerCalls++; return providerDecision(input, threatDecision()); } }, ...service,
    });
    const running = context.runtime.handleUpdate('moderator', update(42, 52, 'calling guard boundary'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(context.db.prepare(`SELECT state FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:42'`).get(), { state: 'decision_ready' });
    assert.deepEqual(context.db.prepare(`SELECT status FROM runtime_moderation_enforcement_receipts
      WHERE event_id = 'moderator:42'`).get(), { status: 'calling' });
    const callingRecovery = await context.runtime.recoverModeratorJudgements({ limit: 2 });
    assert.equal(callingRecovery.recovered, 1);
    assert.equal(providerCalls, 1);
    assert.deepEqual(context.actions, ['ban']);
    releaseBan({ ok: true });
    await running;
    assert.deepEqual(context.actions, ['ban', 'delete']);

    service.guard.banAuthor = async () => {
      context.actions.push('ban_uncertain');
      return { ok: false, uncertain: true, error: 'telegram_transport_unknown' };
    };
    const uncertain = await context.runtime.handleUpdate('moderator', update(43, 53, 'uncertain guard boundary'));
    assert.equal(uncertain.kind, 'moderated');
    assert.deepEqual(context.db.prepare(`SELECT status FROM runtime_moderation_enforcement_receipts
      WHERE event_id = 'moderator:43'`).get(), { status: 'uncertain' });
    // Simulate the narrow crash after receipt completion and before the job's
    // terminal transition; recovery must not turn `uncertain` into a retry.
    context.db.prepare(`UPDATE runtime_moderator_judgement_jobs
      SET state = 'decision_ready', resolved_at = NULL WHERE event_id = 'moderator:43'`).run();
    const uncertainRecovery = await context.runtime.recoverModeratorJudgements({ limit: 2 });
    assert.equal(uncertainRecovery.recovered, 1);
    assert.equal(providerCalls, 2);
    assert.deepEqual(context.actions, ['ban', 'delete', 'ban_uncertain']);
    assert.deepEqual(context.db.prepare(`SELECT state FROM runtime_moderator_judgement_jobs
      WHERE event_id = 'moderator:43'`).get(), { state: 'resolved' });
  } finally { context.close(); }
});

test('a stale safe-retry lease cannot cross the provider boundary after a newer worker claim', () => {
  const context = withRuntime({ provider: { async moderate(input) { return providerDecision(input, cleanDecision()); } } });
  try {
    context.store.claimInboundDelivery({
      receiptId: 'moderator:99', role: 'moderator', updateId: 99, revisionIdentity: '-100:99', payloadFingerprint: 'f'.repeat(64),
    });
    context.store.claimEvent({ eventId: 'moderator:99', role: 'moderator', updateId: 99 });
    context.store.ensureModeratorJudgement({
      eventId: 'moderator:99', receiptId: 'moderator:99', snapshotTtlSec: 600,
      comment: { chatId: '-100', messageId: '99', platformMessageId: '-100:99', userId: '7', senderChatId: null, isBot: false, hasLink: false, text: 'fenced' },
    });
    const first = context.store.claimModeratorJudgement({ eventId: 'moderator:99', leaseSec: 10 });
    assert.equal(first.claimed, true);
    assert.equal(context.store.deferModeratorJudgement({ claim: first.claim, nextAttemptAt: context.clock.now, errorCode: 'fixture' }).deferred, true);
    const second = context.store.claimModeratorJudgement({ eventId: 'moderator:99', leaseSec: 10 });
    assert.equal(second.claimed, true);
    assert.equal(context.store.markModeratorProviderCalling({ claim: first.claim, leaseSec: 10 }).marked, false);
    assert.equal(context.store.markModeratorProviderCalling({ claim: second.claim, leaseSec: 10 }).marked, true);
  } finally { context.close(); }
});

test('the periodic worker has one active drain even when the timer overlaps', async () => {
  let invocations = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const worker = createModeratorRecoveryWorker({
    runtime: { async recoverModeratorJudgements() { invocations++; await pending; return { recovered: 0 }; } },
    intervalSec: 5,
  });
  const first = worker.drain();
  const second = await worker.drain();
  assert.deepEqual(second, { skipped: 'worker_already_active' });
  assert.equal(invocations, 1);
  release();
  await first;
});
