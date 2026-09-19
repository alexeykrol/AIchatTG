import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';

function fixture(t) {
  const db = openRuntimeDatabase(':memory:');
  t.after(() => db.close());
  const store = createRuntimeStore(db, { now: () => 100 });
  const eventId = 'moderator:99';
  store.claimInboundDelivery({ receiptId: eventId, role: 'moderator', updateId: 99,
    revisionIdentity: '-100:99', payloadFingerprint: 'f'.repeat(64) });
  store.claimEvent({ eventId, role: 'moderator', updateId: 99 });
  store.ensureModeratorJudgement({ eventId, receiptId: eventId,
    comment: { chatId: '-100', messageId: '99', platformMessageId: '-100:99', userId: '7',
      senderChatId: null, isBot: false, hasLink: false, text: 'synthetic question' } });
  return { db, store, eventId, claim: store.claimModeratorJudgement({ eventId }).claim };
}

const diagnostic = { stage: 'router', reason: 'completion_truncated', finishReason: 'length',
  refusal: false, outputTextChars: 12, inputTokens: 30, outputTokens: 1024, totalTokens: 1054 };

test('manual review stores only closed diagnostic metadata in the existing result column', (t) => {
  const { db, store, eventId, claim } = fixture(t);
  const before = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  const result = store.manualReviewModeratorJudgement({ claim, errorCode: 'provider_safety_router_invalid',
    providerDiagnostic: { ...diagnostic, text: 'private-output', prompt: 'private-input',
      apiKey: 'private-key', requestId: 'private-id', nested: { secret: true } } });
  assert.equal(result.marked, true);
  assert.deepEqual(JSON.parse(result.row.result_json), { providerDiagnostic: diagnostic });
  assert.equal(result.row.state, 'manual_review');
  assert.equal(result.row.provider_boundary, 'unknown');
  assert.equal(result.row.safe_retry_count, 0);
  assert.equal(result.row.decision_json, null);
  assert.equal(store.getModeratorJudgement(eventId).result_json.includes('private-'), false);
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), before);
  assert.equal(store.claimModeratorJudgement({ eventId }).claimed, false);
});

test('stale worker cannot store diagnostic metadata over the current lease', (t) => {
  const { store, eventId, claim } = fixture(t);
  store.deferModeratorJudgement({ claim, nextAttemptAt: 100 });
  const current = store.claimModeratorJudgement({ eventId }).claim;
  assert.equal(store.manualReviewModeratorJudgement({ claim, providerDiagnostic: diagnostic }).marked, false);
  assert.equal(store.getModeratorJudgement(eventId).result_json, null);
  assert.equal(store.manualReviewModeratorJudgement({ claim: current, providerDiagnostic: diagnostic }).marked, true);
});

for (const value of [null, { ...diagnostic, reason: 'private-provider-message' }, { ...diagnostic, stage: 'private-stage' }]) {
  test('absent or unrecognized diagnostics remain null and do not change fail-closed state', (t) => {
    const { store, claim } = fixture(t);
    const result = store.manualReviewModeratorJudgement({ claim, providerDiagnostic: value });
    assert.equal(result.marked, true);
    assert.equal(result.row.result_json, null);
    assert.equal(result.row.state, 'manual_review');
  });
}
