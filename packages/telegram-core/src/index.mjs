import { createHash } from 'node:crypto';

export {
  admitKnowledgeSnapshot,
  KNOWLEDGE_MANIFEST_FORMAT,
  KNOWLEDGE_SOURCE_IDS,
  knowledgeManifestDigest,
  loadKnowledgeSnapshot,
  validateKnowledgeManifest,
} from './knowledge.mjs';

export const BOT_ROLES = Object.freeze({
  MODERATOR: 'moderator',
  ASSISTANT: 'assistant',
});

export const ASSISTANT_DISPOSITION_STATUSES = Object.freeze([
  'pending', 'allowed', 'blocked', 'error',
]);

export const ASSISTANT_SOURCE_PACKAGES = Object.freeze({
  COURSE_CONTENT: 'course-content-v1',
  COURSE_OPERATIONS: 'course-operations-v1',
});

export const ASSISTANT_ROLE_ACTIONS = Object.freeze({
  TEACH: 'teach',
  NAVIGATE: 'navigate',
  SUPPORT: 'support',
  REDIRECT: 'redirect',
});

// Code-owned deployed safety policy: model output may describe a route and
// severity, but it never chooses text, strikes, deletions, or bans.
export const TELEGRAM_SAFETY_POLICY_VERSION = 'telegram-safety-v1';
export const WARNING_FIRST =
  'Сообщение удалено за нарушение правил общения. Решения модератора не обсуждаются '
  + 'и не обжалуются. Повторное нарушение или попытка продолжить спор приведёт к '
  + 'последнему предупреждению.';
export const WARNING_FINAL =
  'Это второе и последнее предупреждение. Следующее нарушение или продолжение '
  + 'спора приведёт к немедленной блокировке.';

const ROLE_SET = new Set(Object.values(BOT_ROLES));
const ASSISTANT_DISPOSITION_SET = new Set(ASSISTANT_DISPOSITION_STATUSES);
const ASSISTANT_ROLE_ACTION_SET = new Set(Object.values(ASSISTANT_ROLE_ACTIONS));
const ASSISTANT_CMD_RE = /^\s*\/(ask|help)(?:@([A-Za-z0-9_]+))?(?:\s+|$)/i;
const QUOTED_LITERAL_ENTITY_TYPES = new Set([
  'blockquote', 'expandable_blockquote', 'code', 'pre', 'pre_code',
]);
// Telegram `mention` entities are deliberately not links: a person may address
// another participant without triggering the hard link policy.  Entities are
// authoritative when present; this narrow fallback covers normal URLs, t.me
// links and Telegram deep links when clients omit entity metadata.
const TELEGRAM_LINK_RE = /(?<![\p{L}\p{N}_])(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|tg:\/\/)/iu;
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

/**
 * Code-owned Telegram link signal for the Guard safety policy.  Only a URL or
 * text_link entity is a link; an @mention remains ordinary conversation.
 */
export function detectTelegramLink(message) {
  const entities = [...(message?.entities || []), ...(message?.caption_entities || [])];
  if (entities.some((entity) => entity && (entity.type === 'url' || entity.type === 'text_link'))) return true;
  return TELEGRAM_LINK_RE.test(`${message?.text || ''}\n${message?.caption || ''}`);
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
      hasLink: detectTelegramLink(message),
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

/**
 * Validate the provider-neutral safety result before any Telegram action is
 * planned. The provider may classify meaning, but it never selects a platform
 * action or an Assistant disposition.
 */
export function normalizeSafetyClassification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const safetyRoute = String(value.safetyRoute ?? value.safety_route ?? '');
  if (!['clean', 'abuse', 'threat'].includes(safetyRoute)) return null;
  const abuseLevel = value.abuseLevel ?? value.abuse_level ?? null;
  if (safetyRoute === 'abuse' && !['weak', 'strong'].includes(abuseLevel)) return null;
  if (safetyRoute !== 'abuse' && abuseLevel != null) return null;
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return {
    safetyRoute,
    abuseLevel: abuseLevel == null ? null : String(abuseLevel),
    confidence,
    reason: String(value.reason || ''),
    quote: String(value.quote || ''),
    modelId: value.modelId == null ? null : String(value.modelId),
  };
}

/** Deterministic policy copied as behavior, not as a provider prompt. */
export function planTelegramSafetyAction(classification, currentWeakStrikes = 0) {
  const decision = normalizeSafetyClassification(classification);
  if (!decision) throw new Error('invalid_safety_classification');
  const strikeBefore = Math.max(0, Number.parseInt(currentWeakStrikes, 10) || 0);
  const common = {
    safetyRoute: decision.safetyRoute,
    abuseLevel: decision.abuseLevel,
    strikeBefore,
    strikeAfter: strikeBefore,
    policyVersion: TELEGRAM_SAFETY_POLICY_VERSION,
  };
  if (decision.safetyRoute === 'clean') {
    return { ...common, verdict: 'clean', action: 'none', warning: null };
  }
  if (decision.safetyRoute === 'threat' || decision.abuseLevel === 'strong') {
    return { ...common, verdict: 'ban', action: 'ban_purge', warning: null };
  }
  const strikeAfter = strikeBefore + 1;
  if (strikeAfter === 1) {
    return { ...common, verdict: 'suspect', action: 'delete_warn_1', warning: WARNING_FIRST, strikeAfter };
  }
  if (strikeAfter === 2) {
    return { ...common, verdict: 'suspect', action: 'delete_warn_2', warning: WARNING_FINAL, strikeAfter };
  }
  return { ...common, verdict: 'ban', action: 'ban_purge', warning: null, strikeAfter };
}

export function assistantDispositionForSafety(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('safety_plan_required');
  if (plan.verdict === 'clean') return { status: 'allowed', verdict: 'clean' };
  if (plan.verdict === 'suspect' || plan.verdict === 'ban') {
    return { status: 'blocked', verdict: plan.verdict };
  }
  throw new Error('safety_plan_verdict_invalid');
}

export function normalizeAssistantDisposition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = String(value.status || '');
  if (!ASSISTANT_DISPOSITION_SET.has(status)) return null;
  const verdict = value.verdict == null ? null : String(value.verdict);
  if (status === 'allowed' && !['clean', 'exempt'].includes(verdict)) return null;
  if (status === 'blocked' && !['suspect', 'ban'].includes(verdict)) return null;
  return {
    status,
    verdict,
    reason: value.reason == null ? null : String(value.reason),
    moderationMessageId: value.moderationMessageId == null ? null : String(value.moderationMessageId),
    moderationEventId: value.moderationEventId == null ? null : String(value.moderationEventId),
  };
}

/**
 * A closed routing contract keeps course operations separate from course content.
 * Redirect intentionally has no source package and can never unlock a knowledge
 * snapshot by accident.
 */
export function normalizeAssistantRoleRoute(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = String(value.action || '');
  if (!ASSISTANT_ROLE_ACTION_SET.has(action)) return null;
  const sourceId = value.sourceId ?? value.source_id ?? null;
  const requiredSource = action === ASSISTANT_ROLE_ACTIONS.SUPPORT
    ? ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS
    : action === ASSISTANT_ROLE_ACTIONS.TEACH || action === ASSISTANT_ROLE_ACTIONS.NAVIGATE
      ? ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT
      : null;
  if (requiredSource == null) return sourceId == null ? { action, sourceId: null } : null;
  return sourceId === requiredSource ? { action, sourceId: requiredSource } : null;
}

/**
 * This deliberately narrow pre-router identifies questions about operating a
 * course rather than questions about its teaching material. It is a safety
 * boundary: an ambiguous sentence stays with the provider route and is never
 * silently granted access to course content.
 */
export function isCourseOperationsSupportQuestion(text) {
  const normalized = String(text || '').toLowerCase().replace(/ё/g, 'е');
  if (!normalized.includes('курс')) return false;
  // A requested order for studying named modules is a methodological/content
  // question, not a support request about operating the course interface.
  if (/в каком порядке.{0,80}(?:изуч|проход).{0,80}модул/u.test(normalized)) return false;
  return /(?:как|где|не приходит|не могу|не работает|проблем).{0,80}(?:войти|вход|урок|уроки|модул|кнопк|переход|оплат|цен|чат|сообществ|старт|начат)/u.test(normalized)
    || /(?:оплат|цен|доступ|логин|письм|аккаунт|кабинет|урок|модул|кнопк|переход).{0,80}(?:курс)/u.test(normalized)
    || /(?:в|на) курсе.{0,80}(?:оплат|цен|доступ|логин|письм|аккаунт|кабинет|чат|сообществ|с чего начать)/u.test(normalized);
}
