import { createHash } from 'node:crypto';

const CONTRACT = 'moderation-review-capture/v1';
const POLICY_FIELDS = [
  'enabled', 'bindingId', 'epochId', 'chatIds', 'startAt', 'allowUserId',
  'exemptBotIds', 'maxTextChars', 'maxContextChars',
];
const ENVELOPE_FIELDS = [
  'contract', 'bindingId', 'epochId', 'updateId', 'kind', 'chatId', 'messageId',
  'sourceDateSec', 'editDateSec', 'observedAt', 'text', 'userId',
  'contextStatus', 'sourceDigest', 'context', 'truncated',
];
const CONTEXT_FIELDS = ['messageId', 'text', 'relation'];
const SERVICE_FIELDS = [
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
  'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
  'channel_chat_created', 'message_auto_delete_timer_changed', 'pinned_message',
  'migrate_to_chat_id', 'migrate_from_chat_id', 'forum_topic_created',
  'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened',
  'general_forum_topic_hidden', 'general_forum_topic_unhidden',
  'video_chat_scheduled', 'video_chat_started', 'video_chat_ended',
  'video_chat_participants_invited', 'successful_payment', 'refunded_payment',
  'connected_website', 'passport_data', 'proximity_alert_triggered',
  'web_app_data', 'write_access_allowed', 'users_shared', 'chat_shared',
  'giveaway_created', 'giveaway_completed', 'giveaway_winners', 'boost_added',
  'chat_background_set', 'checklist_tasks_done', 'checklist_tasks_added',
  'direct_message_price_changed', 'paid_message_price_changed',
  'suggested_post_approved', 'suggested_post_approval_failed',
  'suggested_post_declined', 'suggested_post_paid', 'suggested_post_refunded',
];

class ReviewProjectionError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = 'ReviewProjectionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, statusCode) => { throw new ReviewProjectionError(code, statusCode); };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function shape(value, fields, code) {
  if (!record(value)) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))
    || keys.some((key) => !fields.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail(code);
}

function identifier(value, minimum, code, { wire = false, nonzero = false } = {}) {
  if (!wire && typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail(code);
    value = String(value);
  }
  if (typeof value !== 'string' || value.length > 17 || !/^-?(?:0|[1-9]\d*)$/u.test(value)) fail(code);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || String(number) !== value || number < minimum
    || (nonzero && number === 0)) fail(code);
  return value;
}

function timestamp(value, code) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value)) fail(code);
  const millis = Date.parse(value);
  if (!Number.isSafeInteger(millis) || millis < 0
    || new Date(millis).toISOString() !== value.replace(/Z$/u, value.includes('.') ? 'Z' : '.000Z')) fail(code);
  return millis;
}

function label(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('review_policy_invalid', 503);
}

function validatePolicy(policy) {
  shape(policy, POLICY_FIELDS, 'review_policy_invalid');
  if (typeof policy.enabled !== 'boolean') fail('review_policy_invalid', 503);
  if (!policy.enabled) fail('review_disabled', 503);
  label(policy.bindingId);
  label(policy.epochId);
  if (typeof policy.allowUserId !== 'boolean'
    || !Number.isSafeInteger(policy.maxTextChars) || policy.maxTextChars < 1
    || !Number.isSafeInteger(policy.maxContextChars) || policy.maxContextChars < 0
    || !Array.isArray(policy.chatIds) || !policy.chatIds.length
    || !Array.isArray(policy.exemptBotIds)) fail('review_policy_invalid', 503);
  for (const id of policy.chatIds) {
    identifier(id, -Number.MAX_SAFE_INTEGER, 'review_policy_invalid', { wire: true, nonzero: true });
  }
  for (const id of policy.exemptBotIds) identifier(id, 1, 'review_policy_invalid', { wire: true });
  if (new Set(policy.chatIds).size !== policy.chatIds.length
    || new Set(policy.exemptBotIds).size !== policy.exemptBotIds.length) fail('review_policy_invalid', 503);
  return timestamp(policy.startAt, 'review_policy_invalid');
}

function sourceTimes(kind, sourceDateSec, editDateSec, observedMillis) {
  if (!Number.isSafeInteger(sourceDateSec) || sourceDateSec < 0 || Object.is(sourceDateSec, -0)
    || sourceDateSec > Math.floor(observedMillis / 1000)) fail('review_source_time_invalid');
  if (kind === 'message') {
    if (editDateSec !== null) fail('review_source_time_invalid');
    return sourceDateSec * 1000;
  }
  if (kind !== 'edit' || !Number.isSafeInteger(editDateSec) || editDateSec < sourceDateSec
    || Object.is(editDateSec, -0) || editDateSec > Math.floor(observedMillis / 1000)) {
    fail('review_source_time_invalid');
  }
  return editDateSec * 1000;
}

function plainText(value, code) {
  if (typeof value !== 'string' || value.includes('\0')) fail(code);
  return value;
}

// Text-first is based on the presence of text, not its truthiness. An empty or
// whitespace-only text field cannot silently switch the source to a caption.
function suppliedText(message) {
  if (Object.hasOwn(message, 'text')) return plainText(message.text, 'review_text_invalid');
  if (Object.hasOwn(message, 'caption')) return plainText(message.caption, 'review_text_invalid');
  return null;
}

function suppliedContext(message, chatId, messageId) {
  const missing = { contextStatus: 'unavailable', context: null };
  if (!Object.hasOwn(message, 'reply_to_message')) {
    return ['external_reply', 'quote', 'reply_to_message_id', 'reply_to_story', 'reply_parameters']
      .some((field) => Object.hasOwn(message, field))
      ? missing : { contextStatus: 'none', context: null };
  }
  const reply = message.reply_to_message;
  // Invalid or unavailable reply evidence does not invalidate the comment, but
  // its absence must remain visible. Never recurse, even into an available reply.
  try {
    if (!record(reply) || !record(reply.chat)) return missing;
    if (identifier(reply.chat.id, -Number.MAX_SAFE_INTEGER, 'review_context_invalid', { nonzero: true }) !== chatId) return missing;
    const replyId = identifier(reply.message_id, 1, 'review_context_invalid');
    if (replyId === messageId || SERVICE_FIELDS.some((field) => Object.hasOwn(reply, field))) return missing;
    const text = suppliedText(reply);
    if (text === null || !text.trim()) return missing;
    return { contextStatus: 'supplied', context: { messageId: replyId, text, relation: 'direct_reply' } };
  } catch {
    return missing;
  }
}

/**
 * Canonical pre-clipping semantic collision fence. Extra source/transport fields
 * are intentionally excluded; no raw input is retained by this pure helper.
 * Context field order is canonical too, regardless of the caller's key order.
 */
export function moderationReviewSourceDigest(semantic) {
  try {
    if (!record(semantic)) fail('review_source_digest_invalid');
    const { kind, chatId, messageId, sourceDateSec, editDateSec, text, userId, contextStatus } = semantic;
    if (!['message', 'edit'].includes(kind) || !Number.isSafeInteger(sourceDateSec) || sourceDateSec < 0
      || Object.is(sourceDateSec, -0)
      || (kind === 'message' ? editDateSec !== null : !Number.isSafeInteger(editDateSec)
        || editDateSec < sourceDateSec || Object.is(editDateSec, -0))) fail('review_source_digest_invalid');
    identifier(chatId, -Number.MAX_SAFE_INTEGER, 'review_source_digest_invalid', { wire: true, nonzero: true });
    identifier(messageId, 1, 'review_source_digest_invalid', { wire: true });
    if (userId !== null) identifier(userId, 1, 'review_source_digest_invalid', { wire: true });
    plainText(text, 'review_source_digest_invalid');
    if (contextStatus === 'supplied') {
      shape(semantic.context, CONTEXT_FIELDS, 'review_source_digest_invalid');
      identifier(semantic.context.messageId, 1, 'review_source_digest_invalid', { wire: true });
      plainText(semantic.context.text, 'review_source_digest_invalid');
      if (semantic.context.relation !== 'direct_reply') fail('review_source_digest_invalid');
    } else if (!['none', 'unavailable'].includes(contextStatus) || semantic.context !== null) {
      fail('review_source_digest_invalid');
    }
    const context = semantic.context === null ? null : {
      messageId: semantic.context.messageId, text: semantic.context.text, relation: semantic.context.relation,
    };
    return createHash('sha256').update(JSON.stringify({
      kind, chatId, messageId, sourceDateSec, editDateSec, text, userId, contextStatus, context,
    })).digest('hex');
  } catch {
    fail('review_source_digest_invalid');
  }
}

/**
 * Revalidate at the private Console boundary. No clock is read implicitly: now
 * must be an explicit ISO UTC timestamp. Returns a fresh, frozen envelope or
 * throws an Error whose message/code contain only a code-owned review_* status.
 * Limits count UTF-16 code units, matching the Review store's string limits.
 */
export function validateModerationReviewEnvelope(envelope, policy, options = {}) {
  try {
    if (!record(options)) fail('review_clock_invalid');
    const { now } = options;
    const startMillis = validatePolicy(policy);
    const nowMillis = timestamp(now, 'review_clock_invalid');
    shape(envelope, ENVELOPE_FIELDS, 'review_envelope_invalid');
    if (envelope.contract !== CONTRACT) fail('review_contract_invalid');
    if (envelope.bindingId !== policy.bindingId || envelope.epochId !== policy.epochId) {
      fail('review_binding_invalid', 403);
    }
    const updateId = identifier(envelope.updateId, 0, 'review_id_invalid', { wire: true });
    const chatId = identifier(envelope.chatId, -Number.MAX_SAFE_INTEGER, 'review_id_invalid', { wire: true, nonzero: true });
    const messageId = identifier(envelope.messageId, 1, 'review_id_invalid', { wire: true });
    if (!policy.chatIds.includes(chatId)) fail('review_chat_forbidden', 403);
    if (envelope.kind !== 'message' && envelope.kind !== 'edit') fail('review_kind_invalid');
    const observedMillis = timestamp(envelope.observedAt, 'review_clock_invalid');
    if (observedMillis > nowMillis) fail('review_clock_invalid');
    const eventMillis = sourceTimes(envelope.kind, envelope.sourceDateSec, envelope.editDateSec, observedMillis);
    if (eventMillis < startMillis) fail('review_before_start');
    let userId = null;
    if (envelope.userId !== null) {
      if (!policy.allowUserId) fail('review_user_forbidden', 403);
      userId = identifier(envelope.userId, 1, 'review_id_invalid', { wire: true });
      if (policy.exemptBotIds.includes(userId)) fail('review_exempt_bot', 403);
    }
    shape(envelope.truncated, ['text', 'context'], 'review_truncation_invalid');
    const truncated = { text: envelope.truncated.text, context: envelope.truncated.context };
    if (typeof truncated.text !== 'boolean' || typeof truncated.context !== 'boolean') fail('review_truncation_invalid');
    const text = plainText(envelope.text, 'review_text_invalid');
    if (text.length > policy.maxTextChars || (truncated.text && text.length !== policy.maxTextChars)
      || (!truncated.text && !text.trim())) fail('review_truncation_invalid');
    let context = null;
    if (envelope.contextStatus === 'supplied') {
      shape(envelope.context, CONTEXT_FIELDS, 'review_context_invalid');
      const contextId = identifier(envelope.context.messageId, 1, 'review_context_invalid', { wire: true });
      const contextText = plainText(envelope.context.text, 'review_context_invalid');
      if (contextId === messageId || envelope.context.relation !== 'direct_reply'
        || contextText.length > policy.maxContextChars
        || (truncated.context && contextText.length !== policy.maxContextChars)
        || (!truncated.context && !contextText.trim())) fail('review_context_invalid');
      context = Object.freeze({ messageId: contextId, text: contextText, relation: 'direct_reply' });
    } else if (!['none', 'unavailable'].includes(envelope.contextStatus)
      || envelope.context !== null || truncated.context) fail('review_context_invalid');
    if (typeof envelope.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(envelope.sourceDigest)) fail('review_source_digest_invalid');
    const result = {
      contract: CONTRACT, bindingId: policy.bindingId, epochId: policy.epochId,
      updateId, kind: envelope.kind, chatId, messageId, sourceDateSec: envelope.sourceDateSec,
      editDateSec: envelope.editDateSec, observedAt: envelope.observedAt, text, userId,
      contextStatus: envelope.contextStatus, sourceDigest: envelope.sourceDigest,
      context, truncated: Object.freeze(truncated),
    };
    // Clipped originals are not available to Console. Their digest is a trusted
    // producer collision fence, never evidence that the clipped text is complete.
    if (!truncated.text && !truncated.context
      && moderationReviewSourceDigest(result) !== result.sourceDigest) fail('review_source_digest_invalid');
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof ReviewProjectionError) throw error;
    fail('review_envelope_invalid');
  }
}

/**
 * Read only the approved Moderator source fields and discard all other payload
 * data before leaving this call. Own bots MUST be in trusted exemptBotIds; no
 * payload bot flag can bypass that exclusion. Primary chat intersection belongs
 * to the runtime's configuration owner, before this policy is supplied.
 */
export function projectModerationReviewUpdate(input = {}) {
  try {
    if (!record(input)) fail('review_update_invalid');
    const { role, update, receivedAt, policy } = input;
    if (policy === undefined || policy === null || (record(policy) && policy.enabled === false)) {
      return { kind: 'skip', code: 'review_disabled' };
    }
    if (role !== 'moderator') return { kind: 'skip', code: 'review_role_ineligible' };
    const startMillis = validatePolicy(policy);
    if (!record(update)) fail('review_update_invalid');
    const hasMessage = Object.hasOwn(update, 'message');
    const hasEdit = Object.hasOwn(update, 'edited_message');
    if (!hasMessage && !hasEdit) return { kind: 'skip', code: 'review_update_unsupported' };
    if (hasMessage && hasEdit) fail('review_update_invalid');
    const message = hasMessage ? update.message : update.edited_message;
    if (!record(message) || !record(message.chat)) fail('review_message_invalid');
    const chatId = identifier(message.chat.id, -Number.MAX_SAFE_INTEGER, 'review_id_invalid', { nonzero: true });
    if (!policy.chatIds.includes(chatId)) return { kind: 'skip', code: 'review_chat_out_of_scope' };
    if (SERVICE_FIELDS.some((field) => Object.hasOwn(message, field))) return { kind: 'skip', code: 'review_service_message' };
    if (Object.hasOwn(message, 'is_automatic_forward') && typeof message.is_automatic_forward !== 'boolean') fail('review_message_invalid');
    if (message.is_automatic_forward === true) return { kind: 'skip', code: 'review_automatic_forward' };
    let senderId = null;
    if (Object.hasOwn(message, 'from')) {
      if (!record(message.from)) fail('review_sender_invalid');
      senderId = identifier(message.from.id, 1, 'review_id_invalid');
      if (policy.exemptBotIds.includes(senderId)) return { kind: 'skip', code: 'review_exempt_bot' };
    }
    const text = suppliedText(message);
    if (text === null || !text.trim()) return { kind: 'skip', code: 'review_no_text' };
    const observedMillis = timestamp(receivedAt, 'review_clock_invalid');
    const updateId = identifier(update.update_id, 0, 'review_id_invalid');
    const messageId = identifier(message.message_id, 1, 'review_id_invalid');
    const kind = hasMessage ? 'message' : 'edit';
    const editDateSec = hasMessage && !Object.hasOwn(message, 'edit_date') ? null : message.edit_date;
    const eventMillis = sourceTimes(kind, message.date, editDateSec, observedMillis);
    if (eventMillis < startMillis) return { kind: 'skip', code: 'review_before_start' };
    const reply = suppliedContext(message, chatId, messageId);
    const semantic = {
      kind, chatId, messageId, sourceDateSec: message.date, editDateSec, text,
      userId: policy.allowUserId ? senderId : null, ...reply,
    };
    const sourceDigest = moderationReviewSourceDigest(semantic);
    const truncated = { text: text.length > policy.maxTextChars,
      context: Boolean(reply.context && reply.context.text.length > policy.maxContextChars) };
    const envelope = {
      contract: CONTRACT, bindingId: policy.bindingId, epochId: policy.epochId,
      updateId, ...semantic, observedAt: receivedAt, sourceDigest,
      text: text.slice(0, policy.maxTextChars),
      context: reply.context ? { ...reply.context, text: reply.context.text.slice(0, policy.maxContextChars) } : null,
      truncated,
    };
    return { kind: 'candidate', envelope: validateModerationReviewEnvelope(envelope, policy, { now: receivedAt }) };
  } catch (error) {
    return { kind: 'reject', code: error instanceof ReviewProjectionError ? error.code : 'review_update_invalid' };
  }
}
