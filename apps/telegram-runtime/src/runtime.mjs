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
import { createHash } from 'node:crypto';
import { createProviderAdapter, isProviderUnavailableError } from './provider-adapter.mjs';
import {
  ASSISTANT_EMPTY_ASK_TEXT,
  ASSISTANT_HELP_TEXT,
  assistantDeterministicReply,
} from './assistant-policy.mjs';

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
  };
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
    const deleted = await callStep('delete', () => guardAdapter.deleteMessage({
      chatId: comment.chatId, messageId: comment.messageId,
    }));
    if (!deleted.ok) {
      receipt.status = deleted.uncertain ? 'uncertain' : 'guard_unproven';
      await completeEnforcement(planned.claim, deleted.uncertain ? 'uncertain' : 'skipped', receipt, deleted.error);
      return { action: 'purge_unconfirmed', receipt, actions };
    }
    store.recordModerationDeletion({ chatId: comment.chatId, messageId: comment.messageId, state: 'deleted' });
    receipt.status = 'completed';
    await completeEnforcement(planned.claim, 'completed', receipt);
    return { action: banned.ok ? 'ban_purge' : 'delete_no_author', receipt, actions };
  }

  async function handleModerator(eventId, comment) {
    store.observeModerationMessage({
      chatId: comment.chatId, messageId: comment.messageId, revisionIdentity: comment.platformMessageId,
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
      store.upsertAssistantDisposition({
        chatId: comment.chatId, messageId: comment.messageId, status: 'error',
        moderationMessageId: comment.platformMessageId, reason: 'guard_adapter_missing', moderationEventId: eventId,
      });
      return { kind: 'skipped', reason: 'guard_adapter_missing' };
    }
    const sender = await guardAdapter.senderDisposition({
      chatId: comment.chatId,
      userId: comment.userId,
      isBot: comment.isBot,
      senderChatId: comment.senderChatId,
    });
    if (!sender?.proven) {
      store.upsertAssistantDisposition({
        chatId: comment.chatId, messageId: comment.messageId, status: 'error',
        moderationMessageId: comment.platformMessageId,
        reason: sender?.reason || 'sender_exemption_unproven', moderationEventId: eventId,
      });
      return { kind: 'skipped', reason: sender?.reason || 'sender_exemption_unproven' };
    }
    if (sender.exempt) {
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
    try {
      decision = normalizeSafetyClassification(await modelProvider.moderate({
        text: comment.text, chatId: comment.chatId, userId: comment.userId,
        messageId: comment.messageId, platformMessageId: comment.platformMessageId,
      }));
    } catch (error) {
      if (isProviderUnavailableError(error)) {
        store.upsertAssistantDisposition({
          chatId: comment.chatId, messageId: comment.messageId, status: 'error',
          moderationMessageId: comment.platformMessageId, reason: error.code, moderationEventId: eventId,
        });
        return { kind: 'skipped', reason: error.code };
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
    decision = applyTelegramSafetySignals(config, decision, comment);
    const strikeState = store.getWeakStrikeState({ chatId: comment.chatId, userId: comment.userId });
    const plan = planTelegramSafetyAction(decision, strikeState.weakStrikes);
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
          ? await handleModerator(eventId, classified.comment)
          : classified.kind === 'question'
            ? await handleAssistant(eventId, classified.question)
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
  };
}
