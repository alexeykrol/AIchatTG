import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { GatekeeperService, isActiveMember, joinUsers, updateForRecovery } from '../src/gatekeeper.mjs';
import { createGatekeeperHttpServer } from '../src/http-server.mjs';
import {
  createScenarioProvider,
  DEFAULT_SCENARIO_PATH,
  SCENARIO_BEGIN,
  SCENARIO_END,
} from '../src/scenario.mjs';
import { decryptPrivateValue, decryptUpdateBody, sha256 } from '../src/security.mjs';
import { GatekeeperStore } from '../src/store.mjs';
import { signTributeWebhook } from '../src/tribute.mjs';

const NOW = Date.parse('2026-08-02T20:00:00.000Z');
const TOKEN = 'opaque_test_start_token';

function editScenario(source, edit) {
  const begin = source.indexOf(SCENARIO_BEGIN);
  const end = source.indexOf(SCENARIO_END);
  assert.notEqual(begin, -1);
  assert.notEqual(end, -1);
  const section = source.slice(begin + SCENARIO_BEGIN.length, end).trim();
  const match = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/u.exec(section);
  assert.ok(match);
  const value = JSON.parse(match[1]);
  edit(value);
  const replacement = `${SCENARIO_BEGIN}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n${SCENARIO_END}`;
  return `${source.slice(0, begin)}${replacement}${source.slice(end + SCENARIO_END.length)}`;
}

function config(overrides = {}) {
  return {
    botUsername: 'krolkeeper_bot',
    targetChatId: '-1003840653970',
    telegramWebhookSecret: 'telegram-secret',
    tributeApiKey: 'tribute-test-api-key',
    tributeSubscriptionIds: ['1644'],
    tributeChannelId: '614',
    linkSigningSecret: 'link-signing-secret',
    startTokenTtlSeconds: 3600,
    scenarioPath: DEFAULT_SCENARIO_PATH,
    allowDraftScenario: true,
    ...overrides,
  };
}

class FakeTelegram {
  constructor() {
    this.messages = [];
    this.callbacks = [];
    this.nextMessageId = 100;
    this.sendError = null;
  }

  async sendMessage(payload) {
    this.messages.push(payload);
    if (this.sendError) throw this.sendError;
    return { message_id: this.nextMessageId++ };
  }

  async answerCallbackQuery(payload) {
    this.callbacks.push(payload);
    return true;
  }
}

function user(overrides = {}) {
  return { id: 196267257, is_bot: false, first_name: 'Алексей', username: 'alexeykrol', ...overrides };
}

function newMemberUpdate(updateId = 1, newcomer = user()) {
  return {
    update_id: updateId,
    message: {
      message_id: 11,
      chat: { id: -1003840653970, type: 'supergroup' },
      new_chat_members: [newcomer],
    },
  };
}

function tributeEvent(overrides = {}, payloadOverrides = {}) {
  return {
    name: 'new_subscription',
    created_at: '2026-08-02T19:59:00.000Z',
    sent_at: '2026-08-02T20:00:00.000Z',
    payload: {
      subscription_name: 'Paid community',
      subscription_id: 1644,
      period_id: 1547,
      period: 'monthly',
      type: 'regular',
      price: 1000,
      amount: 700,
      currency: 'rub',
      user_id: 31326,
      trb_user_id: 'T-31326',
      telegram_user_id: 196267257,
      telegram_username: 'alexeykrol',
      channel_id: 614,
      channel_name: 'Private community',
      expires_at: '2026-09-02T19:59:00.000Z',
      ...payloadOverrides,
    },
    ...overrides,
  };
}

function paidExternalEvent(eventId = 1, newcomer = user()) {
  return {
    event_id: `paid-${eventId}`,
    event_type: 'newcomer',
    chat_id: config().targetChatId,
    user: newcomer,
  };
}

async function invitePaid(targetService, eventId = 1, newcomer = user()) {
  const event = paidExternalEvent(eventId, newcomer);
  const body = JSON.stringify(event);
  return targetService.handleExternalEvent(event, body);
}

async function submitEmail(targetService, updateId, newcomer = user(), email = 'Student@Example.org') {
  return targetService.handleTelegramUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: newcomer.id, type: 'private' },
      from: newcomer,
      text: email,
    },
  });
}

describe('GatekeeperService', () => {
  let store;
  let telegram;
  let service;

  beforeEach(() => {
    store = new GatekeeperStore(':memory:');
    telegram = new FakeTelegram();
    service = new GatekeeperService({
      config: config(),
      store,
      telegram,
      clock: () => NOW,
      randomId: () => '11111111-1111-4111-8111-111111111111',
      makeStartToken: (_id, version) => version === 1 ? TOKEN : `${TOKEN}_${version}`,
      logger: { info() {}, error() {} },
    });
  });

  afterEach(() => store.close());

  test('detects both group service messages and chat_member joins', () => {
    assert.deepEqual(joinUsers(newMemberUpdate(), config().targetChatId).map((item) => item.id), [196267257]);
    const update = {
      chat_member: {
        chat: { id: -1003840653970, type: 'channel' },
        old_chat_member: { status: 'left', user: user() },
        new_chat_member: { status: 'member', user: user() },
      },
    };
    assert.deepEqual(joinUsers(update, config().targetChatId).map((item) => item.id), [196267257]);
    assert.equal(isActiveMember({ status: 'restricted', is_member: false }), false);
    assert.equal(isActiveMember({ status: 'restricted', is_member: true }), true);
  });

  test('recovery payload drops unrelated private-message content', () => {
    const recovery = updateForRecovery({
      update_id: 9,
      message: {
        message_id: 90,
        chat: { id: 196267257, type: 'private' },
        from: user(),
        text: 'arbitrary private conversation',
      },
    });
    assert.equal(recovery.update_id, 9);
    assert.equal(recovery.message.message_id, 90);
    assert.equal(recovery.message.chat.id, 196267257);
    assert.equal(recovery.message.from.id, 196267257);
    assert.equal(recovery.message.text, '');
    assert.equal(JSON.stringify(recovery).includes('arbitrary private conversation'), false);
  });

  test('ignores unverified membership, then posts one paid deep-link invitation', async () => {
    const scenario = createScenarioProvider({
      scenarioPath: DEFAULT_SCENARIO_PATH,
      allowDraftScenario: true,
    }).load();
    const membership = await service.handleTelegramUpdate(newMemberUpdate());
    const first = await invitePaid(service, 1);
    const duplicate = await invitePaid(service, 1);

    assert.deepEqual(membership, { ignored: 'membership_without_confirmed_payment', memberCount: 1 });
    assert.equal(first.delivery, 'sent');
    assert.equal(duplicate.duplicate, true);
    assert.equal(telegram.messages.length, 1);
    assert.equal(telegram.messages[0].reply_markup.inline_keyboard[0][0].text, scenario.messages.group_invitation.button_text);
    const buttonUrl = telegram.messages[0].reply_markup.inline_keyboard[0][0].url;
    assert.equal(buttonUrl, `https://t.me/krolkeeper_bot?start=${TOKEN}`);
    assert.equal(new URL(buttonUrl).searchParams.get('start').includes(String(user().id)), false);
    assert.equal(store.findInvitationByUser(config().targetChatId, user().id).group_send_state, 'sent');
  });

  test('does not create an invitation until the confirmed-payment event arrives', async () => {
    await service.handleTelegramUpdate(newMemberUpdate());
    assert.equal(store.findInvitationByUser(config().targetChatId, user().id), undefined);
    const body = JSON.stringify({
      event_id: 'provider-1',
      event_type: 'newcomer',
      chat_id: config().targetChatId,
      user: user(),
    });
    const result = await service.handleExternalEvent(JSON.parse(body), body);
    assert.equal(result.delivery, 'sent');
    assert.equal(telegram.messages.length, 1);
  });

  test('fails closed for a legacy invitation without a confirmed Tribute event', async () => {
    const scenario = createScenarioProvider({
      scenarioPath: DEFAULT_SCENARIO_PATH,
      allowDraftScenario: true,
    }).load();
    store.createInvitation({
      id: '11111111-1111-4111-8111-111111111111',
      chatId: config().targetChatId,
      user: user(),
      startTokenVersion: 1,
      startTokenSha256: sha256(TOKEN),
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      now: new Date(NOW).toISOString(),
    });
    const result = await service.handleTelegramUpdate({
      update_id: 9,
      message: {
        chat: { id: user().id, type: 'private' },
        from: user(),
        text: `/start ${TOKEN}`,
      },
    });
    assert.equal(result.state, 'payment_not_confirmed');
    assert.equal(telegram.messages[0].text, scenario.messages.start_payment_not_confirmed.text);
    assert.equal(store.findInvitationByUser(config().targetChatId, user().id).status, 'pending');
  });

  test('promotes only an exact legacy event when authenticated Tribute retries it', async () => {
    const event = paidExternalEvent(71);
    const body = JSON.stringify(event);
    store.claimEvent({
      eventKey: `external:${event.event_id}`,
      source: 'external_webhook',
      payloadSha256: sha256(body),
      userId: event.user.id,
      chatId: event.chat_id,
      now: new Date(NOW).toISOString(),
    });
    store.createInvitation({
      id: '11111111-1111-4111-8111-111111111111',
      chatId: event.chat_id,
      user: event.user,
      startTokenVersion: 1,
      startTokenSha256: sha256(TOKEN),
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      now: new Date(NOW).toISOString(),
    });

    const beforeRetry = await service.handleTelegramUpdate({
      update_id: 72,
      message: {
        message_id: 72,
        chat: { id: event.user.id, type: 'private' },
        from: event.user,
        text: `/start ${TOKEN}`,
      },
    });
    assert.equal(beforeRetry.state, 'payment_not_confirmed');

    const retry = await service.handleExternalEvent(event, body);
    assert.equal(retry.duplicate, true);
    assert.equal(store.db.prepare(`
      SELECT source FROM gatekeeper_events WHERE event_key = ?
    `).get(`external:${event.event_id}`).source, 'tribute');

    const afterRetry = await service.handleTelegramUpdate({
      update_id: 73,
      message: {
        message_id: 73,
        chat: { id: event.user.id, type: 'private' },
        from: event.user,
        text: `/start ${TOKEN}`,
      },
    });
    assert.equal(afterRetry.state, 'contact_established');

    store.claimEvent({
      eventKey: 'external:legacy-custom-event',
      source: 'external_webhook',
      payloadSha256: 'legacy-payload',
      userId: 42,
      chatId: event.chat_id,
      now: new Date(NOW).toISOString(),
    });
    assert.equal(store.hasEventSource({ source: 'tribute', userId: 42, chatId: event.chat_id }), false);
  });

  test('rejects reuse of an external event id with a different payload', async () => {
    const first = JSON.stringify({
      event_id: 'same-id', event_type: 'newcomer', chat_id: config().targetChatId, user: user(),
    });
    const second = JSON.stringify({
      event_id: 'same-id', event_type: 'newcomer', chat_id: config().targetChatId, user: user({ id: 42 }),
    });
    await service.handleExternalEvent(JSON.parse(first), first);
    await assert.rejects(service.handleExternalEvent(JSON.parse(second), second), /different payload/);
  });

  test('external event rejects an unallowlisted chat or extra fields', async () => {
    const wrongChat = { event_id: 'wrong-chat', event_type: 'newcomer', chat_id: '-1001', user: user() };
    await assert.rejects(service.handleExternalEvent(wrongChat, JSON.stringify(wrongChat)), /chat_id is not allowed/);
    const extra = {
      event_id: 'extra', event_type: 'newcomer', chat_id: config().targetChatId, user: user(), text: 'send this',
    };
    await assert.rejects(service.handleExternalEvent(extra, JSON.stringify(extra)), /unsupported event field/);
  });

  test('a new event rotates an expired pending start link', async () => {
    let currentTime = NOW;
    const rotatingStore = new GatekeeperStore(':memory:');
    const rotatingTelegram = new FakeTelegram();
    const rotatingService = new GatekeeperService({
      config: config({ startTokenTtlSeconds: 10 }),
      store: rotatingStore,
      telegram: rotatingTelegram,
      clock: () => currentTime,
      randomId: () => '22222222-2222-4222-8222-222222222222',
      makeStartToken: (_id, version) => `rotated_token_${version}`,
      logger: { info() {}, error() {} },
    });
    try {
      await invitePaid(rotatingService, 10);
      currentTime += 11_000;
      await invitePaid(rotatingService, 11);
      assert.equal(rotatingTelegram.messages.length, 2);
      assert.equal(
        rotatingTelegram.messages[1].reply_markup.inline_keyboard[0][0].url,
        'https://t.me/krolkeeper_bot?start=rotated_token_2',
      );
    } finally {
      rotatingStore.close();
    }
  });

  test('does not rotate an expired link while prior group delivery is uncertain', async () => {
    let currentTime = NOW;
    const uncertainStore = new GatekeeperStore(':memory:');
    const uncertainTelegram = new FakeTelegram();
    const timeout = new Error('network timeout');
    timeout.ambiguous = true;
    uncertainTelegram.sendError = timeout;
    const uncertainService = new GatekeeperService({
      config: config({ startTokenTtlSeconds: 10 }),
      store: uncertainStore,
      telegram: uncertainTelegram,
      clock: () => currentTime,
      randomId: () => '33333333-3333-4333-8333-333333333333',
      makeStartToken: (_id, version) => `uncertain_token_${version}`,
      logger: { info() {}, error() {} },
    });
    try {
      await assert.rejects(invitePaid(uncertainService, 20), /network timeout/u);
      currentTime += 11_000;
      uncertainTelegram.sendError = null;
      const result = await invitePaid(uncertainService, 21);
      const invitation = uncertainStore.findInvitationByUser(config().targetChatId, user().id);
      assert.equal(result.delivery, 'inconclusive');
      assert.equal(invitation.start_token_version, 1);
      assert.equal(invitation.group_send_state, 'inconclusive');
      assert.equal(uncertainTelegram.messages.length, 1);
    } finally {
      uncertainStore.close();
    }
  });

  test('binds /start, captures encrypted email, and records completion', async () => {
    const scenario = createScenarioProvider({
      scenarioPath: DEFAULT_SCENARIO_PATH,
      allowDraftScenario: true,
    }).load();
    await invitePaid(service, 1);
    const start = await service.handleTelegramUpdate({
      update_id: 2,
      message: {
        message_id: 12,
        chat: { id: 196267257, type: 'private' },
        from: user(),
        text: `/start ${TOKEN}`,
      },
    });
    assert.equal(start.state, 'contact_established');
    assert.equal(telegram.messages[1].text, scenario.messages.private_instruction.text);
    assert.equal(telegram.messages[1].reply_markup.inline_keyboard.length, 2);

    const email = await submitEmail(service, 3);
    assert.equal(email.state, 'email_collected');
    assert.equal(telegram.messages[2].text, scenario.messages.email_accepted.text);
    assert.equal(
      telegram.messages[2].reply_markup.inline_keyboard[0][0].text,
      scenario.messages.email_accepted.completion_button_text,
    );
    assert.equal(telegram.messages[2].reply_markup.inline_keyboard[0][0].callback_data, `gk_done:${TOKEN}`);
    const invitation = store.findInvitationByUser(config().targetChatId, user().id);
    const privateEmail = store.findPrivateEmail(invitation.id);
    assert.equal(decryptPrivateValue({
      ciphertext: privateEmail.email_ciphertext,
      iv: privateEmail.email_iv,
      tag: privateEmail.email_tag,
    }, config().linkSigningSecret), 'Student@example.org');
    assert.equal(JSON.stringify(privateEmail).includes('Student@example.org'), false);
    const storedEmailUpdate = store.findUpdate(3);
    const emailRecoveryBody = decryptUpdateBody({
      ciphertext: storedEmailUpdate.raw_body_ciphertext,
      iv: storedEmailUpdate.raw_body_iv,
      tag: storedEmailUpdate.raw_body_tag,
    }, config().linkSigningSecret);
    assert.equal(JSON.parse(emailRecoveryBody).message.text, '');
    assert.equal(emailRecoveryBody.includes('Student@Example.org'), false);
    assert.equal(JSON.stringify(storedEmailUpdate).includes('Student@Example.org'), false);

    const done = await service.handleTelegramUpdate({
      update_id: 4,
      callback_query: {
        id: 'callback-1',
        from: user(),
        data: `gk_done:${TOKEN}`,
      },
    });
    assert.equal(done.state, 'completed');
    assert.equal(telegram.callbacks.length, 1);
    assert.equal(telegram.callbacks[0].text, scenario.messages.completion_success.callback_text);
    assert.equal(telegram.messages[3].text, scenario.messages.completion_success.dm_text);
    assert.equal(store.findInvitationByUser(config().targetChatId, user().id).status, 'completed');

    const repeated = await service.handleTelegramUpdate({
      update_id: 5,
      callback_query: {
        id: 'callback-2',
        from: user(),
        data: `gk_done:${TOKEN}`,
      },
    });
    assert.equal(repeated.duplicate, true);
    assert.equal(telegram.messages.length, 4);
    assert.equal(telegram.callbacks[1].text, scenario.messages.completion_already_completed.callback_text);

    const repeatedStart = await service.handleTelegramUpdate({
      update_id: 6,
      message: {
        message_id: 13,
        chat: { id: 196267257, type: 'private' },
        from: user(),
        text: `/start ${TOKEN}`,
      },
    });
    assert.equal(repeatedStart.state, 'completed');
    assert.equal(telegram.messages[4].text, scenario.messages.start_already_completed.text);
  });

  test('rejects malformed email and never overwrites the first accepted address', async () => {
    const scenario = createScenarioProvider({
      scenarioPath: DEFAULT_SCENARIO_PATH,
      allowDraftScenario: true,
    }).load();
    await invitePaid(service, 80);
    await service.handleTelegramUpdate({
      update_id: 81,
      message: {
        chat: { id: user().id, type: 'private' },
        from: user(),
        text: `/start ${TOKEN}`,
      },
    });

    const invalid = await submitEmail(service, 82, user(), 'not an email');
    assert.equal(invalid.state, 'invalid_email');
    assert.equal(telegram.messages.at(-1).text, scenario.messages.email_invalid.text);
    const invitation = store.findInvitationByUser(config().targetChatId, user().id);
    assert.equal(store.findPrivateEmail(invitation.id), undefined);

    await submitEmail(service, 83, user(), 'First@Example.org');
    const first = store.findPrivateEmail(invitation.id);
    const duplicate = await submitEmail(service, 84, user(), 'Second@Example.org');
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(store.findPrivateEmail(invitation.id), first);
    assert.equal(decryptPrivateValue({
      ciphertext: first.email_ciphertext,
      iv: first.email_iv,
      tag: first.email_tag,
    }, config().linkSigningSecret), 'First@example.org');
  });

  test('replays a failed email response without retaining or re-entering the email', async () => {
    const scenario = createScenarioProvider({
      scenarioPath: DEFAULT_SCENARIO_PATH,
      allowDraftScenario: true,
    }).load();
    await invitePaid(service, 90);
    await service.handleTelegramUpdate({
      update_id: 91,
      message: {
        message_id: 91,
        chat: { id: user().id, type: 'private' },
        from: user(),
        text: `/start ${TOKEN}`,
      },
    });

    const originalUpdate = {
      update_id: 92,
      message: {
        message_id: 92,
        chat: { id: user().id, type: 'private' },
        from: user(),
        text: 'Recovery@Test.Example',
      },
    };
    const originalBody = JSON.stringify(originalUpdate);
    telegram.sendError = new Error('sendMessage failed: Too Many Requests');
    await assert.rejects(
      service.handleTelegramUpdate(originalUpdate, originalBody),
      /Too Many Requests/u,
    );
    telegram.sendError = null;

    const invitation = store.findInvitationByUser(config().targetChatId, user().id);
    const privateEmail = store.findPrivateEmail(invitation.id);
    assert.equal(decryptPrivateValue({
      ciphertext: privateEmail.email_ciphertext,
      iv: privateEmail.email_iv,
      tag: privateEmail.email_tag,
    }, config().linkSigningSecret), 'Recovery@test.example');

    const stored = store.findUpdate(92);
    assert.equal(stored.state, 'failed');
    assert.notEqual(stored.raw_body_sha256, sha256(originalBody));
    const recoveryBody = decryptUpdateBody({
      ciphertext: stored.raw_body_ciphertext,
      iv: stored.raw_body_iv,
      tag: stored.raw_body_tag,
    }, config().linkSigningSecret);
    assert.equal(recoveryBody.includes('Recovery@Test.Example'), false);
    assert.equal(JSON.parse(recoveryBody).message.text, '');

    assert.equal(store.markUpdateRetryable(92, new Date(NOW + 1_000).toISOString()), true);
    const replayed = await service.handleTelegramUpdate(JSON.parse(recoveryBody), recoveryBody, {
      rawBodySha256: stored.raw_body_sha256,
    });
    assert.equal(replayed.state, 'email_collected');
    assert.equal(replayed.duplicate, true);
    assert.equal(store.findUpdate(92).state, 'processed');
    assert.equal(telegram.messages.at(-1).text, scenario.messages.email_accepted.text);
  });

  test('recovers a confirmed-absent completion DM without enabling user-triggered duplicates', async () => {
    const scenario = createScenarioProvider({
      scenarioPath: DEFAULT_SCENARIO_PATH,
      allowDraftScenario: true,
    }).load();
    await invitePaid(service, 1);
    await service.handleTelegramUpdate({
      update_id: 2,
      message: {
        message_id: 12,
        chat: { id: 196267257, type: 'private' },
        from: user(),
        text: `/start ${TOKEN}`,
      },
    });
    await submitEmail(service, 6);

    const completionUpdate = {
      update_id: 3,
      callback_query: {
        id: 'callback-recovery',
        from: user(),
        data: `gk_done:${TOKEN}`,
      },
    };
    const completionBody = JSON.stringify(completionUpdate);
    const ambiguous = new Error('completion DM may not have been delivered');
    ambiguous.ambiguous = true;
    telegram.sendError = ambiguous;
    const first = await service.handleTelegramUpdate(completionUpdate, completionBody);
    assert.deepEqual(first, { inconclusive: true, updateId: '3' });
    assert.equal(store.findInvitationByUser(config().targetChatId, user().id).status, 'completed');
    assert.equal(store.findUpdate(3).state, 'inconclusive');
    assert.equal(telegram.callbacks.length, 1);
    assert.equal(telegram.messages.length, 4);

    telegram.sendError = null;
    const stored = store.findUpdate(3);
    assert.equal(store.markUpdateRetryable(3, new Date(NOW + 1_000).toISOString()), true);
    const recovered = await service.handleTelegramUpdate(completionUpdate, completionBody, {
      rawBodySha256: stored.raw_body_sha256,
      confirmedAbsentCompletionDmReplay: true,
    });
    assert.deepEqual(recovered, {
      state: 'completed',
      invitationId: '11111111-1111-4111-8111-111111111111',
      recoveredCompletionDm: true,
    });
    assert.equal(telegram.callbacks.length, 1);
    assert.equal(telegram.messages.length, 5);
    assert.equal(telegram.messages.at(-1).text, scenario.messages.completion_success.dm_text);
    assert.equal(store.findUpdate(3).state, 'processed');

    const repeated = await service.handleTelegramUpdate({
      update_id: 4,
      callback_query: {
        id: 'callback-after-recovery',
        from: user(),
        data: `gk_done:${TOKEN}`,
      },
    });
    assert.equal(repeated.duplicate, true);
    assert.equal(telegram.messages.length, 5);
    assert.equal(telegram.callbacks.length, 2);
    assert.equal(telegram.callbacks.at(-1).text, scenario.messages.completion_already_completed.callback_text);
  });

  test('keeps a definite completion-DM failure operator-recoverable across Telegram retries', async () => {
    await invitePaid(service, 70);
    await service.handleTelegramUpdate({
      update_id: 71,
      message: {
        message_id: 12,
        chat: { id: 196267257, type: 'private' },
        from: user(),
        text: `/start ${TOKEN}`,
      },
    });
    await submitEmail(service, 73);

    const completionUpdate = {
      update_id: 72,
      callback_query: {
        id: 'callback-definite-failure',
        from: user(),
        data: `gk_done:${TOKEN}`,
      },
    };
    const completionBody = JSON.stringify(completionUpdate);
    telegram.sendError = new Error('sendMessage failed: Too Many Requests');
    const failedDelivery = await service.handleTelegramUpdate(completionUpdate, completionBody);
    assert.deepEqual(failedDelivery, { inconclusive: true, updateId: '72' });
    assert.equal(store.findInvitationByUser(config().targetChatId, user().id).status, 'completed');
    assert.equal(store.findUpdate(72).state, 'inconclusive');
    assert.equal(telegram.callbacks.length, 1);
    assert.equal(telegram.messages.length, 4);

    telegram.sendError = null;
    const providerRetry = await service.handleTelegramUpdate(completionUpdate, completionBody);
    assert.deepEqual(providerRetry, { duplicate: true, state: 'inconclusive' });
    assert.equal(store.findUpdate(72).state, 'inconclusive');
    assert.equal(telegram.callbacks.length, 1);
    assert.equal(telegram.messages.length, 4);

    const stored = store.findUpdate(72);
    assert.equal(store.markUpdateRetryable(72, new Date(NOW + 1_000).toISOString()), true);
    const recovered = await service.handleTelegramUpdate(completionUpdate, completionBody, {
      rawBodySha256: stored.raw_body_sha256,
      confirmedAbsentCompletionDmReplay: true,
    });
    assert.equal(recovered.recoveredCompletionDm, true);
    assert.equal(store.findUpdate(72).state, 'processed');
    assert.equal(telegram.callbacks.length, 1);
    assert.equal(telegram.messages.length, 5);
  });

  test('uses scenario copy for missing Start and completion rejection branches', async () => {
    const scenario = createScenarioProvider({
      scenarioPath: DEFAULT_SCENARIO_PATH,
      allowDraftScenario: true,
    }).load();
    const missing = await service.handleTelegramUpdate({
      update_id: 60,
      message: {
        chat: { id: 196267257, type: 'private' },
        from: user(),
        text: '/start',
      },
    });
    assert.equal(missing.state, 'missing_token');
    assert.equal(telegram.messages[0].text, scenario.messages.start_missing_token.text);

    const invalidCompletion = await service.handleTelegramUpdate({
      update_id: 61,
      callback_query: { id: 'invalid-completion', from: user(), data: 'gk_done:not_a_token' },
    });
    assert.equal(invalidCompletion.state, 'invalid_token');
    assert.equal(telegram.callbacks[0].text, scenario.messages.completion_invalid_user.callback_text);

    await invitePaid(service, 62);
    const premature = await service.handleTelegramUpdate({
      update_id: 63,
      callback_query: { id: 'premature-completion', from: user(), data: `gk_done:${TOKEN}` },
    });
    assert.equal(premature.state, 'pending');
    assert.equal(telegram.callbacks[1].text, scenario.messages.completion_before_start.callback_text);

    await service.handleTelegramUpdate({
      update_id: 64,
      message: {
        chat: { id: user().id, type: 'private' },
        from: user(),
        text: `/start ${TOKEN}`,
      },
    });
    const beforeEmail = await service.handleTelegramUpdate({
      update_id: 65,
      callback_query: { id: 'before-email', from: user(), data: `gk_done:${TOKEN}` },
    });
    assert.equal(beforeEmail.state, 'contact_established');
    assert.equal(telegram.callbacks[2].text, scenario.messages.completion_before_email.callback_text);
  });

  test('uses scenario copy for an expired personal link', async () => {
    let currentTime = NOW;
    const expiringStore = new GatekeeperStore(':memory:');
    const expiringTelegram = new FakeTelegram();
    const expiringService = new GatekeeperService({
      config: config({ startTokenTtlSeconds: 1 }),
      store: expiringStore,
      telegram: expiringTelegram,
      clock: () => currentTime,
      randomId: () => 'expired-invitation',
      makeStartToken: () => TOKEN,
      logger: { info() {}, error() {} },
    });
    try {
      await invitePaid(expiringService, 64);
      currentTime += 2_000;
      const expired = await expiringService.handleTelegramUpdate({
        update_id: 65,
        message: {
          chat: { id: 196267257, type: 'private' },
          from: user(),
          text: `/start ${TOKEN}`,
        },
      });
      const scenario = createScenarioProvider({
        scenarioPath: DEFAULT_SCENARIO_PATH,
        allowDraftScenario: true,
      }).load();
      assert.equal(expired.state, 'expired_token');
      assert.equal(expiringTelegram.messages[1].text, scenario.messages.start_expired_token.text);
    } finally {
      expiringStore.close();
    }
  });

  test('loads one immutable scenario snapshot for one payment event', async () => {
    const snapshot = createScenarioProvider({
      scenarioPath: DEFAULT_SCENARIO_PATH,
      allowDraftScenario: true,
    }).load();
    let loads = 0;
    let invitationId = 0;
    const multiStore = new GatekeeperStore(':memory:');
    const multiTelegram = new FakeTelegram();
    const multiService = new GatekeeperService({
      config: config(),
      store: multiStore,
      telegram: multiTelegram,
      scenarioProvider: { load() { loads += 1; return snapshot; } },
      clock: () => NOW,
      randomId: () => `multi-${++invitationId}`,
      makeStartToken: (id) => `token_${id}`,
      logger: { info() {}, error() {} },
    });
    try {
      const result = await invitePaid(multiService, 66);
      assert.equal(result.delivery, 'sent');
      assert.equal(multiTelegram.messages.length, 1);
      assert.equal(loads, 1);
    } finally {
      multiStore.close();
    }
  });

  test('does not let another user consume the deep link', async () => {
    await invitePaid(service, 1);
    const result = await service.handleTelegramUpdate({
      update_id: 2,
      message: {
        chat: { id: 999, type: 'private' },
        from: user({ id: 999 }),
        text: `/start ${TOKEN}`,
      },
    });
    assert.equal(result.state, 'invalid_token');
    const scenario = createScenarioProvider({
      scenarioPath: DEFAULT_SCENARIO_PATH,
      allowDraftScenario: true,
    }).load();
    assert.equal(telegram.messages[1].text, scenario.messages.start_invalid_token.text);
    assert.equal(store.findInvitationByUser(config().targetChatId, user().id).status, 'pending');
  });

  test('loads a changed scenario before each update without restarting', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatekeeper-scenario-reload-'));
    const scenarioPath = path.join(temporaryRoot, 'scenario.md');
    const original = fs.readFileSync(DEFAULT_SCENARIO_PATH, 'utf8');
    fs.writeFileSync(scenarioPath, editScenario(original, (value) => {
      value.messages.group_invitation.text = '{{user_mention}} <версия & один>!';
    }), { mode: 0o600 });
    const reloadStore = new GatekeeperStore(':memory:');
    const reloadTelegram = new FakeTelegram();
    let nextReloadId = 1;
    const reloadService = new GatekeeperService({
      config: config({ scenarioPath }),
      store: reloadStore,
      telegram: reloadTelegram,
      clock: () => NOW,
      randomId: () => `reload-invitation-${nextReloadId++}`,
      makeStartToken: (id, version) => `reload_token_${id}_${version}`,
      logger: { info() {}, error() {} },
    });
    try {
      await invitePaid(reloadService, 40, user({ id: 401 }));
      assert.match(reloadTelegram.messages[0].text, /&lt;версия &amp; один&gt;!/u);
      assert.doesNotMatch(reloadTelegram.messages[0].text, /<версия/u);

      fs.writeFileSync(scenarioPath, editScenario(original, (value) => {
        value.messages.group_invitation.text = '{{user_mention}} версия два!';
      }), { mode: 0o600 });
      await invitePaid(reloadService, 41, user({ id: 402 }));
      assert.match(reloadTelegram.messages[1].text, /версия два!/u);
      assert.doesNotMatch(reloadTelegram.messages[1].text, /версия &amp; один/u);
    } finally {
      reloadStore.close();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('invalid hot edit fails before update claim and never falls back to stale copy', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatekeeper-scenario-invalid-'));
    const scenarioPath = path.join(temporaryRoot, 'scenario.md');
    fs.writeFileSync(scenarioPath, fs.readFileSync(DEFAULT_SCENARIO_PATH, 'utf8'), { mode: 0o600 });
    const isolatedStore = new GatekeeperStore(':memory:');
    const isolatedTelegram = new FakeTelegram();
    const isolatedService = new GatekeeperService({
      config: config({ scenarioPath }),
      store: isolatedStore,
      telegram: isolatedTelegram,
      clock: () => NOW,
      randomId: () => '55555555-5555-4555-8555-555555555555',
      makeStartToken: () => 'invalid_edit_token',
      logger: { info() {}, error() {} },
    });
    try {
      fs.writeFileSync(scenarioPath, '# half-written edit', { mode: 0o600 });
      await assert.rejects(invitePaid(isolatedService, 50), /scenario is invalid/u);
      assert.equal(isolatedStore.db.prepare('SELECT COUNT(*) AS count FROM gatekeeper_events').get().count, 0);
      assert.equal(isolatedTelegram.messages.length, 0);

      fs.writeFileSync(scenarioPath, fs.readFileSync(DEFAULT_SCENARIO_PATH, 'utf8'), { mode: 0o600 });
      const recovered = await invitePaid(isolatedService, 50);
      assert.equal(recovered.delivery, 'sent');
      assert.equal(isolatedTelegram.messages.length, 1);
    } finally {
      isolatedStore.close();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('records ambiguous Telegram delivery without automatic retry', async () => {
    const error = new Error('network timeout');
    error.ambiguous = true;
    telegram.sendError = error;
    await assert.rejects(invitePaid(service, 1), /network timeout/u);
    telegram.sendError = null;

    const retry = await invitePaid(service, 2);
    assert.equal(retry.delivery, 'inconclusive');
    assert.equal(telegram.messages.length, 1);
  });

  test('replays an encrypted minimal update using the original idempotency hash', async () => {
    await invitePaid(service, 30);
    const timeout = new Error('network timeout');
    timeout.ambiguous = true;
    telegram.sendError = timeout;
    const originalUpdate = {
      update_id: 31,
      message: {
        message_id: 99,
        chat: { id: 196267257, type: 'private', extra_private_metadata: 'drop-me' },
        from: user(),
        text: `/start ${TOKEN}`,
        arbitrary_private_field: 'drop-me-too',
      },
    };
    const originalBody = JSON.stringify(originalUpdate);
    const uncertain = await service.handleTelegramUpdate(originalUpdate, originalBody);
    assert.equal(uncertain.inconclusive, true);

    telegram.sendError = null;
    const stored = store.findUpdate(31);
    const recoveryBody = decryptUpdateBody({
      ciphertext: stored.raw_body_ciphertext,
      iv: stored.raw_body_iv,
      tag: stored.raw_body_tag,
    }, config().linkSigningSecret);
    assert.equal(recoveryBody.includes('drop-me'), false);
    assert.equal(store.markUpdateRetryable(31, new Date(NOW + 1_000).toISOString()), true);
    const replayed = await service.handleTelegramUpdate(JSON.parse(recoveryBody), recoveryBody, {
      rawBodySha256: stored.raw_body_sha256,
    });
    assert.equal(replayed.state, 'contact_established');
    assert.equal(store.findUpdate(31).state, 'processed');
  });
});

describe('Gatekeeper HTTP ingress', () => {
  let store;
  let telegram;
  let server;
  let baseUrl;

  beforeEach(async () => {
    store = new GatekeeperStore(':memory:');
    telegram = new FakeTelegram();
    const draftScenario = createScenarioProvider({
      scenarioPath: DEFAULT_SCENARIO_PATH,
      allowDraftScenario: true,
    }).load();
    const readyScenario = { ...draftScenario, status: 'ready' };
    const service = new GatekeeperService({
      config: config(),
      store,
      telegram,
      clock: () => NOW,
      randomId: () => '11111111-1111-4111-8111-111111111111',
      makeStartToken: () => TOKEN,
      logger: { info() {}, error() {} },
    });
    server = createGatekeeperHttpServer({
      config: config(),
      service,
      store,
      clock: () => NOW,
      logger: { info() {}, error() {} },
      ingressScenarioProvider: { load() { return readyScenario; } },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });

  test('health is side-effect free', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'telegram-gatekeeper' });
  });

  test('Telegram webhook fails closed on a wrong secret', async () => {
    const response = await fetch(`${baseUrl}/webhooks/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong' },
      body: JSON.stringify(newMemberUpdate()),
    });
    assert.equal(response.status, 401);
    assert.equal(telegram.messages.length, 0);
  });

  test('Telegram membership webhook is accepted but cannot establish paid eligibility', async () => {
    const response = await fetch(`${baseUrl}/webhooks/telegram`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': config().telegramWebhookSecret,
      },
      body: JSON.stringify(newMemberUpdate()),
    });
    assert.equal(response.status, 200);
    assert.equal(telegram.messages.length, 0);
    assert.equal(store.findInvitationByUser(config().targetChatId, user().id), undefined);
  });

  test('Tribute webhook verifies the raw body and deduplicates a changed sent_at retry', async () => {
    const firstBody = JSON.stringify(tributeEvent());
    const retryBody = JSON.stringify(tributeEvent({ sent_at: '2026-08-02T20:05:00.000Z' }));
    const first = await fetch(`${baseUrl}/webhooks/tribute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'trbt-signature': signTributeWebhook(config().tributeApiKey, firstBody),
      },
      body: firstBody,
    });
    const duplicate = await fetch(`${baseUrl}/webhooks/tribute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'trbt-signature': signTributeWebhook(config().tributeApiKey, retryBody),
      },
      body: retryBody,
    });
    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await first.json(), { status: 'ok' });
    assert.deepEqual(await duplicate.json(), { status: 'ok' });
    assert.equal(telegram.messages.length, 1);
  });

  test('a duplicate signed Tribute delivery never retries a definite failed group send', async () => {
    const body = JSON.stringify(tributeEvent());
    const headers = {
      'content-type': 'application/json',
      'trbt-signature': signTributeWebhook(config().tributeApiKey, body),
    };
    telegram.sendError = new Error('sendMessage failed: Too Many Requests');
    const first = await fetch(`${baseUrl}/webhooks/tribute`, {
      method: 'POST', headers, body,
    });
    assert.equal(first.status, 500);
    assert.equal(telegram.messages.length, 1);
    assert.equal(store.findInvitationByUser(config().targetChatId, user().id).group_send_state, 'failed');

    telegram.sendError = null;
    const duplicate = await fetch(`${baseUrl}/webhooks/tribute`, {
      method: 'POST', headers, body,
    });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { status: 'ok' });
    assert.equal(telegram.messages.length, 1);
    assert.equal(store.findInvitationByUser(config().targetChatId, user().id).group_send_state, 'failed');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM gatekeeper_events').get().count, 1);
  });

  test('networked Telegram and Tribute ingress reject draft even when the service allows it', async () => {
    const isolatedStore = new GatekeeperStore(':memory:');
    const isolatedTelegram = new FakeTelegram();
    const draftConfig = config({ allowDraftScenario: true });
    const isolatedService = new GatekeeperService({
      config: draftConfig,
      store: isolatedStore,
      telegram: isolatedTelegram,
      clock: () => NOW,
      randomId: () => 'draft-ingress-invitation',
      makeStartToken: () => 'draft_ingress_token',
      logger: { info() {}, error() {} },
    });
    const isolatedServer = createGatekeeperHttpServer({
      config: draftConfig,
      service: isolatedService,
      store: isolatedStore,
      clock: () => NOW,
      logger: { info() {}, error() {} },
    });
    try {
      await new Promise((resolve) => isolatedServer.listen(0, '127.0.0.1', resolve));
      const isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
      const telegramResponse = await fetch(`${isolatedBaseUrl}/webhooks/telegram`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': draftConfig.telegramWebhookSecret,
        },
        body: JSON.stringify(newMemberUpdate(900)),
      });
      const tributeBody = JSON.stringify(tributeEvent());
      const tributeResponse = await fetch(`${isolatedBaseUrl}/webhooks/tribute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'trbt-signature': signTributeWebhook(draftConfig.tributeApiKey, tributeBody),
        },
        body: tributeBody,
      });
      assert.equal(telegramResponse.status, 500);
      assert.equal(tributeResponse.status, 500);
      assert.equal(isolatedTelegram.messages.length, 0);
      assert.equal(isolatedStore.db.prepare('SELECT COUNT(*) AS count FROM gatekeeper_updates').get().count, 0);
      assert.equal(isolatedStore.db.prepare('SELECT COUNT(*) AS count FROM gatekeeper_events').get().count, 0);
      assert.equal(isolatedStore.summary().pending, 0);
    } finally {
      await new Promise((resolve, reject) => isolatedServer.close((error) => error ? reject(error) : resolve()));
      isolatedStore.close();
    }
  });

  test('Tribute webhook rejects an invalid signature and the retired route is absent', async () => {
    const body = JSON.stringify(tributeEvent());
    const response = await fetch(`${baseUrl}/webhooks/tribute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'trbt-signature': '0'.repeat(64),
      },
      body,
    });
    assert.equal(response.status, 401);
    assert.equal(telegram.messages.length, 0);

    const retired = await fetch(`${baseUrl}/webhooks/external/newcomer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(retired.status, 404);
  });

  test('Tribute ignores authentic irrelevant subscriptions without DB or Telegram effects', async () => {
    for (const event of [
      tributeEvent({ name: 'renewed_subscription' }),
      tributeEvent({}, { subscription_id: 9999 }),
      tributeEvent({}, { channel_id: 999 }),
      tributeEvent({}, { currency: 'eur' }),
      tributeEvent({}, { type: 'trial', price: 0 }),
      tributeEvent({}, { price: 0 }),
    ]) {
      const body = JSON.stringify(event);
      const response = await fetch(`${baseUrl}/webhooks/tribute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'trbt-signature': signTributeWebhook(config().tributeApiKey, body),
        },
        body,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ignored' });
    }
    assert.equal(telegram.messages.length, 0);
    assert.equal(store.summary().pending, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM gatekeeper_events').get().count, 0);
  });

  test('Tribute rejects a malformed allowlisted paid subscription before DB or send', async () => {
    const event = tributeEvent({}, { telegram_user_id: 'not-an-integer' });
    const body = JSON.stringify(event);
    const response = await fetch(`${baseUrl}/webhooks/tribute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'trbt-signature': signTributeWebhook(config().tributeApiKey, body),
      },
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(telegram.messages.length, 0);
    assert.equal(store.summary().pending, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM gatekeeper_events').get().count, 0);
  });
});
