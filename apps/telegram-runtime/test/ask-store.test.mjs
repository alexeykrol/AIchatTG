import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aichattg-ask-store-'));
  const path = join(dir, 'runtime.sqlite');
  let db;
  let store;
  let at = 1_700_000_000_123.25;
  let sequence = 0;
  function restart() {
    db?.close();
    db = openRuntimeDatabase(path);
    store = createRuntimeStore(db, { now: () => Math.floor(at / 1000), nowMs: () => at });
  }
  restart();
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    path, restart,
    get db() { return db; }, get store() { return store; }, get at() { return at; },
    advance(ms) { at += ms; },
    receipt(revisionIdentity, role = 'assistant', updateId = ++sequence) {
      const receiptId = `${role}:${updateId}`;
      store.claimInboundDelivery({ receiptId, role, updateId, revisionIdentity, payloadFingerprint: `fp-${revisionIdentity}` });
      return receiptId;
    },
    original(message = '10', prompt = '100', user = '7') {
      const eventId = this.receipt(`-100:${message}`);
      store.claimEvent({ eventId, role: 'assistant', updateId: sequence });
      return { eventId, chatId: '-100', userId: user, commandMessageId: message, promptMessageId: prompt };
    },
    job(message = '10', prompt = '100', user = '7') {
      const input = this.original(message, prompt, user);
      assert.ok(store.createAssistantAskPromptJob(input));
      return input;
    },
  };
}

test('fractional millisecond ACK deadline never expires before thirty full seconds', (t) => {
  const h = fixture(t);
  const job = h.job();
  assert.equal(h.store.getAssistantAskPromptJob(job).expires_at_ms, Math.ceil(h.at + 30_000));
  h.advance(29_999.99);
  assert.equal(h.store.claimNextExpiredAssistantAskPrompt(), null);
  h.advance(1);
  assert.ok(h.store.claimNextExpiredAssistantAskPrompt());
});

test('authenticated reply before delayed hint ACK survives restart and cancels idle expiry', (t) => {
  const h = fixture(t);
  const input = h.original();
  assert.equal(h.store.observeAssistantAskPromptReply(input).matched, false);
  h.restart();
  const row = h.store.createAssistantAskPromptJob(input);
  assert.equal(row.state, 'question_received');
  h.advance(60_000);
  assert.equal(h.store.claimNextExpiredAssistantAskPrompt(), null);
  assert.ok(h.store.claimAnsweredAssistantAskPrompt(input));
  const columns = h.db.prepare('PRAGMA table_info(runtime_assistant_ask_reply_observations)').all().map((row) => row.name);
  assert.deepEqual(columns, ['chat_id', 'user_id', 'prompt_message_id', 'observed_at', 'answer_event_id']);
});

test('fully delivered answer before hint ACK retains proof and can clean up immediately after ACK', (t) => {
  const h = fixture(t);
  const input = h.original();
  h.store.observeAssistantAskPromptReply(input);
  h.store.claimEvent({ eventId: 'answer-1', role: 'assistant', updateId: 500 });
  assert.equal(h.store.observeAssistantAskPromptAnswer({ ...input, answerEventId: 'answer-1' }).observed, true);
  assert.equal(h.store.observeAssistantAskPromptAnswer({ ...input, answerEventId: 'answer-1' }).observed, false);
  h.restart();
  assert.equal(h.store.createAssistantAskPromptJob(input).state, 'question_received');
  const observation = h.store.getAssistantAskPromptAnswerObservation(input);
  assert.deepEqual(observation, { answerEventId: 'answer-1' });
  const claim = h.store.claimAnsweredAssistantAskPrompt({ ...input, ...observation });
  assert.equal(h.store.validateAssistantAskPromptCleanupClaim(claim), true);
  assert.equal(h.store.completeAssistantAskPromptJob({ claim,
    prompt: { state: 'deleted' }, command: { state: 'deleted' },
  }).completed, true);
  assert.equal(h.store.claimAnsweredAssistantAskPrompt({ ...input, ...observation }), null);
});

test('terminal answer marker cannot manufacture missing reply, cross-user proof or unknown event', (t) => {
  const h = fixture(t);
  const input = h.original();
  h.store.claimEvent({ eventId: 'answer-1', role: 'assistant', updateId: 500 });
  assert.equal(h.store.observeAssistantAskPromptAnswer({ ...input, answerEventId: 'answer-1' }).observed, false);
  h.store.observeAssistantAskPromptReply(input);
  assert.equal(h.store.observeAssistantAskPromptAnswer({ ...input, answerEventId: 'unknown' }).observed, false);
  assert.equal(h.store.observeAssistantAskPromptAnswer({ ...input, userId: '8', answerEventId: 'answer-1' }).observed, false);
  assert.equal(h.store.getAssistantAskPromptAnswerObservation(input), null);
});

test('restart after ACK/job creation recovers fully delivered answer cleanup without waiting or model replay', (t) => {
  const h = fixture(t);
  const input = h.original();
  h.store.observeAssistantAskPromptReply(input);
  h.store.claimEvent({ eventId: 'answer-1', role: 'assistant', updateId: 500 });
  h.store.observeAssistantAskPromptAnswer({ ...input, answerEventId: 'answer-1' });
  h.store.createAssistantAskPromptJob(input);
  h.restart();
  const claim = h.store.claimNextCompletedAssistantAskPrompt();
  assert.equal(claim.eventId, input.eventId);
  assert.equal(claim.source, 'answer');
  assert.equal(h.store.validateAssistantAskPromptCleanupClaim(claim), true);
  assert.equal(h.store.claimNextCompletedAssistantAskPrompt(), null);
  assert.equal(h.store.claimNextExpiredAssistantAskPrompt(), null);
});

test('foreign user or chat observations cannot cancel an owner timer', (t) => {
  const h = fixture(t);
  const input = h.original();
  h.store.observeAssistantAskPromptReply({ ...input, userId: '8' });
  h.store.observeAssistantAskPromptReply({ ...input, chatId: '-200' });
  assert.equal(h.store.createAssistantAskPromptJob(input).state, 'pending');
  h.advance(30_001);
  assert.ok(h.store.claimNextExpiredAssistantAskPrompt());
});

test('native edit evidence survives unrelated volume, restart and original arriving later', (t) => {
  const h = fixture(t);
  h.receipt('-100:edit:1700000000:10', 'moderator');
  for (let index = 0; index < 2050; index++) h.receipt(`-200:${index + 1}`);
  h.restart();
  const input = h.original();
  assert.equal(h.store.createAssistantAskPromptJob(input), null);
  assert.equal(h.db.prepare('SELECT edited FROM runtime_assistant_ask_native_observations WHERE chat_id = ? AND message_id = ?').get('-100', '10').edited, 1);
  const queryPlan = h.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM runtime_assistant_ask_native_observations WHERE chat_id = ? AND message_id = ?').all('-100', '10');
  assert.match(queryPlan[0].detail, /SEARCH .* USING INDEX/);
});

for (const role of ['moderator', 'assistant']) {
  test(`${role} receipt observes an edit before dispatch/skip and permanently revokes authority`, (t) => {
    const h = fixture(t);
    const input = h.job();
    h.receipt('-100:edit:1700000001:10', role);
    h.advance(30_001);
    assert.equal(h.store.claimNextExpiredAssistantAskPrompt(), null);
    assert.equal(h.store.getAssistantAskPromptJob(input).state, 'skipped');
    assert.equal(h.store.getAssistantAskPromptJob(input).error_code, 'command_edited');
  });
}

test('one invalid or edited due row does not stop the valid expiry batch', (t) => {
  const h = fixture(t);
  const first = h.job('10', '100');
  const second = h.job('11', '101');
  h.receipt('-100:edit:1700000001:10', 'moderator');
  h.advance(30_001);
  const claim = h.store.claimNextExpiredAssistantAskPrompt();
  assert.equal(claim.eventId, second.eventId);
  assert.equal(h.store.getAssistantAskPromptJob(first).state, 'skipped');
});

test('invalid original proof at head of due queue is skipped without starving next valid row', (t) => {
  const h = fixture(t);
  const first = h.job('10', '100');
  const second = h.job('11', '101');
  h.db.prepare('UPDATE runtime_inbound_update_receipts SET revision_identity = ? WHERE receipt_id = ?')
    .run('-200:10', first.eventId);
  h.advance(30_001);
  assert.equal(h.store.claimNextExpiredAssistantAskPrompt().eventId, second.eventId);
  assert.equal(h.store.getAssistantAskPromptJob(first).error_code, 'original_unproven');
});

test('public cleanup claims cannot forge targets, clone authority or complete after restart', (t) => {
  const h = fixture(t);
  h.job();
  h.advance(30_001);
  const claim = h.store.claimNextExpiredAssistantAskPrompt();
  assert.ok(Object.isFrozen(claim));
  assert.equal(h.store.validateAssistantAskPromptCleanupClaim(claim), true);
  for (const forged of [{ ...claim }, { ...claim, promptMessageId: '999' }, { ...claim, chatId: '-200' }]) {
    assert.equal(h.store.validateAssistantAskPromptCleanupClaim(forged), false);
    assert.equal(h.store.completeAssistantAskPromptJob({ claim: forged }).completed, false);
  }
  h.restart();
  assert.equal(h.store.validateAssistantAskPromptCleanupClaim(claim), false);
  assert.equal(h.store.claimNextExpiredAssistantAskPrompt(), null);
});

test('edit after cleanup claim revokes external deletion authority without replay', (t) => {
  const h = fixture(t);
  h.job();
  h.advance(30_001);
  const claim = h.store.claimNextExpiredAssistantAskPrompt();
  h.receipt('-100:edit:1700000001:10', 'moderator');
  assert.equal(h.store.validateAssistantAskPromptCleanupClaim(claim), false);
  assert.equal(h.store.claimNextExpiredAssistantAskPrompt(), null);
});

test('47-hour expiry skips the whole service pair, including answer cleanup', (t) => {
  const h = fixture(t);
  const expiry = h.job('10', '100');
  const answer = h.job('11', '101');
  h.store.observeAssistantAskPromptReply(answer);
  h.advance(47 * 60 * 60 * 1000 + 1);
  assert.equal(h.store.claimNextExpiredAssistantAskPrompt(), null);
  assert.equal(h.store.claimAnsweredAssistantAskPrompt(answer), null);
  for (const input of [expiry, answer]) {
    const row = h.store.getAssistantAskPromptJob(input);
    assert.equal(row.state, 'skipped');
    assert.equal(row.error_code, 'cleanup_authority_expired');
  }
});

test('uncertain deletion result and in-flight crash never schedule a second external attempt', (t) => {
  const h = fixture(t);
  const input = h.job();
  h.advance(30_001);
  const claim = h.store.claimNextExpiredAssistantAskPrompt();
  assert.equal(h.store.completeAssistantAskPromptJob({ claim,
    prompt: { state: 'uncertain' }, command: { state: 'skipped' },
  }).completed, true);
  h.restart();
  assert.equal(h.store.getAssistantAskPromptJob(input).state, 'uncertain');
  assert.equal(h.store.claimNextExpiredAssistantAskPrompt(), null);
  h.store.observeAssistantAskPromptReply(input);
  assert.equal(h.store.claimAnsweredAssistantAskPrompt(input), null);
});

test('answer and idle-expiry claims are mutually exclusive; late reply linkage remains', (t) => {
  const h = fixture(t);
  const input = h.job();
  h.advance(30_001);
  const expiry = h.store.claimNextExpiredAssistantAskPrompt();
  assert.equal(h.store.observeAssistantAskPromptReply(input).matched, true);
  assert.equal(h.store.claimAnsweredAssistantAskPrompt(input), null);
  assert.ok(h.store.completeAssistantAskPromptJob({ claim: expiry,
    prompt: { state: 'deleted' }, command: { state: 'deleted' },
  }).completed);
  const second = h.job('11', '101');
  h.store.observeAssistantAskPromptReply(second);
  const answer = h.store.claimAnsweredAssistantAskPrompt({ ...second, answerEventId: 'answer-1' });
  assert.equal(h.store.validateAssistantAskPromptCleanupClaim(answer), true);
  h.advance(30_001);
  assert.equal(h.store.claimNextExpiredAssistantAskPrompt(), null);
});

test('new durable jobs can never claim legacy cleanup even if public caller attempts fallback', (t) => {
  const h = fixture(t);
  const input = h.job();
  h.store.completeEvent(input.eventId, 'completed', {
    kind: 'answered', command: 'ask_empty', route: 'command:ask_empty',
    receipt: { ok: true, messageId: input.promptMessageId }, askPrompt: input,
  });
  assert.equal(h.store.claimAssistantAskCleanup({ ...input, questionMessageId: '11', answerEventId: 'answer' }), null);
  h.store.invalidateAssistantAskPrompt(input);
  assert.equal(h.store.claimAssistantAskCleanup({ ...input, questionMessageId: '11', answerEventId: 'answer' }), null);
});

test('job creation rejects unsafe IDs, missing original, collisions and invalid deadlines', (t) => {
  const h = fixture(t);
  const input = h.original();
  for (const patch of [
    { chatId: 'undefined' }, { userId: null }, { commandMessageId: '100' },
    { promptMessageId: '-1' }, { promptMessageId: '9007199254740992' },
    { timeoutMs: Infinity }, { timeoutMs: -1 }, { timeoutMs: 'nan' }, { eventId: 'missing' },
  ]) assert.equal(h.store.createAssistantAskPromptJob({ ...input, ...patch }), null);
  const job = h.store.createAssistantAskPromptJob(input);
  assert.ok(job);
  assert.equal(h.store.createAssistantAskPromptJob({ ...input, promptMessageId: '102' }), null);
  h.advance(1000);
  assert.deepEqual(h.store.createAssistantAskPromptJob(input), job);
});

test('synthetic old schema migrates additively and does not invent expiry for legacy service pairs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aichattg-ask-old-'));
  const path = join(dir, 'old.sqlite');
  const old = new Database(path);
  old.exec(`CREATE TABLE runtime_inbound_events (
    event_id TEXT PRIMARY KEY, bot_role TEXT NOT NULL, update_id INTEGER NOT NULL,
    status TEXT NOT NULL, result_json TEXT, error_text TEXT,
    created_at INTEGER NOT NULL, completed_at INTEGER
  )`);
  old.exec(`CREATE TABLE runtime_assistant_ask_reply_observations (
    chat_id TEXT NOT NULL, user_id TEXT NOT NULL, prompt_message_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL, PRIMARY KEY(chat_id, user_id, prompt_message_id)
  ); INSERT INTO runtime_assistant_ask_reply_observations VALUES ('-100', '7', '100', 1)`);
  const historical = JSON.stringify({ route: 'command:ask_empty', askPrompt: { promptMessageId: '100' } });
  old.prepare("INSERT INTO runtime_inbound_events VALUES ('old', 'assistant', 1, 'completed', ?, NULL, 1, 1)").run(historical);
  old.close();
  const db = openRuntimeDatabase(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = createRuntimeStore(db);
  assert.equal(db.prepare("SELECT result_json FROM runtime_inbound_events WHERE event_id='old'").get().result_json, historical);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runtime_assistant_ask_prompt_jobs').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runtime_assistant_ask_native_observations').get().count, 0);
  assert.deepEqual(db.prepare('SELECT * FROM runtime_assistant_ask_reply_observations').get(), {
    chat_id: '-100', user_id: '7', prompt_message_id: '100', observed_at: 1, answer_event_id: null,
  });
  assert.equal(store.claimNextExpiredAssistantAskPrompt(), null);
});
