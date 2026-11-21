import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { parseStartCommand } from '../src/service.mjs';
import { generateToken, hashToken } from '../src/tokens.mjs';
import {
  ambiguousError, CHAT_ID, definiteError, harness, noRequestError, OTHER_CHAT_ID, passAll, T0,
} from './helpers.mjs';

const USER = 555001;
const OTHER_USER = 777002;
const DAY = 24 * 3600 * 1000;

let h;
afterEach(() => {
  h?.close();
  h = null;
});

function issue(siteRecordId = 'site-1') {
  const token = generateToken();
  h.store.insertIssuedToken({ tokenSha256: hashToken(token), siteRecordId, now: T0 });
  return token;
}

function texts() {
  return h.telegram.byMethod('sendMessage').map((c) => c.payload.text);
}

async function toProbation(user = {}) {
  h.telegram.failNext('sendMessage', definiteError());
  const result = await h.joinRequest({ user });
  assert.equal(result.action, 'probation');
  return result;
}

describe('parseStartCommand', () => {
  test('parses /start forms', () => {
    assert.equal(parseStartCommand('/start'), '');
    assert.equal(parseStartCommand('/start gate'), 'gate');
    assert.equal(parseStartCommand('/start@join_bot abc'), 'abc');
    assert.equal(parseStartCommand('hello'), null);
    assert.equal(parseStartCommand('/starting'), null);
  });
});

describe('tokens via /start', () => {
  test('issued token → verified, pending requests approved in every allowlisted chat, welcome DM with group link', async () => {
    h = harness({ targetChatIds: [String(CHAT_ID), String(OTHER_CHAT_ID)], groupLink: 'https://t.me/our_group' });
    const token = issue();
    // No pending request in the first chat: a normal no-op outcome.
    h.telegram.failNext('approveChatJoinRequest', noRequestError());
    const result = await h.say(`/start ${token}`);
    assert.equal(result.action, 'token_verified');
    assert.deepEqual(result.approvals, { [String(CHAT_ID)]: 'no_request', [String(OTHER_CHAT_ID)]: 'done' });
    assert.deepEqual(h.telegram.byMethod('approveChatJoinRequest').map((c) => c.payload),
      [{ chat_id: CHAT_ID, user_id: USER }, { chat_id: OTHER_CHAT_ID, user_id: USER }]);
    assert.equal(h.store.getToken(hashToken(token)).status, 'used');
    assert.equal(h.store.getToken(hashToken(token)).telegram_user_id, String(USER));
    assert.equal(h.store.getVerifiedMember(USER).site_record_id, 'site-1');
    const last = h.telegram.byMethod('sendMessage').at(-1).payload;
    assert.equal(last.chat_id, USER);
    assert.equal(last.text, `${h.scenario.messages.token_welcome}\n\nhttps://t.me/our_group`);
  });

  test('open questionnaire is closed as approved_token', async () => {
    h = harness();
    const { applicationId } = await h.joinRequest();
    const token = issue();
    const result = await h.say(`/start ${token}`);
    assert.equal(result.closed, 1);
    const stored = h.store.getApplication(applicationId);
    assert.equal(stored.state, 'approved_token');
    assert.equal(stored.telegram_action_state, 'done');
    assert.equal((await h.say('Да, хочу участвовать')).action, 'ignored_no_application');
  });

  test('same account again → already verified, no Telegram mutation', async () => {
    h = harness();
    const token = issue();
    await h.say(`/start ${token}`);
    const approvals = h.telegram.byMethod('approveChatJoinRequest').length;
    const again = await h.say(`/start ${token}`);
    assert.equal(again.action, 'token_already_verified');
    assert.equal(h.telegram.byMethod('approveChatJoinRequest').length, approvals);
    assert.equal(texts().at(-1), h.scenario.messages.token_already_verified);
  });

  test('another account reusing a used token → journal token_reuse + neutral reply, not verified', async () => {
    h = harness();
    const token = issue();
    await h.say(`/start ${token}`);
    const result = await h.say(`/start ${token}`, { userId: OTHER_USER });
    assert.equal(result.action, 'token_reuse');
    assert.equal(h.store.getVerifiedMember(OTHER_USER), null);
    const [entry] = h.store.listJournal('token_reuse');
    assert.equal(entry.site_record_id, 'site-1');
    assert.equal(entry.details.bound_user_id, String(USER));
    assert.equal(entry.details.attempted_user_id, String(OTHER_USER));
    assert.equal(texts().at(-1), h.scenario.messages.token_invalid);
    // Normal flow: the other account's join request gets the questionnaire.
    assert.equal((await h.joinRequest({ user: { id: OTHER_USER } })).action, 'asking');
  });

  test('revoked and unknown tokens → journal + same neutral reply', async () => {
    h = harness();
    const token = issue();
    h.store.revokeIssuedTokens('site-1', T0);
    assert.equal((await h.say(`/start ${token}`)).action, 'token_revoked_use');
    assert.equal((await h.say(`/start ${generateToken()}`)).action, 'token_unknown');
    assert.equal(h.store.listJournal('token_revoked_use').length, 1);
    assert.equal(h.store.listJournal('token_unknown').length, 1);
    assert.deepEqual(texts(), [h.scenario.messages.token_invalid, h.scenario.messages.token_invalid]);
    assert.equal(h.store.getVerifiedMember(USER), null);
  });

  test('verified member join request → approved_token, no questions, no screening except is_bot', async () => {
    h = harness();
    await h.say(`/start ${issue()}`);
    const sends = h.telegram.byMethod('sendMessage').length;
    const result = await h.joinRequest({ bio: 'crypto casino https://spam.example' });
    assert.equal(result.action, 'approved_token');
    assert.equal(h.store.getApplication(result.applicationId).state, 'approved_token');
    assert.equal(h.telegram.byMethod('sendMessage').length, sends, 'no questions');
    assert.equal(h.telegram.byMethod('getUserProfilePhotos').length, 0, 'no screening');
    const bot = await h.joinRequest({ user: { id: USER, is_bot: true }, chatId: CHAT_ID });
    assert.equal(bot.action, 'declined_screening', 'is_bot still blocks');
    assert.equal(bot.reason, 'R_SCAM');
  });

  test('token lifts probation → probation_passed reason token', async () => {
    h = harness();
    const { applicationId } = await toProbation();
    await h.say(`/start ${issue()}`);
    const stored = h.store.getApplication(applicationId);
    assert.equal(stored.state, 'probation_passed');
    assert.equal(stored.decision_reason, 'token');
    assert.equal(stored.restrict_state, 'lifted');
    const lift = h.telegram.byMethod('restrictChatMember').at(-1).payload;
    assert.ok(Object.values(lift.permissions).every((v) => v === true));
  });

  test('shadow mode: token binding recorded locally, zero Telegram writes', async () => {
    h = harness({ mode: 'shadow' });
    const token = issue();
    const result = await h.say(`/start ${token}`);
    assert.equal(result.action, 'token_verified');
    assert.equal(h.store.getVerifiedMember(USER).site_record_id, 'site-1');
    await h.say(`/start ${token}`, { userId: OTHER_USER });
    await h.say('/start gate');
    await h.joinRequest();
    assert.deepEqual(h.telegram.writes(), []);
  });
});

describe('probation', () => {
  test('DM failure + clean screening → approve + restrict (no sending) → probation with deadline', async () => {
    h = harness();
    const { applicationId } = await toProbation();
    const restrict = h.telegram.byMethod('restrictChatMember')[0].payload;
    assert.equal(restrict.chat_id, CHAT_ID);
    assert.equal(restrict.user_id, USER);
    assert.ok(Object.values(restrict.permissions).every((v) => v === false));
    const stored = h.store.getApplication(applicationId);
    assert.equal(stored.restrict_state, 'restricted');
    assert.equal(stored.probation_deadline_at, T0 + 7 * DAY);
  });

  test('ambiguous DM failure also → probation (dm_inconclusive)', async () => {
    h = harness();
    h.telegram.failNext('sendMessage', ambiguousError());
    const result = await h.joinRequest();
    assert.equal(result.action, 'probation');
    assert.equal(result.reason, 'dm_inconclusive');
  });

  test('approved but restriction unconfirmed is NOT probation: it joins the visible discrepancy queue', async () => {
    h = harness();
    h.telegram.failNext('sendMessage', definiteError());
    h.telegram.failNext('restrictChatMember', ambiguousError('restrictChatMember'));
    const result = await h.joinRequest();
    assert.equal(result.action, 'restrict_unconfirmed');
    const stored = h.store.getApplication(result.applicationId);
    assert.equal(stored.state, 'manual_review');
    assert.equal(stored.decision_reason, 'restrict_unconfirmed');
    assert.equal(stored.telegram_action_state, 'inconclusive');
    assert.equal(stored.restrict_state, 'inconclusive');
    assert.deepEqual(h.store.listRestrictionDiscrepancies().map((a) => a.id), [result.applicationId]);
    assert.equal(h.store.countByState().probation, undefined);
    assert.deepEqual(h.store.admissionMetrics(), {
      approved: 1, restriction_confirmed: 0, can_ask_first_question: 0, restriction_unconfirmed: 1,
    });
    // Not retried blindly; /start does not run a questionnaire for it; expiry does not remove it.
    assert.equal(h.telegram.byMethod('restrictChatMember').length, 1);
    assert.equal((await h.say('/start gate')).action, 'start_info');
    h.clock.now = T0 + 30 * DAY;
    const sweep = await h.service.sweep();
    assert.equal(sweep.probationExpired, 0);
    assert.equal(h.telegram.byMethod('banChatMember').length, 0);
    // Retention keeps the discrepancy visible with its identity.
    assert.deepEqual(h.store.listRestrictionDiscrepancies().map((a) => a.id), [result.applicationId]);
  });

  test('definite restrict failure also goes to the discrepancy queue', async () => {
    h = harness();
    h.telegram.failNext('sendMessage', definiteError());
    h.telegram.failNext('restrictChatMember', definiteError('restrictChatMember'));
    const result = await h.joinRequest();
    assert.equal(result.action, 'restrict_unconfirmed');
    assert.equal(h.store.getApplication(result.applicationId).restrict_state, 'failed');
  });

  test('a verified token releases a restriction discrepancy by lifting (idempotent), not merely closing it', async () => {
    h = harness();
    h.telegram.failNext('sendMessage', definiteError());
    h.telegram.failNext('restrictChatMember', ambiguousError('restrictChatMember'));
    const { applicationId } = await h.joinRequest();
    const result = await h.say(`/start ${issue()}`);
    assert.equal(result.lifted, 1);
    assert.equal(result.closed, 0);
    const stored = h.store.getApplication(applicationId);
    assert.equal(stored.state, 'probation_passed');
    assert.equal(stored.restrict_state, 'lifted');
    assert.deepEqual(h.store.listRestrictionDiscrepancies(), []);
  });

  test('legacy probation rows with an unconfirmed restriction are listed in the queue', async () => {
    h = harness();
    const { applicationId } = await toProbation();
    h.store.updateApplication(applicationId, { restrict_state: 'inconclusive' });
    assert.deepEqual(h.store.listRestrictionDiscrepancies().map((a) => a.id), [applicationId]);
  });

  test('admission metrics count approved, restriction confirmed and can-ask separately', async () => {
    h = harness();
    const first = await toProbation();
    await toProbation({ id: OTHER_USER });
    assert.deepEqual(h.store.admissionMetrics(), {
      approved: 2, restriction_confirmed: 2, can_ask_first_question: 0, restriction_unconfirmed: 0,
    });
    await h.service.passProbation(h.store.getApplication(first.applicationId), 'answers_passed');
    assert.deepEqual(h.store.admissionMetrics(), {
      approved: 2, restriction_confirmed: 2, can_ask_first_question: 1, restriction_unconfirmed: 0,
    });
  });

  test('approve failure on probation entry → manual_review, no restrict', async () => {
    h = harness();
    h.telegram.failNext('sendMessage', definiteError());
    h.telegram.failNext('approveChatJoinRequest', definiteError('approveChatJoinRequest'));
    const result = await h.joinRequest();
    assert.equal(result.action, 'manual_review');
    assert.equal(h.telegram.byMethod('restrictChatMember').length, 0);
  });

  test('/start gate → intro + questions → pass lifts restriction + welcome DM', async () => {
    h = harness();
    const { applicationId } = await toProbation();
    const started = await h.say('/start gate');
    assert.equal(started.action, 'questionnaire_started');
    assert.deepEqual(texts().slice(-2), [h.scenario.messages.probation_intro, h.scenario.messages.q_participate]);
    assert.equal((await h.press('participate', 'yes')).action, 'asked');
    assert.equal((await h.press('rules', 'agree')).action, 'asked');
    // No 5-minute rule: answering much later still works.
    h.clock.now += 3 * DAY;
    await h.press('topics', 'careers');
    const done = await h.press('topics', 'done');
    assert.equal(done.action, 'probation_passed');
    const stored = h.store.getApplication(applicationId);
    assert.equal(stored.state, 'probation_passed');
    assert.equal(stored.restrict_state, 'lifted');
    const lift = h.telegram.byMethod('restrictChatMember').at(-1).payload;
    assert.ok(Object.values(lift.permissions).every((v) => v === true));
    assert.equal(texts().at(-1), h.scenario.messages.probation_passed);
    assert.equal(h.telegram.byMethod('banChatMember').length, 0);
  });

  test('bare /start also starts the probation questionnaire', async () => {
    h = harness();
    await toProbation();
    assert.equal((await h.say('/start')).action, 'questionnaire_started');
  });

  test('failing probation → ban then unban(only_if_banned) → probation_removed + polite DM', async () => {
    h = harness();
    const { applicationId } = await toProbation();
    await h.say('/start gate');
    const done = await h.press('participate', 'no');
    assert.equal(done.action, 'probation_removed');
    assert.equal(done.reason, 'R_READER');
    assert.equal(h.store.getApplication(applicationId).decision_reason, 'R_READER');
    assert.deepEqual(h.telegram.byMethod('banChatMember').map((c) => c.payload), [{ chat_id: CHAT_ID, user_id: USER }]);
    assert.deepEqual(h.telegram.byMethod('unbanChatMember').map((c) => c.payload),
      [{ chat_id: CHAT_ID, user_id: USER, only_if_banned: true }]);
    assert.equal(h.store.getApplication(applicationId).state, 'probation_removed');
    assert.equal(texts().at(-1), h.scenario.messages.probation_removed);
    assert.equal(h.telegram.byMethod('declineChatJoinRequest').length, 0);
  });

  test('probation expiry sweep → removal; DM only when conversation open', async () => {
    h = harness();
    const silent = await toProbation();
    const talked = await toProbation({ id: OTHER_USER });
    await h.say('/start gate', { userId: OTHER_USER });
    await h.press('participate', 'yes', { userId: OTHER_USER });
    h.clock.now = T0 + 7 * DAY - 1;
    assert.equal((await h.service.sweep()).probationExpired, 0);
    const sendsBefore = h.telegram.byMethod('sendMessage').length;
    h.clock.now = T0 + 7 * DAY + 1;
    const result = await h.service.sweep();
    assert.equal(result.probationExpired, 2);
    for (const id of [silent.applicationId, talked.applicationId]) {
      const stored = h.store.getApplication(id);
      assert.equal(stored.state, 'probation_removed');
      assert.equal(stored.decision_reason, 'probation_expired');
    }
    assert.equal(h.telegram.byMethod('banChatMember').length, 2);
    const newSends = h.telegram.byMethod('sendMessage').slice(sendsBefore);
    assert.deepEqual(newSends.map((c) => [c.payload.chat_id, c.payload.text]),
      [[OTHER_USER, h.scenario.messages.probation_removed]]);
  });

  test('/start from DM-failure manual_review runs that questionnaire → approve', async () => {
    h = harness();
    h.telegram.failNext('sendMessage', definiteError());
    h.telegram.failNext('approveChatJoinRequest', definiteError('approveChatJoinRequest'));
    const { applicationId } = await h.joinRequest();
    assert.equal(h.store.getApplication(applicationId).state, 'manual_review');
    assert.equal((await h.say('/start')).action, 'questionnaire_started');
    assert.equal(texts().at(-2), h.scenario.messages.greeting);
    const done = await passAll(h);
    assert.equal(done.action, 'approved');
    assert.equal(h.store.getApplication(applicationId).state, 'approved');
    assert.equal((await h.say('/start')).action, 'start_info', 'questionnaire not repeated');
  });

  test('/start from DM-failure manual_review: rejecting answer → decline with its code', async () => {
    h = harness();
    h.telegram.failNext('sendMessage', definiteError());
    h.telegram.failNext('approveChatJoinRequest', definiteError('approveChatJoinRequest'));
    const { applicationId } = await h.joinRequest();
    await h.say('/start');
    await h.press('participate', 'yes');
    const done = await h.press('rules', 'disagree');
    assert.equal(done.reason, 'R_RULES');
    const stored = h.store.getApplication(applicationId);
    assert.equal(stored.state, 'declined_answers');
    assert.equal(stored.decision_reason, 'R_RULES');
  });

  test('restarted probation questionnaire ignores topic toggles of the earlier run', async () => {
    h = harness();
    await toProbation();
    await h.say('/start gate');
    await h.press('participate', 'yes');
    await h.press('rules', 'agree');
    await h.press('topics', 'agents');
    // The DM of the next step fails → questionnaire closed, probation kept.
    h.telegram.failNext('sendMessage', definiteError());
    assert.equal((await h.press('topics', 'custom')).action, 'questionnaire_dm_failed');
    await h.say('/start gate');
    await h.press('participate', 'yes');
    await h.press('rules', 'agree');
    assert.equal((await h.press('topics', 'done')).action, 'topics_empty', 'earlier selection does not carry over');
  });

  test('/start with nothing pending → info text', async () => {
    h = harness();
    assert.equal((await h.say('/start')).action, 'start_info');
    assert.deepEqual(texts(), [h.scenario.messages.start_info]);
  });

  test('shadow mode: probation paths make zero Telegram writes', async () => {
    h = harness({ mode: 'shadow' });
    await h.joinRequest({ userChatId: null });
    // A probation record (e.g. from a confirmed triage run) in shadow mode:
    h.store.createApplication({
      chatId: String(CHAT_ID), userId: String(OTHER_USER), state: 'probation', now: T0,
      extra: { probation_deadline_at: T0 + DAY, restrict_state: 'restricted' },
    });
    await h.say('/start gate', { userId: OTHER_USER });
    h.clock.now = T0 + 2 * DAY;
    const sweep = await h.service.sweep();
    assert.equal(sweep.probationExpired, 0);
    assert.deepEqual(h.telegram.writes(), []);
  });
});
