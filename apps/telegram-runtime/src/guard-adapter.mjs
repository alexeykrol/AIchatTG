const ADMIN_STATUSES = new Set(['administrator', 'creator', 'owner']);

function normalizedIds(values) {
  return new Set((values || []).map((value) => String(value).trim()).filter(Boolean));
}

function normalizedResult(result, fallback) {
  if (!result || result.ok !== true) {
    return {
      ok: false,
      error: String(result?.error || fallback).slice(0, 120),
      uncertain: true,
    };
  }
  return { ok: true };
}

function isChatOwnerOrAdmin(member) {
  return ADMIN_STATUSES.has(String(member?.status || '').toLowerCase());
}

function hasGuardCapabilities(member) {
  const status = String(member?.status || '').toLowerCase();
  if (status === 'creator' || status === 'owner') return true;
  return status === 'administrator'
    && member.can_delete_messages === true
    && member.can_restrict_members === true;
}

function hasPinGovernanceCapability(member) {
  const status = String(member?.status || '').toLowerCase();
  if (status === 'creator' || status === 'owner') return true;
  return status === 'administrator' && member.can_pin_messages === true;
}

/**
 * Guard is the only adapter allowed to make a destructive Telegram request.
 * Every invocation first proves that this bot is an administrator in an
 * explicitly configured chat and has both delete and restrict rights. The
 * transport is injected, allowing this contract to be tested without Telegram.
 */
export function createGuardAdapter({
  telegram,
  guardBotId = null,
  guardChatIds = [],
  exemptBotIds = [],
} = {}) {
  if (!telegram || typeof telegram.getChatMember !== 'function') {
    throw new Error('Guard adapter requires an injectable getChatMember transport');
  }
  const configuredChats = normalizedIds(guardChatIds);
  const exemptBots = normalizedIds(exemptBotIds);
  const guardId = guardBotId == null ? '' : String(guardBotId);

  async function member(chatId, userId) {
    try {
      const result = await telegram.getChatMember({ chatId: String(chatId), userId: String(userId) });
      if (result?.ok !== true || !result.data || typeof result.data !== 'object') {
        return { ok: false, reason: 'telegram_membership_unavailable' };
      }
      return { ok: true, member: result.data };
    } catch {
      return { ok: false, reason: 'telegram_membership_unavailable' };
    }
  }

  async function verifyEnforcement({ chatId }) {
    const normalizedChatId = String(chatId || '');
    if (!normalizedChatId || !configuredChats.has(normalizedChatId)) {
      return { proven: false, reason: 'guard_chat_unconfigured' };
    }
    if (!guardId) return { proven: false, reason: 'guard_identity_unavailable' };
    const resolved = await member(normalizedChatId, guardId);
    if (!resolved.ok) return { proven: false, reason: resolved.reason };
    if (!hasGuardCapabilities(resolved.member)) {
      return { proven: false, reason: 'guard_rights_unproven' };
    }
    return {
      proven: true,
      chatId: normalizedChatId,
      status: String(resolved.member.status || '').toLowerCase(),
    };
  }

  /**
   * Pin management has its own Telegram administrator permission. A Moderator
   * with only `can_pin_messages` can safely perform this housekeeping; missing
   * proof must never turn into an external unpin request.
   */
  async function verifyPinGovernance({ chatId }) {
    const normalizedChatId = String(chatId || '');
    if (!normalizedChatId || !configuredChats.has(normalizedChatId)) {
      return { proven: false, reason: 'guard_chat_unconfigured' };
    }
    if (!guardId) return { proven: false, reason: 'guard_identity_unavailable' };
    const resolved = await member(normalizedChatId, guardId);
    if (!resolved.ok) return { proven: false, reason: resolved.reason };
    if (!hasPinGovernanceCapability(resolved.member)) {
      return { proven: false, reason: 'guard_pin_rights_unproven' };
    }
    return {
      proven: true,
      chatId: normalizedChatId,
      status: String(resolved.member.status || '').toLowerCase(),
    };
  }

  /**
   * Match the deployed Guard exemptions: chat creators/admins, known friendly
   * bots, and anonymous messages posted as the group itself are never judged or
   * sanctioned. A failed membership lookup is intentionally not treated as a
   * negative answer: the caller must retain the Assistant's error disposition.
   */
  async function senderDisposition({ chatId, userId, isBot = false, senderChatId = null }) {
    const normalizedChatId = String(chatId || '');
    const normalizedUserId = userId == null ? null : String(userId);
    if (senderChatId != null && String(senderChatId) === normalizedChatId) {
      return { proven: true, exempt: true, reason: 'anonymous_group_sender' };
    }
    if (isBot && normalizedUserId && exemptBots.has(normalizedUserId)) {
      return { proven: true, exempt: true, reason: 'exempt_bot' };
    }
    if (!normalizedUserId) return { proven: true, exempt: false, reason: null };
    const resolved = await member(normalizedChatId, normalizedUserId);
    if (!resolved.ok) return { proven: false, exempt: false, reason: resolved.reason };
    if (isChatOwnerOrAdmin(resolved.member)) {
      return { proven: true, exempt: true, reason: 'chat_admin_or_creator' };
    }
    return { proven: true, exempt: false, reason: null };
  }

  async function callWithProof(chatId, invoke, fallback, beforeInvoke = null, preconditionFailure = 'action_precondition_unproven') {
    const proof = await verifyEnforcement({ chatId });
    if (!proof.proven) return { ok: false, skipped: proof.reason, uncertain: false };
    if (beforeInvoke != null) {
      try {
        // A synchronous literal-true predicate closes the local edit race at
        // the final boundary. Never await it: false, a Promise or a throw is
        // not permission to execute an action after the live rights lookup.
        const decision = typeof beforeInvoke === 'function' ? beforeInvoke() : null;
        if (decision !== true) {
          // Refuse accidental async predicates without leaving a rejected
          // Promise unhandled. This does not await or authorize the decision.
          if (decision && typeof decision.then === 'function') Promise.resolve(decision).catch(() => {});
          return { ok: false, skipped: preconditionFailure, uncertain: false };
        }
      } catch {
        return { ok: false, skipped: preconditionFailure, uncertain: false };
      }
    }
    try {
      return normalizedResult(await invoke(), fallback);
    } catch {
      return { ok: false, error: fallback, uncertain: true };
    }
  }

  async function callWithPinProof(chatId, invoke, fallback) {
    const proof = await verifyPinGovernance({ chatId });
    if (!proof.proven) return { ok: false, skipped: proof.reason, uncertain: false };
    try {
      return normalizedResult(await invoke(), fallback);
    } catch {
      return { ok: false, error: fallback, uncertain: true };
    }
  }

  return {
    verifyEnforcement,
    verifyPinGovernance,
    senderDisposition,
    deleteMessage({ chatId, messageId, beforeDelete = null }) {
      return callWithProof(chatId, () => telegram.deleteMessage({ chatId: String(chatId), messageId: String(messageId) }), 'delete_failed', beforeDelete, 'delete_precondition_unproven');
    },
    sendWarning({ chatId, messageId, text, beforeAction = null }) {
      return callWithProof(chatId, () => telegram.sendMessage({
        chatId: String(chatId), text: String(text), replyToMessageId: String(messageId),
      }), 'warning_failed', beforeAction);
    },
    banAuthor({ chatId, userId = null, senderChatId = null, beforeAction = null }) {
      if (senderChatId != null && String(senderChatId)) {
        if (typeof telegram.banSenderChat !== 'function') {
          return Promise.resolve({ ok: false, skipped: 'ban_sender_chat_unsupported', uncertain: false });
        }
        return callWithProof(chatId, () => telegram.banSenderChat({
          chatId: String(chatId), senderChatId: String(senderChatId),
        }), 'ban_sender_chat_failed', beforeAction);
      }
      if (userId == null || String(userId) === '') {
        return Promise.resolve({ ok: false, skipped: 'author_identity_missing', uncertain: false });
      }
      return callWithProof(chatId, () => telegram.banMember({ chatId: String(chatId), userId: String(userId) }), 'ban_failed', beforeAction);
    },
    unpinMessage({ chatId, messageId }) {
      if (typeof telegram.unpinMessage !== 'function') {
        return Promise.resolve({ ok: false, skipped: 'unpin_unsupported', uncertain: false });
      }
      return callWithPinProof(chatId, () => telegram.unpinMessage({
        chatId: String(chatId), messageId: String(messageId),
      }), 'unpin_failed');
    },
  };
}
