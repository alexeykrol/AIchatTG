import { evaluateAnswer } from './answers.mjs';
import { parseCallbackData } from './scenario.mjs';
import { screenApplicant } from './screening.mjs';
import { isAmbiguousTelegramError } from './telegram-api.mjs';

const SILENT_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });
const MAX_STORED_ANSWER_CHARS = 1000;

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

  // DM could not be delivered → leave the request pending for an admin.
  // Never a silent decline (contract §4, unacceptable outcome 1).
  toManualReviewAfterDmFailure(application, result) {
    const reason = result.ambiguous ? 'dm_inconclusive' : 'dm_failed';
    this.logger.info('manual_review', { application_id: application.id, reason });
    this.store.updateApplication(application.id, {
      state: 'manual_review',
      dm_state: 'failed',
      decided_at: this.now(),
      decision_reason: reason,
    });
    return { action: 'manual_review', reason, applicationId: application.id };
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
      return this.toManualReviewAfterDmFailure(app, { ambiguous: false });
    }

    const firstQuestion = this.scenario.questions[0];
    const sent = await this.sendSequence(app.user_chat_id, [
      { text: messages.greeting },
      this.questionPayload(firstQuestion),
    ]);
    if (!sent.ok) return this.toManualReviewAfterDmFailure(app, sent);

    this.store.updateApplication(app.id, {
      state: 'asking',
      question_index: 0,
      retries_used: 0,
      dm_state: 'sent',
      deadline_at: now + limits.answerTimeoutSeconds * 1000,
    });
    return { action: 'asking', applicationId: app.id, verdict: screening.verdict };
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
    if (!from || from.is_bot || !Number.isSafeInteger(from.id)) return { action: 'ignored_sender' };
    if (!this.store.findAskingByUser(from.id)) return { action: 'ignored_no_application' };
    const text = typeof message.text === 'string' ? message.text : null;
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
      if (!sent.ok) return this.toManualReviewAfterDmFailure(app, sent);
      return { action: 'retry', applicationId: app.id, questionId: question.id, reason: result.reason };
    }

    const nextIndex = app.question_index + 1;
    if (nextIndex < this.scenario.questions.length) {
      app = this.store.updateApplication(app.id, { question_index: nextIndex, retries_used: 0 });
      const sent = await this.sendDm(app.user_chat_id, this.questionPayload(this.scenario.questions[nextIndex]));
      if (!sent.ok) return this.toManualReviewAfterDmFailure(app, sent);
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
    const purged = this.store.purgeExpired(now, limits.retentionDays);
    return { timedOut, timeoutDms, purged };
  }
}
