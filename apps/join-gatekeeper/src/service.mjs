import { evaluateAnswer } from './answers.mjs';
import { parseCallbackData } from './scenario.mjs';
import { screenApplicant } from './screening.mjs';
import { isAmbiguousTelegramError, isNoRequestError, permissions } from './telegram-api.mjs';
import { hashToken, isTokenFormat } from './tokens.mjs';

const SILENT_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });
const MAX_STORED_ANSWER_CHARS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
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

  questionPayload(question) {
    const payload = { text: question.promptText };
    if (question.type === 'choice') {
      payload.reply_markup = {
        inline_keyboard: question.options.map((option) => [{ text: option.label, callback_data: option.callbackData }]),
      };
    }
    return payload;
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

    // Rate limit: repeated requests per user per day.
    if (this.store.countApplicationsLastDay(userId, now) >= limits.maxApplicationsPerUserPerDay) {
      if (!this.enforce) {
        const app = this.store.createApplication({
          ...snapshot, state: 'shadow_logged', now, decidedAt: now, decisionReason: 'would_decline_rate_limit',
        });
        this.logger.info('shadow_decision', { application_id: app.id, decision: 'would_decline_rate_limit' });
        return { action: 'shadow_logged', decision: 'would_decline_rate_limit', applicationId: app.id };
      }
      const app = this.store.createApplication({
        ...snapshot, state: 'declined_rate_limit', now, decidedAt: now, decisionReason: 'rate_limit',
      });
      const actionState = await this.mutateRequest('declineChatJoinRequest', app);
      this.store.updateApplication(app.id, { telegram_action_state: actionState });
      this.logger.info('declined_rate_limit', { application_id: app.id, telegram_action_state: actionState });
      return { action: 'declined_rate_limit', applicationId: app.id, telegramActionState: actionState };
    }

    const photoCount = await this.profilePhotoCount(from.id);
    const screening = screenApplicant({ from, bio: request.bio ?? null, photoCount }, this.scenario);

    if (!this.enforce) {
      const decision = screening.verdict === 'block' ? 'would_decline_screening' : `would_ask_${screening.verdict}`;
      const app = this.store.createApplication({
        ...snapshot,
        state: 'shadow_logged',
        screeningVerdict: screening.verdict,
        screeningReasons: screening.reasons,
        userChatId: request.user_chat_id ?? null,
        now,
        decidedAt: now,
        decisionReason: decision,
      });
      this.logger.info('shadow_decision', {
        application_id: app.id, verdict: screening.verdict, reasons: screening.reasons, decision,
      });
      return { action: 'shadow_logged', decision, verdict: screening.verdict, applicationId: app.id };
    }

    const app = this.store.createApplication({
      ...snapshot,
      state: 'screening',
      screeningVerdict: screening.verdict,
      screeningReasons: screening.reasons,
      userChatId: request.user_chat_id ?? null,
      now,
    });
    if (!app) return { action: 'duplicate_application' };
    this.logger.info('screened', { application_id: app.id, verdict: screening.verdict, reasons: screening.reasons });

    if (screening.verdict === 'block') {
      const actionState = await this.mutateRequest('declineChatJoinRequest', app);
      this.store.updateApplication(app.id, {
        state: 'declined_screening',
        decided_at: this.now(),
        decision_reason: 'screening_block',
        telegram_action_state: actionState,
      });
      return { action: 'declined_screening', applicationId: app.id, telegramActionState: actionState };
    }

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
    return { action: 'asking', applicationId: app.id, verdict: screening.verdict };
  }

  async approveVerifiedRequest(snapshot, verified, now) {
    if (!this.enforce) {
      const app = this.store.createApplication({
        ...snapshot, state: 'shadow_logged', now, decidedAt: now, decisionReason: 'would_approve_token',
      });
      this.logger.info('shadow_decision', { application_id: app.id, decision: 'would_approve_token' });
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
    try {
      await this.telegram.answerCallbackQuery({ callback_query_id: String(query.id) });
    } catch (error) {
      this.logger.warn('answer_callback_failed', { error: error.message });
    }
    const parsed = parseCallbackData(query.data);
    if (!parsed) return { action: 'ignored_callback' };
    return this.withUserLock(from.id, async () => {
      const app = this.store.findAskingByUser(from.id);
      if (!app) return { action: 'ignored_no_application' };
      const question = this.scenario.questions[app.question_index];
      if (!question || question.id !== parsed.questionId) return { action: 'ignored_stale_callback' };
      return this.processAnswer(app, { optionId: parsed.optionId }, `option:${parsed.optionId}`);
    });
  }

  async processAnswer(app, input, storedText) {
    const now = this.now();
    if (!app.conversation_open) app = this.store.updateApplication(app.id, { conversation_open: 1 });
    const question = this.scenario.questions[app.question_index];
    if (!question) return this.finalize(app);

    const result = evaluateAnswer(question, input, { linkPatterns: this.scenario.screening.compiledLinkPatterns });
    this.store.addAnswer({
      applicationId: app.id,
      questionId: question.id,
      text: typeof storedText === 'string' ? storedText.slice(0, MAX_STORED_ANSWER_CHARS) : null,
      pass: result.pass,
      reason: result.reason,
      now,
    });

    if (!result.pass && result.retryable && app.retries_used < 1) {
      this.store.updateApplication(app.id, { retries_used: app.retries_used + 1 });
      const sent = await this.sendSequence(app.user_chat_id, [
        { text: this.scenario.messages.retry },
        this.questionPayload(question),
      ]);
      if (!sent.ok) return this.onDmFailure(app, sent);
      return { action: 'retry', applicationId: app.id, questionId: question.id, reason: result.reason };
    }

    const nextIndex = app.question_index + 1;
    if (nextIndex < this.scenario.questions.length) {
      app = this.store.updateApplication(app.id, { question_index: nextIndex, retries_used: 0 });
      const sent = await this.sendDm(app.user_chat_id, this.questionPayload(this.scenario.questions[nextIndex]));
      if (!sent.ok) return this.onDmFailure(app, sent);
      return { action: 'asked', applicationId: app.id, questionId: this.scenario.questions[nextIndex].id };
    }
    app = this.store.updateApplication(app.id, { question_index: nextIndex, retries_used: 0 });
    return this.finalize(app);
  }

  async finalize(app) {
    const { messages, questions } = this.scenario;
    const lastPass = new Map();
    for (const answer of this.store.listAnswers(app.id)) lastPass.set(answer.question_id, answer.pass === 1);
    const allPassed = questions.every((question) => lastPass.get(question.id) === true);
    const now = this.now();
    if (app.state === 'probation') return this.finalizeProbation(app, allPassed);
    if (app.state === 'manual_review') this.store.updateApplication(app.id, { questionnaire_state: 'none' });

    if (!allPassed) {
      const actionState = await this.mutateRequest('declineChatJoinRequest', app);
      this.store.updateApplication(app.id, {
        state: 'declined_answers', decided_at: now, decision_reason: 'answers_failed', telegram_action_state: actionState,
      });
      await this.sendDm(app.user_chat_id, { text: messages.declined_answers });
      return { action: 'declined_answers', applicationId: app.id, telegramActionState: actionState };
    }

    if (app.screening_verdict === 'review') {
      this.store.updateApplication(app.id, {
        state: 'manual_review', decided_at: now, decision_reason: 'screening_review',
      });
      await this.sendDm(app.user_chat_id, { text: messages.manual_review });
      return { action: 'manual_review', reason: 'screening_review', applicationId: app.id };
    }

    const actionState = await this.mutateRequest('approveChatJoinRequest', app);
    if (actionState === 'done') {
      this.store.updateApplication(app.id, {
        state: 'approved', decided_at: now, decision_reason: 'answers_passed', telegram_action_state: 'done',
      });
      await this.sendDm(app.user_chat_id, { text: messages.approved });
      return { action: 'approved', applicationId: app.id };
    }
    // Approve failed or outcome unknown: the request stays with the admin.
    const reason = actionState === 'failed' ? 'approve_failed' : 'approve_inconclusive';
    this.store.updateApplication(app.id, {
      state: 'manual_review', decided_at: now, decision_reason: reason, telegram_action_state: actionState,
    });
    await this.sendDm(app.user_chat_id, { text: messages.manual_review });
    return { action: 'manual_review', reason, applicationId: app.id };
  }

  // ---------------------------------------------------------- probation

  async finalizeProbation(app, allPassed) {
    const { messages } = this.scenario;
    const userId = app.user_id;
    const probations = this.store.listByUserAndStates(userId, ['probation']);
    if (allPassed) {
      const results = [];
      for (const probation of probations) results.push(await this.passProbation(probation, 'answers_passed'));
      await this.sendDm(app.user_chat_id, { text: messages.probation_passed });
      return { action: 'probation_passed', applicationId: app.id, results };
    }
    const results = [];
    for (const probation of probations) results.push(await this.removeFromProbation(probation, 'answers_failed'));
    await this.sendDm(app.user_chat_id, { text: messages.probation_removed });
    return { action: 'probation_removed', applicationId: app.id, results };
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

  async reply(privateChatId, text, event) {
    if (!this.enforce) {
      this.logger.info('shadow_decision', { decision: `would_reply_${event}` });
      return { ok: true, shadow: true };
    }
    return this.sendDm(privateChatId, { text });
  }

  // `/start gate` or bare `/start` (contract v2 §2).
  async handleGateStart(userId, privateChatId, { infoIfNothing }) {
    const { messages, questions } = this.scenario;
    const target = this.store.findQuestionnaireTarget(userId);
    if (!target) {
      if (infoIfNothing) await this.reply(privateChatId, messages.start_info, 'start_info');
      return { action: 'start_info' };
    }
    if (!this.enforce) {
      this.logger.info('shadow_decision', { application_id: target.id, decision: 'would_start_questionnaire' });
      return { action: 'shadow_logged', decision: 'would_start_questionnaire', applicationId: target.id };
    }
    const intro = target.state === 'probation' ? messages.probation_intro : messages.greeting;
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
      await this.reply(privateChatId, messages.token_already_verified, 'token_already_verified');
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
      await this.reply(privateChatId, messages.token_invalid, 'token_invalid');
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
    const welcome = this.config.groupLink ? `${messages.token_welcome}\n\n${this.config.groupLink}` : messages.token_welcome;
    await this.reply(privateChatId, welcome, 'token_welcome');
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
          const sent = await this.sendDm(app.user_chat_id, { text: messages.timeout });
          if (sent.ok) timeoutDms += 1;
        }
        const actionState = this.enforce ? await this.mutateRequest('declineChatJoinRequest', app) : 'none';
        this.store.updateApplication(app.id, {
          state: 'timed_out', decided_at: now, decision_reason: 'timeout', telegram_action_state: actionState,
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
            await this.sendDm(app.user_chat_id, { text: messages.probation_removed });
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
