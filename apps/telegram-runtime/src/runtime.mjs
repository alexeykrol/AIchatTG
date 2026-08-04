import {
  ASSISTANT_ROLE_ACTIONS,
  BOT_ROLES,
  assistantDispositionForSafety,
  botIdFromToken,
  classifyTelegramUpdate,
  incomingEventId,
  isCourseOperationsSupportQuestion,
  normalizeAssistantDisposition,
  normalizeAssistantRoleRoute,
  normalizeSafetyClassification,
  planTelegramSafetyAction,
} from '@aichattg/telegram-core';
import { LlmDisabledError } from './llm-adapter.mjs';

const HELP_TEXT = 'Используйте /ask <вопрос>, чтобы обратиться к ассистенту.';
const EMPTY_ASK_TEXT = 'После /ask напишите ваш вопрос.';
const WARNING_FIRST = 'Сообщение удалено за нарушение правил общения. Решения модератора не обсуждаются и не обжалуются. Повторное нарушение или попытка продолжить спор приведёт к последнему предупреждению.';
const WARNING_FINAL = 'Это второе и последнее предупреждение. Следующее нарушение или продолжение спора приведёт к немедленной блокировке.';

function roleConfig(config, role) { return role === BOT_ROLES.MODERATOR ? config.moderator : config.assistant; }

function storedDisposition(row) {
  if (!row) return null;
  return normalizeAssistantDisposition({
    status: row.status,
    verdict: row.verdict,
    reason: row.reason,
    moderationMessageId: row.moderation_message_id,
    moderationEventId: row.moderation_event_id,
  });
}

function unavailableKnowledge() {
  return { forSource() { return { available: false, reason: 'knowledge_adapter_missing', snapshot: null }; } };
}

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/**
 * The assistant reads only the moderator's durable terminal result for the exact
 * source revision. A missing/pending/error row never falls through to a model or
 * Telegram delivery call.
 */
async function waitForAssistantDisposition(store, config, question, wait) {
  const timeoutMs = Math.max(0, Number(config.assistantModerationWaitMs ?? 30_000));
  const pollMs = Math.max(1, Number(config.assistantModerationPollMs ?? 50));
  const startedAt = Date.now();
  while (true) {
    const row = store.getAssistantDisposition({ chatId: question.chatId, messageId: question.messageId });
    const disposition = storedDisposition(row);
    const sameRevision = disposition?.moderationMessageId === question.platformMessageId;
    if (disposition && sameRevision && disposition.status !== 'pending') return disposition;
    if (Date.now() - startedAt >= timeoutMs) {
      return {
        status: 'error', verdict: null,
        reason: row ? 'moderator_revision_timeout' : 'moderator_timeout',
        moderationMessageId: row?.moderation_message_id || null,
        moderationEventId: row?.moderation_event_id || null,
      };
    }
    await wait(Math.min(pollMs, timeoutMs - (Date.now() - startedAt)));
  }
}

export function createTelegramRuntime({
  config,
  store,
  llm,
  moderatorTelegram,
  assistantTelegram,
  notifier,
  knowledge = unavailableKnowledge(),
  wait = sleep,
}) {
  async function moderatorActions(comment, plan) {
    const actions = [];
    if (config.moderationMode !== 'live') return actions;
    if (plan.action === 'delete_warn_1' || plan.action === 'delete_warn_2') {
      actions.push(await moderatorTelegram.deleteMessage({ chatId: comment.chatId, messageId: comment.messageId }));
      actions.push(await moderatorTelegram.sendMessage({
        chatId: comment.chatId,
        text: plan.action === 'delete_warn_1' ? WARNING_FIRST : WARNING_FINAL,
        replyToMessageId: comment.messageId,
      }));
    } else if (plan.action === 'ban_purge') {
      actions.push(await moderatorTelegram.banMember({ chatId: comment.chatId, userId: comment.userId }));
      actions.push(await moderatorTelegram.deleteMessage({ chatId: comment.chatId, messageId: comment.messageId }));
    }
    return actions;
  }

  async function handleModerator(eventId, comment) {
    store.upsertAssistantDisposition({
      chatId: comment.chatId,
      messageId: comment.messageId,
      status: 'pending',
      moderationMessageId: comment.platformMessageId,
      reason: 'moderator_judging',
      moderationEventId: eventId,
    });
    let decision;
    try {
      decision = normalizeSafetyClassification(await llm.moderate({
        text: comment.text, chatId: comment.chatId, userId: comment.userId,
        messageId: comment.messageId, platformMessageId: comment.platformMessageId,
      }));
    } catch (error) {
      if (error instanceof LlmDisabledError) {
        store.upsertAssistantDisposition({
          chatId: comment.chatId, messageId: comment.messageId, status: 'error',
          moderationMessageId: comment.platformMessageId, reason: 'llm_disabled', moderationEventId: eventId,
        });
        return { kind: 'skipped', reason: 'llm_disabled' };
      }
      store.upsertAssistantDisposition({
        chatId: comment.chatId, messageId: comment.messageId, status: 'error',
        moderationMessageId: comment.platformMessageId, reason: 'moderation_error', moderationEventId: eventId,
      });
      throw error;
    }
    if (!decision) {
      store.upsertAssistantDisposition({
        chatId: comment.chatId, messageId: comment.messageId, status: 'error',
        moderationMessageId: comment.platformMessageId, reason: 'invalid_safety_verdict', moderationEventId: eventId,
      });
      throw new Error('moderation adapter returned an invalid closed safety verdict');
    }
    const strikes = decision.safetyRoute === 'abuse' && decision.abuseLevel === 'weak'
      ? store.reserveWeakStrike({ chatId: comment.chatId, userId: comment.userId })
      : { before: 0, after: 0 };
    const plan = planTelegramSafetyAction(decision, strikes.before);
    const assistantDisposition = assistantDispositionForSafety(plan);
    store.upsertAssistantDisposition({
      chatId: comment.chatId, messageId: comment.messageId, ...assistantDisposition,
      moderationMessageId: comment.platformMessageId, reason: decision.reason, moderationEventId: eventId,
    });
    const actions = await moderatorActions(comment, plan);
    if (plan.verdict === 'suspect') {
      actions.push(await notifier.notify({ kind: 'moderation_suspect', comment, decision, plan }));
    }
    store.recordModeration({
      eventId, ...comment, ...decision, ...plan, mode: config.moderationMode, actions,
    });
    return { kind: 'moderated', verdict: plan.verdict, action: plan.action, actions };
  }

  async function routeAssistantQuestion(question) {
    let route;
    try {
      route = normalizeAssistantRoleRoute(await llm.routeAssistant({
        text: question.text,
        chatId: question.chatId,
        userId: question.userId,
        courseOperationsHint: isCourseOperationsSupportQuestion(question.text),
      }));
    } catch (error) {
      if (error instanceof LlmDisabledError) return { error: 'llm_disabled' };
      throw error;
    }
    if (!route) return { error: 'assistant_route_invalid' };
    if (isCourseOperationsSupportQuestion(question.text)
      && ![ASSISTANT_ROLE_ACTIONS.SUPPORT, ASSISTANT_ROLE_ACTIONS.REDIRECT].includes(route.action)) {
      return { error: 'course_operations_route_required' };
    }
    if (route.action === ASSISTANT_ROLE_ACTIONS.REDIRECT) return { route, knowledge: null };
    const sourceKnowledge = knowledge.forSource(route.sourceId);
    if (!sourceKnowledge?.available) return { error: sourceKnowledge?.reason || 'knowledge_unavailable' };
    return { route, knowledge: sourceKnowledge.snapshot };
  }

  async function sendAssistantTurn(eventId, question, answer, route = null) {
    if (!answer || typeof answer.text !== 'string' || !answer.text.trim()) {
      throw new Error('assistant adapter returned an empty answer');
    }
    const receipt = await assistantTelegram.sendMessage({
      chatId: question.chatId, text: answer.text.trim(), replyToMessageId: question.messageId,
    });
    store.recordAssistantTurn({
      ...question, eventId, question: question.text, answer: answer.text.trim(),
      modelId: answer.modelId, receipt, route,
    });
    return { kind: 'answered', receipt, route };
  }

  async function handleAssistant(eventId, question) {
    const moderation = await waitForAssistantDisposition(store, config, question, wait);
    if (moderation.status !== 'allowed') {
      return {
        kind: 'skipped',
        reason: moderation.status === 'blocked' ? 'moderator_blocked' : 'moderator_unavailable',
        moderation,
      };
    }
    const questionClaim = store.claimAssistantQuestion({ chatId: question.chatId, messageId: question.messageId });
    if (!questionClaim.claimed) return { kind: 'duplicate_question', status: questionClaim.existing?.status || 'unknown' };
    try {
      if (question.command === 'help') {
        const result = await sendAssistantTurn(eventId, question, { text: HELP_TEXT }, 'command:help');
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'answered' });
        return { ...result, command: 'help' };
      }
      if (!question.text) {
        const result = await sendAssistantTurn(eventId, question, { text: EMPTY_ASK_TEXT }, 'command:ask_empty');
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'answered' });
        return { ...result, command: 'ask_empty' };
      }
      const routing = await routeAssistantQuestion(question);
      if (routing.error) {
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'skipped' });
        return { kind: 'skipped', reason: routing.error };
      }
      let answer;
      try {
        answer = await llm.answer({
          text: question.text,
          chatId: question.chatId,
          userId: question.userId,
          dialogue: store.recentDialogue(question.chatId, question.userId),
          route: routing.route,
          knowledge: routing.knowledge,
        });
      } catch (error) {
        if (error instanceof LlmDisabledError) {
          store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'skipped' });
          return { kind: 'skipped', reason: 'llm_disabled' };
        }
        throw error;
      }
      const result = await sendAssistantTurn(eventId, question, answer, routing.route);
      store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'answered' });
      return result;
    } catch (error) {
      store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'error' });
      throw error;
    }
  }

  return {
    async handleUpdate(role, update) {
      const eventId = incomingEventId(role, update);
      const claim = store.claimEvent({ eventId, role, updateId: update.update_id });
      if (!claim.claimed) return { kind: 'duplicate', eventId, status: claim.existing?.status || 'unknown' };
      try {
        const adapterConfig = roleConfig(config, role);
        const classified = classifyTelegramUpdate({
          role, update, acceptedChatIds: adapterConfig.chatIds, botUsername: adapterConfig.botUsername,
          botId: botIdFromToken(adapterConfig.botToken), exemptBotIds: adapterConfig.exemptBotIds,
        });
        const result = classified.kind === 'comment'
          ? await handleModerator(eventId, classified.comment)
          : classified.kind === 'question'
            ? await handleAssistant(eventId, classified.question)
            : { kind: 'skipped', reason: classified.reason };
        store.completeEvent(eventId, result.kind === 'skipped' ? 'skipped' : 'completed', result);
        return { eventId, ...result };
      } catch (error) {
        store.completeEvent(eventId, 'error', null, error.message);
        throw error;
      }
    },
  };
}
