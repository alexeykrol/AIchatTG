import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ASSISTANT_ROUTER_FAILURE_TEXT } from '../src/assistant-policy.mjs';
import { ASSISTANT_RELEASE_LINE } from '../src/assistant-release.mjs';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';
import { createGuardAdapter } from '../src/guard-adapter.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import { safetyVerdict } from './safety-fixture.mjs';

const ASSISTANT_ID = 7654321;

function update(updateId, messageId, text, { edited = false } = {}) {
  const message = {
    message_id: messageId,
    chat: { id: -100 },
    from: { id: 7, first_name: 'Student', is_bot: false },
    text,
    ...(edited ? { edit_date: 10 } : {}),
  };
  return { update_id: updateId, [edited ? 'edited_message' : 'message']: message };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(t, {
  moderate = null, guard: suppliedGuard = null, answer: suppliedAnswer = null, send: suppliedSend = null,
} = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-single-judge-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const sends = [];
  let moderationCalls = 0;
  const provider = {
    async moderate(input) {
      moderationCalls++;
      return moderate
        ? moderate(input, moderationCalls)
        : safetyVerdict({
          message: input.text,
          safetyRoute: 'clean',
          context: { currentWeakStrikes: input.currentWeakStrikes, warningStage: input.warningStage },
        });
    },
    async routeAssistant() { return { action: 'teach', sourceId: 'course-content-v1' }; },
    async answer(input) {
      return suppliedAnswer ? suppliedAnswer(input) : { text: `answer:${input.text}`, modelId: 'fixture' };
    },
  };
  const moderatorTelegram = {
    async banMember() { return { ok: true }; },
    async banSenderChat() { return { ok: true }; },
    async deleteMessage() { return { ok: true }; },
    async sendMessage() { return { ok: true }; },
    async unpinMessage() { return { ok: true }; },
  };
  const guard = suppliedGuard || {
      async verifyEnforcement() { return { proven: true, status: 'administrator' }; },
      async senderDisposition() { return { proven: true, exempt: false, reason: null }; },
      deleteMessage: (input) => moderatorTelegram.deleteMessage(input),
      sendWarning: (input) => moderatorTelegram.sendMessage(input),
      unpinMessage: (input) => moderatorTelegram.unpinMessage(input),
      banAuthor: (input) => input.senderChatId == null
        ? moderatorTelegram.banMember(input) : moderatorTelegram.banSenderChat(input),
  };
  const assistantTelegram = {
      async sendMessage(input) {
        sends.push(input);
        if (suppliedSend) return suppliedSend(input, sends.length);
        return { ok: true, data: { message_id: 100 + sends.length } };
      },
      async deleteMessage() { return { ok: true }; },
  };
  const createRuntime = () => createTelegramRuntime({
    config: {
      ingressEnabled: false,
      moderationMode: 'live',
      assistantModerationWaitMs: 0,
      assistantModerationPollMs: 1,
      assistantKnowledgeEnabled: true,
      assistantCooldownSec: 0,
      assistantDailyPerUser: 100,
      assistantDialogueTurnLimit: 20,
      assistantDialogueTtlSec: 604800,
      assistant: {
        chatIds: ['-100'], botToken: `${ASSISTANT_ID}:fixture`, botUsername: 'assistant_bot', exemptBotIds: [],
      },
      moderator: { chatIds: ['-100'], botToken: '123:fixture', botUsername: 'moderator_bot', exemptBotIds: [] },
    },
    store: createRuntimeStore(db), provider, guard, assistantTelegram,
    knowledge: {
      forSource(sourceId) {
        return sourceId === 'course-content-v1'
          ? { available: true, snapshot: { sourceId, entries: [{ id: 'fixture', content: 'offline course fixture' }] } }
          : { available: false, reason: 'knowledge_source_unavailable' };
      },
    },
    notifier: { async notify() { return { delivered: true }; } },
  });
  let runtime = createRuntime();
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  return {
    get runtime() { return runtime; }, db, sends, provider,
    moderationCalls: () => moderationCalls,
    restart() { runtime = createRuntime(); return runtime; },
  };
}

for (const order of [
  ['moderator', 'assistant'],
  ['assistant', 'moderator'],
]) {
  test(`one Assistant-owned judge is used in ${order.join(' → ')} webhook order`, async (t) => {
    const h = harness(t);
    const results = [];
    for (const [index, role] of order.entries()) {
      results.push([role, await h.runtime.handleUpdate(role, update(100 + index, 50, '/ask one judge'))]);
    }
    assert.equal(h.moderationCalls(), 1);
    assert.equal(h.sends.length, 1);
    assert.equal(results.find(([role]) => role === 'assistant')[1].kind, 'answered');
    assert.deepEqual(h.db.prepare(`SELECT owner, event_id, state FROM runtime_judgement_envelopes
      WHERE revision_identity = '-100:50:original'`).get(), {
      owner: 'assistant', event_id: `${order[0]}:100`, state: 'active',
    });
  });
}

test('concurrent streams attach to one in-flight Assistant-owned judge', async (t) => {
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  let providerStarted;
  const providerStartedPromise = new Promise((resolve) => { providerStarted = resolve; });
  const h = harness(t, {
    moderate(input) {
      providerStarted();
      return started.then(() => safetyVerdict({ message: input.text, safetyRoute: 'clean' }));
    },
  });
  const assistant = h.runtime.handleUpdate('assistant', update(200, 51, '/ask concurrent'));
  await providerStartedPromise;
  const moderator = h.runtime.handleUpdate('moderator', update(201, 51, '/ask concurrent'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.moderationCalls(), 1);
  release();
  const [assistantResult] = await Promise.all([assistant, moderator]);
  assert.equal(assistantResult.kind, 'answered');
  assert.equal(h.sends.length, 1);
  assert.equal(h.moderationCalls(), 1);
});

test('an Assistant-only direct question is judged and answered without a Moderator stream', async (t) => {
  const h = harness(t);
  const result = await h.runtime.handleUpdate('assistant', update(300, 52, '/ask no moderator delivery'));
  assert.equal(result.kind, 'answered');
  assert.equal(h.moderationCalls(), 1);
  assert.equal(h.sends.length, 1);
});

test('a Moderator-only addressed question creates the Assistant-owned judgement but cannot answer early', async (t) => {
  const h = harness(t);
  const moderator = await h.runtime.handleUpdate('moderator', update(350, 525, '/ask raw source stays intact'));
  assert.equal(moderator.kind, 'moderated');
  assert.equal(h.moderationCalls(), 1);
  assert.equal(h.sends.length, 0, 'only the Assistant stream may deliver a substantive answer');
  assert.deepEqual(h.db.prepare(`SELECT owner, event_id FROM runtime_judgement_envelopes
    WHERE revision_identity = '-100:525:original'`).get(), {
    owner: 'assistant', event_id: 'moderator:350',
  });
  const snapshot = h.db.prepare(`SELECT snapshot_json FROM runtime_moderator_judgement_jobs
    WHERE event_id = 'moderator:350'`).get();
  assert.match(snapshot.snapshot_json, /\/ask raw source stays intact/,
    'the arbiter receives the unstripped source rather than an Assistant-normalized question');

  const assistant = await h.runtime.handleUpdate('assistant', update(351, 525, '/ask raw source stays intact'));
  assert.equal(assistant.kind, 'answered');
  assert.equal(h.moderationCalls(), 1);
  assert.equal(h.sends.length, 1);
});

test('redelivery on both streams and restart after acceptance never repeats provider, judgement, or weak strike', async (t) => {
  const h = harness(t, {
    moderate(input) {
      return safetyVerdict({ message: input.text, safetyRoute: 'abuse', abuseLevel: 'weak' });
    },
  });
  const moderator = update(360, 526, '/ask duplicate weak abuse');
  const assistant = update(361, 526, '/ask duplicate weak abuse');
  await h.runtime.handleUpdate('moderator', moderator);
  await h.runtime.handleUpdate('assistant', assistant);
  await h.runtime.handleUpdate('moderator', moderator);
  await h.runtime.handleUpdate('assistant', assistant);
  h.restart();
  await h.runtime.handleUpdate('assistant', assistant);
  await h.runtime.handleUpdate('moderator', moderator);

  assert.equal(h.moderationCalls(), 1);
  assert.equal(h.db.prepare(`SELECT count(*) AS count FROM runtime_moderator_judgement_jobs AS job
    JOIN runtime_judgement_envelopes AS envelope ON envelope.event_id = job.event_id
    WHERE envelope.revision_identity = '-100:526:original'`).get().count, 1);
  assert.equal(h.db.prepare(`SELECT weak_strikes FROM runtime_moderation_weak_strikes
    WHERE chat_id = '-100' AND user_id = '7'`).get().weak_strikes, 1);
});

test('an invalid judgement has one visible code-owned fallback and no content answer', async (t) => {
  const h = harness(t, {
    async moderate() {
      // The shallow legacy shape normalizes, but the new submission boundary
      // must reject this trace because it cannot prove raw evidence.
      return {
        safetyRoute: 'clean', abuseLevel: null, confidence: 1,
        reason: 'forged', modelId: 'fixture', safetyTrace: {},
      };
    },
  });
  const result = await h.runtime.handleUpdate('assistant', update(400, 53, '/ask invalid safety'));
  assert.deepEqual({ kind: result.kind, degraded: result.degraded, reason: result.reason }, {
    kind: 'answered', degraded: true, reason: 'judgement_unavailable',
  });
  assert.equal(h.moderationCalls(), 1);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].text, ASSISTANT_ROUTER_FAILURE_TEXT);
  assert.equal(h.sends[0].footer, ASSISTANT_RELEASE_LINE);
  assert.equal(h.db.prepare(`SELECT state FROM runtime_moderator_judgement_jobs
    WHERE event_id = 'assistant:400'`).get().state, 'manual_review');
  assert.equal(h.db.prepare('SELECT count(*) AS count FROM runtime_assistant_turns').get().count, 0,
    'a service fallback is not a model dialogue turn');

  await h.runtime.handleUpdate('moderator', update(401, 53, '/ask invalid safety'));
  const recovery = await h.runtime.recoverModeratorJudgements({ limit: 10, startup: true });
  assert.equal(recovery.recovered, 0);
  assert.equal(h.moderationCalls(), 1);
  assert.equal(h.sends.length, 1, 'late stream and recovery must not repeat fallback delivery');
});

test('a stale threat cannot cross the real Guard final rights boundary after an edit', async (t) => {
  const rightsEntered = deferred();
  const releaseRights = deferred();
  const externalActions = [];
  let guardProofs = 0;
  const member = { status: 'member' };
  const administrator = {
    status: 'administrator', can_delete_messages: true, can_restrict_members: true,
  };
  const guard = createGuardAdapter({
    guardBotId: '123', guardChatIds: ['-100'],
    telegram: {
      async getChatMember({ userId }) {
        if (String(userId) === '7') return { ok: true, data: member };
        guardProofs++;
        if (guardProofs === 1) {
          rightsEntered.resolve();
          await releaseRights.promise;
        }
        return { ok: true, data: administrator };
      },
      async deleteMessage(input) { externalActions.push({ name: 'delete', input }); return { ok: true }; },
      async sendMessage(input) { externalActions.push({ name: 'warning', input }); return { ok: true }; },
      async banMember(input) { externalActions.push({ name: 'ban', input }); return { ok: true }; },
    },
  });
  const h = harness(t, {
    guard,
    moderate(input, call) {
      return safetyVerdict({
        message: input.text,
        safetyRoute: call === 1 ? 'threat' : 'clean',
      });
    },
  });
  const original = h.runtime.handleUpdate('assistant', update(450, 535, '/ask threat before edit'));
  await rightsEntered.promise;
  const edited = await h.runtime.handleUpdate('assistant', update(451, 535, '/ask safe after edit', { edited: true }));
  assert.equal(edited.kind, 'answered');
  releaseRights.resolve();
  await original;

  assert.equal(h.moderationCalls(), 2);
  assert.deepEqual(externalActions, [],
    'the Guard re-proves rights and then observes the stale revision before every Telegram action');
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].replyToMessageId, '535');
});

test('an edit replaces an answer still before first send without refunding the obsolete provider reservation', async (t) => {
  const originalAnswerStarted = deferred();
  const releaseOriginalAnswer = deferred();
  let answerCalls = 0;
  const h = harness(t, {
    answer({ text }) {
      answerCalls++;
      if (answerCalls === 1) {
        originalAnswerStarted.resolve();
        return releaseOriginalAnswer.promise.then(() => ({ text: `old:${text}`, modelId: 'fixture' }));
      }
      return { text: `new:${text}`, modelId: 'fixture' };
    },
  });
  const original = h.runtime.handleUpdate('assistant', update(460, 536, '/ask old answer'));
  await originalAnswerStarted.promise;
  const edited = await h.runtime.handleUpdate('assistant', update(461, 536, '/ask new answer', { edited: true }));
  assert.equal(edited.kind, 'answered');
  releaseOriginalAnswer.resolve();
  await original;

  assert.equal(answerCalls, 2, 'the old provider call crossed its paid boundary and is never replayed');
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].text, 'new:new answer');
  assert.equal(h.sends[0].replyToMessageId, '536');
  const reservations = h.db.prepare(`SELECT event_id, status FROM runtime_assistant_request_reservations
    WHERE event_id IN ('assistant:460', 'assistant:461') ORDER BY event_id`).all();
  assert.equal(reservations.length, 2, 'both ordinary quota reservations remain accounted for');
  assert.ok(reservations.every(({ status }) => ['completed', 'uncertain'].includes(status)),
    'an obsolete call which reached the provider must never be refunded');
});

for (const delivery of ['calling', 'partial', 'throw', 'confirmed']) {
  test(`an edit cannot start a second answer after the first send is ${delivery}`, async (t) => {
    const entered = deferred();
    const release = deferred();
    let answerCalls = 0;
    const h = harness(t, {
      answer({ text }) { answerCalls++; return { text: `answer:${text}`, modelId: 'fixture' }; },
      async send(_input, count) {
        assert.equal(count, 1, 'a native question has only one visible answer sequence');
        if (delivery === 'calling') {
          entered.resolve();
          await release.promise;
          return { ok: true, data: { message_id: 801 } };
        }
        if (delivery === 'partial') return { ok: true, partial: true, data: { message_id: 801 } };
        if (delivery === 'throw') throw new Error('transport outcome unknown');
        return { ok: true, data: { message_id: 801 } };
      },
    });
    const originalUpdate = update(470, 537, '/ask original delivery');
    const original = h.runtime.handleUpdate('assistant', originalUpdate);
    if (delivery === 'calling') await entered.promise;
    else await original;

    const edit = await h.runtime.handleUpdate('assistant', update(471, 537, '/ask edit after send boundary', { edited: true }));
    assert.equal(edit.kind, 'duplicate_question');
    if (delivery === 'calling') {
      release.resolve();
      await original;
    }
    assert.equal(answerCalls, 1);
    assert.equal(h.sends.length, 1);
    assert.equal(h.db.prepare(`SELECT count(*) AS count FROM runtime_assistant_request_reservations
      WHERE chat_id = '-100' AND user_id = '7'`).get().count, 1,
    'a rejected edit leaves ordinary quota accounting unchanged');

    h.restart();
    await h.runtime.handleUpdate('assistant', originalUpdate);
    assert.equal(answerCalls, 1, 'restart and redelivery cannot replay the answer provider');
    assert.equal(h.sends.length, 1, 'restart and redelivery cannot replay a native answer');
  });
}

test('a stale async original judgement cannot answer after an edited revision wins', async (t) => {
  let releaseOriginal;
  const originalGate = new Promise((resolve) => { releaseOriginal = resolve; });
  let originalStarted;
  const originalStartedPromise = new Promise((resolve) => { originalStarted = resolve; });
  const h = harness(t, {
    moderate(input, call) {
      if (call === 1) {
        originalStarted();
        return originalGate.then(() => safetyVerdict({ message: input.text, safetyRoute: 'clean' }));
      }
      return safetyVerdict({ message: input.text, safetyRoute: 'clean' });
    },
  });
  const original = h.runtime.handleUpdate('assistant', update(500, 54, '/ask original'));
  await originalStartedPromise;
  const edited = await h.runtime.handleUpdate('assistant', update(501, 54, '/ask edited', { edited: true }));
  assert.equal(edited.kind, 'answered');
  releaseOriginal();
  const stale = await original;
  assert.deepEqual({ kind: stale.kind, reason: stale.reason }, { kind: 'skipped', reason: 'stale_judgement' });
  assert.equal(h.moderationCalls(), 2);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].replyToMessageId, '54');
});
