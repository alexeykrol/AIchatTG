import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { messageIdentity } from '@aichattg/telegram-core';
import { ASSISTANT_EMPTY_ASK_TEXT } from '../src/assistant-policy.mjs';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';
import { createGuardAdapter } from '../src/guard-adapter.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';

function harness(t, options = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-ask-cleanup-'));
  const path = join(folder, 'runtime.db');
  let db;
  let store;
  let runtime;
  let updateId = 0;
  let sentId = 1000;
  let now = 1_000_000;
  const actions = [];
  const botId = 555444;
  const config = {
    assistantModerationWaitMs: 0, assistantCooldownSec: 0, assistantDailyPerUser: 100,
    assistantDialogueTurnLimit: 10, assistantDialogueTtlSec: 604800,
    assistant: {
      chatIds: ['-100', '-200'], botToken: `${botId}:fixture`, botUsername: 'assistant_bot', exemptBotIds: [],
    },
    moderator: { chatIds: ['-100', '-200'], botToken: '111:fixture', exemptBotIds: [] },
  };
  const telegram = {
    async getChatMember(input) {
      actions.push({ kind: 'guard_rights', ...input });
      await options.beforeGuardProof?.(input);
      return { ok: true, data: {
        user: { id: 111 }, status: 'administrator',
        can_delete_messages: options.guardRights !== false, can_restrict_members: true,
      } };
    },
    async deleteMessage(input) {
      actions.push({ kind: 'guard_delete', ...input });
      if (options.commandThrows) throw new Error('fixture transport timeout');
      return options.commandResult || { ok: true };
    },
  };
  const assistant = {
    async sendMessage(input) {
      const messageId = String(sentId++);
      actions.push({ kind: 'send', messageId, ...input });
      await options.beforeHintSendReturn?.(input);
      const overridden = options.delivery?.(input);
      return { ok: true, data: { message_id: Number(messageId) }, ...overridden };
    },
    async deleteMessage(input) {
      actions.push({ kind: 'assistant_delete', ...input });
      await options.beforePromptDelete?.(input);
      if (options.promptThrows) throw new Error('fixture transport timeout');
      return options.promptResult || { ok: true };
    },
  };
  function restart() {
    db?.close();
    db = openRuntimeDatabase(path);
    store = createRuntimeStore(db, { now: () => now });
    runtime = createTelegramRuntime({
      config, store, assistantTelegram: assistant,
      guard: options.noGuard ? null : createGuardAdapter({
        telegram, guardBotId: 111, guardChatIds: config.moderator.chatIds,
      }),
    });
  }
  restart();
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  function update(messageId, text, { userId = 7, chatId = -100, replyTo = null, edited = false } = {}) {
    const message = {
      message_id: messageId, chat: { id: chatId }, from: { id: userId, is_bot: false }, text,
      ...(edited ? { edit_date: now } : {}),
      ...(replyTo == null ? {} : { reply_to_message: {
        message_id: Number(replyTo), from: { id: botId, is_bot: true }, text: ASSISTANT_EMPTY_ASK_TEXT,
      } }),
    };
    return { update_id: ++updateId, [edited ? 'edited_message' : 'message']: message };
  }
  async function receive(input) {
    const message = input.message || input.edited_message;
    const identity = messageIdentity(message, input);
    store.upsertAssistantDisposition({
      chatId: identity.chatId, messageId: identity.messageId,
      moderationMessageId: identity.platformMessageId, status: 'allowed', verdict: 'clean',
    });
    return runtime.handleUpdate('assistant', input);
  }
  return {
    actions, update, receive, restart,
    get db() { return db; }, get store() { return store; },
    advance(seconds) { now += seconds; },
    deletions() { return actions.filter((action) => action.kind.endsWith('_delete')); },
    result(eventId) {
      return JSON.parse(db.prepare('SELECT result_json FROM runtime_inbound_events WHERE event_id = ?')
        .get(eventId).result_json);
    },
    async menu(text = '/ask@assistant_bot') {
      const result = await receive(update(10, text));
      assert.equal(result.command, 'ask_empty');
      return result;
    },
  };
}

test('menu → reply → full answer removes only linked command and hint, keeping real Q/A', async (t) => {
  const h = harness(t);
  const menu = await h.menu();
  assert.equal(h.actions[0].forceReply, true);
  assert.deepEqual(h.deletions(), []);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM runtime_assistant_turns').get().n, 0);
  assert.deepEqual(h.result(menu.eventId).askPrompt, {
    chatId: '-100', userId: '7', commandMessageId: '10', promptMessageId: '1000',
  });
  assert.equal(JSON.stringify(h.result(menu.eventId)).includes(ASSISTANT_EMPTY_ASK_TEXT), false);

  const question = h.update(11, 'Что ты можешь?', { replyTo: menu.receipt.messageId });
  const answer = await h.receive(question);
  assert.equal(answer.kind, 'answered');
  assert.deepEqual(h.deletions(), [
    { kind: 'assistant_delete', chatId: '-100', messageId: '1000' },
    { kind: 'guard_delete', chatId: '-100', messageId: '10' },
  ]);
  const sent = h.actions.filter((action) => action.kind === 'send');
  assert.equal(sent[1].replyToMessageId, '11');
  assert.ok(h.actions.indexOf(sent[1]) < h.actions.indexOf(h.deletions()[0]));
  const turn = h.db.prepare('SELECT question, answer FROM runtime_assistant_turns').get();
  assert.equal(turn.question, 'Что ты можешь?');
  assert.ok(turn.answer.length > 0);
  assert.equal(h.result(menu.eventId).askPromptCleanup.command.actor, 'guard');
  assert.deepEqual(await h.receive(question), answer);
  assert.equal(h.deletions().length, 2);
});

test('prompt linkage survives a real database/runtime restart', async (t) => {
  const h = harness(t);
  const menu = await h.menu('/ask');
  h.restart();
  assert.equal((await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }))).kind, 'answered');
  assert.equal(h.deletions().length, 2);
});

test('another user, another chat, and a historical real-answer reply never match the pair', async (t) => {
  const h = harness(t);
  const menu = await h.menu();
  await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId, userId: 8 }));
  await h.receive(h.update(12, 'Кто ты?', { replyTo: menu.receipt.messageId, chatId: -200 }));
  const prior = await h.receive(h.update(13, '/ask Кто ты?'));
  // Even exact prompt-looking reply text is insufficient without ID ownership.
  await h.receive(h.update(14, 'Что ты можешь?', { replyTo: prior.receipt.messageId }));
  assert.deepEqual(h.deletions(), []);
  assert.equal(h.result(menu.eventId).askPromptCleanup, undefined);
  await h.receive(h.update(15, 'Кто ты?', { replyTo: menu.receipt.messageId }));
  assert.equal(h.deletions().length, 2);
});

test('legacy/unmapped prompt text and substantive /ask commands are never deletion authority', async (t) => {
  const h = harness(t);
  await h.receive(h.update(11, 'Кто ты?', { replyTo: 900 }));
  const answer = await h.receive(h.update(12, '/ask@assistant_bot Что ты можешь?'));
  assert.equal(answer.askPrompt, undefined);
  await h.receive(h.update(13, 'Кто ты?', { replyTo: answer.receipt.messageId }));
  const mention = await h.menu('@assistant_bot');
  assert.equal(mention.askPrompt, undefined);
  await h.receive(h.update(14, 'Кто ты?', { replyTo: mention.receipt.messageId }));
  assert.deepEqual(h.deletions(), []);
});

for (const text of ['/help', '/ai', '/ask']) {
  test(`service reply ${text} does not consume or clean the existing prompt`, async (t) => {
    const h = harness(t);
    const menu = await h.menu();
    await h.receive(h.update(11, text, { replyTo: menu.receipt.messageId }));
    assert.deepEqual(h.deletions(), []);
    assert.equal(h.result(menu.eventId).askPromptCleanup, undefined);
  });
}

for (const [name, delivery] of [
  ['partial', { partial: true, error: 'second_chunk_refused' }],
  ['failed', { ok: false, error: 'send_refused' }],
  ['uncertain', { uncertain: true }],
]) {
  test(`${name} answer delivery leaves command and hint intact`, async (t) => {
    const h = harness(t, { delivery: (input) => input.forceReply ? null : delivery });
    const menu = await h.menu();
    await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }));
    assert.deepEqual(h.deletions(), []);
    assert.equal(h.result(menu.eventId).askPromptCleanup, undefined);
  });
}

test('fully delivered markup-stripped answer may clean its service pair', async (t) => {
  const h = harness(t, { delivery: (input) => input.forceReply ? null : { degraded: 'markup_stripped' } });
  const menu = await h.menu();
  await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }));
  assert.equal(h.deletions().length, 2);
});

test('incomplete hint delivery does not mint a cleanup association', async (t) => {
  const h = harness(t, { delivery: (input) => input.forceReply ? { partial: true } : null });
  const menu = await h.menu();
  assert.equal(menu.askPrompt, undefined);
  await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }));
  assert.deepEqual(h.deletions(), []);
});

test('missing Guard rights preserves the user command and records a definitive skipped outcome', async (t) => {
  const h = harness(t, { guardRights: false });
  const menu = await h.menu();
  const answer = await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }));
  assert.equal(answer.kind, 'answered');
  assert.deepEqual(h.deletions(), [{ kind: 'assistant_delete', chatId: '-100', messageId: '1000' }]);
  assert.deepEqual(h.result(menu.eventId).askPromptCleanup.command, {
    state: 'skipped', actor: 'guard', reason: 'guard_rights_unproven',
  });
  h.restart();
  await h.receive(h.update(12, 'Что ты можешь?', { replyTo: menu.receipt.messageId }));
  assert.equal(h.deletions().length, 1);
});

for (const [name, options] of [
  ['prompt transport timeout', { promptThrows: true }],
  ['command transport timeout', { commandThrows: true }],
  ['prompt Telegram refusal', { promptResult: { ok: false, error: 'message_cannot_be_deleted' } }],
]) {
  test(`${name} never costs the answer or retries a deletion after restart`, async (t) => {
    const h = harness(t, options);
    const menu = await h.menu();
    assert.equal((await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }))).kind, 'answered');
    assert.equal(h.deletions().length, 2);
    assert.equal(h.result(menu.eventId).askPromptCleanup.state, 'finished');
    if (options.commandThrows) assert.equal(h.result(menu.eventId).askPromptCleanup.command.state, 'uncertain');
    if (options.promptThrows) assert.equal(h.result(menu.eventId).askPromptCleanup.prompt.state, 'uncertain');
    h.restart();
    await h.receive(h.update(12, 'Кто ты?', { replyTo: menu.receipt.messageId }));
    assert.equal(h.deletions().length, 2);
  });
}

test('crash after cleanup claim leaves a permanent no-retry fence', async (t) => {
  const h = harness(t);
  const menu = await h.menu();
  assert.ok(h.store.claimAssistantAskCleanup({
    chatId: '-100', userId: '7', promptMessageId: menu.receipt.messageId,
    questionMessageId: '11', answerEventId: 'interrupted-answer',
  }));
  h.restart();
  await h.receive(h.update(12, 'Кто ты?', { replyTo: menu.receipt.messageId }));
  assert.deepEqual(h.deletions(), []);
  assert.equal(h.result(menu.eventId).askPromptCleanup.state, 'calling');
});

test('an observed edit of the old bare command invalidates cleanup even if it is no longer an invocation', async (t) => {
  const h = harness(t);
  const menu = await h.menu();
  await h.receive(h.update(10, 'Теперь здесь настоящий вопрос', { edited: true }));
  assert.equal(h.result(menu.eventId).askPromptCleanup.reason, 'command_edited');
  await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }));
  assert.deepEqual(h.deletions(), []);
});

test('cleanup lookup expires at 47 hours and never scans beyond its recent-row budget', async (t) => {
  const expired = harness(t);
  const menu = await expired.menu();
  expired.advance(47 * 60 * 60 + 1);
  await expired.receive(expired.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }));
  assert.deepEqual(expired.deletions(), []);

  const busy = harness(t);
  const recent = await busy.menu();
  for (let index = 0; index < 2048; index++) {
    busy.store.claimEvent({ eventId: `unrelated:${index}`, role: 'moderator', updateId: 2000 + index });
  }
  await busy.receive(busy.update(11, 'Кто ты?', { replyTo: recent.receipt.messageId }));
  assert.deepEqual(busy.deletions(), []);
});

test('an edit while the force-reply send is in flight prevents minting cleanup authority', async (t) => {
  let releaseHint;
  let hintStarted;
  const hintGate = new Promise((resolve) => { releaseHint = resolve; });
  const started = new Promise((resolve) => { hintStarted = resolve; });
  const h = harness(t, { beforeHintSendReturn: async (input) => {
    if (input.forceReply) { hintStarted(); await hintGate; }
  } });
  const pendingMenu = h.menu();
  await started;
  const edit = h.update(10, 'Теперь это настоящий вопрос без команды', { edited: true });
  assert.equal((await h.receive(edit)).kind, 'skipped');
  assert.equal(h.store.getInboundDelivery(`assistant:${edit.update_id}`).revision_identity,
    `-100:edit:${edit.update_id}:10`);
  releaseHint();
  const menu = await pendingMenu;
  assert.equal(menu.askPrompt, undefined);
  await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }));
  assert.deepEqual(h.deletions(), []);
});

for (const stage of ['beforePromptDelete', 'beforeGuardProof']) {
  test(`an edit during ${stage} prevents the raw user-command delete`, async (t) => {
    let h;
    let edited = false;
    h = harness(t, { [stage]: async () => {
      if (edited) return;
      edited = true;
      await h.receive(h.update(10, 'Теперь это настоящий вопрос без команды', { edited: true }));
    } });
    const menu = await h.menu();
    const answer = await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }));
    assert.equal(answer.kind, 'answered');
    assert.deepEqual(h.deletions(), [{ kind: 'assistant_delete', chatId: '-100', messageId: '1000' }]);
    assert.deepEqual(h.result(menu.eventId).askPromptCleanup.command, {
      state: 'skipped', actor: 'guard', reason: 'delete_precondition_unproven',
    });
    h.restart();
    await h.receive(h.update(12, 'Кто ты?', { replyTo: menu.receipt.messageId }));
    assert.equal(h.deletions().length, 1);
  });
}

test('a first-observed edited /ask cannot mint a deletable command', async (t) => {
  const h = harness(t);
  const menu = await h.receive(h.update(10, '/ask', { edited: true }));
  assert.equal(menu.command, 'ask_empty');
  assert.equal(menu.askPrompt, undefined);
  await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }));
  assert.deepEqual(h.deletions(), []);
});

for (const [name, predicate] of [
  ['false', () => false], ['truthy number', () => 1], ['Promise', () => Promise.resolve(true)],
  ['rejected Promise', () => Promise.reject(new Error('fixture'))], ['throw', () => { throw new Error('fixture'); }],
]) {
  test(`Guard rejects ${name} permission after rights lookup`, async () => {
    const calls = [];
    const guard = createGuardAdapter({
      guardBotId: 111, guardChatIds: ['-100'], telegram: {
        async getChatMember() {
          calls.push('rights');
          return { ok: true, data: { status: 'administrator', can_delete_messages: true, can_restrict_members: true } };
        },
        async deleteMessage() { calls.push('delete'); return { ok: true }; },
      },
    });
    const result = await guard.deleteMessage({ chatId: '-100', messageId: '10', beforeDelete: () => {
      assert.deepEqual(calls, ['rights']);
      calls.push('precondition');
      return predicate();
    } });
    assert.deepEqual(result, { ok: false, skipped: 'delete_precondition_unproven', uncertain: false });
    assert.deepEqual(calls, ['rights', 'precondition']);
  });
}

for (const [role, state] of [
  ['assistant', 'processing'], ['assistant', 'uncertain'], ['moderator', 'processing'], ['moderator', 'uncertain'],
]) {
  test(`${role} ${state} edit receipts revoke deletion without requiring a finished edit handler`, async (t) => {
    const h = harness(t);
    const menu = await h.menu();
    const claimed = h.store.claimInboundDelivery({
      receiptId: `${role}:50`, role, updateId: 50,
      revisionIdentity: '-100:edit:50:10', payloadFingerprint: 'fixture-edit',
    });
    if (state === 'uncertain') h.store.markInboundDeliveryUncertain({ claim: claimed.claim });
    await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }));
    assert.deepEqual(h.deletions(), []);
  });
}

test('receipt budget exhaustion refuses cleanup even while the original event mapping remains', async (t) => {
  const h = harness(t);
  const menu = await h.menu();
  for (let id = 100; id < 2148; id++) {
    h.store.claimInboundDelivery({
      receiptId: `moderator:${id}`, role: 'moderator', updateId: id,
      revisionIdentity: `-200:${id}`, payloadFingerprint: 'fixture-unrelated',
    });
  }
  assert.ok(h.result(menu.eventId).askPrompt);
  await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }));
  assert.deepEqual(h.deletions(), []);
});

test('an out-of-order original older than the retained Assistant boundary cannot mint authority', async (t) => {
  const h = harness(t);
  h.store.claimInboundDelivery({
    receiptId: 'assistant:50', role: 'assistant', updateId: 50,
    revisionIdentity: '-100:edit:50:10', payloadFingerprint: 'fixture-older-edit',
  });
  for (let id = 100; id < 2148; id++) {
    h.store.claimInboundDelivery({
      receiptId: `assistant:${id}`, role: 'assistant', updateId: id,
      revisionIdentity: `-200:${id}`, payloadFingerprint: 'fixture-unrelated',
    });
  }
  const menu = await h.menu();
  assert.equal(menu.askPrompt, undefined);
  await h.receive(h.update(11, 'Кто ты?', { replyTo: menu.receipt.messageId }));
  assert.deepEqual(h.deletions(), []);
});
