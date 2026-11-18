import {
  decideAnswers, evaluateChoice, evaluateCustomTopic, TOPIC_ROW, topicState,
} from './answers.mjs';
import { parseCallbackData, reasonText } from './scenario.mjs';
import { precheckApplicant } from './screening.mjs';
import { isAmbiguousTelegramError, isNoRequestError, permissions } from './telegram-api.mjs';
import { hashToken, isTokenFormat } from './tokens.mjs';

const SILENT_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });
const MAX_STORED_ANSWER_CHARS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Marker row in join_answers: answers before it belong to an earlier run of
// the questionnaire (e.g. a probation questionnaire restarted via /start).
const QUESTIONNAIRE_START = 'questionnaire_start';
const SELECTED_MARK = '✅ ';
const START_RE = /^\/start(?:@[A-Za-z0-9_]{1,64})?(?:\s+(\S+))?\s*$/;

// Returns the /start payload ('' for bare /start) or null if not /start.
export function parseStartCommand(text) {
  if (typeof text !== 'string') return null;
  const match = START_RE.exec(text.trim());
  if (!match) return null;
  return match[1] ?? '';
}

export class NonPrivateChatError extends Error {
  constructor(chatId) {
    super(`refusing to send a message to non-private chat ${chatId}`);
    this.name = 'NonPrivateChatError';
  }
}

// The group is a showcase: the bot only ever writes to a private chat, whose
// id is a positive integer. Group/supergroup/channel ids are negative.
export function assertPrivateChatId(chatId) {
  if (!/^[1-9]\d*$/.test(String(chatId))) throw new NonPrivateChatError(chatId);
}

function telegramUserId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`invalid Telegram user id ${value}`);
  return id;
}

function telegramChatId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error(`invalid Telegram chat id ${value}`);
  return id;
}

export class JoinGatekeeperService {
  constructor({ config, store, telegram, scenario = config.scenario, now = () => Date.now(), logger = SILENT_LOGGER }) {
    if (!scenario) throw new Error('JoinGatekeeperService requires a scenario');
    this.config = config;
    this.store = store;
    this.telegram = telegram;
    this.scenario = scenario;
    this.now = now;
    this.logger = logger;
    this.allowlist = new Set(config.targetChatIds.map(String));
    this.enforce = config.mode === 'enforce';
    this.locks = new Map();
  }

  // ---------------------------------------------------------------- routing

  async handleUpdate(update) {
    if (!update || typeof update !== 'object' || !Number.isSafeInteger(update.update_id)) {
      return { action: 'invalid_update' };
    }
    if (!this.store.claimUpdate(update.update_id, this.now())) return { action: 'duplicate_update' };
    if (update.chat_join_request) return this.handleJoinRequest(update.chat_join_request);
    if (update.callback_query) return this.handleCallbackQuery(update.callback_query);
    if (update.message) return this.handleMessage(update.message);
    return { action: 'ignored_update_type' };
  }

  async withUserLock(userId, fn) {
    const key = String(userId);
    const previous = this.locks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  // ------------------------------------------------------- telegram helpers

  async sendDm(chatId, payload) {
    assertPrivateChatId(chatId);
    try {
      await this.telegram.sendMessage({ chat_id: Number(chatId), ...payload });
      return { ok: true };
    } catch (error) {
      const ambiguous = isAmbiguousTelegramError(error);
      this.logger.warn('dm_send_failed', { ambiguous, error: error.message });
      return { ok: false, ambiguous };
    }
  }

  // Join-request mutation; returns telegram_action_state. Never retried in a loop.
  async mutateRequest(method, application) {
    try {
      await this.telegram[method]({
        chat_id: telegramChatId(application.chat_id),
        user_id: telegramUserId(application.user_id),
      });
      return 'done';
    } catch (error) {
      const state = isAmbiguousTelegramError(error) ? 'inconclusive' : 'failed';
      this.logger.warn('join_request_mutation_failed', {
        method, application_id: application.id, state, error: error.message,
      });
      return state;
    }
  }

  // Chat-member action (restrict/ban/unban); returns done|failed|inconclusive.
  async memberAction(method, chatId, userId, extra = {}) {
    try {
      await this.telegram[method]({ chat_id: telegramChatId(chatId), user_id: telegramUserId(userId), ...extra });
      return 'done';
    } catch (error) {
      const state = isAmbiguousTelegramError(error) ? 'inconclusive' : 'failed';
      this.logger.error('member_action_failed', { method, chat_id: String(chatId), user_id: String(userId), state, error: error.message });
      return state;
    }
  }

  restrict(chatId, userId) {
    return this.memberAction('restrictChatMember', chatId, userId, {
      permissions: permissions(false), use_independent_chat_permissions: true,
    });
  }

  liftRestriction(chatId, userId) {
    return this.memberAction('restrictChatMember', chatId, userId, {
      permissions: permissions(true), use_independent_chat_permissions: true,
    });
  }

  // Removal that still lets the person request again (contract v2 §2).
  async removeMember(chatId, userId) {
    const ban = await this.memberAction('banChatMember', chatId, userId);
    if (ban !== 'done') return ban;
    const unban = await this.memberAction('unbanChatMember', chatId, userId, { only_if_banned: true });
    if (unban !== 'done') this.logger.error('unban_after_removal_failed', { chat_id: String(chatId), user_id: String(userId), state: unban });
    return unban;
  }

  // approveChatJoinRequest by chat+user; 'no_request' is a normal outcome.
  async approveByUser(chatId, userId) {
    try {
      await this.telegram.approveChatJoinRequest({ chat_id: telegramChatId(chatId), user_id: telegramUserId(userId) });
      return 'done';
    } catch (error) {
      if (isNoRequestError(error)) return 'no_request';
      const state = isAmbiguousTelegramError(error) ? 'inconclusive' : 'failed';
      this.logger.warn('approve_by_user_failed', { chat_id: String(chatId), user_id: String(userId), state, error: error.message });
      return state;
    }
  }

  // Inline keyboard of a question. For multi_choice, `selected` topic ids are
  // marked; "add your own" and "done" go last.
  questionKeyboard(question, selected = []) {
    if (question.type === 'choice') {
      return { inline_keyboard: question.options.map((option) => [{ text: option.label, callback_data: option.callbackData }]) };
    }
    return {
      inline_keyboard: [
        ...question.options.map((option) => [{
          text: `${selected.includes(option.id) ? SELECTED_MARK : ''}${option.label}`, callback_data: option.callbackData,
        }]),
        [{ text: question.custom.label, callback_data: question.custom.callbackData }],
        [{ text: question.done.label, callback_data: question.done.callbackData }],
      ],
    };
  }

  questionPayload(question, selected = []) {
    return { text: question.promptText, reply_markup: this.questionKeyboard(question, selected) };
  }

  // Answers of the current questionnaire run (after the last start marker).
  currentAnswers(applicationId) {
    const rows = this.store.listAnswers(applicationId);
    let from = 0;
    rows.forEach((row, index) => { if (row.reason === QUESTIONNAIRE_START) from = index + 1; });
    return rows.slice(from);
  }

  // The bot message whose button was pressed — the place where the next step
  // is shown. null when the update is not a button press in a private chat.
  originOf(message) {
    const chatId = message?.chat?.id;
    const messageId = message?.message_id;
    if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(messageId)) return null;
    return { chatId, messageId };
  }

  // Shows the next step of a questionnaire. After a button press the pressed
  // message is edited in place: Telegram may refuse a NEW message to a user
  // who never wrote to the bot ("bot can't initiate conversation", prod
  // 18.11 — 14 of 15 people stuck after the first answer), while editing the
  // bot's own message is always allowed. Edit failure → a new message.
  async deliver(app, payload, origin = null) {
    if (origin) {
      try {
        await this.telegram.editMessageText({
          chat_id: origin.chatId, message_id: origin.messageId, text: payload.text,
          ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}),
        });
        return { ok: true, edited: true };
      } catch (error) {
        if (/message is not modified/i.test(error.message)) return { ok: true, edited: true };
        this.logger.warn('edit_message_failed', { application_id: app.id, error: error.message });
      }
    }
    if (!Number.isSafeInteger(Number(app.user_chat_id)) || Number(app.user_chat_id) <= 0) return { ok: false, ambiguous: false };
    return this.sendDm(app.user_chat_id, payload);
  }

  // Sends a sequence of DMs; stops at the first failure.
  async sendSequence(chatId, payloads) {
    for (const payload of payloads) {
      const result = await this.sendDm(chatId, payload);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  // DM could not be delivered.
  // - questionnaire started via /start (probation / manual_review): the
  //   application keeps its state, the questionnaire is closed;
  // - new request with clean screening: approve + restrict → probation
  //   (contract v2 §2, overrides v1 manual_review);
  // - otherwise the request stays pending for an admin (manual_review).
  // Never a silent decline (contract v1 §4, unacceptable outcome 1).
  async onDmFailure(application, result, { missingChat = false } = {}) {
    const reason = missingChat ? 'missing_user_chat_id' : (result.ambiguous ? 'dm_inconclusive' : 'dm_failed');
    if (application.state === 'probation' || application.state === 'manual_review') {
      this.store.updateApplication(application.id, { questionnaire_state: 'none' });
      this.logger.warn('questionnaire_dm_failed', { application_id: application.id, reason });
      return { action: 'questionnaire_dm_failed', reason, applicationId: application.id };
    }
    if (application.screening_verdict === 'clean') return this.enterProbation(application, reason);
    this.logger.info('manual_review', { application_id: application.id, reason });
    this.store.updateApplication(application.id, {
      state: 'manual_review',
      dm_state: missingChat ? application.dm_state : 'failed',
      decided_at: this.now(),
      decision_reason: reason,
      questionnaire_state: 'none',
    });
    return { action: 'manual_review', reason, applicationId: application.id };
  }

  // approve + restrict → probation. If approve does not succeed, the request
  // stays pending with an admin (manual_review, same DM-failure reason, so a
  // later /start can still run the questionnaire).
  async enterProbation(application, reason) {
    const now = this.now();
    const approve = await this.mutateRequest('approveChatJoinRequest', application);
    if (approve !== 'done') {
      this.store.updateApplication(application.id, {
        state: 'manual_review', dm_state: 'failed', decided_at: now, decision_reason: reason,
        telegram_action_state: approve, questionnaire_state: 'none',
      });
      this.logger.warn('probation_approve_failed', { application_id: application.id, reason, state: approve });
      return { action: 'manual_review', reason, applicationId: application.id, telegramActionState: approve };
    }
    const restricted = await this.restrict(application.chat_id, application.user_id);
    this.store.updateApplication(application.id, {
      state: 'probation',
      dm_state: reason === 'missing_user_chat_id' ? application.dm_state : 'failed',
      decided_at: now,
      decision_reason: reason,
      telegram_action_state: restricted,
      restrict_state: restricted === 'done' ? 'restricted' : restricted,
      probation_deadline_at: now + this.scenario.limits.probationDays * DAY_MS,
      questionnaire_state: 'none',
    });
    if (restricted !== 'done') {
      // The person is in the group WITHOUT restriction: operator must check.
      this.logger.error('probation_restrict_failed', {
        application_id: application.id, chat_id: application.chat_id, user_id: application.user_id, state: restricted,
      });
    }
    return { action: 'probation', reason, applicationId: application.id, restrictState: restricted };
  }

  // ----------------------------------------------------------- join request

  async handleJoinRequest(request) {
    const chatId = String(request?.chat?.id ?? '');
    if (!this.allowlist.has(chatId)) return { action: 'ignored_chat' };
    const from = request.from;
    if (!from || !Number.isSafeInteger(from.id) || from.id <= 0) return { action: 'invalid_request' };
    return this.withUserLock(from.id, () => this.processJoinRequest(chatId, request));
  }

  async processJoinRequest(chatId, request) {
    const { from } = request;
    const userId = String(from.id);
    const now = this.now();
    const { limits, messages } = this.scenario;
    const snapshot = {
      chatId,
      userId,
      username: typeof from.username === 'string' ? from.username : null,
      firstName: typeof from.first_name === 'string' ? from.first_name : null,
      lastName: typeof from.last_name === 'string' ? from.last_name : null,
    };

    if (this.store.findActiveApplication(chatId, userId)) {
      this.logger.info('duplicate_application', { chat_id: chatId, user_id: userId });
      return { action: 'duplicate_application' };
    }

    // Verified member (token): approve at once, only is_bot is screened (v2 §1).
    const verified = this.store.getVerifiedMember(userId);
    if (verified && from.is_bot !== true) return this.approveVerifiedRequest(snapshot, verified, now);

    const userChatId = request.user_chat_id ?? null;

    // Pre-questionnaire checks (A0-bis). Precedence:
    // R_RATE → R_SCAM → R_PROFILE_AD → R_STOPWORD.
    if (this.store.countApplicationsLastDay(userId, now) >= limits.maxApplicationsPerUserPerDay) {
      return this.declineBeforeQuestionnaire(snapshot, userChatId, 'R_RATE', 'declined_rate_limit', null, now);
    }
    let precheck = from.is_bot === true ? precheckApplicant({ from }, this.scenario) : null;
    if (!precheck) {
      // Best-effort reads (allowed in shadow mode); failure = unknown.
      const profile = await this.profileInfo(from.id);
      const photoCount = await this.profilePhotoCount(from.id);
      precheck = precheckApplicant({
        from,
        bio: typeof request.bio === 'string' ? request.bio : profile.bio,
        personalChat: profile.personalChat,
        photoCount,
      }, this.scenario);
    }
    if (precheck.reason) {
      return this.declineBeforeQuestionnaire(snapshot, userChatId, precheck.reason, 'declined_screening', precheck, now);
    }
    const reasons = [...precheck.signals, ...precheck.info];

    if (!this.enforce) {
      const decision = 'would_start_questionnaire';
      const app = this.store.createApplication({
        ...snapshot,
        state: 'shadow_logged',
        screeningVerdict: 'clean',
        screeningReasons: reasons,
        userChatId,
        now,
        decidedAt: now,
        decisionReason: decision,
      });
      this.logger.info('shadow_decision', { application_id: app.id, decision, info: precheck.info });
      return { action: 'shadow_logged', decision, applicationId: app.id };
    }

    const app = this.store.createApplication({
      ...snapshot,
      state: 'screening',
      screeningVerdict: 'clean',
      screeningReasons: reasons,
      userChatId,
      now,
    });
    if (!app) return { action: 'duplicate_application' };
    this.logger.info('screened', { application_id: app.id, reason: null, info: precheck.info });

    if (!Number.isSafeInteger(request.user_chat_id) || request.user_chat_id <= 0) {
      return this.onDmFailure(app, { ambiguous: false }, { missingChat: true });
    }

    const firstQuestion = this.scenario.questions[0];
    const sent = await this.sendSequence(app.user_chat_id, [
      { text: messages.greeting },
      this.questionPayload(firstQuestion),
    ]);
    if (!sent.ok) return this.onDmFailure(app, sent);

    this.store.updateApplication(app.id, {
      state: 'asking',
      question_index: 0,
      retries_used: 0,
      dm_state: 'sent',
      deadline_at: now + limits.answerTimeoutSeconds * 1000,
    });
    return { action: 'asking', applicationId: app.id, verdict: 'clean' };
  }

  // Pre-check decline (R_RATE / R_SCAM / R_PROFILE_AD / R_STOPWORD): no
  // questionnaire. Shadow: record + log only. Enforce: reason DM first, then
  // decline (user_chat_id stops working once the request is processed).
  async declineBeforeQuestionnaire(snapshot, userChatId, code, state, precheck, now) {
    const signals = precheck ? precheck.signals : [];
    const screening = precheck
      ? { screeningVerdict: 'block', screeningReasons: [...precheck.signals, ...precheck.info] }
      : {};
    if (!this.enforce) {
      const app = this.store.createApplication({
        ...snapshot, ...screening, state: 'shadow_logged', userChatId, now, decidedAt: now, decisionReason: code,
      });
      this.logger.info('shadow_decision', { application_id: app.id, decision: 'would_decline', reason: code, signals });
      return { action: 'shadow_logged', decision: 'would_decline', reason: code, applicationId: app.id };
    }
    const app = this.store.createApplication({
      ...snapshot, ...screening, state, userChatId, now, decidedAt: now, decisionReason: code,
    });
    this.logger.info('screened', { application_id: app.id, reason: code, signals });
    return this.declineWithReason(app, code, state);
  }

  // Decline with exactly one reason code. The reason DM goes BEFORE
  // declineChatJoinRequest: an unopened private chat (user_chat_id) can no
  // longer be written to once the request is processed.
  async declineWithReason(app, code, state, origin = null) {
    const update = {};
    if (origin || (Number.isSafeInteger(Number(app.user_chat_id)) && Number(app.user_chat_id) > 0)) {
      const sent = await this.deliver(app, { text: reasonText(this.scenario, code) }, origin);
      if (app.dm_state === 'none') update.dm_state = sent.ok ? 'sent' : 'failed';
    }
    const actionState = await this.mutateRequest('declineChatJoinRequest', app);
    this.store.updateApplication(app.id, {
      ...update,
      state,
      decided_at: this.now(),
      decision_reason: code,
      telegram_action_state: actionState,
      questionnaire_state: 'none',
    });
    this.logger.info('declined', { application_id: app.id, reason: code, state, telegram_action_state: actionState });
    return { action: state, reason: code, applicationId: app.id, telegramActionState: actionState };
  }

  async approveVerifiedRequest(snapshot, verified, now) {
    if (!this.enforce) {
      const app = this.store.createApplication({
        ...snapshot, state: 'shadow_logged', now, decidedAt: now, decisionReason: 'would_approve_token',
      });
      this.logger.info('shadow_decision', { application_id: app.id, decision: 'would_approve', reason: 'token' });
      return { action: 'shadow_logged', decision: 'would_approve_token', applicationId: app.id };
    }
    const app = this.store.createApplication({
      ...snapshot, state: 'approved_token', now, decidedAt: now, decisionReason: 'token',
    });
    const actionState = await this.mutateRequest('approveChatJoinRequest', app);
    if (actionState === 'done') {
      this.store.updateApplication(app.id, { telegram_action_state: 'done' });
      this.logger.info('approved_token', { application_id: app.id, site_record_id: verified.site_record_id });
      return { action: 'approved_token', applicationId: app.id };
    }
    const reason = actionState === 'failed' ? 'token_approve_failed' : 'token_approve_inconclusive';
    this.store.updateApplication(app.id, { state: 'manual_review', decision_reason: reason, telegram_action_state: actionState });
    return { action: 'manual_review', reason, applicationId: app.id };
  }

  // getChat(user_id) → { personalChat: true|false|null, bio: string|null }.
  // Failure or absence = unknown, never a signal.
  async profileInfo(userId) {
    try {
      const chat = await this.telegram.getChat({ chat_id: userId });
      if (!chat || typeof chat !== 'object') return { personalChat: null, bio: null };
      return {
        personalChat: chat.personal_chat && typeof chat.personal_chat === 'object' ? true : false,
        bio: typeof chat.bio === 'string' ? chat.bio : null,
      };
    } catch (error) {
      this.logger.warn('profile_info_unknown', { error: error.message });
      return { personalChat: null, bio: null };
    }
  }

  async profilePhotoCount(userId) {
    try {
      const result = await this.telegram.getUserProfilePhotos({ user_id: userId, limit: 1 });
      return Number.isSafeInteger(result?.total_count) ? result.total_count : null;
    } catch (error) {
      this.logger.warn('profile_photos_unknown', { error: error.message });
      return null;
    }
  }

  // ------------------------------------------------------------ answers

  async handleMessage(message) {
    if (message?.chat?.type !== 'private') return { action: 'ignored_non_private' };
    const from = message.from;
    if (!from || from.is_bot || !Number.isSafeInteger(from.id) || from.id <= 0) return { action: 'ignored_sender' };
    const text = typeof message.text === 'string' ? message.text : null;
    const startPayload = parseStartCommand(text);
    if (startPayload !== null) {
      const chatId = message.chat.id;
      if (!Number.isSafeInteger(chatId) || chatId <= 0) return { action: 'ignored_sender' };
      return this.withUserLock(from.id, () => this.handleStart(from.id, chatId, startPayload));
    }
    if (!this.store.findAskingByUser(from.id)) return { action: 'ignored_no_application' };
    return this.withUserLock(from.id, async () => {
      const app = this.store.findAskingByUser(from.id);
      if (!app) return { action: 'ignored_no_application' };
      return this.processAnswer(app, { text }, text);
    });
  }

  async handleCallbackQuery(query) {
    if (!this.enforce) return { action: 'ignored_shadow' };
    const from = query?.from;
    if (!from || !Number.isSafeInteger(from.id)) return { action: 'ignored_sender' };
    const parsed = parseCallbackData(query.data);
    let result = { action: 'ignored_callback' };
    try {
      if (parsed) {
        result = await this.withUserLock(from.id, async () => {
          const app = this.store.findAskingByUser(from.id);
          if (!app) return { action: 'ignored_no_application' };
          const question = this.scenario.questions[app.question_index];
          if (!question || question.id !== parsed.questionId) return { action: 'ignored_stale_callback' };
          const origin = this.originOf(query.message);
          if (question.type === 'multi_choice') return this.processTopicButton(app, question, parsed.optionId, query.message, origin);
          return this.processAnswer(app, { optionId: parsed.optionId }, `option:${parsed.optionId}`, origin);
        });
      }
    } finally {
      try {
        await this.telegram.answerCallbackQuery({
          callback_query_id: String(query.id), ...(result?.notice ? { text: result.notice } : {}),
        });
      } catch (error) {
        this.logger.warn('answer_callback_failed', { error: error.message });
      }
    }
    return result;
  }

  openConversation(app) {
    return app.conversation_open ? app : this.store.updateApplication(app.id, { conversation_open: 1 });
  }

  // A typed message or a pressed button on a choice question.
  async processAnswer(app, input, storedText, origin = null) {
    const now = this.now();
    app = this.openConversation(app);
    const question = this.scenario.questions[app.question_index];
    if (!question) return this.finalize(app, origin);
    if (question.type === 'multi_choice') return this.processTopicText(app, question, input.text);

    const result = evaluateChoice(question, input);
    this.store.addAnswer({
      applicationId: app.id,
      questionId: question.id,
      text: typeof storedText === 'string' ? storedText.slice(0, MAX_STORED_ANSWER_CHARS) : null,
      pass: result.pass,
      reason: result.reason,
      now,
    });
    if (result.reason === 'no_matching_option' || result.reason === 'unknown_option') {
      // Not an answer: show the question again (no extra text).
      const sent = await this.deliver(app, this.questionPayload(question), origin);
      if (!sent.ok) return this.onDmFailure(app, sent);
      return { action: 'reasked', applicationId: app.id, questionId: question.id };
    }
    if (!result.pass) return this.failQuestionnaire(app, result.reason, origin);
    return this.advance(app, origin);
  }

  async advance(app, origin = null) {
    const nextIndex = app.question_index + 1;
    app = this.store.updateApplication(app.id, { question_index: nextIndex, retries_used: 0 });
    if (nextIndex < this.scenario.questions.length) {
      const next = this.scenario.questions[nextIndex];
      const sent = await this.deliver(app, this.questionPayload(next), origin);
      if (!sent.ok) return this.onDmFailure(app, sent);
      return { action: 'asked', applicationId: app.id, questionId: next.id };
    }
    return this.finalize(app, origin);
  }

  // Buttons of the multi_choice (topics) question.
  async processTopicButton(app, question, optionId, message, origin = null) {
    const now = this.now();
    app = this.openConversation(app);
    if (optionId === question.done.id) {
      const state = topicState(question, this.currentAnswers(app.id));
      if (!state.satisfied) {
        return { action: 'topics_empty', applicationId: app.id, notice: this.scenario.messages[question.done.emptyNotice] };
      }
      this.store.addAnswer({
        applicationId: app.id,
        questionId: question.id,
        text: `selected:${state.selected.join(',')};custom:${state.custom}`,
        pass: true,
        reason: TOPIC_ROW.done,
        now,
      });
      return this.advance(app, origin);
    }
    if (optionId === question.custom.id) {
      // Prompt goes under the question; the keyboard stays so «Готово» works.
      const state = topicState(question, this.currentAnswers(app.id));
      const payload = origin
        ? { text: `${question.promptText}\n\n${this.scenario.messages[question.custom.prompt]}`, reply_markup: this.questionKeyboard(question, state.selected) }
        : { text: this.scenario.messages[question.custom.prompt] };
      const sent = await this.deliver(app, payload, origin);
      if (!sent.ok) return this.onDmFailure(app, sent);
      return { action: 'custom_topic_prompt', applicationId: app.id };
    }
    if (!question.options.some((option) => option.id === optionId)) return { action: 'ignored_callback' };
    this.store.addAnswer({ applicationId: app.id, questionId: question.id, text: optionId, pass: true, reason: TOPIC_ROW.toggle, now });
    const state = topicState(question, this.currentAnswers(app.id));
    await this.editKeyboard(message, this.questionKeyboard(question, state.selected));
    return { action: 'topic_toggled', applicationId: app.id, selected: state.selected };
  }

  // Re-render the keyboard of the question message; failure is not fatal.
  async editKeyboard(message, replyMarkup) {
    const chatId = message?.chat?.id;
    const messageId = message?.message_id;
    if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(messageId)) return 'skipped';
    try {
      await this.telegram.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
      return 'done';
    } catch (error) {
      this.logger.warn('edit_keyboard_failed', { error: error.message });
      return 'failed';
    }
  }

  // Free text while on the topics question = the user's own topic.
  async processTopicText(app, question, text) {
    const now = this.now();
    const evaluation = evaluateCustomTopic(question, typeof text === 'string' ? text : '', this.scenario);
    if (evaluation.kind === 'reject') {
      this.store.addAnswer({
        applicationId: app.id, questionId: question.id, text: text.slice(0, MAX_STORED_ANSWER_CHARS), pass: false,
        reason: evaluation.reason, now,
      });
      return this.failQuestionnaire(app, evaluation.reason);
    }
    if (evaluation.kind === 'accept') {
      this.store.addAnswer({
        applicationId: app.id, questionId: question.id, text: text.slice(0, MAX_STORED_ANSWER_CHARS), pass: true,
        reason: TOPIC_ROW.custom, now,
      });
    }
    // Keep the topics keyboard at hand so the user can press «Готово».
    const state = topicState(question, this.currentAnswers(app.id));
    const sent = await this.sendDm(app.user_chat_id, this.questionPayload(question, state.selected));
    if (!sent.ok) return this.onDmFailure(app, sent);
    return {
      action: evaluation.kind === 'accept' ? 'custom_topic_added' : 'topic_ignored',
      applicationId: app.id,
      ...(evaluation.kind === 'ignore' ? { reason: evaluation.reason } : {}),
    };
  }

  // An answer that declines with its own reason code.
  async failQuestionnaire(app, code, origin = null) {
    if (app.state === 'probation') return this.finalizeProbation(app, false, code, origin);
    return this.declineWithReason(app, code, 'declined_answers', origin);
  }

  async finalize(app, origin = null) {
    const { messages, questions } = this.scenario;
    const decision = decideAnswers(questions, this.currentAnswers(app.id));
    if (!decision.approve) {
      // Unreachable by construction (rejecting answers decline at once); kept
      // so an inconsistency never approves. The sweep closes it as R_TIMEOUT.
      this.logger.error('decision_incomplete', { application_id: app.id, missing: decision.missing });
      return { action: 'incomplete', applicationId: app.id, missing: decision.missing };
    }
    const now = this.now();
    if (app.state === 'probation') return this.finalizeProbation(app, true, null, origin);
    if (app.state === 'manual_review') this.store.updateApplication(app.id, { questionnaire_state: 'none' });

    const actionState = await this.mutateRequest('approveChatJoinRequest', app);
    if (actionState === 'done') {
      this.store.updateApplication(app.id, {
        state: 'approved', decided_at: now, decision_reason: 'answers_passed', telegram_action_state: 'done',
      });
      await this.deliver(app, { text: messages.approved }, origin);
      this.logger.info('approved', { application_id: app.id });
      return { action: 'approved', applicationId: app.id };
    }
    // Approve failed or outcome unknown: the request stays with the admin.
    const reason = actionState === 'failed' ? 'approve_failed' : 'approve_inconclusive';
    this.store.updateApplication(app.id, {
      state: 'manual_review', decided_at: now, decision_reason: reason, telegram_action_state: actionState,
    });
    await this.deliver(app, this.withGroupButton(messages.manual_review), origin);
    return { action: 'manual_review', reason, applicationId: app.id };
  }

  // ---------------------------------------------------------- probation

  // Probation keeps its own texts (contract v2 §2); a failure records the
  // reason code as decision_reason.
  async finalizeProbation(app, passed, code = null, origin = null) {
    const { messages } = this.scenario;
    const userId = app.user_id;
    const probations = this.store.listByUserAndStates(userId, ['probation']);
    if (passed) {
      const results = [];
      for (const probation of probations) results.push(await this.passProbation(probation, 'answers_passed'));
      // «You can write now» only after Telegram confirmed every lift.
      const confirmed = results.length > 0 && results.every((r) => r.telegramActionState === 'done');
      await this.deliver(app, {
        text: confirmed ? messages.probation_passed : messages.probation_lift_unconfirmed,
      }, origin);
      if (!confirmed) return { action: 'probation_lift_unconfirmed', applicationId: app.id, results };
      return { action: 'probation_passed', applicationId: app.id, results };
    }
    const results = [];
    for (const probation of probations) results.push(await this.removeFromProbation(probation, code));
    await this.deliver(app, { text: messages.probation_removed }, origin);
    return { action: 'probation_removed', reason: code, applicationId: app.id, results };
  }

  async passProbation(app, reason) {
    const lifted = this.enforce ? await this.liftRestriction(app.chat_id, app.user_id) : 'none';
    if (!this.enforce) this.logger.info('shadow_decision', { application_id: app.id, decision: 'would_lift_restriction' });
    this.store.updateApplication(app.id, {
      state: 'probation_passed',
      decided_at: this.now(),
      decision_reason: reason,
      telegram_action_state: lifted,
      restrict_state: lifted === 'done' ? 'lifted' : (lifted === 'none' ? app.restrict_state : `lift_${lifted}`),
      questionnaire_state: 'none',
    });
    return { applicationId: app.id, chatId: app.chat_id, telegramActionState: lifted };
  }

  async removeFromProbation(app, reason) {
    const removed = this.enforce ? await this.removeMember(app.chat_id, app.user_id) : 'none';
    if (!this.enforce) this.logger.info('shadow_decision', { application_id: app.id, decision: 'would_remove' });
    this.store.updateApplication(app.id, {
      state: 'probation_removed',
      decided_at: this.now(),
      decision_reason: reason,
      telegram_action_state: removed,
      questionnaire_state: 'none',
    });
    if (removed !== 'done' && removed !== 'none') {
      this.logger.error('probation_removal_failed', { application_id: app.id, state: removed });
    }
    return { applicationId: app.id, chatId: app.chat_id, telegramActionState: removed };
  }

  // -------------------------------------------------------------- /start

  async handleStart(userId, privateChatId, payload) {
    if (isTokenFormat(payload)) return this.handleToken(userId, privateChatId, payload);
    return this.handleGateStart(userId, privateChatId, { infoIfNothing: true });
  }

  async reply(privateChatId, payload, event) {
    if (!this.enforce) {
      this.logger.info('shadow_decision', { decision: `would_reply_${event}` });
      return { ok: true, shadow: true };
    }
    return this.sendDm(privateChatId, typeof payload === 'string' ? { text: payload } : payload);
  }

  // DM payload with the inline «Открыть группу» button (URL = configured
  // group link; without a link the text goes alone).
  withGroupButton(text) {
    if (!this.config.groupLink) return { text };
    return {
      text,
      reply_markup: { inline_keyboard: [[{ text: this.scenario.messages.button_open_group, url: this.config.groupLink }]] },
    };
  }

  // `/start gate` or bare `/start` (contract v2 §2).
  async handleGateStart(userId, privateChatId, { infoIfNothing }) {
    const { messages, questions } = this.scenario;
    const target = this.store.findQuestionnaireTarget(userId);
    if (!target) {
      if (infoIfNothing) await this.reply(privateChatId, this.withGroupButton(messages.start_info), 'start_info');
      return { action: 'start_info' };
    }
    if (!this.enforce) {
      this.logger.info('shadow_decision', { application_id: target.id, decision: 'would_start_questionnaire' });
      return { action: 'shadow_logged', decision: 'would_start_questionnaire', applicationId: target.id };
    }
    const intro = target.state === 'probation' ? messages.probation_intro : messages.greeting;
    this.store.addAnswer({
      applicationId: target.id, questionId: 'questionnaire', text: null, pass: true, reason: QUESTIONNAIRE_START, now: this.now(),
    });
    this.store.updateApplication(target.id, {
      questionnaire_state: 'active',
      question_index: 0,
      retries_used: 0,
      user_chat_id: String(privateChatId),
      conversation_open: 1,
      dm_state: 'sent',
    });
    const sent = await this.sendSequence(privateChatId, [{ text: intro }, this.questionPayload(questions[0])]);
    if (!sent.ok) return this.onDmFailure(this.store.getApplication(target.id), sent);
    return { action: 'questionnaire_started', applicationId: target.id, state: target.state };
  }

  // `/start <token>` (contract v2 §1).
  async handleToken(userId, privateChatId, token) {
    const now = this.now();
    const { messages } = this.scenario;
    const tokenSha256 = hashToken(token);
    const row = this.store.getToken(tokenSha256);

    if (row && row.status === 'used' && row.telegram_user_id === String(userId)) {
      await this.reply(privateChatId, this.withGroupButton(messages.token_already_verified), 'token_already_verified');
      return { action: 'token_already_verified', siteRecordId: row.site_record_id };
    }

    if (!row || row.status !== 'issued' || !this.store.useToken({ tokenSha256, userId, now })) {
      const current = row ? this.store.getToken(tokenSha256) : null;
      let event = 'token_unknown';
      const details = { attempted_user_id: String(userId) };
      if (current?.status === 'used') {
        event = 'token_reuse';
        details.bound_user_id = current.telegram_user_id;
      } else if (current?.status === 'revoked') {
        event = 'token_revoked_use';
      }
      this.store.addJournal({ event, userId, siteRecordId: current?.site_record_id ?? null, details, now });
      this.logger.warn(event, { site_record_id: current?.site_record_id ?? null, user_id: String(userId) });
      await this.reply(privateChatId, this.withGroupButton(messages.token_invalid), 'token_invalid');
      // Normal flow: a pending questionnaire (probation / DM failure) starts.
      const next = await this.handleGateStart(userId, privateChatId, { infoIfNothing: false });
      return { action: event, next: next.action };
    }

    // Token is now used and the account is a verified member.
    const siteRecordId = row.site_record_id;
    this.store.addJournal({ event: 'token_verified', userId, siteRecordId, details: {}, now });
    this.logger.info('token_verified', { site_record_id: siteRecordId, user_id: String(userId) });

    const approvals = {};
    for (const chatId of this.config.targetChatIds) {
      if (!this.enforce) {
        approvals[chatId] = 'shadow';
        this.logger.info('shadow_decision', { chat_id: chatId, decision: 'would_approve_by_user' });
        continue;
      }
      approvals[chatId] = await this.approveByUser(chatId, userId);
    }

    // Close open questionnaires / pending reviews as approved_token.
    const open = this.store.listByUserAndStates(userId, ['screening', 'asking', 'manual_review']);
    for (const application of open) {
      const outcome = approvals[application.chat_id];
      this.store.updateApplication(application.id, {
        state: 'approved_token',
        decided_at: now,
        decision_reason: 'token',
        questionnaire_state: 'none',
        telegram_action_state: outcome === 'done' ? 'done' : (outcome === 'failed' || outcome === 'inconclusive' ? outcome : 'none'),
      });
    }

    // Lift any probation restriction.
    const lifted = [];
    for (const probation of this.store.listByUserAndStates(userId, ['probation'])) {
      lifted.push(await this.passProbation(probation, 'token'));
    }

    this.store.addJournal({ event: 'token_approvals', userId, siteRecordId, details: { approvals, closed: open.length, lifted: lifted.length }, now });
    // «I approved your request» only after Telegram confirmed an approve;
    // otherwise (no request, failure, shadow) — «submit a request».
    const approved = Object.values(approvals).includes('done');
    const welcome = approved ? messages.token_approved : messages.token_welcome;
    await this.reply(privateChatId, this.withGroupButton(welcome), approved ? 'token_approved' : 'token_welcome');
    return { action: 'token_verified', siteRecordId, approvals, closed: open.length, lifted: lifted.length };
  }

  // -------------------------------------------------------------- sweep

  async sweep() {
    const now = this.now();
    const { limits, messages } = this.scenario;
    let timedOut = 0;
    let timeoutDms = 0;
    for (const expired of this.store.listExpiredAsking(now)) {
      await this.withUserLock(expired.user_id, async () => {
        const app = this.store.getApplication(expired.id);
        if (!app || app.state !== 'asking') return;
        // Notify before declining: user_chat_id stops working once the request
        // is processed, so the order matters when the chat is not yet open.
        const insideWindow = now < app.created_at + limits.dmWindowSeconds * 1000;
        if (this.enforce && app.user_chat_id && (app.conversation_open === 1 || insideWindow)) {
          const sent = await this.sendDm(app.user_chat_id, { text: reasonText(this.scenario, 'R_TIMEOUT') });
          if (sent.ok) timeoutDms += 1;
        }
        const actionState = this.enforce ? await this.mutateRequest('declineChatJoinRequest', app) : 'none';
        this.store.updateApplication(app.id, {
          state: 'timed_out', decided_at: now, decision_reason: 'R_TIMEOUT', telegram_action_state: actionState,
        });
        timedOut += 1;
      });
    }
    // Probation expiry (contract v2 §2). In shadow mode nothing is removed:
    // a probation record may exist from a confirmed triage run, and marking
    // it removed without the Telegram action would lie about the group.
    let probationExpired = 0;
    if (this.enforce) {
      for (const expired of this.store.listExpiredProbation(now)) {
        await this.withUserLock(expired.user_id, async () => {
          const app = this.store.getApplication(expired.id);
          if (!app || app.state !== 'probation') return;
          await this.removeFromProbation(app, 'probation_expired');
          if (app.conversation_open === 1 && app.user_chat_id) {
            await this.sendDm(app.user_chat_id, { text: messages.probation_expired });
          }
          probationExpired += 1;
        });
      }
    } else {
      const pending = this.store.listExpiredProbation(now).length;
      if (pending) this.logger.info('shadow_decision', { decision: 'would_remove_expired_probation', count: pending });
    }
    const purged = this.store.purgeExpired(now, limits.retentionDays);
    return { timedOut, timeoutDms, probationExpired, purged };
  }
}
