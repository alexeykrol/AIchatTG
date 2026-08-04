import assert from 'node:assert/strict';
import { GatekeeperService } from './gatekeeper.mjs';
import { createScenarioProvider, DEFAULT_SCENARIO_PATH } from './scenario.mjs';
import { decryptPrivateValue, decryptUpdateBody, sha256 } from './security.mjs';
import { GatekeeperStore } from './store.mjs';

const TARGET_CHAT_ID = '-1003840653970';
const USER_ID = 196267257;
const START_TOKEN = 'local_simulation_start_token';
const LINK_SIGNING_SECRET = 'local-simulation-only-signing-secret';

class LocalTelegramRecorder {
  constructor() {
    this.messages = [];
    this.callbacks = [];
  }

  async sendMessage(payload) {
    this.messages.push(structuredClone(payload));
    return { message_id: 1_000 + this.messages.length };
  }

  async answerCallbackQuery(payload) {
    this.callbacks.push(structuredClone(payload));
    return true;
  }
}

const config = {
  botUsername: 'local_gatekeeper_bot',
  targetChatId: TARGET_CHAT_ID,
  linkSigningSecret: LINK_SIGNING_SECRET,
  startTokenTtlSeconds: 3_600,
  scenarioPath: DEFAULT_SCENARIO_PATH,
  allowDraftScenario: true,
};
const scenarioProvider = createScenarioProvider({
  scenarioPath: DEFAULT_SCENARIO_PATH,
  allowDraftScenario: true,
});
const scenario = scenarioProvider.load();
const store = new GatekeeperStore(':memory:');
const telegram = new LocalTelegramRecorder();
const service = new GatekeeperService({
  config,
  store,
  telegram,
  scenarioProvider,
  clock: () => Date.parse('2026-08-02T20:00:00.000Z'),
  randomId: () => '11111111-1111-4111-8111-111111111111',
  makeStartToken: () => START_TOKEN,
  logger: { info() {}, error() {} },
});

const newcomer = {
  id: USER_ID,
  is_bot: false,
  first_name: 'Тестовый',
  last_name: 'Новичок',
  username: 'local_newcomer',
};

try {
  const membership = await service.handleTelegramUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: Number(TARGET_CHAT_ID), type: 'supergroup' },
      new_chat_members: [newcomer],
    },
  });
  assert.equal(membership.ignored, 'membership_without_confirmed_payment');
  assert.equal(telegram.messages.length, 0);

  const paymentEvent = {
    event_id: 'local-confirmed-rub-payment',
    event_type: 'newcomer',
    chat_id: TARGET_CHAT_ID,
    user: newcomer,
  };
  const paymentBody = JSON.stringify(paymentEvent);
  const invitationResult = await service.handleExternalEvent(paymentEvent, paymentBody);
  assert.equal(invitationResult.delivery, 'sent');
  assert.equal(telegram.messages.length, 1);
  assert.equal(telegram.messages[0].chat_id, TARGET_CHAT_ID);
  assert.match(telegram.messages[0].text, /tg:\/\/user\?id=196267257/u);

  const start = await service.handleTelegramUpdate({
    update_id: 2,
    message: {
      message_id: 11,
      chat: { id: USER_ID, type: 'private' },
      from: newcomer,
      text: `/start ${START_TOKEN}`,
    },
  });
  assert.equal(start.state, 'contact_established');
  assert.equal(telegram.messages.length, 2);
  assert.equal(telegram.messages[1].text, scenario.messages.private_instruction.text);

  const emailText = 'Student@Example.org';
  const emailUpdate = {
    update_id: 3,
    message: {
      message_id: 12,
      chat: { id: USER_ID, type: 'private' },
      from: newcomer,
      text: emailText,
    },
  };
  const emailBody = JSON.stringify(emailUpdate);
  const email = await service.handleTelegramUpdate(emailUpdate, emailBody);
  assert.equal(email.state, 'email_collected');
  assert.equal(telegram.messages[2].text, scenario.messages.email_accepted.text);

  const completion = await service.handleTelegramUpdate({
    update_id: 4,
    callback_query: {
      id: 'local-completion-1',
      from: newcomer,
      data: `gk_done:${START_TOKEN}`,
    },
  });
  assert.equal(completion.state, 'completed');
  assert.equal(telegram.messages.length, 4);
  assert.equal(telegram.messages[3].text, scenario.messages.completion_success.dm_text);

  const messageCountAfterCompletion = telegram.messages.length;
  const repeatedCompletion = await service.handleTelegramUpdate({
    update_id: 5,
    callback_query: {
      id: 'local-completion-2',
      from: newcomer,
      data: `gk_done:${START_TOKEN}`,
    },
  });
  assert.equal(repeatedCompletion.duplicate, true);
  assert.equal(telegram.messages.length, messageCountAfterCompletion);
  assert.equal(
    telegram.callbacks.at(-1).text,
    scenario.messages.completion_already_completed.callback_text,
  );

  const repeatedStart = await service.handleTelegramUpdate({
    update_id: 6,
    message: {
      message_id: 12,
      chat: { id: USER_ID, type: 'private' },
      from: newcomer,
      text: `/start ${START_TOKEN}`,
    },
  });
  assert.equal(repeatedStart.state, 'completed');
  assert.equal(telegram.messages.at(-1).text, scenario.messages.start_already_completed.text);

  const privateText = 'Произвольный личный разговор, который нельзя сохранять';
  const freeForm = await service.handleTelegramUpdate({
    update_id: 7,
    message: {
      message_id: 13,
      chat: { id: USER_ID, type: 'private' },
      from: newcomer,
      text: privateText,
    },
  });
  assert.deepEqual(freeForm, { ignored: 'unsupported_private_message' });
  const storedFreeForm = store.findUpdate(7);
  const recoveryBody = decryptUpdateBody({
    ciphertext: storedFreeForm.raw_body_ciphertext,
    iv: storedFreeForm.raw_body_iv,
    tag: storedFreeForm.raw_body_tag,
  }, LINK_SIGNING_SECRET);
  assert.equal(JSON.parse(recoveryBody).message.text, '');
  assert.equal(recoveryBody.includes(privateText), false);

  const invitation = store.findInvitationByUser(TARGET_CHAT_ID, USER_ID);
  const encryptedEmail = store.findPrivateEmail(invitation.id);
  assert.equal(decryptPrivateValue({
    ciphertext: encryptedEmail.email_ciphertext,
    iv: encryptedEmail.email_iv,
    tag: encryptedEmail.email_tag,
  }, LINK_SIGNING_SECRET), 'Student@example.org');
  assert.equal(JSON.stringify(encryptedEmail).includes(emailText), false);
  const storedEmailUpdate = store.findUpdate(3);
  const emailRecoveryBody = decryptUpdateBody({
    ciphertext: storedEmailUpdate.raw_body_ciphertext,
    iv: storedEmailUpdate.raw_body_iv,
    tag: storedEmailUpdate.raw_body_tag,
  }, LINK_SIGNING_SECRET);
  assert.equal(JSON.parse(emailRecoveryBody).message.text, '');
  assert.equal(emailRecoveryBody.includes(emailText), false);
  assert.notEqual(storedEmailUpdate.raw_body_sha256, sha256(emailBody));
  assert.equal(JSON.stringify(storedEmailUpdate).includes(emailText), false);
  assert.equal(invitation.status, 'completed');
  console.log(JSON.stringify({
    simulation: 'passed',
    scenario: { id: scenario.scenario_id, status: scenario.status },
    state: {
      membership: membership.ignored,
      paid_invitation: invitationResult.delivery,
      start: start.state,
      email: email.state,
      completion: completion.state,
      repeated_completion: repeatedCompletion.state,
      repeated_start: repeatedStart.state,
      free_form: freeForm.ignored,
    },
    telegram_recorder: {
      network_calls: 0,
      group_posts: telegram.messages.filter((message) => message.chat_id === TARGET_CHAT_ID).length,
      instruction_dms: telegram.messages.filter(
        (message) => message.text === scenario.messages.private_instruction.text,
      ).length,
      completion_dms: telegram.messages.filter(
        (message) => message.text === scenario.messages.completion_success.dm_text,
      ).length,
      callback_answers: telegram.callbacks.length,
    },
    privacy: {
      email_plaintext_retained: false,
      email_recovery_body: emailRecoveryBody,
      free_form_text_retained: false,
      recovery_body: recoveryBody,
    },
  }));
} finally {
  store.close();
}
