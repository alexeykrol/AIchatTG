import { randomUUID } from 'node:crypto';
import { createScenarioProvider } from './scenario.mjs';
import {
  createSiteOnboardingToken,
  createStartToken,
  decryptPrivateValue,
  encryptPrivateValue,
  encryptUpdateBody,
  privateValueFingerprint,
  sha256,
} from './security.mjs';
import { buildZapierPayload, sendZapierEvent } from './zapier.mjs';

const ACTIVE_MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function displayName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || (user.username ? `@${user.username}` : `user ${user.id}`);
}

function userMention(user) {
  return `<a href="tg://user?id=${encodeURIComponent(String(user.id))}">${escapeHtml(displayName(user))}</a>`;
}

function normalizeUser(user) {
  if (!user || !Number.isSafeInteger(Number(user.id))) throw validationError('user.id must be a safe integer');
  return {
    id: Number(user.id),
    is_bot: Boolean(user.is_bot),
    first_name: user.first_name ? String(user.first_name).slice(0, 128) : '',
    last_name: user.last_name ? String(user.last_name).slice(0, 128) : '',
    username: user.username ? String(user.username).slice(0, 64) : '',
  };
}

function normalizeEmail(value) {
  const email = String(value || '').trim();
  if (email.length < 3 || email.length > 254 || /\s/u.test(email)) return null;
  const separator = email.lastIndexOf('@');
  if (separator < 1 || separator === email.length - 1) return null;
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1).toLowerCase();
  if (local.length > 64 || domain.length > 253) return null;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u.test(domain)) {
    return null;
  }
  return `${local}@${domain}`;
}

function isActiveMember(chatMember) {
  if (!chatMember) return false;
  if (ACTIVE_MEMBER_STATUSES.has(chatMember.status)) return true;
  return chatMember.status === 'restricted' && chatMember.is_member === true;
}

function validateExternalEventShape(event) {
  const eventKeys = new Set(['event_id', 'event_type', 'chat_id', 'user']);
  const userKeys = new Set(['id', 'is_bot', 'first_name', 'last_name', 'username']);
  for (const key of Object.keys(event || {})) {
    if (!eventKeys.has(key)) throw validationError(`unsupported event field: ${key}`);
  }
  for (const key of Object.keys(event?.user || {})) {
    if (!userKeys.has(key)) throw validationError(`unsupported user field: ${key}`);
  }
}

function recoveryUser(user) {
  if (!user) return undefined;
  return {
    id: user.id,
    is_bot: Boolean(user.is_bot),
    first_name: user.first_name,
    last_name: user.last_name,
    username: user.username,
  };
}

function updateForRecovery(update) {
  const minimal = { update_id: update.update_id };
  if (Array.isArray(update.message?.new_chat_members)) {
    minimal.message = {
      message_id: update.message.message_id,
      chat: { id: update.message.chat?.id, type: update.message.chat?.type },
      new_chat_members: update.message.new_chat_members.map(recoveryUser),
    };
  } else if (update.message?.text?.startsWith('/start')) {
    minimal.message = {
      message_id: update.message.message_id,
      chat: { id: update.message.chat?.id, type: update.message.chat?.type },
      from: recoveryUser(update.message.from),
      text: update.message.text,
    };
  } else if (
    update.message?.chat?.type === 'private'
    && update.message?.from
    && typeof update.message?.text === 'string'
  ) {
    minimal.message = {
      message_id: update.message.message_id,
      chat: { id: update.message.chat.id, type: 'private' },
      from: recoveryUser(update.message.from),
      // Never retain the email candidate. An empty sentinel is sufficient:
      // after a successful store it resends the completion prompt; otherwise
      // it deterministically replays the invalid-email response.
      text: '',
    };
  } else if (update.chat_member) {
    const membership = update.chat_member;
    minimal.chat_member = {
      chat: { id: membership.chat?.id, type: membership.chat?.type },
      old_chat_member: {
        status: membership.old_chat_member?.status,
        is_member: membership.old_chat_member?.is_member,
        user: recoveryUser(membership.old_chat_member?.user),
      },
      new_chat_member: {
        status: membership.new_chat_member?.status,
        is_member: membership.new_chat_member?.is_member,
        user: recoveryUser(membership.new_chat_member?.user),
      },
    };
  } else if (update.callback_query) {
    minimal.callback_query = {
      id: update.callback_query.id,
      from: recoveryUser(update.callback_query.from),
      data: update.callback_query.data,
    };
  }
  return minimal;
}

function joinUsers(update, targetChatId) {
  const users = [];
  const message = update.message;
  if (message && String(message.chat?.id) === String(targetChatId) && Array.isArray(message.new_chat_members)) {
    users.push(...message.new_chat_members);
  }

  const membership = update.chat_member;
  if (membership && String(membership.chat?.id) === String(targetChatId)) {
    if (!isActiveMember(membership.old_chat_member) && isActiveMember(membership.new_chat_member)) {
      users.push(membership.new_chat_member?.user);
    }
  }

  const seen = new Set();
  return users.filter((user) => {
    if (!user || user.is_bot || seen.has(String(user.id))) return false;
    seen.add(String(user.id));
    return true;
  }).map(normalizeUser);
}

export class GatekeeperService {
  constructor({
    config,
    store,
    telegram,
    clock = Date.now,
    randomId = randomUUID,
    makeStartToken = (id, version) => createStartToken(id, version, config.linkSigningSecret),
    makeSiteToken = (id, version) => createSiteOnboardingToken(id, version, config.linkSigningSecret),
    zapierSender = sendZapierEvent,
    scenarioProvider = createScenarioProvider({
      scenarioPath: config.scenarioPath,
      allowDraftScenario: config.allowDraftScenario,
    }),
    logger = console,
  }) {
    this.config = config;
    this.store = store;
    this.telegram = telegram;
    this.clock = clock;
    this.randomId = randomId;
    this.makeStartToken = makeStartToken;
    this.makeSiteToken = makeSiteToken;
    this.zapierSender = zapierSender;
    this.scenarioProvider = scenarioProvider;
    this.logger = logger;
  }

  startTokenForInvitation(invitation) {
    const token = this.makeStartToken(invitation.id, invitation.start_token_version);
    if (sha256(token) !== invitation.start_token_sha256) {
      throw new Error('link signing secret does not match the stored invitation');
    }
    return token;
  }

  siteTokenForCase(siteCase) {
    const token = this.makeSiteToken(siteCase.id, siteCase.start_token_version);
    if (sha256(token) !== siteCase.start_token_sha256) {
      throw new Error('link signing secret does not match the stored site onboarding case');
    }
    return token;
  }

  prepareZapierIntent(eventType, data, now = nowIso(this.clock)) {
    const payload = buildZapierPayload(eventType, data);
    return {
      payload,
      intent: {
        deliveryKey: payload.idempotency_key,
        eventType,
        onboardingCaseId: payload.onboarding_case_id,
        now,
      },
    };
  }

  async sendClaimedZapier(eventType, data, payload) {
    const result = await this.zapierSender({
      config: this.config,
      eventType,
      data,
    });
    const storedState = result.state === 'definite_failure' ? 'failed' : result.state;
    this.store.finishZapierDelivery(payload.idempotency_key, {
      state: storedState,
      providerStatus: result.status || null,
      error: result.code || null,
      now: nowIso(this.clock),
    });
    return result;
  }

  async dispatchZapier(eventType, data) {
    if (!this.config.zapierEnabled) return { state: 'not_configured' };
    const { payload, intent } = this.prepareZapierIntent(eventType, data);
    const claim = this.store.beginZapierDelivery({
      ...intent,
    });
    if (claim.claim !== 'claimed') {
      return { state: claim.delivery?.state || 'duplicate', duplicate: true };
    }
    return this.sendClaimedZapier(eventType, data, payload);
  }

  async handleSiteRegistration(event, canonicalBody, { scenario } = {}) {
    if (!event || event.event_type !== 'student_registered' || event.source !== 'site') {
      throw validationError('site event must be student_registered');
    }
    const registrationEventId = String(event.event_id || '').trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(registrationEventId)) {
      throw validationError('site event_id must contain 1-128 safe identifier characters');
    }
    const email = normalizeEmail(event.email);
    if (!email) throw validationError('site event email is invalid');
    const copy = scenario?.messages?.site_email_instruction;
    if (!copy) throw new Error('site email instruction is missing from the ready scenario');

    const id = this.randomId();
    const startTokenVersion = 1;
    const startToken = this.makeSiteToken(id, startTokenVersion);
    const now = nowIso(this.clock);
    const expiresAt = new Date(this.clock() + this.config.siteTokenTtlSeconds * 1000).toISOString();
    const encryptedEmail = encryptPrivateValue(email, this.config.linkSigningSecret);
    const onboardingUrl = `${this.config.publicBaseUrl}/onboarding/site?token=${encodeURIComponent(startToken)}`;
    const invitationData = {
      onboarding_case_id: id,
      registration_event_id: registrationEventId,
      email,
      onboarding_url: onboardingUrl,
      occurred_at: event.occurred_at,
      email_subject: copy.subject,
      email_text: copy.text,
      button_text: copy.button_text,
    };
    const preparedInvitation = this.prepareZapierIntent('site_invite_requested', invitationData, now);
    const claimed = this.store.claimSiteCase({
      id,
      registrationEventId,
      payloadFingerprint: privateValueFingerprint(canonicalBody, this.config.linkSigningSecret),
      email: encryptedEmail,
      emailFingerprint: privateValueFingerprint(email, this.config.linkSigningSecret),
      telegramUserId: event.telegram_user_id,
      telegramUsername: event.telegram_username,
      startTokenVersion,
      startTokenSha256: sha256(startToken),
      expiresAt,
      now,
    }, { zapierIntent: preparedInvitation.intent });
    if (claimed.claim === 'conflict') {
      throw Object.assign(new Error('site event key was already used for a different payload'), { statusCode: 409 });
    }
    if (claimed.claim === 'duplicate') {
      const existingToken = this.siteTokenForCase(claimed.siteCase);
      const existingData = {
        ...invitationData,
        onboarding_case_id: claimed.siteCase.id,
        onboarding_url: `${this.config.publicBaseUrl}/onboarding/site?token=${encodeURIComponent(existingToken)}`,
      };
      const delivery = this.store.findZapierDelivery(
        buildZapierPayload('site_invite_requested', existingData).idempotency_key,
      );
      return {
        state: claimed.siteCase.status,
        invitationDelivery: delivery?.state || 'not_started',
        duplicate: true,
      };
    }

    const invitationDelivery = await this.sendClaimedZapier(
      'site_invite_requested',
      invitationData,
      preparedInvitation.payload,
    );
    return {
      state: claimed.siteCase.status,
      invitationDelivery: invitationDelivery.state,
      duplicate: false,
    };
  }

  getSiteOnboarding(token) {
    const normalized = String(token || '');
    if (!/^[A-Za-z0-9_-]{1,96}$/u.test(normalized)) return { state: 'invalid' };
    const siteCase = this.store.findSiteCaseByTokenHash(sha256(normalized));
    if (!siteCase) return { state: 'invalid' };
    if (Date.parse(siteCase.start_token_expires_at) < this.clock()) return { state: 'expired' };
    return { state: siteCase.status, siteCase };
  }

  async completeSiteOnboarding(token) {
    const lookup = this.getSiteOnboarding(token);
    if (!lookup.siteCase) return lookup;
    if (lookup.state === 'completed') return { state: 'completed', duplicate: true };
    const completedAt = nowIso(this.clock);
    const email = decryptPrivateValue({
      ciphertext: lookup.siteCase.email_ciphertext,
      iv: lookup.siteCase.email_iv,
      tag: lookup.siteCase.email_tag,
    }, this.config.linkSigningSecret);
    const completionData = {
      onboarding_case_id: lookup.siteCase.id,
      completed_at: completedAt,
      source: 'site',
      email,
      ...(lookup.siteCase.telegram_user_id
        ? { telegram_user_id: Number(lookup.siteCase.telegram_user_id) }
        : {}),
    };
    const preparedCompletion = this.config.zapierEnabled
      ? this.prepareZapierIntent('onboarding_completed', completionData, completedAt)
      : null;
    const completed = this.store.markSiteCaseCompleted(lookup.siteCase.id, completedAt, {
      zapierIntent: preparedCompletion?.intent || null,
    });
    if (!completed.changed) return { state: completed.siteCase?.status || 'invalid', duplicate: true };
    const delivery = preparedCompletion
      ? await this.sendClaimedZapier(
        'onboarding_completed', completionData, preparedCompletion.payload,
      )
      : { state: 'not_configured' };
    return { state: 'completed', completionDelivery: delivery.state };
  }

  hasConfirmedPayment(invitation) {
    return this.store.hasEventSource({
      source: 'tribute',
      userId: invitation.user_id,
      chatId: invitation.chat_id,
    });
  }

  createInvitation(user, { allowRotation }) {
    let existing = this.store.findInvitationByUser(this.config.targetChatId, user.id);
    const now = nowIso(this.clock);
    const expiresAt = new Date(this.clock() + this.config.startTokenTtlSeconds * 1000).toISOString();
    if (existing) {
      const deliveryIsCertain = !['intent', 'inconclusive'].includes(existing.group_send_state);
      if (
        allowRotation
        && deliveryIsCertain
        && existing.status === 'pending'
        && Date.parse(existing.start_token_expires_at) < this.clock()
      ) {
        const nextVersion = existing.start_token_version + 1;
        const nextToken = this.makeStartToken(existing.id, nextVersion);
        existing = this.store.rotateInvitationToken(existing.id, {
          expectedVersion: existing.start_token_version,
          nextVersion,
          startTokenSha256: sha256(nextToken),
          expiresAt,
          now,
        }) || this.store.findInvitationByUser(this.config.targetChatId, user.id);
      }
      return {
        invitation: existing,
        startToken: this.startTokenForInvitation(existing),
      };
    }

    const id = this.randomId();
    const startTokenVersion = 1;
    const startToken = this.makeStartToken(id, startTokenVersion);
    const invitation = this.store.createInvitation({
      id,
      chatId: this.config.targetChatId,
      user,
      startTokenVersion,
      startTokenSha256: sha256(startToken),
      expiresAt,
      now,
    });
    return {
      invitation,
      startToken: invitation.id === id
        ? startToken
        : this.makeStartToken(invitation.id, invitation.start_token_version),
    };
  }

  async inviteUser(user, { source, eventKey, payloadSha256 }, scenario) {
    const now = nowIso(this.clock);
    const eventClaim = this.store.claimEvent({
      eventKey,
      source,
      payloadSha256,
      userId: user.id,
      chatId: this.config.targetChatId,
      now,
    });
    if (eventClaim === 'conflict') {
      throw Object.assign(new Error('event key was already used for a different payload'), { statusCode: 409 });
    }
    if (eventClaim === 'duplicate') {
      const existing = this.store.findInvitationByUser(this.config.targetChatId, user.id);
      return existing
        ? {
          state: existing.status,
          delivery: existing.group_send_state,
          invitationId: existing.id,
          duplicate: true,
        }
        : { state: 'unresolved', delivery: 'not_started', duplicate: true };
    }

    let { invitation, startToken } = this.createInvitation(user, { allowRotation: eventClaim === 'claimed' });
    if (invitation.group_send_state === 'sent' || invitation.status !== 'pending') {
      return { state: invitation.status, delivery: invitation.group_send_state, invitationId: invitation.id };
    }
    if (invitation.group_send_state === 'intent' || invitation.group_send_state === 'inconclusive') {
      return { state: invitation.status, delivery: invitation.group_send_state, invitationId: invitation.id };
    }

    if (!this.store.beginGroupSend(invitation.id, now)) {
      invitation = this.store.findInvitationByUser(this.config.targetChatId, user.id);
      return { state: invitation.status, delivery: invitation.group_send_state, invitationId: invitation.id };
    }

    const deepLink = `https://t.me/${this.config.botUsername}?start=${startToken}`;
    const copy = scenario.messages.group_invitation;
    const text = escapeHtml(copy.text).replaceAll('{{user_mention}}', userMention(user));

    try {
      const message = await this.telegram.sendMessage({
        chat_id: this.config.targetChatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: copy.button_text, url: deepLink }]],
        },
      });
      this.store.finishGroupSend(invitation.id, {
        state: 'sent',
        messageId: message.message_id,
        now: nowIso(this.clock),
      });
      return { state: 'pending', delivery: 'sent', invitationId: invitation.id, messageId: String(message.message_id) };
    } catch (error) {
      const state = error.ambiguous ? 'inconclusive' : 'failed';
      this.store.finishGroupSend(invitation.id, {
        state,
        error: error.message,
        now: nowIso(this.clock),
      });
      throw error;
    }
  }

  async handleExternalEvent(event, rawBody, { scenario: suppliedScenario = null } = {}) {
    if (!event || event.event_type !== 'newcomer') throw validationError('event_type must be newcomer');
    validateExternalEventShape(event);
    const eventId = String(event.event_id || '').trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(eventId)) {
      throw validationError('event_id must contain 1-128 safe identifier characters');
    }
    if (event.chat_id == null) throw validationError('chat_id is required');
    if (String(event.chat_id) !== String(this.config.targetChatId)) {
      throw validationError('chat_id is not allowed');
    }
    const user = normalizeUser(event.user);
    const scenario = suppliedScenario || this.scenarioProvider.load();
    if (user.is_bot) return { ignored: 'bot_user' };
    return this.inviteUser(user, {
      source: 'tribute',
      eventKey: `external:${eventId}`,
      payloadSha256: sha256(rawBody),
    }, scenario);
  }

  async sendEmailAccepted(chatId, invitation, scenario) {
    const copy = scenario.messages.email_accepted;
    const token = this.startTokenForInvitation(invitation);
    await this.telegram.sendMessage({
      chat_id: chatId,
      text: copy.text,
      reply_markup: {
        inline_keyboard: [[{
          text: copy.completion_button_text,
          callback_data: `gk_done:${token}`,
        }]],
      },
    });
  }

  async handleStart(message, scenario) {
    if (message.chat?.type !== 'private' || !message.from) return { ignored: 'not_private_start' };
    const match = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/.exec(message.text || '');
    if (!match) return { ignored: 'not_start' };
    const token = match[1];
    if (!token) {
      await this.telegram.sendMessage({
        chat_id: message.chat.id,
        text: scenario.messages.start_missing_token.text,
      });
      return { state: 'missing_token' };
    }

    const invitation = this.store.findInvitationByTokenHash(sha256(token));
    if (!invitation || String(invitation.user_id) !== String(message.from.id)) {
      await this.telegram.sendMessage({
        chat_id: message.chat.id,
        text: scenario.messages.start_invalid_token.text,
      });
      return { state: 'invalid_token' };
    }
    if (!this.hasConfirmedPayment(invitation)) {
      await this.telegram.sendMessage({
        chat_id: message.chat.id,
        text: scenario.messages.start_payment_not_confirmed.text,
      });
      return { state: 'payment_not_confirmed' };
    }
    if (Date.parse(invitation.start_token_expires_at) < this.clock()) {
      await this.telegram.sendMessage({
        chat_id: message.chat.id,
        text: scenario.messages.start_expired_token.text,
      });
      return { state: 'expired_token' };
    }

    if (invitation.status === 'completed') {
      await this.telegram.sendMessage({
        chat_id: message.chat.id,
        text: scenario.messages.start_already_completed.text,
      });
      return { state: 'completed', invitationId: invitation.id };
    }

    const updated = this.store.markContactEstablished(invitation.id, nowIso(this.clock));
    if (this.store.findPrivateEmail(invitation.id)) {
      await this.sendEmailAccepted(message.chat.id, invitation, scenario);
    } else {
      const instruction = scenario.messages.private_instruction;
      const linkRows = instruction.links.map((link) => [{ text: link.label, url: link.url }]);
      await this.telegram.sendMessage({
        chat_id: message.chat.id,
        text: instruction.text,
        reply_markup: { inline_keyboard: linkRows },
      });
    }
    return { state: updated.status, invitationId: invitation.id };
  }

  async handleEmail(message, scenario) {
    if (message.chat?.type !== 'private' || !message.from) return { ignored: 'not_private_email' };
    const invitation = this.store.findInvitationByUser(this.config.targetChatId, message.from.id);
    if (!invitation || invitation.status !== 'contact_established') {
      return { ignored: 'unsupported_private_message' };
    }
    if (!this.hasConfirmedPayment(invitation)) {
      await this.telegram.sendMessage({
        chat_id: message.chat.id,
        text: scenario.messages.start_payment_not_confirmed.text,
      });
      return { state: 'payment_not_confirmed', invitationId: invitation.id };
    }
    if (this.store.findPrivateEmail(invitation.id)) {
      await this.sendEmailAccepted(message.chat.id, invitation, scenario);
      return { state: 'email_collected', invitationId: invitation.id, duplicate: true };
    }

    const email = normalizeEmail(message.text);
    if (!email) {
      await this.telegram.sendMessage({
        chat_id: message.chat.id,
        text: scenario.messages.email_invalid.text,
      });
      return { state: 'invalid_email', invitationId: invitation.id };
    }

    const encrypted = encryptPrivateValue(email, this.config.linkSigningSecret);
    this.store.storePrivateEmail(invitation.id, {
      ...encrypted,
      emailFingerprint: privateValueFingerprint(email, this.config.linkSigningSecret),
      now: nowIso(this.clock),
    });
    await this.sendEmailAccepted(message.chat.id, invitation, scenario);
    return { state: 'email_collected', invitationId: invitation.id };
  }

  async handleCompletion(
    callbackQuery,
    scenario,
    { confirmedAbsentCompletionDmReplay = false } = {},
  ) {
    const data = String(callbackQuery.data || '');
    if (!data.startsWith('gk_done:')) return { ignored: 'unknown_callback' };
    const token = data.slice('gk_done:'.length);
    const invitation = this.store.findInvitationByTokenHash(sha256(token));
    if (!invitation || String(invitation.user_id) !== String(callbackQuery.from?.id)) {
      await this.telegram.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: scenario.messages.completion_invalid_user.callback_text,
        show_alert: true,
      });
      return { state: 'invalid_token' };
    }
    if (invitation.status === 'completed') {
      if (confirmedAbsentCompletionDmReplay) {
        await this.telegram.sendMessage({
          chat_id: callbackQuery.from.id,
          text: scenario.messages.completion_success.dm_text,
        });
        return {
          state: 'completed',
          invitationId: invitation.id,
          recoveredCompletionDm: true,
        };
      }
      await this.telegram.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: scenario.messages.completion_already_completed.callback_text,
      });
      return { state: 'completed', invitationId: invitation.id, duplicate: true };
    }
    if (invitation.status === 'pending') {
      await this.telegram.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: scenario.messages.completion_before_start.callback_text,
        show_alert: true,
      });
      return { state: 'pending' };
    }
    if (!this.store.findPrivateEmail(invitation.id)) {
      await this.telegram.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: scenario.messages.completion_before_email.callback_text,
        show_alert: true,
      });
      return { state: 'contact_established' };
    }

    const completedAt = nowIso(this.clock);
    const storedEmail = this.store.findPrivateEmail(invitation.id);
    const email = decryptPrivateValue({
      ciphertext: storedEmail.email_ciphertext,
      iv: storedEmail.email_iv,
      tag: storedEmail.email_tag,
    }, this.config.linkSigningSecret);
    const completionData = {
      onboarding_case_id: invitation.id,
      completed_at: completedAt,
      source: 'tribute',
      email,
      telegram_user_id: Number(invitation.user_id),
    };
    const preparedCompletion = this.config.zapierEnabled
      ? this.prepareZapierIntent('onboarding_completed', completionData, completedAt)
      : null;
    const completed = preparedCompletion
      ? this.store.markCompletedWithZapierIntent(
        invitation.id, completedAt, preparedCompletion.intent,
      )
      : { changed: true, invitation: this.store.markCompleted(invitation.id, completedAt) };
    if (!completed.changed) {
      return { state: completed.invitation?.status || 'completed', invitationId: invitation.id, duplicate: true };
    }
    const completionDelivery = preparedCompletion
      ? await this.sendClaimedZapier(
        'onboarding_completed', completionData, preparedCompletion.payload,
      )
      : { state: 'not_configured' };
    try {
      await this.telegram.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: scenario.messages.completion_success.callback_text,
      });
      await this.telegram.sendMessage({
        chat_id: callbackQuery.from.id,
        text: scenario.messages.completion_success.dm_text,
      });
    } catch (error) {
      const recoveryError = error instanceof Error ? error : new Error(String(error));
      recoveryError.requiresManualCompletionRecovery = true;
      throw recoveryError;
    }
    return {
      state: completed.invitation.status,
      invitationId: invitation.id,
      completionDelivery: completionDelivery.state,
    };
  }

  async handleTelegramUpdate(
    update,
    rawBody = JSON.stringify(update),
    {
      rawBodySha256 = null,
      confirmedAbsentCompletionDmReplay = false,
      scenario: suppliedScenario = null,
    } = {},
  ) {
    if (!Number.isSafeInteger(Number(update?.update_id))) throw new Error('update_id must be a safe integer');
    const scenario = suppliedScenario || this.scenarioProvider.load();
    const updateId = String(update.update_id);
    const containsPrivateCandidate = update.message?.chat?.type === 'private'
      && typeof update.message?.text === 'string'
      && !update.message.text.startsWith('/start');
    const bodyHash = rawBodySha256 || (containsPrivateCandidate
      ? privateValueFingerprint(rawBody, this.config.linkSigningSecret)
      : sha256(rawBody));
    const recoveryBody = JSON.stringify(updateForRecovery(update));
    const claim = this.store.claimUpdate({
      updateId,
      encryptedBody: encryptUpdateBody(recoveryBody, this.config.linkSigningSecret),
      rawBodySha256: bodyHash,
      now: nowIso(this.clock),
    });
    if (claim === 'conflict') {
      throw Object.assign(new Error('update_id was already used for a different payload'), { statusCode: 409 });
    }
    if (claim !== 'claimed') return { duplicate: true, state: claim };

    try {
      let result = { ignored: 'unsupported_update' };
      const users = joinUsers(update, this.config.targetChatId);
      if (users.length) {
        result = {
          ignored: 'membership_without_confirmed_payment',
          memberCount: users.length,
        };
      } else if (update.message?.text?.startsWith('/start')) {
        result = await this.handleStart(update.message, scenario);
      } else if (update.message?.chat?.type === 'private' && typeof update.message?.text === 'string') {
        result = await this.handleEmail(update.message, scenario);
      } else if (update.callback_query) {
        result = await this.handleCompletion(update.callback_query, scenario, {
          confirmedAbsentCompletionDmReplay,
        });
      }
      this.store.finishUpdate(updateId, {
        state: 'processed',
        outcome: JSON.stringify(result),
        now: nowIso(this.clock),
      });
      this.logger.info?.('[gatekeeper] telegram update processed', { updateId, result });
      return result;
    } catch (error) {
      const inconclusive = error.ambiguous || error.requiresManualCompletionRecovery;
      const state = inconclusive ? 'inconclusive' : 'failed';
      this.store.finishUpdate(updateId, {
        state,
        error: error.message,
        now: nowIso(this.clock),
      });
      if (inconclusive) {
        this.logger.error?.('[gatekeeper] update outcome is inconclusive', { updateId, message: error.message });
        return { inconclusive: true, updateId };
      }
      throw error;
    }
  }
}

export { isActiveMember, joinUsers, normalizeEmail, normalizeUser, updateForRecovery };
