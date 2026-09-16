import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';
import { buildJudgementEnvelope } from '../src/judgement-envelope.mjs';
import { safetyVerdict } from './safety-fixture.mjs';

const config = { moderationMode: 'live',
  assistant: { chatIds: ['-100'], botUsername: 'assistant_bot', botToken: '900:fixture', exemptBotIds: [] },
  moderator: { chatIds: ['-100'], botToken: '901:fixture', exemptBotIds: [] },
};

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-answer-claims-'));
  const path = join(folder, 'runtime.sqlite');
  let db; let store; let sequence = 0;
  function restart() {
    db?.close(); db = openRuntimeDatabase(path); store = createRuntimeStore(db, { now: () => 100 });
  }
  restart();
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  return {
    restart, get db() { return db; }, get store() { return store; },
    row() { return db.prepare('SELECT * FROM runtime_assistant_answer_claims').get(); },
    async observe(revision = 0, status = 'allowed') {
      const id = ++sequence;
      const raw = { update_id: id, [revision ? 'edited_message' : 'message']: {
        chat: { id: -100 }, message_id: 10, from: { id: 7, is_bot: false },
        text: `/ask question revision ${revision}`, ...(revision ? { edit_date: revision } : {}),
      } };
      const envelope = buildJudgementEnvelope(config, raw);
      const eventId = `assistant:${id}`;
      store.claimEvent({ eventId, role: 'assistant', updateId: id });
      store.claimInboundDelivery({ receiptId: eventId, role: 'assistant', updateId: id,
        revisionIdentity: envelope.revisionIdentity, payloadFingerprint: envelope.sourceHash });
      const observed = store.observeJudgementEnvelope({ envelope, eventId, receiptId: eventId });
      const judgementEventId = observed.row.event_id;
      if (status === 'allowed' && !observed.row.verdict_fingerprint) {
        const { claim } = store.claimModeratorJudgement({ eventId: judgementEventId });
        assert.ok(store.markModeratorProviderCalling({ claim }).marked);
        assert.ok(store.submitJudgementVerdict(store.issueJudgementSubmissionClaim(claim),
          await safetyVerdict({ message: envelope.comment.text })).ready);
      } else {
        store.upsertAssistantDisposition({ chatId: '-100', messageId: '10', status,
          moderationEventId: judgementEventId, moderationMessageId: envelope.revisionIdentity });
      }
      return { chatId: '-100', messageId: '10', eventId, judgementEventId };
    },
  };
}

test('newer observed allowed revision replaces only unsent preparation and fences old completion', async (t) => {
  const h = fixture(t);
  const first = await h.observe();
  const old = h.store.claimAssistantQuestion(first).claim;
  assert.ok(old);
  assert.equal(h.store.completeAssistantQuestion({ ...first, claim: old, outcome: 'skipped' }).completed, true);
  const second = await h.observe(500);
  const fresh = h.store.claimAssistantQuestion(second).claim;
  assert.equal(fresh.generation, old.generation + 1);
  assert.equal(h.store.validateAssistantAnswerClaim(old), false);
  assert.equal(h.store.markAssistantAnswerCalling(old), false);
  assert.equal(h.store.completeAssistantQuestion({ ...first, claim: old, outcome: 'answered' }).completed, false);
  assert.equal(h.store.completeAssistantAnswerDelivery({ claim: old, state: 'confirmed' }).completed, false);
  assert.equal(h.row().event_id, second.eventId);
  assert.equal(h.row().state, 'preparing');
  assert.equal(h.store.validateAssistantAnswerClaim(fresh), true);
  assert.equal(h.db.prepare('SELECT status FROM runtime_assistant_question_claims').get().status, 'processing');
});

test('same revision never retries even after skipped completion or another stream receipt', async (t) => {
  const h = fixture(t);
  const input = await h.observe();
  const claim = h.store.claimAssistantQuestion(input).claim;
  h.store.completeAssistantQuestion({ ...input, claim, outcome: 'skipped' });
  assert.equal(h.store.claimAssistantQuestion(input).claimed, false);
  assert.equal(h.store.claimAssistantQuestion(await h.observe()).claimed, false);
});

for (const terminal of ['calling', 'confirmed', 'uncertain']) {
  test(`${terminal} native delivery permanently blocks replacement answer sequences`, async (t) => {
    const h = fixture(t);
    const input = await h.observe();
    const claim = h.store.claimAssistantQuestion(input).claim;
    assert.equal(h.store.markAssistantAnswerCalling(claim), true);
    assert.equal(h.store.markAssistantAnswerCalling(claim), true, 'same live claim may send further parts');
    if (terminal !== 'calling') assert.equal(h.store.completeAssistantAnswerDelivery({ claim, state: terminal }).completed, true);
    const newer = await h.observe(500);
    assert.equal(h.store.claimAssistantQuestion(newer).claimed, false);
    assert.equal(h.store.markAssistantAnswerCalling(claim), false, 'superseded claim cannot send another part');
    assert.equal(h.row().state, terminal);
    h.restart();
    assert.equal(h.store.claimAssistantQuestion(newer).claimed, false);
  });
}

test('restart does not reconstruct same-revision authority; newer unsent revision can replace', async (t) => {
  const h = fixture(t);
  const input = await h.observe();
  const old = h.store.claimAssistantQuestion(input).claim;
  h.restart();
  assert.equal(h.store.validateAssistantAnswerClaim(old), false);
  assert.equal(h.store.completeAssistantQuestion({ ...input, claim: old, outcome: 'answered' }).completed, false);
  assert.equal(h.store.claimAssistantQuestion(input).claimed, false);
  assert.equal(h.store.claimAssistantQuestion(await h.observe(500)).claimed, true);
});

test('legacy unresolved/completed native reservations never become new send authority', async (t) => {
  const h = fixture(t);
  const input = await h.observe();
  assert.deepEqual(h.store.claimAssistantQuestion({ chatId: '-100', messageId: '10' }), { claimed: true, existing: null });
  assert.equal(h.store.claimAssistantQuestion(input).claimed, false);
  assert.equal(h.store.completeAssistantQuestion({ chatId: '-100', messageId: '10', outcome: 'unknown' }).completed, true);
  assert.equal(h.store.claimAssistantQuestion(await h.observe(500)).claimed, false);
  assert.equal(h.row(), undefined);
});

test('opaque, wrong-target, missing-stream and stale-head claims fail closed', async (t) => {
  const h = fixture(t);
  const input = await h.observe();
  assert.equal(h.store.claimAssistantQuestion({ ...input, eventId: 'missing' }).claimed, false);
  assert.equal(h.store.claimAssistantQuestion({ ...input, messageId: '99' }).claimed, false);
  const claim = h.store.claimAssistantQuestion(input).claim;
  assert.ok(Object.isFrozen(claim));
  for (const forged of [{ ...claim }, { ...claim, eventId: 'missing' }, null]) {
    assert.equal(h.store.validateAssistantAnswerClaim(forged), false);
    assert.equal(h.store.markAssistantAnswerCalling(forged), false);
    assert.equal(h.store.completeAssistantQuestion({ ...input, claim: forged, outcome: 'answered' }).completed, false);
  }
  assert.equal(h.store.completeAssistantQuestion({ ...input, messageId: '99', claim, outcome: 'answered' }).completed, false);
  await h.observe(500);
  assert.equal(h.store.claimAssistantQuestion(input).claimed, false);
  assert.equal(h.store.markAssistantAnswerCalling(claim), false);
});

for (const status of ['pending', 'error']) {
  test(`explicit fixed fallback can claim exact ${status} disposition but cannot call answer provider`, async (t) => {
    const h = fixture(t);
    const input = await h.observe(0, status);
    assert.equal(h.store.claimAssistantQuestion(input).claimed, false);
    const claim = h.store.claimAssistantQuestion({ ...input, purpose: 'fallback' }).claim;
    assert.equal(claim.purpose, 'fallback');
    assert.equal(h.store.markAssistantAnswerProviderCalling(claim).marked, false);
    assert.equal(h.store.markAssistantAnswerCalling(claim), true);
    assert.equal(h.store.completeAssistantAnswerDelivery({ claim, state: 'confirmed' }).completed, true);
    assert.equal(h.store.claimAssistantQuestion(await h.observe(500)).claimed, false);
  });
}

test('blocked and foreign disposition never authorize answer or fallback', async (t) => {
  const h = fixture(t);
  const input = await h.observe(0, 'blocked');
  for (const purpose of ['answer', 'fallback']) assert.equal(h.store.claimAssistantQuestion({ ...input, purpose }).claimed, false);
  h.store.upsertAssistantDisposition({ chatId: '-100', messageId: '10', status: 'error',
    moderationMessageId: '-100:10:original', moderationEventId: 'foreign' });
  assert.equal(h.store.claimAssistantQuestion({ ...input, purpose: 'fallback' }).claimed, false);
});

test('superseded paid callback records only its original usage and cannot mutate newer native claim', async (t) => {
  const h = fixture(t);
  const oldInput = await h.observe();
  const old = h.store.claimAssistantQuestion(oldInput).claim;
  assert.equal(h.store.markAssistantAnswerProviderCalling(old).marked, true);
  assert.equal(h.store.markAssistantAnswerProviderCalling(old).marked, false);
  const newInput = await h.observe(500);
  const fresh = h.store.claimAssistantQuestion(newInput).claim;
  assert.equal(h.store.markAssistantAnswerProviderCalling(fresh).marked, true);
  assert.equal(h.store.completeAssistantAnswerProviderAttempt({ claim: old, status: 'returned', usage: {
    modelId: 'model-old', inputTokens: 80, outputTokens: 20, totalTokens: 100, answer: 'never persist this body',
  } }).completed, true);
  assert.equal(h.row().event_id, newInput.eventId);
  assert.equal(h.row().state, 'preparing');
  const oldAttempt = h.db.prepare('SELECT * FROM runtime_assistant_answer_attempts WHERE event_id = ?').get(oldInput.eventId);
  assert.equal(oldAttempt.status, 'returned');
  assert.equal(oldAttempt.total_tokens, 100);
  assert.equal(JSON.stringify(oldAttempt).includes('never persist'), false);
  assert.equal(h.db.prepare('SELECT status FROM runtime_assistant_answer_attempts WHERE event_id = ?').get(newInput.eventId).status, 'calling');
  assert.equal(h.store.completeAssistantAnswerProviderAttempt({ claim: { ...old }, status: 'returned', usage: {} }).completed, false);
  assert.equal(h.store.completeAssistantAnswerProviderAttempt({ claim: old, status: 'unknown', usage: {} }).completed, false);
});

test('unknown provider attempt preserves normalized receipt and cannot be replayed after restart', async (t) => {
  const h = fixture(t);
  const input = await h.observe();
  const claim = h.store.claimAssistantQuestion(input).claim;
  h.store.markAssistantAnswerProviderCalling(claim);
  assert.equal(h.store.completeAssistantAnswerProviderAttempt({ claim, status: 'unknown', usage: {
    modelId: 'bad model!', inputTokens: -1, outputTokens: NaN, totalTokens: 12,
  } }).completed, true);
  const attempt = h.db.prepare('SELECT * FROM runtime_assistant_answer_attempts').get();
  assert.equal(attempt.model_id, null);
  assert.equal(attempt.input_tokens, null);
  assert.equal(attempt.output_tokens, null);
  assert.equal(attempt.total_tokens, 12);
  h.restart();
  assert.equal(h.store.claimAssistantQuestion(input).claimed, false);
  assert.equal(h.store.markAssistantAnswerProviderCalling(claim).marked, false);
});
