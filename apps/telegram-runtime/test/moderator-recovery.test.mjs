import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProviderRequestError, ProviderUnavailableError } from '../src/provider-adapter.mjs';
import { openRuntimeDatabase, createRuntimeStore } from '../src/database.mjs';
import { createModeratorRecoveryWorker } from '../src/moderator-recovery.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';

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

function withRuntime({ provider, now = 100, runtimeConfig = {}, actions = [] } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-moderator-recovery-'));
  const databasePath = join(folder, 'runtime.db');
  const db = openRuntimeDatabase(databasePath);
  const clock = { now };
  const store = createRuntimeStore(db, { now: () => clock.now });
  const runtime = createTelegramRuntime({
    config: config(runtimeConfig), store, provider, ...adapters(actions),
  });
  return {
    db, store, runtime, clock, actions,
    close() { db.close(); rmSync(folder, { recursive: true, force: true }); },
  };
}

test('only a pre-request unavailable provider judgement is safely recovered once from its minimal private snapshot', async () => {
  let calls = 0;
  const context = withRuntime({
    provider: { async moderate() {
      calls++;
      if (calls === 1) throw new ProviderUnavailableError('provider_disabled');
      return { ...cleanDecision(), reason: 'provider rationale', quote: 'recoverable private text' };
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
    release(cleanDecision());
    await first;
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
  const context = withRuntime({ provider: { async moderate() { calls++; return cleanDecision(); } } });
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

test('a stale safe-retry lease cannot cross the provider boundary after a newer worker claim', () => {
  const context = withRuntime({ provider: { async moderate() { return cleanDecision(); } } });
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
