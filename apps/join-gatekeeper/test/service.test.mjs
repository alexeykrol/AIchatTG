import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { reasonText } from '../src/scenario.mjs';
import { assertPrivateChatId, NonPrivateChatError } from '../src/service.mjs';
import { TelegramApiError } from '../src/telegram-api.mjs';
import {
  ambiguousError,
  CHAT_ID,
  definiteError,
  harness,
  memoryLogger,
  OTHER_CHAT_ID,
  passAll,
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

// What the user sees: new messages and messages edited in place.
function texts() {
  return h.telegram.shownTexts();
}

function lastShown() {
  return h.telegram.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').at(-1).payload;
}

function methods() {
  return h.telegram.calls.map((c) => c.method);
}

const R = (code) => reasonText(h.scenario, code);

describe('questionnaire v2 — enforce flow', () => {
  test('happy path: greeting + Q1 → Q2 → Q3 multi-select → approve + welcome', async () => {
    h = harness();
    const started = await h.joinRequest({ userChatId: 555001 });
    assert.equal(started.action, 'asking');
    assert.deepEqual(texts(), [h.scenario.messages.greeting, h.scenario.messages.q_participate]);
    const q1 = h.telegram.byMethod('sendMessage')[1].payload.reply_markup.inline_keyboard;
    assert.deepEqual(q1.map((row) => row[0].text), ['Да, хочу участвовать', 'Нет, только читать']);
    assert.deepEqual(h.telegram.byMethod('getChat').map((c) => c.payload), [{ chat_id: 555001 }]);
    assert.equal(app(started.applicationId).deadline_at, T0 + 1800 * 1000);

    assert.equal((await h.press('participate', 'yes')).action, 'asked');
    assert.equal(texts().at(-1), h.scenario.messages.q_rules);
    assert.equal(app(started.applicationId).conversation_open, 1);
    assert.equal((await h.press('rules', 'agree')).action, 'asked');
    assert.equal(texts().at(-1), h.scenario.messages.q_topics);
    // Steps after a button press replace the pressed message, no new message.
    assert.equal(h.telegram.byMethod('sendMessage').length, 2);
    const q3 = lastShown().reply_markup.inline_keyboard;
    assert.deepEqual(q3.map((row) => row[0].text), [
      'ИИ-агенты и автоматизация', 'ИИ в бизнесе и работе', 'Профессии и будущее в эпоху ИИ',
      'Инструменты: ChatGPT, Claude и другие', 'Касты, роли и личная стратегия', 'Добавить свою тему', 'Готово',
    ]);
    for (const row of q3) assert.ok(Buffer.byteLength(row[0].callback_data) <= 64);

    assert.equal((await h.press('topics', 'tools')).action, 'topic_toggled');
    const done = await h.press('topics', 'done');
    assert.equal(done.action, 'approved');
    assert.deepEqual(h.telegram.byMethod('approveChatJoinRequest').map((c) => c.payload), [{ chat_id: CHAT_ID, user_id: 555001 }]);
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 0);
    assert.equal(texts().at(-1), 'Спасибо! Заявка одобрена — добро пожаловать в группу.');
    const stored = app(started.applicationId);
    assert.equal(stored.state, 'approved');
    assert.equal(stored.decision_reason, 'answers_passed');
    assert.equal(h.telegram.byMethod('answerCallbackQuery').length, 4);
    onlyPrivateSends(h.telegram);
  });

  test('prod 18.11: new messages refused after the first answer → questionnaire still completes by edits', async () => {
    h = harness();
    const started = await h.joinRequest();
    // From now on Telegram refuses any NEW message to this user.
    const refuse = () => { throw new TelegramApiError("sendMessage failed: Forbidden: bot can't initiate conversation with a user", { method: 'sendMessage', status: 403 }); };
    h.telegram.sendMessage = async (payload) => { h.telegram.calls.push({ method: 'sendMessage', payload }); refuse(); };
    assert.equal((await h.press('participate', 'yes', { messageId: 42 })).action, 'asked');
    assert.equal((await h.press('rules', 'agree', { messageId: 42 })).action, 'asked');
    await h.press('topics', 'agents', { messageId: 42 });
    const done = await h.press('topics', 'done', { messageId: 42 });
    assert.equal(done.action, 'approved');
    assert.equal(app(started.applicationId).state, 'approved');
    const edits = h.telegram.byMethod('editMessageText').map((c) => [c.payload.message_id, c.payload.text]);
    assert.deepEqual(edits, [
      [42, h.scenario.messages.q_rules], [42, h.scenario.messages.q_topics], [42, h.scenario.messages.approved],
    ]);
    assert.equal(h.telegram.byMethod('restrictChatMember').length, 0, 'no fallback to probation');
  });

  test('edit refused → the step goes as a new message', async () => {
    h = harness();
    await h.joinRequest();
    h.telegram.failNext('editMessageText', definiteError('editMessageText'));
    assert.equal((await h.press('participate', 'yes')).action, 'asked');
    assert.equal(h.telegram.byMethod('sendMessage').at(-1).payload.text, h.scenario.messages.q_rules);
  });

  test('final text replaces the question without its keyboard', async () => {
    h = harness();
    await h.joinRequest();
    await h.press('participate', 'no');
    const last = h.telegram.byMethod('editMessageText').at(-1).payload;
    assert.equal(last.text, R('R_READER'));
    assert.equal(last.reply_markup, undefined);
  });

  test('answers are stored: choice options, topic toggles, custom topic, done summary', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    await h.press('participate', 'yes');
    await h.press('rules', 'agree');
    await h.press('topics', 'agents');
    await h.press('topics', 'castes');
    await h.say('ИИ в медицине');
    await h.press('topics', 'done');
    const rows = h.store.listAnswers(applicationId).map((r) => [r.question_id, r.text, r.pass, r.reason]);
    assert.deepEqual(rows, [
      ['participate', 'option:yes', 1, 'accepted_option'],
      ['rules', 'option:agree', 1, 'accepted_option'],
      ['topics', 'agents', 1, 'toggle'],
      ['topics', 'castes', 1, 'toggle'],
      ['topics', 'ИИ в медицине', 1, 'custom_topic'],
      ['topics', 'selected:agents,castes;custom:1', 1, 'done'],
    ]);
    assert.equal(app(applicationId).state, 'approved');
  });

  test('Q1 «Нет, только читать» → decline R_READER with its text (DM before decline)', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    const result = await h.press('participate', 'no');
    assert.equal(result.action, 'declined_answers');
    assert.equal(result.reason, 'R_READER');
    assert.equal(texts().at(-1), R('R_READER'));
    const order = methods();
    assert.ok(order.lastIndexOf('editMessageText') < order.indexOf('declineChatJoinRequest'));
    const stored = app(applicationId);
    assert.equal(stored.state, 'declined_answers');
    assert.equal(stored.decision_reason, 'R_READER');
    assert.equal(h.telegram.byMethod('approveChatJoinRequest').length, 0);
  });

  test('Q2 «Нет» → decline R_RULES', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    await h.press('participate', 'yes');
    const result = await h.press('rules', 'disagree');
    assert.equal(result.reason, 'R_RULES');
    assert.equal(texts().at(-1), R('R_RULES'));
    assert.equal(app(applicationId).decision_reason, 'R_RULES');
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 1);
  });

  test('typed answers: label/alias accepted, unmatched text re-shows the question, typed «нет» rejects', async () => {
    h = harness();
    await h.joinRequest();
    assert.equal((await h.say('может быть')).action, 'reasked');
    assert.equal(texts().at(-1), h.scenario.messages.q_participate);
    assert.equal((await h.say('Да, хочу участвовать')).action, 'asked');
    assert.equal((await h.say('нет')).reason, 'R_RULES');
  });

  test('multi-select: toggling edits the keyboard of the same message and answers the callback', async () => {
    h = harness();
    await h.joinRequest();
    await h.press('participate', 'yes');
    await h.press('rules', 'agree');
    await h.press('topics', 'business', { messageId: 77 });
    let edit = h.telegram.byMethod('editMessageReplyMarkup').at(-1).payload;
    assert.equal(edit.chat_id, 555001);
    assert.equal(edit.message_id, 77);
    assert.equal(edit.reply_markup.inline_keyboard[1][0].text, '✅ ИИ в бизнесе и работе');
    assert.equal(edit.reply_markup.inline_keyboard[0][0].text, 'ИИ-агенты и автоматизация');
    const toggledOff = await h.press('topics', 'business', { messageId: 77 });
    assert.deepEqual(toggledOff.selected, []);
    edit = h.telegram.byMethod('editMessageReplyMarkup').at(-1).payload;
    assert.equal(edit.reply_markup.inline_keyboard[1][0].text, 'ИИ в бизнесе и работе');
    assert.equal(h.telegram.byMethod('answerCallbackQuery').length, 4);
  });

  test('«Готово» with nothing selected → toast, no decision', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    await h.press('participate', 'yes');
    await h.press('rules', 'agree');
    const result = await h.press('topics', 'done');
    assert.equal(result.action, 'topics_empty');
    const answer = h.telegram.byMethod('answerCallbackQuery').at(-1).payload;
    assert.equal(answer.text, 'Отметьте хотя бы одну тему.');
    assert.equal(app(applicationId).state, 'asking');
    assert.equal(h.telegram.byMethod('approveChatJoinRequest').length, 0);
    // Toggle on, then off again: still empty.
    await h.press('topics', 'agents');
    await h.press('topics', 'agents');
    assert.equal((await h.press('topics', 'done')).action, 'topics_empty');
  });

  test('«Добавить свою тему» → prompt; clean custom topic re-shows Q3; «Готово» then approves', async () => {
    h = harness();
    await h.joinRequest();
    await h.press('participate', 'yes');
    await h.press('rules', 'agree');
    assert.equal((await h.press('topics', 'custom')).action, 'custom_topic_prompt');
    assert.equal(texts().at(-1), `${h.scenario.messages.q_topics}\n\nНапишите свою тему одним сообщением.`);
    assert.equal(lastShown().reply_markup.inline_keyboard.at(-1)[0].text, 'Готово', 'keyboard stays');
    assert.equal((await h.say('Нейросети в образовании')).action, 'custom_topic_added');
    const reshown = h.telegram.byMethod('sendMessage').at(-1).payload;
    assert.equal(reshown.text, h.scenario.messages.q_topics);
    assert.equal(reshown.reply_markup.inline_keyboard.at(-1)[0].text, 'Готово');
    assert.equal((await h.press('topics', 'done')).action, 'approved');
  });

  test('free text on Q3 without pressing «Добавить» counts as a custom topic; nonsense is ignored', async () => {
    h = harness();
    await h.joinRequest();
    await h.press('participate', 'yes');
    await h.press('rules', 'agree');
    assert.equal((await h.say('🔥🔥🔥')).action, 'topic_ignored');
    assert.equal((await h.press('topics', 'done')).action, 'topics_empty');
    assert.equal((await h.say('Автоматизация бухгалтерии')).action, 'custom_topic_added');
    assert.equal((await h.press('topics', 'done')).action, 'approved');
  });

  test('custom topic with a link, @mention or spam keyword → decline R_TOPIC_AD', async () => {
    for (const dirty of ['мой курс https://x.example', 'подпишитесь @my_channel_x', 'казино и ставки']) {
      h = harness();
      const { applicationId } = await h.joinRequest();
      await h.press('participate', 'yes');
      await h.press('rules', 'agree');
      await h.press('topics', 'agents');
      const result = await h.say(dirty);
      assert.equal(result.action, 'declined_answers', dirty);
      assert.equal(result.reason, 'R_TOPIC_AD');
      assert.equal(texts().at(-1), R('R_TOPIC_AD'));
      assert.equal(app(applicationId).decision_reason, 'R_TOPIC_AD');
      assert.equal(h.telegram.byMethod('approveChatJoinRequest').length, 0);
      h.close();
      h = null;
    }
  });

  test('approve failure leaves request for admin (manual_review)', async () => {
    h = harness();
    await h.joinRequest();
    h.telegram.failNext('approveChatJoinRequest', ambiguousError('approveChatJoinRequest'));
    const result = await passAll(h);
    assert.equal(result.action, 'manual_review');
    assert.equal(result.reason, 'approve_inconclusive');
    assert.equal(app(result.applicationId).telegram_action_state, 'inconclusive');
    assert.equal(h.telegram.byMethod('approveChatJoinRequest').length, 1, 'no retry loop');
  });

  test('DM failure with passing pre-checks → probation', async () => {
    h = harness();
    h.telegram.failNext('sendMessage', definiteError());
    const result = await h.joinRequest();
    assert.equal(result.action, 'probation');
    assert.equal(result.reason, 'dm_failed');
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 0);
    assert.equal(h.telegram.byMethod('restrictChatMember').length, 1);
    assert.equal(app(result.applicationId).state, 'probation');
  });

  test('soft signals (no photo, emoji name) no longer decline or force manual review', async () => {
    h = harness();
    h.telegram.photoCount = 0;
    const result = await h.joinRequest({ user: { first_name: '🔥🔥💰', last_name: undefined } });
    assert.equal(result.action, 'asking');
    assert.deepEqual(app(result.applicationId).screening_reasons, ['empty_name', 'no_photo']);
    assert.equal((await passAll(h)).action, 'approved');
  });
});

describe('pre-questionnaire checks (enforce)', () => {
  function assertPreDecline(result, code, state = 'declined_screening') {
    assert.equal(result.action, state);
    assert.equal(result.reason, code);
    // Exactly one DM (the reason text), sent BEFORE the decline.
    assert.deepEqual(texts(), [R(code)]);
    assert.deepEqual(methods().filter((m) => m !== 'getChat' && m !== 'getUserProfilePhotos'),
      ['sendMessage', 'declineChatJoinRequest']);
    const stored = app(result.applicationId);
    assert.equal(stored.state, state);
    assert.equal(stored.decision_reason, code);
    assert.equal(h.telegram.byMethod('approveChatJoinRequest').length, 0);
  }

  test('R_SCAM: from.is_bot → no reads, DM then decline, no questionnaire', async () => {
    h = harness();
    const result = await h.joinRequest({ user: { is_bot: true }, bio: 'https://spam.example' });
    assertPreDecline(result, 'R_SCAM');
    assert.equal(h.telegram.byMethod('getChat').length, 0);
  });

  test('R_PROFILE_AD: link in bio', async () => {
    h = harness();
    assertPreDecline(await h.joinRequest({ bio: 'Мой блог https://example.com' }), 'R_PROFILE_AD');
  });

  test('R_PROFILE_AD: @mention in name', async () => {
    h = harness();
    assertPreDecline(await h.joinRequest({ user: { last_name: '@promo_channel' } }), 'R_PROFILE_AD');
  });

  test('R_PROFILE_AD: getChat shows personal_chat', async () => {
    h = harness();
    h.telegram.chatInfo = { type: 'private', personal_chat: { id: -100555, type: 'channel', title: 'My channel' } };
    const result = await h.joinRequest();
    assertPreDecline(result, 'R_PROFILE_AD');
    assert.deepEqual(app(result.applicationId).screening_reasons, ['personal_chat']);
  });

  test('R_PROFILE_AD: bio from getChat is used when the join request has none', async () => {
    h = harness();
    h.telegram.chatInfo = { type: 'private', bio: 'Канал t.me/promo' };
    assertPreDecline(await h.joinRequest(), 'R_PROFILE_AD');
  });

  test('getChat failure is unknown, never a signal', async () => {
    h = harness();
    h.telegram.failNext('getChat', definiteError('getChat'));
    assert.equal((await h.joinRequest()).action, 'asking');
  });

  test('R_STOPWORD: spam keyword in name', async () => {
    h = harness();
    assertPreDecline(await h.joinRequest({ user: { first_name: 'Казино' } }), 'R_STOPWORD');
  });

  test('precedence: R_SCAM over R_PROFILE_AD over R_STOPWORD', async () => {
    h = harness();
    h.telegram.chatInfo = { type: 'private', personal_chat: { id: -1, type: 'channel' } };
    const bot = await h.joinRequest({ user: { id: 1, is_bot: true, first_name: 'Казино' } });
    assert.equal(bot.reason, 'R_SCAM');
    const ad = await h.joinRequest({ user: { id: 2, first_name: 'Казино' } });
    assert.equal(ad.reason, 'R_PROFILE_AD');
    h.telegram.chatInfo = { type: 'private' };
    const stop = await h.joinRequest({ user: { id: 3, first_name: 'Казино' } });
    assert.equal(stop.reason, 'R_STOPWORD');
  });

  test('R_RATE: over max applications per day → DM then decline; precedes R_SCAM', async () => {
    h = harness();
    for (let i = 0; i < 3; i += 1) await h.joinRequest({ user: { is_bot: true } });
    const before = h.telegram.calls.length;
    const result = await h.joinRequest({ user: { is_bot: true } });
    assert.equal(result.action, 'declined_rate_limit');
    assert.equal(result.reason, 'R_RATE');
    const calls = h.telegram.calls.slice(before);
    assert.deepEqual(calls.map((c) => c.method), ['sendMessage', 'declineChatJoinRequest']);
    assert.equal(calls[0].payload.text, R('R_RATE'));
    assert.equal(app(result.applicationId).decision_reason, 'R_RATE');
    h.clock.now += 25 * 3600 * 1000;
    assert.equal((await h.joinRequest()).action, 'asking', 'limit resets after a day');
  });

  test('pre-check decline without user_chat_id: decline only', async () => {
    h = harness();
    const result = await h.joinRequest({ user: { is_bot: true }, userChatId: null });
    assert.equal(result.reason, 'R_SCAM');
    assert.equal(h.telegram.byMethod('sendMessage').length, 0);
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 1);
  });

  test('decline failure is recorded, not retried', async () => {
    h = harness();
    h.telegram.failNext('declineChatJoinRequest', definiteError('declineChatJoinRequest'));
    const result = await h.joinRequest({ user: { is_bot: true } });
    assert.equal(result.telegramActionState, 'failed');
    assert.equal(app(result.applicationId).telegram_action_state, 'failed');
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 1);
  });
});

describe('guards', () => {
  test('shadow mode: zero writes (only getChat/getUserProfilePhotos reads), codes logged, no user text logged', async () => {
    const logger = memoryLogger();
    h = harness({ mode: 'shadow', logger });
    const clean = await h.joinRequest({ user: { first_name: 'Уникальноеимя', username: 'uniq_user' }, bio: 'Люблю нейросети' });
    const ad = await h.joinRequest({ user: { id: 777 }, bio: 'Мой блог https://secret-blog.example' });
    const stop = await h.joinRequest({ user: { id: 778, first_name: 'Казино' } });
    const bot = await h.joinRequest({ user: { id: 779, is_bot: true } });
    h.telegram.chatInfo = { type: 'private', personal_chat: { id: -1, type: 'channel' } };
    const channel = await h.joinRequest({ user: { id: 780 } });
    await h.say('мой курс https://x.example');
    await h.press('participate', 'yes');
    assert.equal(clean.decision, 'would_start_questionnaire');
    assert.deepEqual([ad, stop, bot, channel].map((r) => [r.decision, r.reason]), [
      ['would_decline', 'R_PROFILE_AD'], ['would_decline', 'R_STOPWORD'], ['would_decline', 'R_SCAM'], ['would_decline', 'R_PROFILE_AD'],
    ]);
    assert.deepEqual(h.telegram.writes(), [], 'shadow mode must not write to Telegram');
    assert.ok(h.telegram.calls.every((c) => ['getChat', 'getUserProfilePhotos'].includes(c.method)));
    assert.equal(app(ad.applicationId).decision_reason, 'R_PROFILE_AD');
    for (let i = 0; i < 3; i += 1) await h.joinRequest({ user: { id: 781 } });
    const rate = await h.joinRequest({ user: { id: 781 } });
    assert.equal(rate.reason, 'R_RATE');
    h.clock.now += 10 * 3600 * 1000;
    await h.service.sweep();
    assert.deepEqual(h.telegram.writes(), []);

    const decisions = logger.lines.filter((l) => l.event === 'shadow_decision');
    assert.ok(decisions.some((l) => l.decision === 'would_decline' && l.reason === 'R_STOPWORD'));
    assert.ok(decisions.some((l) => l.decision === 'would_start_questionnaire'));
    const logged = JSON.stringify(logger.lines);
    for (const secret of ['Уникальноеимя', 'uniq_user', 'Люблю нейросети', 'secret-blog', 'Петрова', 'Мария', 'x.example']) {
      assert.ok(!logged.includes(secret), `log must not contain ${secret}`);
    }
  });

  test('enforce logs contain no names, bio or topic text', async () => {
    const logger = memoryLogger();
    h = harness({ logger });
    await h.joinRequest({ bio: 'Ссылка https://private-bio.example' });
    await h.joinRequest({ user: { id: 600, first_name: 'Тайноеимя' } });
    await h.press('participate', 'yes', { userId: 600 });
    await h.press('rules', 'agree', { userId: 600 });
    await h.say('Моя секретная тема', { userId: 600 });
    await h.say('реклама https://topic-ad.example', { userId: 600 });
    const logged = JSON.stringify(logger.lines);
    for (const secret of ['private-bio', 'Тайноеимя', 'Моя секретная тема', 'topic-ad']) {
      assert.ok(!logged.includes(secret), `log must not contain ${secret}`);
    }
    assert.ok(logger.lines.some((l) => l.event === 'declined' && l.reason === 'R_TOPIC_AD'));
  });

  test('non-allowlisted chat is ignored without any Telegram call', async () => {
    h = harness();
    assert.equal((await h.joinRequest({ chatId: OTHER_CHAT_ID })).action, 'ignored_chat');
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

  test('group messages are ignored entirely', async () => {
    h = harness();
    await h.joinRequest();
    const calls = h.telegram.calls.length;
    assert.equal((await h.say('Да, хочу участвовать', { chatType: 'supergroup' })).action, 'ignored_non_private');
    assert.equal(h.telegram.calls.length, calls);
  });

  test('private message without an active application is ignored', async () => {
    h = harness();
    assert.equal((await h.say('привет')).action, 'ignored_no_application');
    assert.deepEqual(h.telegram.calls, []);
  });

  test('stale callback for another question is ignored (callback still answered)', async () => {
    h = harness();
    await h.joinRequest();
    assert.equal((await h.press('rules', 'agree')).action, 'ignored_stale_callback');
    assert.equal(h.telegram.byMethod('answerCallbackQuery').length, 1);
  });

  test('never sends to a negative (group) chat id', async () => {
    assert.throws(() => assertPrivateChatId(CHAT_ID), NonPrivateChatError);
    assert.throws(() => assertPrivateChatId('-1'), NonPrivateChatError);
    assertPrivateChatId(555001);
    h = harness();
    await assert.rejects(() => h.service.sendDm(CHAT_ID, { text: 'x' }), NonPrivateChatError);
    assert.deepEqual(h.telegram.calls, []);
    const result = await h.joinRequest({ userChatId: CHAT_ID });
    assert.equal(result.action, 'probation', 'invalid user_chat_id → probation, never a DM to the group');
    assert.equal(result.reason, 'missing_user_chat_id');
    assert.equal(h.telegram.byMethod('sendMessage').length, 0);
    const bot = await h.joinRequest({ user: { id: 9, is_bot: true }, userChatId: CHAT_ID });
    assert.equal(bot.reason, 'R_SCAM');
    assert.equal(h.telegram.byMethod('sendMessage').length, 0, 'reason DM never goes to a group id');
  });
});

describe('sweep', () => {
  test('timeout with open conversation → R_TIMEOUT DM, then decline', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    h.clock.now += 60 * 1000;
    await h.press('participate', 'yes');
    h.clock.now = T0 + 1800 * 1000 + 1;
    const before = h.telegram.calls.length;
    const result = await h.service.sweep();
    assert.equal(result.timedOut, 1);
    assert.equal(result.timeoutDms, 1);
    assert.deepEqual(h.telegram.calls.slice(before).map((c) => c.method), ['sendMessage', 'declineChatJoinRequest']);
    assert.equal(texts().at(-1), 'Вы не ответили на вопросы, поэтому заявка закрыта. Её можно подать снова в любой момент.');
    const stored = app(applicationId);
    assert.equal(stored.state, 'timed_out');
    assert.equal(stored.decision_reason, 'R_TIMEOUT');
  });

  test('timeout on the topics question (nothing selected) is R_TIMEOUT too', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    await h.press('participate', 'yes');
    await h.press('rules', 'agree');
    await h.press('topics', 'done');
    h.clock.now = T0 + 1800 * 1000 + 1;
    await h.service.sweep();
    assert.equal(app(applicationId).decision_reason, 'R_TIMEOUT');
  });

  test('timeout without reply, past the 5-minute window → decline, no DM', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    const sends = h.telegram.byMethod('sendMessage').length;
    h.clock.now = T0 + 1800 * 1000 + 1;
    const result = await h.service.sweep();
    assert.equal(result.timeoutDms, 0);
    assert.equal(h.telegram.byMethod('sendMessage').length, sends);
    assert.equal(app(applicationId).state, 'timed_out');
  });

  test('timeout inside the DM window still sends the notice', async () => {
    h = harness({ scenarioEdit: (raw) => { raw.limits.answerTimeoutSeconds = 60; } });
    await h.joinRequest();
    h.clock.now = T0 + 61 * 1000;
    assert.equal((await h.service.sweep()).timeoutDms, 1);
  });

  test('retention purge removes answers (incl. custom topics) and name snapshots', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    await h.press('participate', 'yes');
    await h.press('rules', 'agree');
    await h.say('Своя тема');
    await h.press('topics', 'done');
    assert.equal(app(applicationId).state, 'approved');
    const answers = h.store.listAnswers(applicationId).length;
    assert.equal(answers, 4);

    h.clock.now = T0 + 29 * 24 * 3600 * 1000;
    assert.equal((await h.service.sweep()).purged.answers, 0);
    h.clock.now = T0 + 31 * 24 * 3600 * 1000;
    const { purged } = await h.service.sweep();
    assert.equal(purged.answers, answers);
    const stored = app(applicationId);
    assert.equal(stored.first_name, null);
    assert.equal(stored.state, 'approved', 'decision record kept');
    assert.equal(h.store.listAnswers(applicationId).length, 0);
  });
});
