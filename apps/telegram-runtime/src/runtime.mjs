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
  WARNING_FINAL,
  WARNING_FIRST,
} from '@aichattg/telegram-core';
import { createHash } from 'node:crypto';
import { createProviderAdapter, isProviderUnavailableError } from './provider-adapter.mjs';
import {
  ASSISTANT_EMPTY_ASK_TEXT,
  ASSISTANT_HELP_TEXT,
  assistantDeterministicReply,
} from './assistant-policy.mjs';

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

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Telegram update must be JSON-compatible');
}

function inboundPayloadFingerprint(update) {
  return createHash('sha256').update(canonicalJson(update)).digest('hex');
}

function inboundRevisionIdentity(classified, update) {
  return classified.comment?.platformMessageId || classified.question?.platformMessageId || `update:${update.update_id}`;
}

function replayInboundResult({ eventId, receiptId, existing, collision }) {
  if (collision) return { kind: 'delivery_conflict', eventId, receiptId, reason: 'receipt_identity_conflict' };
  if (existing?.status === 'completed' || existing?.status === 'skipped') {
    try {
      const result = JSON.parse(existing.result_json);
      if (result && typeof result === 'object' && !Array.isArray(result)) return result;
    } catch { /* A corrupt terminal result must not be retried as a side effect. */ }
    return { kind: 'uncertain_delivery', eventId, receiptId, reason: 'terminal_result_unreadable' };
  }
  if (existing?.status === 'processing') return { kind: 'processing', eventId, receiptId, reason: 'claim_in_progress' };
  return {
    kind: 'uncertain_delivery', eventId, receiptId,
    reason: existing?.error_code || 'recovery_required', recoveryId: existing?.recovery_id || null,
  };
}

function redactedActionResult(result, fallback) {
  if (result?.ok === true) return { ok: true };
  return {
    ok: false,
    error: String(result?.error || result?.skipped || fallback).slice(0, 120),
    uncertain: result?.uncertain === true,
  };
}

function assistantDeliveryReceipt(result) {
  if (!result?.ok) throw new Error(`assistant_delivery_failed:${String(result?.error || result?.skipped || 'unknown').slice(0, 80)}`);
  const messageId = result?.data?.message_id ?? result?.messageId ?? null;
  return {
    ok: true,
    ...(messageId == null ? {} : { messageId: String(messageId) }),
  };
}

// These exits are entirely local: they reach neither the answer model nor the
// Telegram delivery adapter. A malformed/forbidden route or absent admitted
// snapshot must not consume a user's cooldown or daily quota. Provider transport
// errors deliberately stay outside this set because a remote call can be paid or
// otherwise ambiguous even when no Telegram message was attempted.
function isDefinitiveAssistantRoutingExit(errorCode) {
  const code = String(errorCode || '');
  return code === 'assistant_route_invalid'
    || code === 'course_operations_route_required'
    || code === 'knowledge_unavailable'
    || code === 'knowledge_adapter_missing'
    || code === 'knowledge_source_invalid'
    || code === 'knowledge_source_unavailable'
    || code === 'knowledge_identity_missing'
    || code === 'knowledge_identity_mismatch';
}

function applyTelegramSafetySignals(config, decision, comment) {
  if (decision.safetyRoute === 'threat') return decision;
  const exemptBots = new Set((config.moderator?.exemptBotIds || []).map(String));
  let signal = null;
  if (comment.isBot && !exemptBots.has(String(comment.userId || ''))) signal = 'is_bot';
  else if (comment.senderChatId) signal = 'sender_chat';
  else if (config.moderationBanLinks === true && comment.hasLink) signal = 'link';
  if (!signal) return decision;
  return {
    ...decision,
    safetyRoute: 'threat',
    abuseLevel: null,
    confidence: Math.max(decision.confidence, 1),
    reason: `${decision.reason || ''} [signal:${signal}]`.trim(),
    codeSignal: signal,
  };
}

function enforcementReceipt(plan, guardProof = null) {
  return {
    policy: {
      action: plan.action,
      route: plan.safetyRoute,
      abuseLevel: plan.abuseLevel,
      strikeBefore: plan.strikeBefore,
      strikeAfter: plan.strikeAfter,
    },
    guard: guardProof == null ? null : {
      proven: guardProof.proven === true,
      reason: guardProof.reason || null,
      status: guardProof.status || null,
    },
    steps: {},
    purge: { attempted: false, total: 0, deleted: 0, failed: 0, items: [] },
  };
}

const MAX_KNOWN_BAN_PURGE_MESSAGES = 100;

function knownBanPurgeTargets(store, comment) {
  const known = store.listKnownUndeletedModerationMessages({
    chatId: comment.chatId,
    userId: comment.userId,
    limit: MAX_KNOWN_BAN_PURGE_MESSAGES,
  });
  const candidates = [...known, {
    chat_id: String(comment.chatId), message_id: String(comment.messageId), user_id: comment.userId,
  }];
  const targets = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const chatId = String(candidate.chat_id ?? comment.chatId);
    const messageId = String(candidate.message_id ?? comment.messageId);
    const nativeKey = `${chatId}:${messageId}`;
    if (seen.has(nativeKey)) continue;
    seen.add(nativeKey);
    targets.push({ chatId, messageId });
  }
  return targets;
}

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
  provider = null,
  // Temporary injection compatibility for tests and local callers of the
  // previous seam. New bootstrap code provides `provider` exclusively.
  llm = null,
  moderatorTelegram,
  guard = null,
  assistantTelegram,
  notifier,
  knowledge = unavailableKnowledge(),
  wait = sleep,
}) {
  const modelProvider = provider || llm || createProviderAdapter({ enabled: false });
  const guardAdapter = guard;

  async function completeEnforcement(claim, status, receipt, errorCode = null) {
    const completed = store.completeModerationEnforcement({ claim, status, receipt, errorCode });
    return { receipt, persisted: completed.completed === true, status };
  }

  /**
   * Channel auto-pins are service housekeeping, not moderation.  The native
   * `(chat_id, message_id)` claim prevents Telegram's paired auto-forward and
   * pinned-message updates (or a webhook redelivery) from issuing a second
   * unpin.  We deliberately never retry a failed/ambiguous external action.
   */
  async function handlePinGovernance(eventId, pin) {
    if (config.moderationAntichannelPin === false) {
      return { kind: 'pin_governance', action: 'disabled', pin: { ...pin } };
    }
    if (pin.kind === 'remember_owner_pin') {
      const remembered = store.rememberOwnerPin({
        chatId: pin.chatId, messageId: pin.messageId, eventId,
      });
      return {
        kind: 'pin_governance', action: 'owner_pin_remembered',
        pin: { chatId: pin.chatId, messageId: pin.messageId },
        rememberedAt: remembered?.remembered_at ?? null,
      };
    }
    if (pin.kind !== 'unpin_auto_forward') {
      return { kind: 'skipped', reason: 'unsupported_pin_governance_action' };
    }

    const claimed = store.claimAutoUnpin({
      chatId: pin.chatId, messageId: pin.messageId, eventId,
    });
    if (!claimed.claimed) {
      return {
        kind: 'pin_governance', action: 'auto_unpin_already_recorded',
        pin: { chatId: pin.chatId, messageId: pin.messageId },
        state: claimed.existing?.state || 'unknown',
      };
    }
    if (!guardAdapter || typeof guardAdapter.unpinMessage !== 'function') {
      store.completeAutoUnpin({
        chatId: pin.chatId, messageId: pin.messageId, state: 'skipped',
        result: { ok: false, error: 'guard_adapter_missing' }, errorCode: 'guard_adapter_missing',
      });
      return {
        kind: 'pin_governance', action: 'auto_unpin_skipped',
        pin: { chatId: pin.chatId, messageId: pin.messageId }, reason: 'guard_adapter_missing',
      };
    }
    if (!store.markAutoUnpinCalling({ chatId: pin.chatId, messageId: pin.messageId }).marked) {
      return {
        kind: 'pin_governance', action: 'auto_unpin_already_recorded',
        pin: { chatId: pin.chatId, messageId: pin.messageId }, state: 'claim_fenced',
      };
    }

    let unpin;
    try {
      unpin = await guardAdapter.unpinMessage({ chatId: pin.chatId, messageId: pin.messageId });
    } catch {
      store.completeAutoUnpin({
        chatId: pin.chatId, messageId: pin.messageId, state: 'uncertain',
        result: { ok: false, error: 'unpin_transport_unknown', uncertain: true }, errorCode: 'unpin_transport_unknown',
      });
      return {
        kind: 'pin_governance', action: 'auto_unpin_uncertain',
        pin: { chatId: pin.chatId, messageId: pin.messageId }, reason: 'unpin_transport_unknown',
      };
    }
    const result = redactedActionResult(unpin, 'unpin_failed');
    const state = result.ok ? 'completed' : result.uncertain ? 'uncertain' : 'skipped';
    store.completeAutoUnpin({
      chatId: pin.chatId, messageId: pin.messageId, state, result,
      errorCode: result.ok ? null : result.error,
    });
    return {
      kind: 'pin_governance',
      action: result.ok ? 'auto_unpinned' : result.uncertain ? 'auto_unpin_uncertain' : 'auto_unpin_skipped',
      pin: { chatId: pin.chatId, messageId: pin.messageId },
      ...(result.ok ? {} : { reason: result.error }),
    };
  }

  async function enforceSafetyPlan(eventId, comment, decision, previewPlan) {
    const isWeak = decision.safetyRoute === 'abuse' && decision.abuseLevel === 'weak';
    const derivePreviewPolicy = () => planTelegramSafetyAction(decision, previewPlan.strikeBefore);
    const deriveLivePolicy = (strikeBefore) => planTelegramSafetyAction(
      decision, isWeak ? strikeBefore : previewPlan.strikeBefore,
    );

    // Clean is a terminal Moderator outcome but not enforcement. It gets its
    // own receipt without probing or depending on destructive Guard rights.
    if (previewPlan.action === 'none') {
      const planned = store.claimModerationSafetyEnforcement({
        eventId, chatId: comment.chatId, messageId: comment.messageId,
        revisionIdentity: comment.platformMessageId, userId: comment.userId,
        isWeak: false, derivePolicy: derivePreviewPolicy,
      });
      if (!planned.claimed) return { action: 'enforcement_already_recorded', receipt: planned.existing, actions: [] };
      const receipt = enforcementReceipt(planned.policy);
      receipt.status = 'clean';
      await completeEnforcement(planned.claim, 'skipped', receipt, 'clean');
      return { action: 'none', receipt, actions: [] };
    }

    if (config.moderationMode !== 'live') {
      const planned = store.claimModerationSafetyEnforcement({
        eventId, chatId: comment.chatId, messageId: comment.messageId,
        revisionIdentity: comment.platformMessageId, userId: comment.userId,
        isWeak: false, derivePolicy: derivePreviewPolicy,
      });
      if (!planned.claimed) return { action: 'enforcement_already_recorded', receipt: planned.existing, actions: [] };
      const receipt = enforcementReceipt(planned.policy);
      receipt.status = 'shadow';
      await completeEnforcement(planned.claim, 'skipped', receipt, 'shadow_mode');
      return { action: 'shadow', receipt, actions: [] };
    }

    const guardProof = !guardAdapter || typeof guardAdapter.verifyEnforcement !== 'function'
      ? { proven: false, reason: 'guard_adapter_missing' }
      : await guardAdapter.verifyEnforcement({ chatId: comment.chatId });
    if (!guardProof?.proven) {
      const planned = store.claimModerationSafetyEnforcement({
        eventId, chatId: comment.chatId, messageId: comment.messageId,
        revisionIdentity: comment.platformMessageId, userId: comment.userId,
        isWeak: false, guardProof, derivePolicy: derivePreviewPolicy,
      });
      if (!planned.claimed) return { action: 'enforcement_already_recorded', receipt: planned.existing, actions: [] };
      const receipt = enforcementReceipt(planned.policy, guardProof);
      receipt.status = 'guard_unproven';
      await completeEnforcement(planned.claim, 'skipped', receipt, guardProof?.reason || 'guard_rights_unproven');
      return { action: 'guard_unproven', receipt, actions: [], reason: guardProof?.reason || 'guard_rights_unproven' };
    }

    const planned = store.claimModerationSafetyEnforcement({
      eventId, chatId: comment.chatId, messageId: comment.messageId,
      revisionIdentity: comment.platformMessageId, userId: comment.userId,
      isWeak, guardProof, derivePolicy: deriveLivePolicy,
    });
    if (!planned.claimed) return { action: 'enforcement_already_recorded', receipt: planned.existing, actions: [] };
    const plan = planned.policy;
    const receipt = enforcementReceipt(plan, guardProof);
    if (planned.duplicateNative) {
      receipt.status = 'duplicate_native_revision';
      await completeEnforcement(planned.claim, 'skipped', receipt, 'duplicate_native_revision');
      return { action: 'duplicate_native_revision', receipt, actions: [] };
    }
    const actions = [];
    const callStep = async (name, invoke) => {
      receipt.steps[name] = { status: 'calling' };
      const calling = store.markModerationEnforcementCalling({ claim: planned.claim, receipt });
      if (!calling.marked) return { ok: false, error: 'enforcement_claim_fenced', uncertain: true };
      const result = redactedActionResult(await invoke(), `${name}_failed`);
      receipt.steps[name] = { status: result.ok ? 'completed' : result.uncertain ? 'uncertain' : 'skipped', ...result };
      actions.push({ step: name, ...receipt.steps[name] });
      return result;
    };
    if (plan.action === 'delete_warn_1' || plan.action === 'delete_warn_2') {
      const deleted = await callStep('delete', () => guardAdapter.deleteMessage({
        chatId: comment.chatId, messageId: comment.messageId,
      }));
      if (!deleted.ok) {
        receipt.status = deleted.uncertain ? 'uncertain' : 'guard_unproven';
        await completeEnforcement(planned.claim, deleted.uncertain ? 'uncertain' : 'skipped', receipt, deleted.error);
        return { action: 'abuse_delete_unconfirmed', receipt, actions };
      }
      store.recordModerationDeletion({ chatId: comment.chatId, messageId: comment.messageId, state: 'deleted' });
      const warned = await callStep('warning', () => guardAdapter.sendWarning({
        chatId: comment.chatId,
        messageId: comment.messageId,
        text: plan.action === 'delete_warn_1' ? WARNING_FIRST : WARNING_FINAL,
      }));
      if (!warned.ok) {
        receipt.status = warned.uncertain ? 'uncertain' : 'guard_unproven';
        await completeEnforcement(planned.claim, warned.uncertain ? 'uncertain' : 'skipped', receipt, warned.error);
        return { action: 'abuse_warning_unconfirmed', receipt, actions };
      }
      store.markWarningDelivered({
        chatId: comment.chatId, userId: comment.userId, eventId,
        stage: plan.action === 'delete_warn_1' ? 'first' : 'final',
      });
      receipt.status = 'completed';
      await completeEnforcement(planned.claim, 'completed', receipt);
      return { action: plan.action, receipt, actions };
    }

    const banned = await callStep('ban', () => guardAdapter.banAuthor({
      chatId: comment.chatId, userId: comment.userId, senderChatId: comment.senderChatId,
    }));
    if (!banned.ok && banned.uncertain) {
      receipt.status = 'uncertain';
      await completeEnforcement(planned.claim, 'uncertain', receipt, banned.error);
      return { action: 'ban_unconfirmed', receipt, actions };
    }
    receipt.purge.attempted = true;
    for (const target of knownBanPurgeTargets(store, comment)) {
      const item = { chatId: target.chatId, messageId: target.messageId, status: 'calling' };
      receipt.purge.items.push(item);
      // Fence the native target before the Telegram call. If the process dies
      // after this point, a later ban cannot mistake an unknown delivery outcome
      // for a safely retryable undeleted message.
      store.recordModerationDeletion({
        chatId: target.chatId, messageId: target.messageId, state: 'calling',
      });
      const deleted = await callStep(`delete:${target.messageId}`, () => guardAdapter.deleteMessage(target));
      Object.assign(item, redactedActionResult(deleted, 'delete_failed'), {
        status: deleted.ok ? 'completed' : deleted.uncertain ? 'uncertain' : 'skipped',
      });
      store.recordModerationDeletion({
        chatId: target.chatId,
        messageId: target.messageId,
        state: deleted.ok ? 'deleted' : deleted.uncertain ? 'uncertain' : 'failed',
      });
    }
    receipt.purge.total = receipt.purge.items.length;
    receipt.purge.deleted = receipt.purge.items.filter((item) => item.ok).length;
    receipt.purge.failed = receipt.purge.total - receipt.purge.deleted;
    const uncertain = receipt.purge.items.some((item) => item.uncertain === true);
    receipt.status = uncertain ? 'uncertain' : receipt.purge.failed ? 'guard_unproven' : 'completed';
    await completeEnforcement(
      planned.claim,
      uncertain ? 'uncertain' : receipt.purge.failed ? 'skipped' : 'completed',
      receipt,
      uncertain ? 'purge_uncertain' : receipt.purge.failed ? 'purge_unconfirmed' : null,
    );
    return {
      action: receipt.purge.failed
        ? 'purge_unconfirmed'
        : banned.ok ? 'ban_purge' : 'delete_no_author',
      receipt,
      actions,
    };
  }

  function moderatorRetryDelaySeconds(safeRetryCount) {
    const base = Math.max(0, Number(config.moderatorRecoveryBackoffSec ?? 60));
    return Math.min(3_600, base * (2 ** Math.min(6, Math.max(0, safeRetryCount))));
  }

  function moderatorRetryLimit() {
    return Math.max(1, Math.min(10, Number(config.moderatorRecoveryMaxSafeRetries ?? 3)));
  }

  function moderatorLeaseSeconds() {
    return Math.max(5, Math.min(900, Number(config.moderatorRecoveryLeaseSec ?? 90)));
  }

  function jobResult(eventId, row, fallback = 'moderator_recovery_pending') {
    if (row?.state === 'manual_review') {
      return { kind: 'moderation_manual_review', eventId, reason: row.error_code || 'manual_review' };
    }
    if (row?.state === 'resolved') {
      return { kind: 'moderation_resolved', eventId, reason: 'already_resolved' };
    }
    return { kind: 'moderation_deferred', eventId, reason: row?.error_code || fallback };
  }

  /**
   * Runs one fenced, private Moderator job. Its state remains `safe_retry`
   * during read-only guard preflight and flips to `calling` in SQLite directly
   * before the semantic provider boundary. Therefore a crash can never be
   * mistaken for a proved-zero-call retry.
   */
  async function runModeratorJudgement(claim) {
    const eventId = claim.eventId;
    const job = store.getModeratorJudgement(claim.eventId);
    let snapshot;
    try { snapshot = JSON.parse(job?.snapshot_json || ''); } catch { snapshot = null; }
    const comment = snapshot?.schemaVersion === 'moderator-comment-v1' ? snapshot.comment : null;
    if (!comment || snapshot?.expired === true) {
      store.manualReviewModeratorJudgement({ claim, errorCode: 'snapshot_invalid_or_expired', providerBoundary: 'not_started' });
      return jobResult(claim.eventId, store.getModeratorJudgement(claim.eventId), 'snapshot_invalid_or_expired');
    }

    store.observeModerationMessage({
      chatId: comment.chatId, messageId: comment.messageId, userId: comment.userId,
      revisionIdentity: comment.platformMessageId,
    });
    store.upsertAssistantDisposition({
      chatId: comment.chatId,
      messageId: comment.messageId,
      status: 'pending',
      moderationMessageId: comment.platformMessageId,
      reason: 'moderator_judging',
      moderationEventId: eventId,
    });
    if (!guardAdapter || typeof guardAdapter.senderDisposition !== 'function') {
      store.manualReviewModeratorJudgement({ claim, errorCode: 'guard_adapter_missing', providerBoundary: 'not_started' });
      store.upsertAssistantDisposition({
        chatId: comment.chatId, messageId: comment.messageId, status: 'error',
        moderationMessageId: comment.platformMessageId, reason: 'guard_adapter_missing', moderationEventId: eventId,
      });
      return jobResult(claim.eventId, store.getModeratorJudgement(claim.eventId));
    }
    let sender;
    try {
      sender = await guardAdapter.senderDisposition({
        chatId: comment.chatId,
        userId: comment.userId,
        isBot: comment.isBot,
        senderChatId: comment.senderChatId,
      });
    } catch {
      sender = { proven: false, reason: 'telegram_membership_unavailable' };
    }
    if (!sender?.proven) {
      const reason = sender?.reason || 'sender_exemption_unproven';
      if (reason === 'telegram_membership_unavailable' && job.safe_retry_count < moderatorRetryLimit()) {
        const deferred = store.deferModeratorJudgement({
          claim,
          nextAttemptAt: store.currentTime() + moderatorRetryDelaySeconds(job.safe_retry_count),
          errorCode: reason,
        });
        return jobResult(claim.eventId, deferred.row, reason);
      }
      store.manualReviewModeratorJudgement({ claim, errorCode: reason, providerBoundary: 'not_started' });
      store.upsertAssistantDisposition({
        chatId: comment.chatId, messageId: comment.messageId, status: 'error',
        moderationMessageId: comment.platformMessageId,
        reason, moderationEventId: eventId,
      });
      return jobResult(claim.eventId, store.getModeratorJudgement(claim.eventId), reason);
    }
    if (sender.exempt) {
      const resolved = store.resolveModeratorJudgement({
        claim,
        decision: { verdict: 'clean', reason: sender.reason || 'sender_exempt', source: 'guard_preflight' },
        result: { verdict: 'clean', action: 'exempt' },
        providerBoundary: 'not_started',
      });
      if (!resolved.resolved) return jobResult(claim.eventId, resolved.row, 'judgement_claim_fenced');
      store.upsertAssistantDisposition({
        chatId: comment.chatId, messageId: comment.messageId, status: 'allowed', verdict: 'exempt',
        moderationMessageId: comment.platformMessageId, reason: sender.reason, moderationEventId: eventId,
      });
      store.recordModeration({
        eventId, ...comment, verdict: 'clean', confidence: 1, reason: sender.reason,
        mode: config.moderationMode, actions: [],
      });
      return { kind: 'moderated', verdict: 'clean', action: 'exempt', actions: [] };
    }
    let decision;
    // The semantic v3 router may use no history except the deterministic state
    // required to recognise a dispute about an earlier warning. Read it before
    // the non-retrying provider boundary, then use the same snapshot to plan
    // the resulting safety action.
    const strikeState = store.getWeakStrikeState({ chatId: comment.chatId, userId: comment.userId });
    if (!store.markModeratorProviderCalling({ claim, leaseSec: moderatorLeaseSeconds() }).marked) {
      return jobResult(claim.eventId, store.getModeratorJudgement(claim.eventId), 'judgement_claim_fenced');
    }
    try {
      decision = normalizeSafetyClassification(await modelProvider.moderate({
        text: comment.text, chatId: comment.chatId, userId: comment.userId,
        messageId: comment.messageId, platformMessageId: comment.platformMessageId,
        currentWeakStrikes: strikeState.weakStrikes,
        warningStage: strikeState.warningStage,
      }));
    } catch (error) {
      if (isProviderUnavailableError(error)) {
        if (job.safe_retry_count < moderatorRetryLimit()) {
          const deferred = store.deferModeratorJudgement({
            claim,
            nextAttemptAt: store.currentTime() + moderatorRetryDelaySeconds(job.safe_retry_count),
            errorCode: error.code,
          });
          return jobResult(claim.eventId, deferred.row, error.code);
        }
        store.manualReviewModeratorJudgement({
          claim, errorCode: 'provider_unavailable_retry_limit', providerBoundary: 'not_started',
        });
        store.upsertAssistantDisposition({
          chatId: comment.chatId, messageId: comment.messageId, status: 'error',
          moderationMessageId: comment.platformMessageId, reason: 'provider_unavailable_retry_limit', moderationEventId: eventId,
        });
        return jobResult(claim.eventId, store.getModeratorJudgement(claim.eventId));
      }
      store.manualReviewModeratorJudgement({
        claim, errorCode: String(error?.code || 'provider_request_failed').slice(0, 120), providerBoundary: 'unknown',
      });
      store.upsertAssistantDisposition({
        chatId: comment.chatId, messageId: comment.messageId, status: 'error',
        moderationMessageId: comment.platformMessageId, reason: 'moderation_manual_review', moderationEventId: eventId,
      });
      return jobResult(claim.eventId, store.getModeratorJudgement(claim.eventId));
    }
    if (!decision) {
      store.manualReviewModeratorJudgement({ claim, errorCode: 'invalid_safety_verdict', providerBoundary: 'unknown' });
      store.upsertAssistantDisposition({
        chatId: comment.chatId, messageId: comment.messageId, status: 'error',
        moderationMessageId: comment.platformMessageId, reason: 'invalid_safety_verdict', moderationEventId: eventId,
      });
      return jobResult(claim.eventId, store.getModeratorJudgement(claim.eventId));
    }
    decision = applyTelegramSafetySignals(config, decision, comment);
    const plan = planTelegramSafetyAction(decision, strikeState.weakStrikes);
    // The semantic verdict is final before any Telegram enforcement. A crash
    // below this line must not cause another provider call; existing Guard
    // receipts remain the only authority over Telegram effects.
    const resolved = store.resolveModeratorJudgement({
      claim,
      // This operator-visible durable decision intentionally excludes the
      // model's reason/quote/receipt. The private comment snapshot is the only
      // retained message text, and inbound/enforcement receipts remain textless.
      decision: {
        safetyRoute: decision.safetyRoute,
        abuseLevel: decision.abuseLevel,
        confidence: decision.confidence,
        modelId: decision.modelId || null,
        plan,
      },
      result: { verdict: plan.verdict, actionPlan: plan.action },
      providerBoundary: 'returned',
    });
    if (!resolved.resolved) return jobResult(claim.eventId, resolved.row, 'judgement_claim_fenced');
    const assistantDisposition = assistantDispositionForSafety(plan);
    store.upsertAssistantDisposition({
      chatId: comment.chatId, messageId: comment.messageId, ...assistantDisposition,
      moderationMessageId: comment.platformMessageId, reason: decision.reason, moderationEventId: eventId,
    });
    const enforcement = await enforceSafetyPlan(eventId, comment, decision, plan);
    const actions = enforcement.actions || [];
    if (plan.verdict === 'suspect' && ['delete_warn_1', 'delete_warn_2'].includes(enforcement.action)) {
      actions.push(await notifier.notify({ kind: 'moderation_suspect', comment, decision, plan }));
    }
    store.recordModeration({
      eventId, ...comment, ...decision, ...plan, mode: config.moderationMode, actions,
    });
    return {
      kind: 'moderated', verdict: plan.verdict, action: enforcement.action,
      actions, enforcement: enforcement.receipt || null,
    };
  }

  async function handleModerator(eventId, receiptId, comment) {
    const created = store.ensureModeratorJudgement({
      eventId, receiptId, comment, snapshotTtlSec: config.moderatorRecoverySnapshotTtlSec,
    });
    const claimed = store.claimModeratorJudgement({ eventId, leaseSec: moderatorLeaseSeconds() });
    if (!claimed.claimed) return jobResult(eventId, claimed.row || created);
    return runModeratorJudgement(claimed.claim);
  }

  async function routeAssistantQuestion(question) {
    let route;
    try {
      route = normalizeAssistantRoleRoute(await modelProvider.routeAssistant({
        text: question.text,
        chatId: question.chatId,
        userId: question.userId,
        courseOperationsHint: isCourseOperationsSupportQuestion(question.text),
      }));
    } catch (error) {
      if (isProviderUnavailableError(error)) return { error: error.code };
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
    const transport = await assistantTelegram.sendMessage({
      chatId: question.chatId, text: answer.text.trim(), replyToMessageId: question.messageId,
    });
    const receipt = assistantDeliveryReceipt(transport);
    store.recordBoundedAssistantTurn({
      ...question, eventId, question: question.text, answer: answer.text.trim(),
      modelId: answer.modelId, receipt, route,
    }, {
      maxTurns: config.assistantDialogueTurnLimit,
      ttlSeconds: config.assistantDialogueTtlSec,
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
        const result = await sendAssistantTurn(eventId, question, { text: ASSISTANT_HELP_TEXT }, 'command:help');
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'answered' });
        return { ...result, command: 'help' };
      }
      if (!question.text) {
        const result = await sendAssistantTurn(eventId, question, { text: ASSISTANT_EMPTY_ASK_TEXT }, 'command:ask_empty');
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'answered' });
        return { ...result, command: 'ask_empty' };
      }
      const request = store.reserveAssistantRequest({
        eventId,
        chatId: question.chatId,
        userId: question.userId,
        cooldownSec: config.assistantCooldownSec,
        dailyCap: config.assistantDailyPerUser,
      });
      if (!request.allowed) {
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: request.reason });
        return { kind: 'skipped', reason: request.reason };
      }
      // During extraction no course/index source package is admitted. Public
      // identity and boundary replies remain useful without allowing a provider
      // to fill the missing corpus from general knowledge.
      if (config.assistantKnowledgeEnabled !== true) {
        const deterministic = assistantDeterministicReply(question.text);
        const result = await sendAssistantTurn(eventId, question, { text: deterministic.text }, deterministic.route);
        store.completeAssistantRequest(eventId);
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'answered' });
        return result;
      }
      const routing = await routeAssistantQuestion(question);
      if (routing.error) {
        if (isDefinitiveAssistantRoutingExit(routing.error)) store.releaseAssistantRequest(eventId);
        else store.markAssistantRequestUncertain(eventId);
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'skipped' });
        return { kind: 'skipped', reason: routing.error };
      }
      let answer;
      try {
        answer = await modelProvider.answer({
          text: question.text,
          chatId: question.chatId,
          userId: question.userId,
          dialogue: store.recentDialogue(question.chatId, question.userId, {
            limit: config.assistantDialogueTurnLimit,
            ttlSeconds: config.assistantDialogueTtlSec,
          }),
          route: routing.route,
          knowledge: routing.knowledge,
        });
      } catch (error) {
        if (isProviderUnavailableError(error)) {
          // The answer transport may have reached a paid provider before it
          // reported failure. Keep the reservation fenced rather than treating
          // this as a proven zero-call rejection.
          store.markAssistantRequestUncertain(eventId);
          store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'skipped' });
          return { kind: 'skipped', reason: error.code };
        }
        throw error;
      }
      const result = await sendAssistantTurn(eventId, question, answer, routing.route);
      store.completeAssistantRequest(eventId);
      store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'answered' });
      return result;
    } catch (error) {
      store.markAssistantRequestUncertain(eventId);
      store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, outcome: 'error' });
      throw error;
    }
  }

  return {
    async handleUpdate(role, update) {
      const eventId = incomingEventId(role, update);
      const adapterConfig = roleConfig(config, role);
      const classified = classifyTelegramUpdate({
        role, update, acceptedChatIds: adapterConfig.chatIds, botUsername: adapterConfig.botUsername,
        botId: botIdFromToken(adapterConfig.botToken), exemptBotIds: adapterConfig.exemptBotIds,
      });
      const receiptId = eventId;
      const inboundClaim = store.claimInboundDelivery({
        receiptId, role, updateId: update.update_id,
        revisionIdentity: inboundRevisionIdentity(classified, update),
        payloadFingerprint: inboundPayloadFingerprint(update),
      });
      if (!inboundClaim.claimed) {
        return replayInboundResult({ eventId, receiptId, existing: inboundClaim.existing, collision: inboundClaim.collision });
      }
      // Existing moderation/assistant business records still retain their
      // event_id foreign keys. A legacy event without the new receipt is not
      // safe to resume because its payload/effect boundary was never recorded.
      const legacyClaim = store.claimEvent({ eventId, role, updateId: update.update_id });
      if (!legacyClaim.claimed) {
        store.markInboundDeliveryUncertain({ claim: inboundClaim.claim, errorCode: 'legacy_event_unresolved' });
        return { kind: 'uncertain_delivery', eventId, receiptId, reason: 'legacy_event_unresolved', recoveryId: null };
      }
      try {
        const result = classified.kind === 'comment'
          ? await handleModerator(eventId, receiptId, classified.comment)
          : classified.kind === 'question'
            ? await handleAssistant(eventId, classified.question)
            : classified.kind === 'pin_governance'
              ? await handlePinGovernance(eventId, classified.pin)
            : { kind: 'skipped', reason: classified.reason };
        const response = { eventId, ...result };
        const completed = store.completeInboundDelivery({
          claim: inboundClaim.claim,
          status: result.kind === 'skipped' ? 'skipped' : 'completed',
          result: response,
        });
        if (!completed.completed) return { kind: 'uncertain_delivery', eventId, receiptId, reason: 'claim_fenced', recoveryId: null };
        store.completeEvent(eventId, result.kind === 'skipped' ? 'skipped' : 'completed', response);
        return response;
      } catch {
        const marked = store.markInboundDeliveryUncertain({ claim: inboundClaim.claim, errorCode: 'runtime_error' });
        return {
          kind: 'uncertain_delivery', eventId, receiptId,
          reason: marked.marked ? 'runtime_error' : 'claim_fenced', recoveryId: null,
        };
      }
    },
    /** Explicit, side-effect-free recovery: fence in-flight claims into review. */
    recoverInboundDeliveries({ recoveryId }) {
      return store.quarantineProcessingInboundDeliveries({ recoveryId });
    },
    /**
     * Startup/timer recovery is intentionally limited to safe_retry jobs. It
     * first makes stale `calling` rows visible as manual review, then claims at
     * most the requested safe jobs. No inbound, Telegram or provider action is
     * replayed for `calling`, `manual_review` or `resolved` records.
     */
    async recoverModeratorJudgements({ limit = 10, startup = false } = {}) {
      const quarantined = store.quarantineExpiredModeratorCalls({ allCalling: startup === true });
      const outcomes = [];
      const maximum = Math.max(1, Math.min(50, Number(limit) || 10));
      for (let index = 0; index < maximum; index++) {
        const claimed = store.claimNextModeratorJudgement({ leaseSec: moderatorLeaseSeconds() });
        if (!claimed.claimed) break;
        outcomes.push(await runModeratorJudgement(claimed.claim));
      }
      return { ...quarantined, recovered: outcomes.length, outcomes };
    },
    moderatorRecoveryStatus({ limit = 50 } = {}) {
      const status = store.moderatorRecoveryStatus();
      return { states: status.states, jobs: store.listModeratorJudgements({ limit }) };
    },
  };
}
