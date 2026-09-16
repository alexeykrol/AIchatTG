import { createHash } from 'node:crypto';
import { botIdFromToken, classifyTelegramUpdate, detectTelegramLink } from '@aichattg/telegram-core';
import { buildSafetyRouterSystem, buildAbuseClassifierSystem } from './safety-v3.mjs';

export function judgementDigest(value) {
  const canonical = (item) => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function judgementPolicy(config) {
  return { mode: config.moderationMode || 'shadow', banLinks: config.moderationBanLinks === true,
    chatScopes: Object.fromEntries(['assistant', 'moderator'].map((role) =>
      [role, (config[role]?.chatIds || []).map(String).sort()])),
    exemptBots: (config.moderator?.exemptBotIds || []).map(String).sort(),
    syntheticBots: config.syntheticTestingEnabled === true
      ? (config.assistant?.syntheticBotIds || []).map(String).sort() : [],
    router: judgementDigest(buildSafetyRouterSystem()), abuse: judgementDigest(buildAbuseClassifierSystem()) };
}

/** Derive both projections from the authenticated raw update. Bot-specific
 * update IDs and stripped question text are never safety evidence. */
export function buildJudgementEnvelope(config, update) {
  const message = update.message || update.edited_message;
  if (!message?.chat || !Number.isSafeInteger(message.message_id)) return null;
  const edited = Boolean(update.edited_message);
  if (edited && (!Number.isSafeInteger(message.edit_date) || message.edit_date <= 0)) return null;
  const classify = (role) => {
    const adapter = config[role] || {};
    return classifyTelegramUpdate({ role, update, acceptedChatIds: adapter.chatIds || [],
      botUsername: adapter.botUsername, botId: botIdFromToken(adapter.botToken),
      exemptBotIds: adapter.exemptBotIds || [], syntheticBotIds: adapter.syntheticBotIds || [] });
  };
  const assistant = classify('assistant');
  const moderator = classify('moderator');
  const judgeEligible = assistant.kind === 'question' || moderator.kind === 'comment';
  const inScope = ['assistant', 'moderator'].some((role) =>
    (config[role]?.chatIds || []).map(String).includes(String(message.chat.id)));
  // An edit to an ignored/empty message still supersedes an in-flight older
  // revision. It creates only a tombstone, never a provider schedule.
  if (!judgeEligible && !(edited && inScope)) return null;
  const question = assistant.kind === 'question' ? assistant.question : null;
  const owner = question ? 'assistant' : 'moderator';
  const chatId = String(message.chat.id);
  const messageId = String(message.message_id);
  const revision = edited ? message.edit_date : 0;
  const revisionIdentity = `${chatId}:${messageId}:${edited ? `edit:${revision}` : 'original'}`;
  const entity = (entry) => ({ type: entry.type, offset: entry.offset, length: entry.length,
    ...(entry.url ? { url: entry.url } : {}), ...(entry.user?.id ? { userId: String(entry.user.id) } : {}) });
  const source = {
    chatId, messageId, revision, judgeEligible,
    userId: message.from?.id == null ? null : String(message.from.id),
    senderChatId: message.sender_chat?.id == null ? null : String(message.sender_chat.id),
    isBot: message.from?.is_bot === true,
    text: message.text || '', caption: message.caption || '',
    entities: (message.entities || []).map(entity), captionEntities: (message.caption_entities || []).map(entity),
    replyTo: message.reply_to_message?.message_id == null ? null : String(message.reply_to_message.message_id),
    replyAuthor: message.reply_to_message?.from?.id == null ? null : String(message.reply_to_message.from.id),
    forwarded: Boolean(message.forward_origin || message.forward_date || message.forward_from || message.forward_from_chat),
  };
  const policy = judgementPolicy(config);
  return { chatId, messageId, revision, revisionIdentity, owner, judgeEligible,
    sourceHash: judgementDigest(source), policyHash: judgementDigest(policy), policy,
    comment: { chatId, messageId, platformMessageId: revisionIdentity, userId: source.userId,
      senderChatId: source.senderChatId, isBot: source.isBot, hasLink: detectTelegramLink(message),
      text: message.text || message.caption || '' },
    question: question ? { ...question, platformMessageId: revisionIdentity,
      bareAskCommand: !edited && /^\s*\/ask(?:@[A-Za-z0-9_]+)?\s*$/i.test(message.text || ''),
      replyToAssistant: source.replyAuthor === botIdFromToken(config.assistant?.botToken),
    } : null,
  };
}
