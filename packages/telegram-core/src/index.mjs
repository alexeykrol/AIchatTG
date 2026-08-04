import { createHash } from 'node:crypto';

export const BOT_ROLES = Object.freeze({
  MODERATOR: 'moderator',
  ASSISTANT: 'assistant',
});

const ROLE_SET = new Set(Object.values(BOT_ROLES));
const ASSISTANT_CMD_RE = /^\s*\/(ask|help)(?:@([A-Za-z0-9_]+))?(?:\s+|$)/i;
const QUOTED_LITERAL_ENTITY_TYPES = new Set([
  'blockquote', 'expandable_blockquote', 'code', 'pre', 'pre_code',
]);
const SERVICE_FIELDS = [
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
  'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
  'channel_chat_created', 'message_auto_delete_timer_changed', 'pinned_message',
  'migrate_to_chat_id', 'migrate_from_chat_id',
];

export function assertBotRole(role) {
  if (!ROLE_SET.has(role)) throw new Error(`unsupported Telegram bot role: ${role}`);
  return role;
}

export function botIdFromToken(token) {
  const id = String(token || '').split(':')[0].trim();
  return /^\d+$/.test(id) ? id : null;
}

function isForwardedMessage(message) {
  return Boolean(
    message.forward_origin || message.forward_date || message.forward_from || message.forward_from_chat,
  );
}

function isLiteralEntityAt(message, offset) {
  const entities = [...(message.entities || []), ...(message.caption_entities || [])];
  return entities.some((entity) => (
    entity
    && QUOTED_LITERAL_ENTITY_TYPES.has(entity.type)
    && Number.isInteger(entity.offset)
    && Number.isInteger(entity.length)
    && offset >= entity.offset
    && offset < entity.offset + entity.length
  ));
}

/**
 * Exact legacy invocation semantics, extracted from the immutable source object:
 * only leading /ask and /help commands are accepted, optional @bot suffixes must
 * name this bot, and forwarded or literal-quoted commands are ignored.
 */
export function detectAssistantQuestion(message, botUsername = '') {
  const raw = message?.text || message?.caption || '';
  if (!raw || isForwardedMessage(message)) return { isQuestion: false, reason: null, text: '' };
  const command = raw.match(ASSISTANT_CMD_RE);
  if (!command) return { isQuestion: false, reason: null, text: '' };
  const commandOffset = raw.indexOf('/', command.index || 0);
  if (isLiteralEntityAt(message, commandOffset)) return { isQuestion: false, reason: null, text: '' };

  const expectedUsername = String(botUsername || '').replace(/^@/, '').toLowerCase();
  const targetUsername = command[2] || null;
  if (targetUsername && (!expectedUsername || targetUsername.toLowerCase() !== expectedUsername)) {
    return { isQuestion: false, reason: null, text: '' };
  }
  if (command[1].toLowerCase() === 'help') {
    return { isQuestion: true, reason: 'command', text: '', isHelpCommand: true };
  }
  return { isQuestion: true, reason: 'command', text: raw.slice(command[0].length).trim() };
}

export function incomingEventId(role, update) {
  assertBotRole(role);
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
    throw new Error('Telegram update_id must be a non-negative safe integer');
  }
  return `${role}:${update.update_id}`;
}

export function messageFromUpdate(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const message = update.message || update.edited_message;
  if (!message || !message.chat || message.message_id == null) return null;
  return message;
}

export function messageIdentity(message, update) {
  const chatId = String(message.chat.id);
  const messageId = String(message.message_id);
  const revision = update.edited_message
    ? `edit:${Number.isSafeInteger(update.update_id) ? update.update_id : createHash('sha256')
      .update(JSON.stringify([message.edit_date ?? null, message.text ?? null, message.caption ?? null]))
      .digest('hex').slice(0, 16)}:`
    : '';
  return {
    chatId,
    messageId,
    platformMessageId: `${chatId}:${revision}${messageId}`,
    userId: message.from?.id == null ? null : String(message.from.id),
    text: message.text || message.caption || '',
  };
}

function isServiceMessage(message) {
  return SERVICE_FIELDS.some((field) => field in message);
}

/**
 * Preserve the two-bot structural split: an Assistant can never classify a
 * moderation comment and a Moderator can never classify an assistant question.
 */
export function classifyTelegramUpdate({
  role,
  update,
  acceptedChatIds = [],
  botUsername = '',
  botId = null,
  exemptBotIds = [],
}) {
  assertBotRole(role);
  const message = messageFromUpdate(update);
  if (!message) return { kind: 'skip', reason: 'unsupported_update' };
  const identity = messageIdentity(message, update);
  if (!new Set(acceptedChatIds.map(String)).has(identity.chatId)) {
    return { kind: 'skip', reason: 'unknown_chat' };
  }
  if (message.from?.is_bot && new Set(exemptBotIds.map(String)).has(String(message.from.id))) {
    return { kind: 'skip', reason: 'exempt_bot' };
  }
  if (botId != null && String(message.from?.id) === String(botId)) {
    return { kind: 'skip', reason: 'own_bot' };
  }

  if (role === BOT_ROLES.ASSISTANT) {
    if (message.from?.is_bot) return { kind: 'skip', reason: 'bot_sender' };
    const question = detectAssistantQuestion(message, botUsername);
    if (!question.isQuestion) return { kind: 'skip', reason: 'not_assistant_command' };
    return {
      kind: 'question',
      question: {
        ...identity,
        authorName: message.from?.first_name || null,
        username: message.from?.username || null,
        command: question.isHelpCommand ? 'help' : 'ask',
        text: question.text,
      },
    };
  }

  if (!identity.text.trim()) {
    return { kind: 'skip', reason: isServiceMessage(message) ? 'service_message' : 'no_text' };
  }
  return {
    kind: 'comment',
    comment: {
      ...identity,
      authorName: message.from?.first_name || null,
      username: message.from?.username || null,
      isBot: Boolean(message.from?.is_bot),
      senderChatId: message.sender_chat?.id == null ? null : String(message.sender_chat.id),
    },
  };
}

export function normalizeModerationVerdict(value) {
  if (!value || typeof value !== 'object') return null;
  const verdict = String(value.verdict || '');
  if (!['clean', 'suspect', 'ban'].includes(verdict)) return null;
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return {
    verdict,
    confidence,
    reason: String(value.reason || ''),
    quote: String(value.quote || ''),
    modelId: value.modelId == null ? null : String(value.modelId),
  };
}
