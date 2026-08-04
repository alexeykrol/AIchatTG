import {
  BOT_ROLES,
  botIdFromToken,
  classifyTelegramUpdate,
  incomingEventId,
  normalizeModerationVerdict,
} from '@aichattg/telegram-core';
import { LlmDisabledError } from './llm-adapter.mjs';

const HELP_TEXT = 'Используйте /ask <вопрос>, чтобы обратиться к ассистенту.';
const EMPTY_ASK_TEXT = 'После /ask напишите ваш вопрос.';

function roleConfig(config, role) { return role === BOT_ROLES.MODERATOR ? config.moderator : config.assistant; }

export function createTelegramRuntime({ config, store, llm, moderatorTelegram, assistantTelegram, notifier }) {
  async function handleModerator(eventId, comment) {
    let decision;
    try {
      decision = normalizeModerationVerdict(await llm.moderate({ text: comment.text, chatId: comment.chatId, userId: comment.userId }));
    } catch (error) {
      if (error instanceof LlmDisabledError) return { kind: 'skipped', reason: 'llm_disabled' };
      throw error;
    }
    if (!decision) throw new Error('moderation adapter returned an invalid closed verdict');
    const actions = [];
    if (config.moderationMode === 'live' && decision.verdict === 'ban') {
      actions.push(await moderatorTelegram.banMember({ chatId: comment.chatId, userId: comment.userId }));
      actions.push(await moderatorTelegram.deleteMessage({ chatId: comment.chatId, messageId: comment.messageId }));
    }
    if (decision.verdict === 'suspect') {
      actions.push(await notifier.notify({ kind: 'moderation_suspect', comment, decision }));
    }
    store.recordModeration({ eventId, ...comment, ...decision, mode: config.moderationMode, actions });
    return { kind: 'moderated', verdict: decision.verdict, actions };
  }

  async function handleAssistant(eventId, question) {
    if (question.command === 'help') {
      const receipt = await assistantTelegram.sendMessage({ chatId: question.chatId, text: HELP_TEXT, replyToMessageId: question.messageId });
      store.recordAssistantTurn({ ...question, eventId, question: '/help', answer: HELP_TEXT, receipt });
      return { kind: 'answered', command: 'help', receipt };
    }
    if (!question.text) {
      const receipt = await assistantTelegram.sendMessage({ chatId: question.chatId, text: EMPTY_ASK_TEXT, replyToMessageId: question.messageId });
      store.recordAssistantTurn({ ...question, eventId, question: '/ask', answer: EMPTY_ASK_TEXT, receipt });
      return { kind: 'answered', command: 'ask_empty', receipt };
    }
    let answer;
    try {
      answer = await llm.answer({ text: question.text, chatId: question.chatId, userId: question.userId, dialogue: store.recentDialogue(question.chatId, question.userId) });
    } catch (error) {
      if (error instanceof LlmDisabledError) return { kind: 'skipped', reason: 'llm_disabled' };
      throw error;
    }
    if (!answer || typeof answer.text !== 'string' || !answer.text.trim()) throw new Error('assistant adapter returned an empty answer');
    const receipt = await assistantTelegram.sendMessage({ chatId: question.chatId, text: answer.text.trim(), replyToMessageId: question.messageId });
    store.recordAssistantTurn({ ...question, eventId, question: question.text, answer: answer.text.trim(), modelId: answer.modelId, receipt });
    return { kind: 'answered', receipt };
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
