import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { assertPrivateChatId, NonPrivateChatError } from '../src/service.mjs';
import {
  ambiguousError,
  CHAT_ID,
  definiteError,
  GOOD_ABOUT,
  harness,
  OTHER_CHAT_ID,
  T0,
} from './helpers.mjs';

let h;
afterEach(() => {
  h?.close();
  h = null;
});

function onlyPrivateSends(telegram) {
  for (const call of telegram.byMethod('sendMessage')) {
    assert.ok(call.payload.chat_id > 0, `sendMessage to non-private chat ${call.payload.chat_id}`);
  }
}

function app(id) {
  return h.store.getApplication(id);
}

describe('JoinGatekeeperService — enforce flow', () => {
  test('happy path: request → greeting via user_chat_id → 3 answers → approve + welcome', async () => {
    h = harness();
    const userChatId = 555001;
    const started = await h.joinRequest({ userChatId });
    assert.equal(started.action, 'asking');
    const sends = h.telegram.byMethod('sendMessage');
    assert.equal(sends.length, 2);
    assert.equal(sends[0].payload.chat_id, userChatId);
    assert.equal(sends[0].payload.text, h.scenario.messages.greeting);
    assert.equal(sends[1].payload.text, h.scenario.messages.q_purpose);
    assert.equal(sends[1].payload.reply_markup.inline_keyboard.length, 4);
    assert.equal(app(started.applicationId).deadline_at, T0 + 1800 * 1000);

    assert.equal((await h.press('purpose', 'discuss')).action, 'asked');
    assert.equal(h.telegram.byMethod('answerCallbackQuery').length, 1);
    assert.equal(app(started.applicationId).conversation_open, 1);
    assert.equal((await h.say(GOOD_ABOUT)).action, 'asked');
    const done = await h.say('Согласен');
    assert.equal(done.action, 'approved');

    const approve = h.telegram.byMethod('approveChatJoinRequest');
    assert.deepEqual(approve.map((c) => c.payload), [{ chat_id: CHAT_ID, user_id: 555001 }]);
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 0);
    const last = h.telegram.byMethod('sendMessage').at(-1);
    assert.equal(last.payload.text, h.scenario.messages.approved);
    const stored = app(started.applicationId);
    assert.equal(stored.state, 'approved');
    assert.equal(stored.telegram_action_state, 'done');
    assert.equal(h.store.listAnswers(started.applicationId).length, 3);
    onlyPrivateSends(h.telegram);
  });

  test('failing free-text answer gets one retry, then counts as failed → decline + polite DM', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    await h.press('purpose', 'course');
    const retry = await h.say('привет');
    assert.equal(retry.action, 'retry');
    const retryTexts = h.telegram.byMethod('sendMessage').slice(-2).map((c) => c.payload.text);
    assert.deepEqual(retryTexts, [h.scenario.messages.retry, h.scenario.messages.q_about]);
    assert.equal((await h.say('ну просто')).action, 'asked');
    const result = await h.press('rules', 'agree');
    assert.equal(result.action, 'declined_answers');
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 1);
    assert.equal(h.telegram.byMethod('approveChatJoinRequest').length, 0);
    assert.equal(h.telegram.byMethod('sendMessage').at(-1).payload.text, h.scenario.messages.declined_answers);
    assert.equal(app(applicationId).state, 'declined_answers');
  });

  test('retry that succeeds still leads to approval', async () => {
    h = harness();
    await h.joinRequest();
    await h.press('purpose', 'discuss');
    assert.equal((await h.say('🔥🔥🔥')).action, 'retry');
    assert.equal((await h.say(GOOD_ABOUT)).action, 'asked');
    assert.equal((await h.press('rules', 'agree')).action, 'approved');
  });

  test('not-accepted choice is a definite fail, no retry', async () => {
    h = harness();
    await h.joinRequest();
    assert.equal((await h.press('purpose', 'ads')).action, 'asked');
    await h.say(GOOD_ABOUT);
    assert.equal((await h.press('rules', 'agree')).action, 'declined_answers');
  });

  test('screening review → answers pass → manual_review, no approve, no decline', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest({ bio: 'Мой блог https://example.com' });
    await h.press('purpose', 'discuss');
    await h.say(GOOD_ABOUT);
    const result = await h.press('rules', 'agree');
    assert.equal(result.action, 'manual_review');
    assert.equal(h.telegram.byMethod('approveChatJoinRequest').length, 0);
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 0);
    assert.equal(h.telegram.byMethod('sendMessage').at(-1).payload.text, h.scenario.messages.manual_review);
    const stored = app(applicationId);
    assert.equal(stored.state, 'manual_review');
    assert.equal(stored.decision_reason, 'screening_review');
    assert.deepEqual(stored.screening_reasons, ['link:bio']);
  });

  test('screening block → decline, no DM', async () => {
    h = harness();
    const result = await h.joinRequest({ user: { is_bot: true } });
    assert.equal(result.action, 'declined_screening');
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 1);
    assert.equal(h.telegram.byMethod('sendMessage').length, 0);
    assert.equal(app(result.applicationId).state, 'declined_screening');
  });

  test('approve failure leaves request for admin (manual_review)', async () => {
    h = harness();
    await h.joinRequest();
    await h.press('purpose', 'discuss');
    await h.say(GOOD_ABOUT);
    h.telegram.failNext('approveChatJoinRequest', ambiguousError('approveChatJoinRequest'));
    const result = await h.press('rules', 'agree');
    assert.equal(result.action, 'manual_review');
    assert.equal(result.reason, 'approve_inconclusive');
    assert.equal(app(result.applicationId).telegram_action_state, 'inconclusive');
    assert.equal(h.telegram.byMethod('approveChatJoinRequest').length, 1, 'no retry loop');
  });

  test('decline failure is recorded, not retried', async () => {
    h = harness();
    h.telegram.failNext('declineChatJoinRequest', definiteError('declineChatJoinRequest'));
    const result = await h.joinRequest({ user: { is_bot: true } });
    assert.equal(result.telegramActionState, 'failed');
    assert.equal(app(result.applicationId).telegram_action_state, 'failed');
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 1);
  });

  test('DM failure with clean screening → probation (v2 overrides v1 manual_review)', async () => {
    h = harness();
    h.telegram.failNext('sendMessage', definiteError());
    const result = await h.joinRequest();
    assert.equal(result.action, 'probation');
    assert.equal(result.reason, 'dm_failed');
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 0);
    assert.equal(h.telegram.byMethod('approveChatJoinRequest').length, 1);
    assert.equal(h.telegram.byMethod('restrictChatMember').length, 1);
    const stored = app(result.applicationId);
    assert.equal(stored.state, 'probation');
    assert.equal(stored.dm_state, 'failed');
  });

  test('DM failure with screening review → manual_review dm_failed, request not declined', async () => {
    h = harness();
    h.telegram.failNext('sendMessage', definiteError());
    const result = await h.joinRequest({ bio: 'Мой блог https://example.com' });
    assert.equal(result.action, 'manual_review');
    assert.equal(result.reason, 'dm_failed');
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 0);
    assert.equal(h.telegram.byMethod('approveChatJoinRequest').length, 0);
    assert.equal(h.telegram.byMethod('restrictChatMember').length, 0);
    const stored = app(result.applicationId);
    assert.equal(stored.state, 'manual_review');
    assert.equal(stored.dm_state, 'failed');
  });

  test('photo lookup failure is unknown, not a signal', async () => {
    h = harness();
    h.telegram.failNext('getUserProfilePhotos', ambiguousError('getUserProfilePhotos'));
    const result = await h.joinRequest();
    assert.equal(result.action, 'asking');
    assert.equal(result.verdict, 'clean');
  });
});

describe('JoinGatekeeperService — guards', () => {
  test('shadow mode: no Telegram writes, decision logged', async () => {
    h = harness({ mode: 'shadow' });
    const clean = await h.joinRequest();
    const blocked = await h.joinRequest({ user: { id: 777, is_bot: true } });
    await h.say('привет');
    await h.press('purpose', 'discuss');
    assert.equal(clean.action, 'shadow_logged');
    assert.equal(clean.decision, 'would_ask_clean');
    assert.equal(blocked.decision, 'would_decline_screening');
    assert.deepEqual(h.telegram.writes(), [], 'shadow mode must not write to Telegram');
    assert.equal(app(clean.applicationId).state, 'shadow_logged');
    h.clock.now += 10 * 3600 * 1000;
    await h.service.sweep();
    assert.deepEqual(h.telegram.writes(), []);
  });

  test('non-allowlisted chat is ignored without any Telegram call', async () => {
    h = harness();
    const result = await h.joinRequest({ chatId: OTHER_CHAT_ID });
    assert.equal(result.action, 'ignored_chat');
    assert.deepEqual(h.telegram.calls, []);
  });

  test('duplicate update_id is ignored', async () => {
    h = harness();
    const update = {
      update_id: 42,
      chat_join_request: {
        chat: { id: CHAT_ID, type: 'supergroup' },
        from: { id: 555001, is_bot: false, first_name: 'Мария' },
        user_chat_id: 555001,
        date: 1,
      },
    };
    assert.equal((await h.service.handleUpdate(update)).action, 'asking');
    const callsAfterFirst = h.telegram.calls.length;
    assert.equal((await h.service.handleUpdate(update)).action, 'duplicate_update');
    assert.equal(h.telegram.calls.length, callsAfterFirst);
  });

  test('second request while an application is active is ignored', async () => {
    h = harness();
    assert.equal((await h.joinRequest()).action, 'asking');
    const sends = h.telegram.byMethod('sendMessage').length;
    assert.equal((await h.joinRequest()).action, 'duplicate_application');
    assert.equal(h.telegram.byMethod('sendMessage').length, sends);
  });

  test('rate limit: over max applications per day → decline without DM', async () => {
    h = harness();
    for (let i = 0; i < 3; i += 1) {
      await h.joinRequest({ user: { is_bot: true } });
    }
    const sendsBefore = h.telegram.byMethod('sendMessage').length;
    const result = await h.joinRequest({ user: { is_bot: true } });
    assert.equal(result.action, 'declined_rate_limit');
    assert.equal(h.telegram.byMethod('sendMessage').length, sendsBefore);
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 4);
    h.clock.now += 25 * 3600 * 1000;
    assert.equal((await h.joinRequest()).action, 'asking', 'limit resets after a day');
  });

  test('group messages are ignored entirely', async () => {
    h = harness();
    await h.joinRequest();
    const calls = h.telegram.calls.length;
    assert.equal((await h.say(GOOD_ABOUT, { chatType: 'supergroup' })).action, 'ignored_non_private');
    assert.equal(h.telegram.calls.length, calls);
  });

  test('private message without an active application is ignored', async () => {
    h = harness();
    assert.equal((await h.say('привет')).action, 'ignored_no_application');
    assert.deepEqual(h.telegram.calls, []);
  });

  test('stale callback for another question is ignored', async () => {
    h = harness();
    await h.joinRequest();
    assert.equal((await h.press('rules', 'agree')).action, 'ignored_stale_callback');
  });

  test('never sends to a negative (group) chat id', async () => {
    assert.throws(() => assertPrivateChatId(CHAT_ID), NonPrivateChatError);
    assert.throws(() => assertPrivateChatId('-1'), NonPrivateChatError);
    assertPrivateChatId(555001);
    h = harness();
    await assert.rejects(() => h.service.sendDm(CHAT_ID, { text: 'x' }), NonPrivateChatError);
    assert.deepEqual(h.telegram.calls, []);
    const result = await h.joinRequest({ userChatId: CHAT_ID });
    assert.equal(result.action, 'probation', 'invalid user_chat_id with clean screening → probation, never a DM to the group');
    assert.equal(result.reason, 'missing_user_chat_id');
    assert.equal(h.telegram.byMethod('sendMessage').length, 0);
  });
});

describe('JoinGatekeeperService — sweep', () => {
  test('timeout with open conversation → decline + timeout DM', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    h.clock.now += 60 * 1000;
    await h.press('purpose', 'discuss');
    h.clock.now = T0 + 1800 * 1000 + 1;
    const result = await h.service.sweep();
    assert.equal(result.timedOut, 1);
    assert.equal(result.timeoutDms, 1);
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 1);
    assert.equal(h.telegram.byMethod('sendMessage').at(-1).payload.text, h.scenario.messages.timeout);
    assert.equal(app(applicationId).state, 'timed_out');
  });

  test('timeout without reply, past the 5-minute window → decline, no DM', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    const sends = h.telegram.byMethod('sendMessage').length;
    h.clock.now = T0 + 1800 * 1000 + 1;
    const result = await h.service.sweep();
    assert.equal(result.timedOut, 1);
    assert.equal(result.timeoutDms, 0);
    assert.equal(h.telegram.byMethod('sendMessage').length, sends);
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 1);
    assert.equal(app(applicationId).state, 'timed_out');
  });

  test('timeout inside the DM window still sends the notice', async () => {
    h = harness({ scenarioEdit: (raw) => { raw.limits.answerTimeoutSeconds = 60; } });
    await h.joinRequest();
    h.clock.now = T0 + 61 * 1000;
    const result = await h.service.sweep();
    assert.equal(result.timeoutDms, 1);
  });

  test('sweep before deadline does nothing', async () => {
    h = harness();
    await h.joinRequest();
    h.clock.now = T0 + 1000;
    assert.equal((await h.service.sweep()).timedOut, 0);
  });

  test('retention purge removes answers and name snapshots of old decided applications', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    await h.press('purpose', 'discuss');
    await h.say(GOOD_ABOUT);
    await h.press('rules', 'agree');
    const active = await h.joinRequest({ user: { id: 600, first_name: 'Иван', username: 'ivan' } });
    assert.equal(h.store.listAnswers(applicationId).length, 3);

    h.clock.now = T0 + 29 * 24 * 3600 * 1000;
    assert.deepEqual((await h.service.sweep()).purged, { answers: 0, applications: 0, updates: 0 });

    h.clock.now = T0 + 31 * 24 * 3600 * 1000;
    const { purged } = await h.service.sweep();
    assert.equal(purged.answers, 3);
    assert.ok(purged.applications >= 1);
    const stored = app(applicationId);
    assert.equal(stored.username, null);
    assert.equal(stored.first_name, null);
    assert.equal(stored.last_name, null);
    assert.equal(stored.state, 'approved', 'decision record kept');
    assert.equal(h.store.listAnswers(applicationId).length, 0);
    const timedOut = app(active.applicationId);
    assert.equal(timedOut.state, 'timed_out');
  });
});
