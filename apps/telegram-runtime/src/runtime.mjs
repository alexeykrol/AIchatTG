import {
  ASSISTANT_ROLE_ACTIONS,
  ASSISTANT_SOURCE_PACKAGES,
  BOT_ROLES,
  DOMAIN_ROUTE_REASONS,
  GROUNDING_REASONS,
  assistantDispositionForSafety,
  botIdFromToken,
  classifyTelegramUpdate,
  incomingEventId,
  messageIdentity,
  isDefinitiveDomainRouteReason,
  normalizeAssistantDisposition,
  normalizeSafetyClassification,
  planTelegramSafetyAction,
  WARNING_FINAL,
  WARNING_FIRST,
} from '@aichattg/telegram-core';
import { createHash } from 'node:crypto';
import { buildJudgementEnvelope, judgementDigest, judgementPolicy } from './judgement-envelope.mjs';
import {
  createProviderAdapter,
  isProvenNoCallRequestError,
  isProviderUnavailableError,
  providerCallUsage,
  providerFailureDiagnostic,
} from './provider-adapter.mjs';
import { assistantDialogue } from './assistant-dialogue.mjs';
import { ASSISTANT_RELEASE_LINE, assistantReleaseText } from './assistant-release.mjs';
import { ANALYZER_MODES } from './analyzer-adapter.mjs';
import { DEFAULT_DOMAIN_CATALOG } from './assistant-domains.mjs';
import { domainQuestionHints, normalizeDomainSelection, resolveDomainSelection, domainBoundaryReply, diagnosticDomainDecision, selectDomainRoutes } from './assistant-domain-routing.mjs';
import {
  ASSISTANT_EMPTY_ASK_TEXT,
  ASSISTANT_HELP_TEXT,
  ASSISTANT_RETIRED_COMMAND_TEXT,
  ASSISTANT_ROUTER_FAILURE_TEXT,
  ASSISTANT_UNAVAILABLE_TEXT,
  assistantAbstentionReply,
  assistantDeterministicReply,
  coverageDeficitCandidateLevel,
  isAbstentionReason,
  isOutOfCoverageReason,
} from './assistant-policy.mjs';

function roleConfig(config, role) { return role === BOT_ROLES.MODERATOR ? config.moderator : config.assistant; }

/** Journal only the exact examples that supported a registry decision. */
function firedHintNames(hints) {
  return hints?.domains || [];
}

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

function inboundRevisionIdentity(classified, update, acceptedChatIds) {
  const edited = update.edited_message;
  // An edit that removes /ask is still evidence that the command is no longer
  // disposable. Keep its content-free identity even when classification skips
  // it, and before any asynchronous moderation/answer work can begin.
  const rawEditIdentity = edited?.message_id != null && edited?.chat?.id != null
    && acceptedChatIds.map(String).includes(String(edited.chat.id))
    ? messageIdentity(edited, update).platformMessageId : null;
  return classified.comment?.platformMessageId || classified.question?.platformMessageId
    || rawEditIdentity || `update:${update.update_id}`;
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

/**
 * Техническая суть падения — и только она. Молчаливое падение (пустой лог,
 * `error_text = null`) стоило боевого расследования: событие навсегда оставалось
 * `processing`, а причина не сохранялась нигде. Полезная нагрузка сообщения сюда
 * НЕ попадает (персональные данные): класс, код, message и первая строка стека —
 * этого достаточно, чтобы опознать дефект, и недостаточно, чтобы утечь тексту.
 */
function runtimeErrorSummary(error) {
  const name = String(error?.name || error?.constructor?.name || 'Error');
  const code = error?.code == null ? '' : ` code=${String(error.code)}`;
  const message = String(error?.message || '').replace(/\s+/g, ' ').trim();
  const frame = String(error?.stack || '').split('\n').slice(1, 2).join('').trim();
  return `${name}${code}: ${message}${frame ? ` | at ${frame}` : ''}`.slice(0, 1_000);
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
//
// The `retriever_*` codes are decided by opening a local package file or by
// validating the question string, always before the answer model is reached, so
// they are definitive on the same grounds. The rewrite step (input-layer step 5)
// is the one place where a code may follow a *model* call: `rewrite_provider_*`
// is therefore deliberately absent from this set, because a rewrite request can
// be billed even when it reports failure. That asymmetry is the whole point of
// the classification and must survive future edits.
function isDefinitiveAssistantRoutingExit(errorCode) {
  const code = String(errorCode || '');
  return code === 'assistant_route_invalid'
    || code === 'domain_knowledge_invalid'
    || code === 'domain_context_too_large'
    || code === 'domain_retrieval_unavailable'
    || code === 'course_operations_route_required'
    || code === 'course_value_route_required'
    || code === 'knowledge_unavailable'
    || code === 'knowledge_adapter_missing'
    || code === 'knowledge_source_invalid'
    || code === 'knowledge_source_unavailable'
    || code === 'knowledge_identity_missing'
    || code === 'knowledge_identity_mismatch'
    || code === 'retriever_package_missing'
    || code === 'retriever_package_unreadable'
    || code === 'retriever_package_invalid'
    || code === 'retriever_domain_unknown'
    || code === 'retriever_question_invalid'
    || code === 'retriever_pack_missing'
    // Contract self-validation (task B). Reading a schema shipped inside the
    // package and checking our own projection against it happens entirely
    // locally and always before the answer model, so a failure is our defect
    // and the user's quota returns.
    || code === 'retriever_pack_contract_invalid'
    || code === 'retriever_request_contract_invalid'
    // The pack→provider projection. `grounding_pack_missing` means the pack was
    // absent or malformed before the answer call; the other two grounding
    // reasons never arrive here at all, because an ungrounded question is
    // answered with the abstention message instead of being skipped.
    || code === GROUNDING_REASONS.PACK_MISSING
    // v2 binary package admission (input-layer step 1, task B). Each of these
    // is decided while validating a manifest and hashing local files, before
    // any provider call, so the reservation is released.
    || code === 'knowledge_identity_invalid'
    || code === 'knowledge_manifest_missing'
    || code === 'knowledge_manifest_invalid'
    || code === 'knowledge_snapshot_invalid'
    || code === 'knowledge_snapshot_empty'
    || code === 'knowledge_package_manifest_invalid'
    || code === 'knowledge_package_invalid'
    // Step 1 domain veto. Its reasons are computed from the question text and
    // the local dictionary only; the veto runs before the answer model, so a
    // vetoed question costs the user nothing. See isDefinitiveDomainRouteReason,
    // which lives beside the reason codes so a new code cannot be introduced
    // without deciding its billing class.
    || isDefinitiveDomainRouteReason(code);
}

/**
 * Классификация вызова анализатора по цене (боевой контракт §2.3): каждый
 * вызов обязан объявить, дошёл ли он до платного пути. НЕОДНОЗНАЧЕН — только
 * отказ, случившийся ПОСЛЕ выхода в сеть (транспорт, HTTP): там оплата
 * недоказуема ни в одну сторону, и ход фенсится, как фенсится ответный вызов
 * с теми же кодами.
 *
 * Неоднозначными НЕ являются:
 *  - `ok` и `invalid` — ответ провайдера существует, исход вызова известен;
 *    квотная судьба хода дальше решается ровно так же, как решалась бы после
 *    вызова роутера (прецедент: `assistant_route_invalid` — оплаченный вызов
 *    с мусорным маршрутом — возвращает квоту, потому что человек не платит за
 *    наш дефект);
 *  - выходы локальной валидации ДО сети — зеркало isProvenNoCallRequestError:
 *    пустой ход (`analyzer_request_invalid`) и запрос, отвергнутый адаптером
 *    провайдера до fetch (`provider_request_invalid`).
 *
 * Кого нет в списке доказуемо-локальных — тот неоднозначен: ошибка в сторону
 * недоверия оставляет резервацию зафенсенной и не может занизить счёт хода.
 */
function analyzerCallAmbiguous(observation) {
  if (observation == null) return false;
  if (observation.status !== 'error') return false;
  const code = String(observation.code || '');
  return code !== 'analyzer_request_invalid' && code !== 'provider_request_invalid';
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

/**
 * Модерация хода ассистента. Обычный отправитель ждёт вердикта модератора —
 * контракт «ассистент не отвечает на непромодерированное» держится.
 *
 * Синтетик — единственное исключение, и оно вынужденное, а не удобное.
 * ЗАМЕР (2026-08-16, четыре пробы в тестовом чате): модератор НЕ получает от
 * Telegram ни одного сообщения бота-синтетика — ни команды, ни обычного
 * текста, — тогда как ассистент получает все. Оба бота администраторы, у обоих
 * privacy включён, вебхуки настроены одинаково; разницу задаёт Telegram, и
 * снаружи она не управляется. Значит вердикта по синтетику не может
 * существовать в принципе: ждать его — это не «строже», это выключить
 * синтетическую полосу целиком при полностью написанной функции.
 *
 * Обход требует ВСЕХ трёх условий сразу: включён режим синтетического
 * тестирования, отправитель — бот, и этот бот назван в списке синтетиков.
 * Живой человек не может попасть под него ни при какой конфигурации.
 * Результат хода всегда несёт `moderation.reason`, поэтому обойдённая
 * модерация видна в журнале, а не подразумевается.
 */
async function assistantModeration(store, config, question, wait) {
  if (config.syntheticTestingEnabled === true && question.isSyntheticSender === true) {
    return { status: 'allowed', verdict: null, reason: 'synthetic_sender_unmoderated' };
  }
  return waitForAssistantDisposition(store, config, question, wait);
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
  // The retriever over the admitted v2 content package. Absent by default so a
  // deployment that has not admitted a package keeps the previous snapshot
  // behaviour instead of failing closed on a path it never enabled.
  contentRetrieval = null,
  domainCatalog = DEFAULT_DOMAIN_CATALOG,
  sourceRetrievals = {},
  // Анализатор запроса. Отсутствует по умолчанию: деплой, который его не
  // включал, обязан вести себя ровно как прежде — без вызова и без записи.
  analyzer = null,
  workingStateProvider = null,
  durableAnswerReceipts = false,
  wait = sleep,
  // Test-only crash injection. Production bootstrap never supplies hooks.
  testHooks = null,
}) {
  const modelProvider = provider || llm || createProviderAdapter({ enabled: false }, { domainCatalog });
  for (const consumer of [modelProvider, analyzer]) {
    if (consumer?.domainCatalogDigest && consumer.domainCatalogDigest !== domainCatalog.digest) {
      throw new Error('assistant_domain_catalog_mismatch');
    }
  }
  const retrievals = sourceRetrievals instanceof Map ? new Map(sourceRetrievals) : new Map(Object.entries(sourceRetrievals));
  // Compatibility adapter for the already admitted course package. New sources
  // use sourceRetrievals; the resolver itself never assumes a subject.
  if (contentRetrieval && !retrievals.has(ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT)) {
    retrievals.set(ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT, contentRetrieval);
  }
  const guardAdapter = guard;
  const activeJudgements = new Map();
  function judgementIsCurrent(eventId) {
    if (!store.isCurrentJudgement(eventId)) return false;
    const envelope = store.getJudgementEnvelope(eventId);
    return !envelope || envelope.policy_hash === judgementDigest(judgementPolicy(config));
  }

  async function scheduleJudgement(envelope) {
    if (activeJudgements.has(envelope.event_id)) return activeJudgements.get(envelope.event_id);
    const run = (async () => {
      const claim = store.claimModeratorJudgement({ eventId: envelope.event_id, leaseSec: moderatorLeaseSeconds() });
      if (claim.claimed) return runModeratorJudgement(claim.claim);
      return jobResult(envelope.event_id, claim.row);
    })();
    activeJudgements.set(envelope.event_id, run);
    try { return await run; } finally { activeJudgements.delete(envelope.event_id); }
  }

  // Routing receipts contain only bounded contract fields. Never retain raw
  // provider text, diagnostic evidence, questions, dialogue or knowledge here.
  function normalizedRoutingChoice(selection) {
    if (!selection) return null;
    return {
      domains: selection.routes.map((route) => route.domainId),
      routes: selection.routes.map(({ domainId, action, sourceId }) => ({ domainId, action, sourceId })),
      riskFlags: [...selection.riskFlags],
    };
  }

  function routingPrimacy(primacy) {
    if (!primacy) return null;
    const ruleId = typeof primacy.ruleId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/u.test(primacy.ruleId)
      ? primacy.ruleId : null;
    return { ruleId,
      from: domainCatalog.get(primacy.from) ? primacy.from : null,
      to: domainCatalog.get(primacy.to) ? primacy.to : null };
  }

  function captureRoutingDiagnosis(context, {
    selection = null, rawSelection = selection, hints, origin = 'router', primacy = null,
    analyzerAttempt = null, error = null,
  }) {
    const decision = selection ? selectDomainRoutes(selection, { catalog: domainCatalog, hints }) : null;
    context.routingDiagnosis = {
      schemaVersion: 'assistant-routing-diagnosis-v1', origin,
      registryDigest: domainCatalog.digest,
      selectionStatus: rawSelection ? 'valid' : error === 'router_unavailable' ? 'unavailable' : 'invalid',
      rawModelChoice: normalizedRoutingChoice(rawSelection),
      afterPrimacyDomains: selection?.routes.map((route) => route.domainId) || [],
      finalDomains: decision?.routes.map((route) => route.domainId) || [],
      exactExampleDomains: [...(hints.domains || [])],
      primacy: routingPrimacy(primacy),
      override: {
        applied: Boolean(decision?.arbitration),
        debt: decision?.arbitration?.debt || null,
      },
      riskFlags: [...(rawSelection?.riskFlags || [])],
      analyzerAttempt, error,
    };
  }

  async function completeEnforcement(claim, status, receipt, errorCode = null) {
    const completed = store.completeModerationEnforcement({ claim, status, receipt, errorCode });
    return { receipt, persisted: completed.completed === true, status };
  }

  /**
   * Delete only the exact, same-user bare-command/prompt pair whose completed
   * receipt proves ownership. Claim before any external call: a crash or an
   * ambiguous Telegram result must never cause another deletion attempt.
   */
  async function executeAssistantAskCleanup(eventId, claim) {
    try {
      if (!claim) return;
      async function remove(messageId, target, adapter, actor) {
        if (claim.durable && !store.validateAssistantAskPromptCleanupClaim(claim)) {
          return { state: 'skipped', reason: 'delete_precondition_unproven', actor };
        }
        if (typeof adapter?.deleteMessage !== 'function') {
          return { state: 'skipped', reason: `${actor}_delete_unavailable`, actor };
        }
        try {
          const result = await adapter.deleteMessage({
            chatId: claim.chatId, messageId,
            ...(target === 'command' ? {
              // Guard runs this synchronously AFTER its asynchronous live
              // rights check, immediately before invoking raw deleteMessage.
              beforeDelete: () => claim.durable
                ? store.validateAssistantAskPromptCleanupClaim(claim) : store.isAssistantAskCommandUnedited(claim),
            } : {}),
          });
          if (result?.ok === true) return { state: 'deleted', actor };
          console.error(`[runtime] ask cleanup failed event=${eventId} target=${target} `
            + `error=${String(result?.error || result?.skipped || 'telegram_refused').slice(0, 120)}`);
          return {
            state: result?.uncertain === true ? 'uncertain' : 'skipped', actor,
            reason: result?.skipped ? String(result.skipped).slice(0, 120) : 'telegram_refused',
          };
        } catch {
          console.error(`[runtime] ask cleanup uncertain event=${eventId} target=${target}`);
          return { state: 'uncertain', reason: 'delete_transport_unknown', actor };
        }
      }
      // Own hint uses its author token. User-message deletion always follows
      // Guard's existing configured-chat and live-rights proof; there is no
      // second-token fallback or permission mutation after any attempted call.
      const prompt = await remove(claim.promptMessageId, 'prompt', assistantTelegram, 'assistant');
      const command = await remove(claim.commandMessageId, 'command', guardAdapter, 'guard');
      if (claim.durable === true) store.completeAssistantAskPromptJob({ claim, prompt, command });
      else store.completeAssistantAskCleanup({ claim, prompt, command });
    } catch (error) {
      // Cleanup is secondary to an already delivered and recorded answer.
      console.error(`[runtime] ask cleanup failed event=${eventId} ${runtimeErrorSummary(error)}`);
    }
  }

  async function cleanupAssistantAskPrompt(eventId, question, { confirmedAnswer = true } = {}) {
    if (!question.replyToMessageId || !question.text?.trim()) return;
    if (confirmedAnswer && question.replyToAssistant) store.observeAssistantAskPromptAnswer({
      chatId: question.chatId, userId: question.userId, promptMessageId: question.replyToMessageId, answerEventId: eventId,
    });
    // Durable jobs are the only authority minted by a newly delivered hint.
    // The legacy scan is retained solely for pre-upgrade service pairs that
    // have no honest 30-second deadline and therefore are never timer-cleaned.
    const durable = store.claimAnsweredAssistantAskPrompt({
      chatId: question.chatId, userId: question.userId, promptMessageId: question.replyToMessageId, answerEventId: eventId,
    });
    const durableJob = durable ? null : store.getAssistantAskPromptJob({
      chatId: question.chatId, userId: question.userId, promptMessageId: question.replyToMessageId,
    });
    const legacy = durable || durableJob ? null : store.claimAssistantAskCleanup({
      chatId: question.chatId, userId: question.userId,
      promptMessageId: question.replyToMessageId, questionMessageId: question.messageId,
      answerEventId: eventId,
    });
    await executeAssistantAskCleanup(eventId, durable || legacy);
  }

  async function expireAssistantAskPrompts({ limit = 10 } = {}) {
    const outcomes = [];
    const maximum = Math.max(1, Math.min(50, Number(limit) || 10));
    for (let index = 0; index < maximum; index++) {
      const claim = store.claimNextCompletedAssistantAskPrompt() || store.claimNextExpiredAssistantAskPrompt();
      if (!claim) break;
      await executeAssistantAskCleanup(`ask-expiry:${claim.eventId}`, claim);
      outcomes.push({ eventId: claim.eventId, source: claim.source });
    }
    return { expired: outcomes.length, outcomes };
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

  async function enforceSafetyPlan(eventId, comment, plan, { initialClaim = null } = {}) {
    if (!judgementIsCurrent(eventId)) return { action: 'stale_judgement', actions: [] };
    const existing = store.getModerationEnforcement(eventId);
    if (!existing) return { action: 'enforcement_receipt_missing', actions: [], pending: true };
    let persistedPlan;
    try { persistedPlan = JSON.parse(existing.policy_json); } catch { persistedPlan = null; }
    if (!persistedPlan || canonicalJson(persistedPlan) !== canonicalJson(plan)) {
      return { action: 'enforcement_plan_invalid', receipt: existing, actions: [], pending: true };
    }
    let claim = initialClaim;
    let resumed = false;
    if (!claim) {
      // Only `planned` proves that no Guard action was marked calling. All
      // other states are terminal or ambiguous and never get a Telegram retry.
      if (existing.status !== 'planned') {
        return { action: 'enforcement_already_recorded', receipt: existing, actions: [] };
      }
      const resumedClaim = store.resumePlannedModerationEnforcement({ eventId });
      if (!resumedClaim.claimed) {
        return { action: 'enforcement_already_recorded', receipt: resumedClaim.row, actions: [] };
      }
      claim = resumedClaim.claim;
      resumed = true;
    } else if (existing.status !== 'planned') {
      return { action: 'enforcement_already_recorded', receipt: existing, actions: [] };
    }

    const receipt = enforcementReceipt(plan);
    if (plan.duplicateNative === true) {
      receipt.status = 'duplicate_native_revision';
      await completeEnforcement(claim, 'skipped', receipt, 'duplicate_native_revision');
      return { action: 'duplicate_native_revision', receipt, actions: [] };
    }
    // Clean is terminal Moderator work, but still uses its pre-persisted
    // receipt so recovery cannot mint a second record.
    if (plan.action === 'none') {
      receipt.status = 'clean';
      await completeEnforcement(claim, 'skipped', receipt, 'clean');
      return { action: 'none', receipt, actions: [] };
    }
    if (config.moderationMode !== 'live') {
      receipt.status = 'shadow';
      await completeEnforcement(claim, 'skipped', receipt, 'shadow_mode');
      return { action: 'shadow', receipt, actions: [] };
    }

    // The receipt and (when weak) strike reservation already exist before this
    // read-only Guard preflight. Recovery consumes that immutable policy only.
    const guardProof = !guardAdapter || typeof guardAdapter.verifyEnforcement !== 'function'
      ? { proven: false, reason: 'guard_adapter_missing' }
      : await guardAdapter.verifyEnforcement({ chatId: comment.chatId });
    receipt.guard = guardProof == null ? null : {
      proven: guardProof.proven === true,
      reason: guardProof.reason || null,
      status: guardProof.status || null,
    };
    if (!guardProof?.proven) {
      receipt.status = 'guard_unproven';
      await completeEnforcement(claim, 'skipped', receipt, guardProof?.reason || 'guard_rights_unproven');
      return { action: 'guard_unproven', receipt, actions: [], reason: guardProof?.reason || 'guard_rights_unproven' };
    }

    const actions = [];
    await testHooks?.afterEnforcementPlanned?.({ eventId, plan, resumed });
    const callStep = async (name, invoke) => {
      receipt.steps[name] = { status: 'calling' };
      const calling = store.markModerationEnforcementCalling({ claim, receipt });
      if (!calling.marked) return { ok: false, error: 'enforcement_claim_fenced', uncertain: true };
      const result = redactedActionResult(await invoke(), `${name}_failed`);
      receipt.steps[name] = { status: result.ok ? 'completed' : result.uncertain ? 'uncertain' : 'skipped', ...result };
      actions.push({ step: name, ...receipt.steps[name] });
      return result;
    };
    if (plan.action === 'delete_warn_1' || plan.action === 'delete_warn_2') {
      const deleted = await callStep('delete', () => guardAdapter.deleteMessage({
        chatId: comment.chatId, messageId: comment.messageId,
        beforeDelete: () => judgementIsCurrent(eventId),
      }));
      if (!deleted.ok) {
        receipt.status = deleted.uncertain ? 'uncertain' : 'guard_unproven';
        await completeEnforcement(claim, deleted.uncertain ? 'uncertain' : 'skipped', receipt, deleted.error);
        return { action: 'abuse_delete_unconfirmed', receipt, actions };
      }
      store.recordModerationDeletion({ chatId: comment.chatId, messageId: comment.messageId, state: 'deleted' });
      const warned = await callStep('warning', () => guardAdapter.sendWarning({
        chatId: comment.chatId,
        messageId: comment.messageId,
        text: plan.action === 'delete_warn_1' ? WARNING_FIRST : WARNING_FINAL,
        beforeAction: () => judgementIsCurrent(eventId),
      }));
      if (!warned.ok) {
        receipt.status = warned.uncertain ? 'uncertain' : 'guard_unproven';
        await completeEnforcement(claim, warned.uncertain ? 'uncertain' : 'skipped', receipt, warned.error);
        return { action: 'abuse_warning_unconfirmed', receipt, actions };
      }
      store.markWarningDelivered({
        chatId: comment.chatId, userId: comment.userId, eventId,
        stage: plan.action === 'delete_warn_1' ? 'first' : 'final',
      });
      receipt.status = 'completed';
      await completeEnforcement(claim, 'completed', receipt);
      return { action: plan.action, receipt, actions };
    }

    const banned = await callStep('ban', () => guardAdapter.banAuthor({
      chatId: comment.chatId, userId: comment.userId, senderChatId: comment.senderChatId,
      beforeAction: () => judgementIsCurrent(eventId),
    }));
    if (!banned.ok && banned.uncertain) {
      receipt.status = 'uncertain';
      await completeEnforcement(claim, 'uncertain', receipt, banned.error);
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
      const deleted = await callStep(`delete:${target.messageId}`, () => guardAdapter.deleteMessage({
        ...target, beforeDelete: () => judgementIsCurrent(eventId),
      }));
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
    // Deleting the known messages cannot complete a plan that also requires a
    // ban. Definitive ban skips remain terminal, even when the permitted purge
    // succeeds; an ambiguous purge still takes precedence over that skip.
    const completed = banned.ok && receipt.purge.failed === 0;
    receipt.status = uncertain ? 'uncertain' : completed ? 'completed' : 'guard_unproven';
    await completeEnforcement(
      claim,
      uncertain ? 'uncertain' : completed ? 'completed' : 'skipped',
      receipt,
      uncertain ? 'purge_uncertain' : receipt.purge.failed ? 'purge_unconfirmed' : banned.ok ? null : banned.error,
    );
    return {
      action: receipt.purge.failed
        ? 'purge_unconfirmed'
        : banned.ok ? 'ban_purge' : 'ban_unconfirmed',
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
    if (!judgementIsCurrent(eventId)) {
      store.manualReviewModeratorJudgement({ claim, errorCode: 'stale_judgement', providerBoundary: 'not_started' });
      return { kind: 'moderation_manual_review', eventId, reason: 'stale_judgement' };
    }
    const envelope = store.getJudgementEnvelope(eventId);
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
    const syntheticExempt = envelope?.owner === 'assistant' && config.syntheticTestingEnabled === true
      && comment.isBot === true && (config.assistant?.syntheticBotIds || []).map(String).includes(String(comment.userId));
    if (!syntheticExempt && (!guardAdapter || typeof guardAdapter.senderDisposition !== 'function')) {
      store.manualReviewModeratorJudgement({ claim, errorCode: 'guard_adapter_missing', providerBoundary: 'not_started' });
      store.upsertAssistantDisposition({
        chatId: comment.chatId, messageId: comment.messageId, status: 'error',
        moderationMessageId: comment.platformMessageId, reason: 'guard_adapter_missing', moderationEventId: eventId,
      });
      return jobResult(claim.eventId, store.getModeratorJudgement(claim.eventId));
    }
    let sender;
    try {
      sender = syntheticExempt ? { proven: true, exempt: true, reason: 'synthetic_sender_unmoderated' }
        : await guardAdapter.senderDisposition({
        chatId: comment.chatId,
        userId: comment.userId,
        isBot: comment.isBot,
        senderChatId: comment.senderChatId,
      });
    } catch {
      sender = { proven: false, reason: 'telegram_membership_unavailable' };
    }
    if (!judgementIsCurrent(eventId)) {
      store.manualReviewModeratorJudgement({ claim, errorCode: 'stale_judgement', providerBoundary: 'not_started' });
      return { kind: 'moderation_manual_review', eventId, reason: 'stale_judgement' };
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
      const resolved = store.resolveJudgementExemption({ claim, comment, reason: sender.reason || 'sender_exempt' });
      if (!resolved.resolved) return jobResult(claim.eventId, resolved.row, 'judgement_claim_fenced');
      store.recordModeration({
        eventId, ...comment, verdict: 'clean', confidence: 1, reason: sender.reason,
        mode: config.moderationMode, actions: [],
      });
      return { kind: 'moderated', verdict: 'clean', action: 'exempt', actions: [] };
    }
    let decision;
    /**
     * Цена модерации — самого частого платного вызова рантайма: он идёт на
     * КАЖДОМ сообщении чата. Берётся АГРЕГАТ обеих ступеней контракта (роутер
     * и, для оскорблений, классификатор тяжести), а не квитанция последнего
     * вызова: та занизила бы счёт ровно на целый оплаченный вызов. До
     * прохождения границы провайдера расход пуст — это «вызова не было», а не
     * ноль.
     */
    let moderationUsage = providerCallUsage(null);
    // The semantic v3 router may use no history except the deterministic state
    // required to recognise a dispute about an earlier warning. Read it before
    // the non-retrying provider boundary, then use the same snapshot to plan
    // the resulting safety action.
    const strikeState = store.judgementContext(eventId)
      || store.getWeakStrikeState({ chatId: comment.chatId, userId: comment.userId });
    if (!store.markModeratorProviderCalling({ claim, leaseSec: moderatorLeaseSeconds() }).marked) {
      return jobResult(claim.eventId, store.getModeratorJudgement(claim.eventId), 'judgement_claim_fenced');
    }
    const submissionClaim = envelope ? store.issueJudgementSubmissionClaim(claim) : null;
    let semantic;
    try {
      const classified = await modelProvider.moderate({
        text: comment.text, chatId: comment.chatId, userId: comment.userId,
        messageId: comment.messageId, platformMessageId: comment.platformMessageId,
        currentWeakStrikes: strikeState.weakStrikes,
        warningStage: strikeState.warningStage,
        judgeOwner: envelope?.owner || 'moderator',
      });
      semantic = classified;
      decision = normalizeSafetyClassification(classified);
      moderationUsage = providerCallUsage(classified?.safetyTrace?.usage);
    } catch (error) {
      if (!judgementIsCurrent(eventId)) {
        store.manualReviewModeratorJudgement({ claim, errorCode: 'stale_judgement', providerBoundary: 'unknown' });
        return { kind: 'moderation_manual_review', eventId, reason: 'stale_judgement' };
      }
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
        providerDiagnostic: providerFailureDiagnostic(error),
      });
      store.upsertAssistantDisposition({
        chatId: comment.chatId, messageId: comment.messageId, status: 'error',
        moderationMessageId: comment.platformMessageId, reason: 'moderation_manual_review', moderationEventId: eventId,
      });
      return jobResult(claim.eventId, store.getModeratorJudgement(claim.eventId));
    }
    if (!judgementIsCurrent(eventId)) {
      store.manualReviewModeratorJudgement({ claim, errorCode: 'stale_judgement', providerBoundary: 'returned' });
      return { kind: 'moderation_manual_review', eventId, reason: 'stale_judgement' };
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
    // Commit the provider verdict together with the exact policy and any weak
    // strike reservation before reading Guard rights or taking Telegram action.
    // No later recovery path may derive this policy from a live counter.
    const reserveWeakStrike = config.moderationMode === 'live'
      && decision.safetyRoute === 'abuse' && decision.abuseLevel === 'weak';
    const ready = envelope ? store.submitJudgementVerdict(submissionClaim, semantic)
      : store.persistModeratorDecisionAndEnforcement({
      claim,
      // This operator-visible durable decision intentionally excludes the
      // model's reason/quote/receipt. The private comment snapshot is the only
      // retained message text, and inbound/enforcement receipts remain textless.
      decision: {
        safetyRoute: decision.safetyRoute,
        abuseLevel: decision.abuseLevel,
        confidence: decision.confidence,
        modelId: decision.modelId || null,
        // Четыре числа, и ни одного слова: счётчики текста не несут, поэтому
        // запрет на хранение сказанного моделью их не касается. Долговечными
        // они обязаны быть по другой причине — вызов уже оплачен ЗДЕСЬ, а
        // запись модерации может быть дописана другим процессом после падения.
        // Без этого поля восстановленный ход выглядел бы бесплатным.
        usage: moderationUsage,
      },
      chatId: comment.chatId,
      messageId: comment.messageId,
      revisionIdentity: comment.platformMessageId,
      userId: comment.userId,
      isWeak: reserveWeakStrike,
      // Shadow policies retain the observed pre-provider context but do not
      // mutate weak strikes; live weak policies obtain their count only in the
      // atomic reservation transaction above.
      derivePolicy: (reservedStrikeBefore) => planTelegramSafetyAction(
        decision, reserveWeakStrike ? reservedStrikeBefore : strikeState.weakStrikes,
      ),
    });
    if (!ready.ready) return jobResult(claim.eventId, ready.row || store.getModeratorJudgement(eventId), ready.reason || 'judgement_claim_fenced');
    if (envelope) decision = { ...ready.decision, reason: 'judgement_accepted', quote: '' };
    const plan = ready.enforcement.policy;
    await testHooks?.afterDecisionReady?.({ eventId, plan });
    if (!judgementIsCurrent(eventId)) return { kind: 'moderation_manual_review', eventId, reason: 'stale_judgement' };
    const assistantDisposition = assistantDispositionForSafety(plan);
    store.upsertAssistantDisposition({
      chatId: comment.chatId, messageId: comment.messageId, ...assistantDisposition,
      moderationMessageId: comment.platformMessageId, reason: decision.reason, moderationEventId: eventId,
    });
    const enforcement = await enforceSafetyPlan(eventId, comment, plan, { initialClaim: ready.enforcement.claim });
    const actions = enforcement.actions || [];
    if (plan.verdict === 'suspect' && ['delete_warn_1', 'delete_warn_2'].includes(enforcement.action)) {
      actions.push(await notifier.notify({ kind: 'moderation_suspect', comment, decision, plan }));
    }
    store.recordModeration({
      eventId, ...comment, ...decision, ...plan, mode: config.moderationMode, actions,
      usage: moderationUsage,
    });
    store.completeModeratorDecision({ eventId });
    return {
      kind: 'moderated', verdict: plan.verdict, action: enforcement.action,
      actions, enforcement: enforcement.receipt || null,
    };
  }

  function readDurableModeratorDecision(job) {
    let snapshot;
    let durableDecision;
    try { snapshot = JSON.parse(job?.snapshot_json || ''); } catch { snapshot = null; }
    try { durableDecision = JSON.parse(job?.decision_json || ''); } catch { durableDecision = null; }
    const comment = snapshot?.schemaVersion === 'moderator-comment-v1' && snapshot?.expired !== true
      ? snapshot.comment : null;
    const decision = normalizeSafetyClassification(durableDecision);
    const storedPlan = durableDecision?.plan;
    const { duplicateNative = false, ...storedPolicy } = storedPlan && typeof storedPlan === 'object' ? storedPlan : {};
    let expectedPlan;
    try {
      expectedPlan = storedPlan == null ? null : planTelegramSafetyAction(decision, storedPolicy.strikeBefore);
    } catch { expectedPlan = null; }
    if (!comment || !decision || !expectedPlan || typeof duplicateNative !== 'boolean'
      || canonicalJson(storedPolicy) !== canonicalJson(expectedPlan)) return null;
    return {
      comment,
      decision,
      // Цена вызова, сделанного ДО падения. Этот процесс никого не вызывал, и
      // выдумать расход ему нечем: снимок без счётчиков (запись до появления
      // учёта) читается как «не измерено», а не как бесплатный ход.
      usage: providerCallUsage(durableDecision?.usage),
      plan: duplicateNative ? { ...expectedPlan, duplicateNative: true } : expectedPlan,
    };
  }

  /**
   * A ready decision has crossed only the provider boundary. It may create an
   * initial receipt or resume a still-planned receipt, but `calling` and
   * `uncertain` Guard receipts are evidence of an ambiguous external action
   * and are terminalized without a second Telegram call.
   */
  async function recoverDecisionReadyModeratorJob(job) {
    if (!judgementIsCurrent(job.event_id)) {
      store.manualReviewDecisionReadyModeratorJudgement({ eventId: job.event_id, errorCode: 'stale_judgement' });
      return { kind: 'moderation_manual_review', eventId: job.event_id, reason: 'stale_judgement' };
    }
    const durable = readDurableModeratorDecision(job);
    if (!durable) {
      const reviewed = store.manualReviewDecisionReadyModeratorJudgement({
        eventId: job?.event_id,
        errorCode: 'durable_decision_or_snapshot_invalid',
      });
      return jobResult(job?.event_id, reviewed.row, 'durable_decision_or_snapshot_invalid');
    }
    const { comment, decision, plan, usage } = durable;
    store.observeModerationMessage({
      chatId: comment.chatId, messageId: comment.messageId, userId: comment.userId,
      revisionIdentity: comment.platformMessageId,
    });
    const assistantDisposition = assistantDispositionForSafety(plan);
    store.upsertAssistantDisposition({
      chatId: comment.chatId, messageId: comment.messageId, ...assistantDisposition,
      moderationMessageId: comment.platformMessageId,
      reason: 'moderator_decision_recovered', moderationEventId: job.event_id,
    });
    let enforcement = store.getModerationEnforcement(job.event_id);
    if (!enforcement) {
      // `decision_ready` rows created by the rejected d71 candidate did not
      // reserve a weak strike or persist a receipt. Their fixed weak plan must
      // be quarantined rather than reconstructed from the current counter.
      if (decision.safetyRoute === 'abuse' && decision.abuseLevel === 'weak') {
        const reviewed = store.manualReviewDecisionReadyModeratorJudgement({
          eventId: job.event_id, errorCode: 'legacy_weak_plan_unreserved',
        });
        return jobResult(job.event_id, reviewed.row, 'legacy_weak_plan_unreserved');
      }
      const created = store.claimModerationEnforcement({
        eventId: job.event_id, chatId: comment.chatId, messageId: comment.messageId, policy: plan,
      });
      if (!created.claimed && !created.existing) {
        return { kind: 'moderation_deferred', eventId: job.event_id, reason: 'legacy_enforcement_receipt_missing' };
      }
      enforcement = created.claimed ? store.getModerationEnforcement(job.event_id) : created.existing;
    }
    if (!enforcement || (
      enforcement.status === 'planned'
      && plan.duplicateNative !== true
      && decision.safetyRoute === 'abuse'
      && decision.abuseLevel === 'weak'
      && !store.hasWeakStrikeReservation({
        eventId: job.event_id, chatId: comment.chatId, messageId: comment.messageId, userId: comment.userId,
      })
    )) {
      const reviewed = store.manualReviewDecisionReadyModeratorJudgement({
        eventId: job.event_id, errorCode: 'weak_strike_reservation_missing',
      });
      return jobResult(job.event_id, reviewed.row, 'weak_strike_reservation_missing');
    }
    const enforcementResult = await enforceSafetyPlan(job.event_id, comment, plan);
    if (enforcementResult.pending === true) {
      return {
        kind: 'moderation_deferred', eventId: job.event_id,
        reason: enforcementResult.reason || enforcementResult.action,
      };
    }
    // Notifications are deliberately not replayed: unlike the Guard receipt,
    // their prior delivery cannot be proved from this job.
    store.recordModeration({
      eventId: job.event_id, ...comment, ...decision, ...plan,
      mode: config.moderationMode, actions: enforcementResult.actions || [],
      // Расход того самого вызова, что был оплачен до падения: он доехал сюда
      // долговечной записью решения. Иначе восстановленный ход — единственный,
      // где оплаченная модерация не оставила бы следа.
      usage,
    });
    store.completeModeratorDecision({ eventId: job.event_id });
    return {
      kind: 'moderated', eventId: job.event_id, recovered: true,
      verdict: plan.verdict, action: enforcementResult.action,
      actions: enforcementResult.actions || [], enforcement: enforcementResult.receipt || null,
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

  /**
   * Расход роутера уезжает вместе с маршрутом (`routerUsage`) и прикладывается
   * к ЛЮБОМУ исходу: вызов оплачен и тогда, когда его ответ оказался негодным.
   * Учёт, считающий только удачные вызовы, показывал бы систему дешевле, чем
   * она есть, — а нужен ровно обратный эффект.
   */
  async function routeAssistantQuestion(question, hints, dialogue, workingState, context,
    { origin = 'router', analyzerAttempt = null } = {}) {
    let answered;
    try {
      answered = await modelProvider.routeAssistant({
        text: question.text,
        chatId: question.chatId,
        userId: question.userId,
        domainHints: hints,
        dialogue,
        ...(workingState ? { working_state: workingState } : {}),
      });
    } catch (error) {
      // Провайдера нет вовсе — вызова не было, и расхода тоже: квитанции здесь
      // не существует, поэтому счётчики остаются пустыми, а не нулевыми.
      if (isProviderUnavailableError(error)) {
        captureRoutingDiagnosis(context, { hints, origin, analyzerAttempt, error: 'router_unavailable' });
        return { error: error.code, routerUsage: providerCallUsage(error?.receipt) };
      }
      throw error;
    }
    const routerUsage = providerCallUsage(answered?.receipt);
    const selection = normalizeDomainSelection(answered, domainCatalog);
    captureRoutingDiagnosis(context, { selection, hints, origin, analyzerAttempt,
      error: selection ? null : 'selection_invalid' });
    if (!selection) return { error: 'assistant_route_invalid', routerUsage };
    return { ...(await resolveAssistantRoute(question, hints, selection, dialogue)), routerUsage };
  }

  /** Both router modes resolve the same registered source capabilities. */
  async function resolveAssistantRoute(question, hints, selection, dialogue) {
    return resolveDomainSelection(selection, { catalog: domainCatalog, knowledge, retrievals, question, dialogue, hints });
  }

  /**
   * История диалога — контекст беседы, а не журнал доставок. Служебный текст
   * («после /ask напишите вопрос», справка, снятая команда) — реакция интерфейса
   * на пустой или устаревший ввод, а не ход разговора: он ничего не добавляет к
   * пониманию следующего вопроса. Поэтому такие ответы доставляются и квитуются,
   * но в `runtime_assistant_turns` НЕ попадают (`persist: false`).
   *
   * Цена ошибки замерена на бою: служебный ход писался с пустым вопросом,
   * отравлял историю, и все последующие вопросы этого человека молча падали.
   * Ответ-воздержание («в материалах этого нет») сюда НЕ относится — это
   * настоящий ответ на настоящий вопрос, он остаётся в истории.
   */
  async function sendAssistantTurn(eventId, question, answer, route = null,
    { persist = true, markup = false, knowledge = null, forceReply = false } = {}) {
    if (!answer || typeof answer.text !== 'string' || !answer.text.trim()) {
      throw new Error('assistant adapter returned an empty answer');
    }
    if (question.judgementEventId && !judgementIsCurrent(question.judgementEventId)) {
      return { kind: 'skipped', reason: 'stale_judgement', deliveryUncertain: true };
    }
    // Разметка включается только там, где текст ПИСАЛА модель: её промпты
    // требуют структуры, и без разбора читатель видел `**жирный**` буквально.
    // Служебные и детерминированные ответы — код-owned плоский текст, им
    // рендер не нужен и добавил бы класс ошибок на ровном месте.
    const beforeSend = () => (!question.judgementEventId || judgementIsCurrent(question.judgementEventId))
      && (!question.answerClaim || store.markAssistantAnswerCalling(question.answerClaim));
    if (!beforeSend()) return { kind: 'skipped', reason: 'stale_answer_claim', deliveryUncertain: true };
    let transport;
    try {
      transport = await assistantTelegram.sendMessage({
        chatId: question.chatId, text: answer.text.trim(), replyToMessageId: question.messageId,
        markup, forceReply, footer: ASSISTANT_RELEASE_LINE, beforeSend,
      });
    } catch (error) {
      if (question.answerClaim) store.completeAssistantAnswerDelivery({ claim: question.answerClaim, state: 'uncertain' });
      throw error;
    }
    if (question.answerClaim) store.completeAssistantAnswerDelivery({ claim: question.answerClaim,
      state: transport?.ok === true && !transport?.partial && !transport?.uncertain ? 'confirmed' : 'uncertain' });
    // Деградация доставки не отменяет квитанцию: ответ дошёл, просто не целиком
    // или без оформления, а повтор целого ответа задвоил бы уже доставленное.
    // Но она обязана быть видна в журнале — иначе усечённый ответ выглядит
    // безупречным.
    if (transport?.degraded || transport?.partial) {
      console.error(`[runtime] assistant delivery degraded event=${eventId} `
        + `mode=${transport.partial ? 'partial' : String(transport.degraded)} `
        + `error=${String(transport.error || '').slice(0, 120)}`);
    }
    const receipt = assistantDeliveryReceipt(transport);
    if (persist) {
      store.recordBoundedAssistantTurn({
        ...question, eventId, question: question.text, answer: answer.text.trim(),
        modelId: answer.modelId, receipt, route,
      }, {
        maxTurns: config.assistantDialogueTurnLimit,
        ttlSeconds: config.assistantDialogueTtlSec,
      });
      // Долговечная запись — рядом с ограниченной памятью и по тому же
      // признаку «это ход разговора, а не реакция интерфейса»: служебный текст
      // (`persist: false`) в стенограмму не попадает, потому что вопроса за ним
      // нет и судить там нечего.
      recordAssistantAnswerRecord({
        eventId, question, text: assistantReleaseText(answer.text.trim()), route, knowledge,
        modelId: answer.modelId || null, transport,
        // Цена ответа берётся из квитанции провайдера. У детерминированного
        // текста (граница, воздержание, служебный ответ) квитанции нет —
        // счётчики останутся пустыми, и это честное «вызова не было».
        usage: providerCallUsage(answer.receipt),
      });
      if (!transport?.partial && !transport?.uncertain) {
        await cleanupAssistantAskPrompt(eventId, question);
      }
    }
    const askPrompt = route === 'command:ask_empty' && forceReply && question.bareAskCommand === true
      && !transport?.partial && !transport?.uncertain && receipt.messageId
      ? store.createAssistantAskPromptJob({
        eventId, chatId: question.chatId, userId: question.userId,
        commandMessageId: question.messageId, promptMessageId: receipt.messageId,
      })
      : null;
    if (askPrompt) {
      const binding = { chatId: question.chatId, userId: question.userId, promptMessageId: receipt.messageId };
      const completed = store.getAssistantAskPromptAnswerObservation(binding);
      if (completed) await executeAssistantAskCleanup(completed.answerEventId,
        store.claimAnsweredAssistantAskPrompt({ ...binding, ...completed }));
    }
    return {
      kind: 'answered', receipt, route,
      deliveryUncertain: transport?.partial === true || transport?.uncertain === true,
      ...(askPrompt ? {
          askPrompt: {
            chatId: String(question.chatId), userId: String(question.userId),
            commandMessageId: String(question.messageId), promptMessageId: receipt.messageId,
          },
        } : {}),
    };
  }

  /**
   * Долговечная запись ответа — вторая половина приёмочного контура. Сегодня
   * судить можно только маршрут: текст ответа живёт лишь в ОГРАНИЧЕННОЙ памяти
   * диалога (`runtime_assistant_turns`, N последних ходов + TTL) и стирается
   * разговором раньше, чем до него доходит судья.
   *
   * Default gate follows the analyzer; explicit managed local sessions also
   * retain these existing receipts for crash reconciliation without analysis.
   * Гейт тот же, что у анализатора, и это контракт, а не осторожность: в чате
   * вне списка ход идёт байт-в-байт прежним путём — без вызова анализатора, без
   * строки в журнале и без этой записи.
   *
   * Запись обёрнута: сенсор не имеет права стоить человеку ответа. Её отказ
   * виден в логе процесса, а не в молчании бота.
   */
  function recordAssistantAnswerRecord({ eventId, question, text, route, knowledge, modelId, transport, usage }) {
    if (!durableAnswerReceipts && (!analyzer?.enabled || !analyzer.appliesTo(question.chatId))) return;
    try {
      store.recordAssistantAnswer({
        eventId,
        chatId: question.chatId,
        userId: question.userId,
        question: question.text,
        answer: text,
        route,
        knowledge,
        modelId,
        usage,
        // Деградация доставки обязана доехать до стенограммы: судить текст,
        // который человек получил урезанным, как целый — значит мерить не то,
        // что произошло.
        delivery: transport?.partial ? 'partial'
          : transport?.degraded ? `degraded:${String(transport.degraded).slice(0, 60)}` : 'ok',
      });
    } catch (error) {
      console.error(`[runtime] assistant answer record failed event=${eventId} ${runtimeErrorSummary(error)}`);
    }
  }

  /** Доставка служебного текста: человек получает ответ, история не трогается. */
  function sendAssistantServiceReply(eventId, question, text, route, { forceReply = false } = {}) {
    return sendAssistantTurn(eventId, question, { text }, route, { persist: false, forceReply });
  }

  /** Вызов анализатора с контекстом диалога — общий вход observe и dispatch. */
  function analyzeAssistantQuestion(question, dialogue, workingState) {
    return analyzer.analyze({
      text: question.text, previousTexts: dialogue.map((turn) => turn.question), dialogue, workingState,
    });
  }

  /**
   * Строка журнала наблюдений: диагноз, сработавшие хинты, ИТОГОВЫЙ маршрут и
   * долг детектора — вместе, иначе сверять их потом будет не с чем.
   *
   * Долг детектора — спор слоёв, разрешённый в пользу доказанной точности.
   * После перебивания в `route_action` стоит домен победителя, и без этой
   * записи проигравший голос исчезал бы бесследно — вместе с уликой о том,
   * что детектор чего-то не видит.
   *
   * Здесь же — цена самой маршрутизации: расход анализатора (`usage`) и расход
   * модельного роутера (`routeUsage`), когда он вызывался. Роутер живёт в этой
   * строке, а не в записи ответа, потому что строка журнала пишется на КАЖДОМ
   * ходу — включая те, что закончились отказом и вовсе не дошли до ответа.
   * Оплаченный вызов, не оставивший следа, — это и есть та дыра в учёте,
   * ради которой всё затевалось.
   */
  function recordAnalyzerObservationRow({ eventId, question, hints, routing, observation }) {
    store.recordAnalyzerObservation({
      eventId,
      chatId: question.chatId,
      userId: question.userId,
      question: question.text,
      status: observation.status,
      verdict: observation.status === 'ok' ? observation.verdict : null,
      hints: firedHintNames(hints),
      route: routing?.route || null,
      detectorDebt: routing?.arbitration?.debt || null,
      modelId: observation.modelId || null,
      usage: observation.usage || null,
      routeUsage: routing?.routerUsage || null,
      error: observation.status === 'ok' ? null : (observation.error || observation.code || null),
    });
  }

  /**
   * Наблюдение анализатора: один дешёвый вызов и строка в журнал. Поведение
   * ассистента не меняется — ни ответ, ни маршрут, ни квота.
   *
   * Всё внутри обёрнуто: анализатор — надстройка, и его дефект не имеет права
   * стоить человеку ответа. Провал тоже журналируется: молчащий журнал читался
   * бы как «анализатор работает», а это противоположный вывод.
   */
  async function observeAssistantQuestion({ eventId, question, hints, routing, dialogue, workingState }) {
    if (!analyzer?.enabled || !analyzer.appliesTo(question.chatId)) return null;
    try {
      const observation = await analyzeAssistantQuestion(question, dialogue, workingState);
      recordAnalyzerObservationRow({ eventId, question, hints, routing, observation });
      return observation;
    } catch (error) {
      console.error(`[runtime] analyzer observation failed event=${eventId} ${runtimeErrorSummary(error)}`);
      try {
        recordAnalyzerObservationRow({
          eventId,
          question,
          hints,
          routing,
          observation: { status: 'error', code: String(error?.code || error?.message || 'analyzer_failed') },
        });
      } catch { /* журнал не важнее ответа: молча идём дальше */ }
      return null;
    }
  }

  /** Analyzer dispatch replaces the router call and retains all selected domains.
   * Invalid analysis falls back to the same catalog-backed router.
   */
  async function dispatchAssistantQuestion({ eventId, question, hints, dialogue, workingState, routingContext }) {
    let observation;
    try {
      observation = await analyzeAssistantQuestion(question, dialogue, workingState);
    } catch (error) {
      observation = { status: 'error', code: String(error?.code || error?.message || 'analyzer_failed') };
    }
    // The analyzer and router share domain IDs, validation and source resolution.
    const diagnostic = observation.status === 'ok'
      ? diagnosticDomainDecision(observation.verdict, analyzer.domainPrimacyRules, domainCatalog)
      : { topics: null, primacy: null };
    const topics = diagnostic.topics;
    const rawTopics = observation.status === 'ok' ? observation.verdict.topics : null;
    const rawSelection = Array.isArray(rawTopics) && !(rawTopics.includes('out_of_corpus') && rawTopics.length > 1)
      ? normalizeDomainSelection({ domains: rawTopics[0] === 'out_of_corpus' ? [] : rawTopics,
        riskFlags: observation.verdict.riskFlags || [] }, domainCatalog) : null;
    const mapped = topics && !(topics.includes('out_of_corpus') && topics.length > 1)
      ? normalizeDomainSelection({
        domains: topics[0] === 'out_of_corpus' ? [] : topics,
        riskFlags: observation.verdict.riskFlags || [],
      }, domainCatalog) : null;
    if (!mapped) {
      console.error(`[runtime] analyzer dispatch degraded to the previous router event=${eventId} `
        + `status=${observation.status} error=${String(observation.error || observation.code || '').slice(0, 200)}`);
    }
    if (mapped) captureRoutingDiagnosis(routingContext, { selection: mapped, rawSelection, hints,
      origin: 'analyzer_dispatch', primacy: diagnostic.primacy });
    const routing = mapped
      ? await resolveAssistantRoute(question, hints, mapped, dialogue)
      : await routeAssistantQuestion(question, hints, dialogue, workingState, routingContext, {
        origin: 'router_fallback', analyzerAttempt: {
          status: ['ok', 'invalid', 'error'].includes(observation.status) ? observation.status : 'error',
          rawModelChoice: normalizedRoutingChoice(rawSelection),
          primacy: routingPrimacy(diagnostic.primacy),
          error: observation.status === 'ok' ? 'analyzer_mapping_invalid'
            : observation.status === 'invalid' ? 'analyzer_invalid' : 'analyzer_error',
        },
      });
    try {
      recordAnalyzerObservationRow({ eventId, question, hints, routing, observation });
    } catch (error) {
      // Журнал не важнее ответа, но его отказ обязан быть виден в логе.
      console.error(`[runtime] analyzer dispatch journal failed event=${eventId} ${runtimeErrorSummary(error)}`);
    }
    return { routing, observation, routedByVerdict: Boolean(mapped) };
  }

  async function handleAssistant(eventId, question, routingContext) {
    // A correctly bound non-command reply ends only the *idle* 30-second
    // timer before the moderation/provider boundary. It never changes reply
    // detection itself, so a reply that arrives after expiry stays routable.
    if (question.replyToAssistant && question.command === 'ask' && question.replyToMessageId && question.text?.trim()) {
      store.observeAssistantAskPromptReply({
        chatId: question.chatId, userId: question.userId, promptMessageId: question.replyToMessageId,
      });
    }
    const moderation = await assistantModeration(store, config, question, wait);
    if (question.judgementEventId && !judgementIsCurrent(question.judgementEventId)) {
      return { kind: 'skipped', reason: 'stale_judgement' };
    }
    if (moderation.status === 'allowed' || moderation.status === 'error') {
      const questionClaim = store.claimAssistantQuestion({ chatId: question.chatId, messageId: question.messageId,
        eventId, judgementEventId: question.judgementEventId,
        purpose: moderation.status === 'error' ? 'fallback' : 'answer' });
      if (!questionClaim.claimed) return { kind: 'duplicate_question', status: questionClaim.existing?.status || 'unknown' };
      question.answerClaim = questionClaim.claim;
    }
    if (moderation.status !== 'allowed') {
      if (moderation.status === 'error') {
        const delivered = await sendAssistantServiceReply(
          eventId, question, ASSISTANT_ROUTER_FAILURE_TEXT, 'boundary:judgement_unavailable',
        );
        if (delivered.deliveryUncertain !== true) {
          await cleanupAssistantAskPrompt(eventId, question);
        }
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, claim: question.answerClaim, outcome: 'operational_fallback' });
        return { ...delivered, degraded: true, reason: 'judgement_unavailable', moderation };
      }
      await cleanupAssistantAskPrompt(eventId, question, { confirmedAnswer: false });
      return {
        kind: 'skipped',
        reason: moderation.status === 'blocked' ? 'moderator_blocked' : 'moderator_unavailable',
        moderation,
      };
    }
    try {
      if (question.command === 'help') {
        const result = await sendAssistantServiceReply(eventId, question, ASSISTANT_HELP_TEXT, 'command:help');
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, claim: question.answerClaim, outcome: 'answered' });
        return { ...result, command: 'help' };
      }
      // `/ai` снята с вооружения. Ответ детерминированный и до резервирования
      // квоты: команда не доходит ни до модели, ни до платного пути.
      if (question.command === 'retired') {
        const result = await sendAssistantServiceReply(eventId, question, ASSISTANT_RETIRED_COMMAND_TEXT, 'command:retired');
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, claim: question.answerClaim, outcome: 'answered' });
        return { ...result, command: 'retired' };
      }
      // Одинокая `/ask` (клик по меню Telegram) — самый массовый служебный ход и
      // источник боевого дефекта: вопроса нет, писать в историю нечего.
      if (!question.text) {
        // forceReply: следующее сообщение этого человека Telegram доставит как
        // ОТВЕТ на эту подсказку — и `detectAssistantQuestion` (reason: 'reply')
        // примет его без повторного `/ask`. Без этого текст «одним сообщением»
        // читается двумя способами, и естественный способ (просто ответить)
        // раньше уходил в молчание: Telegram не доставляет боту произвольное
        // следующее сообщение без команды, тега или явного Reply.
        const result = await sendAssistantServiceReply(
          eventId, question, ASSISTANT_EMPTY_ASK_TEXT, 'command:ask_empty', { forceReply: true },
        );
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, claim: question.answerClaim, outcome: 'answered' });
        return { ...result, command: 'ask_empty' };
      }
      const request = store.reserveAssistantRequest({
        eventId,
        chatId: question.chatId,
        userId: question.userId,
        cooldownSec: config.assistantCooldownSec,
        // Синтетик считается по своему потолку: иначе приёмочный прогон упирается
        // в защиту, написанную против злоупотребления человеком (замер: 26 отказов
        // из 30 ходов). Кулдаун при этом общий — он защищает не квоту, а темп.
        dailyCap: (config.syntheticTestingEnabled === true && question.isSyntheticSender === true)
          ? config.assistantSyntheticDailyPerUser
          : config.assistantDailyPerUser,
      });
      if (!request.allowed) {
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, claim: question.answerClaim, outcome: request.reason });
        return { kind: 'skipped', reason: request.reason };
      }
      // During extraction no course/index source package is admitted. Public
      // identity and boundary replies remain useful without allowing a provider
      // to fill the missing corpus from general knowledge.
      if (config.assistantKnowledgeEnabled !== true) {
        const deterministic = assistantDeterministicReply(question.text);
        const result = await sendAssistantTurn(eventId, question, { text: deterministic.text }, deterministic.route);
        store.completeAssistantRequest(eventId);
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, claim: question.answerClaim, outcome: 'answered' });
        return result;
      }
      // Read once before asynchronous routing: later stages must not observe
      // a different tail after a concurrent turn or TTL boundary. Retention
      // stays with the store; this is only the existing answer-sized projection.
      const dialogue = assistantDialogue(store.recentDialogue(question.chatId, question.userId, {
        limit: config.assistantDialogueTurnLimit,
        ttlSeconds: config.assistantDialogueTtlSec,
      }));
      const workingState = workingStateProvider
        ? structuredClone(await workingStateProvider({ chatId: question.chatId, userId: question.userId })) : null;
      const hints = domainQuestionHints(question.text, domainCatalog);
      // Режим dispatch действует ПО-ЧАТНО (ступень 1 инфраструктурной
      // лестницы): для чата вне списка условие ниже ложно, и ход идёт прежним
      // путём байт-в-байт — без вызова анализатора и без строки в журнале.
      const dispatched = analyzer?.enabled === true
        && analyzer.mode === ANALYZER_MODES.DISPATCH
        && analyzer.appliesTo(question.chatId)
        ? await dispatchAssistantQuestion({ eventId, question, hints, dialogue, workingState, routingContext })
        : null;
      const routing = dispatched ? dispatched.routing
        : await routeAssistantQuestion(question, hints, dialogue, workingState, routingContext);
      if (routing.error && routingContext.routingDiagnosis?.error == null) {
        routingContext.routingDiagnosis.error = 'source_resolution_failed';
      }
      // Наблюдение анализатора идёт ПОСЛЕ маршрутизации и до ответа: в одной
      // строке журнала должны стоять и диагноз, и маршрут, иначе сверять их
      // потом будет не с чем. Режим observe ничего не меняет в ответе — он
      // только смотрит; сбой анализатора не отменяет ответ человеку.
      // В dispatch-чате журнал уже записан внутри dispatchAssistantQuestion —
      // event_id уникален, второй строки на ход не бывает.
      if (!dispatched) await observeAssistantQuestion({ eventId, question, hints, routing, dialogue, workingState });
      if (routing.error) {
        // Классификация по цене (§2.3) с учётом вызова анализатора: локальный
        // доказуемый выход возвращает квоту, только если и вызов анализатора
        // не завис в неоднозначности — иначе резервация фенсится, как после
        // любого неоднозначного платного вызова.
        if (isDefinitiveAssistantRoutingExit(routing.error)
          && !analyzerCallAmbiguous(dispatched?.observation)) store.releaseAssistantRequest(eventId);
        else store.markAssistantRequestUncertain(eventId);
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, claim: question.answerClaim, outcome: 'skipped' });
        return { kind: 'skipped', reason: routing.error };
      }
      // The corpus cannot ground this question. The user is told so — the reply
      // is delivered like any other, and the request is completed rather than
      // released, because a delivered answer is what the quota pays for.
      if (routing.abstain === true) {
        const abstention = domainBoundaryReply(routing, domainCatalog) || assistantAbstentionReply(routing.reason);
        // An uncovered topic is logged as a deficit before delivery: the signal
        // is the question itself, and it stays valuable even if the send fails.
        if (isOutOfCoverageReason(routing.reason) || routing.reason === 'domain_knowledge_missing') {
          store.recordCoverageDeficit({
            chatId: question.chatId,
            userId: question.userId,
            question: question.text,
            reason: routing.reason,
            candidateLevel: coverageDeficitCandidateLevel(question.text),
          });
        }
        const delivered = await sendAssistantTurn(eventId, question, { text: abstention.text }, abstention.route);
        store.completeAssistantRequest(eventId);
        store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, claim: question.answerClaim, outcome: 'answered' });
        return { ...delivered, abstained: true, reason: routing.reason };
      }
      let answer;
      try {
        if (question.answerClaim && (!judgementIsCurrent(question.judgementEventId)
          || !store.markAssistantAnswerProviderCalling(question.answerClaim).marked)) {
          return { kind: 'skipped', reason: 'stale_answer_claim' };
        }
        answer = await modelProvider.answer({
          text: question.text,
          chatId: question.chatId,
          userId: question.userId,
          dialogue,
          ...(workingState ? { working_state: workingState } : {}),
          route: routing.route,
          knowledge: routing.knowledge,
          domainRoutes: routing.domainRoutes,
          domainCoverage: routing.domainCoverage,
          missingDomains: routing.missingDomains,
          riskFlags: routing.riskFlags,
          registryDigest: routing.registryDigest,
        });
        if (question.answerClaim) store.completeAssistantAnswerProviderAttempt({ claim: question.answerClaim,
          status: 'returned', usage: answer?.receipt });
      } catch (error) {
        if (question.answerClaim) store.completeAssistantAnswerProviderAttempt({ claim: question.answerClaim,
          status: 'unknown', usage: error?.receipt });
        if (isProviderUnavailableError(error)) {
          // The answer transport may have reached a paid provider before it
          // reported failure. Keep the reservation fenced rather than treating
          // this as a proven zero-call rejection.
          store.markAssistantRequestUncertain(eventId);
          store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, claim: question.answerClaim, outcome: 'skipped' });
          return { kind: 'skipped', reason: error.code };
        }
        // Наш собственный дефект сборки запроса: отвергла ЛОКАЛЬНАЯ проверка до
        // сети, платного вызова не было — поэтому квота возвращается
        // (releaseAssistantRequest), как на любом доказуемо-недошедшем выходе, а
        // не фенсится как неоднозначная. Раньше эта ошибка летела наверх и
        // становилась молчанием: человек не получал НИЧЕГО, и каждый следующий
        // его вопрос падал так же. Молчание — худший из возможных ответов, оно
        // читается как поломка и провоцирует повтор в ту же стену; поэтому
        // здесь доставляется честный служебный текст «материалы проверяются».
        // Служебный — значит в историю не пишется (иначе дефект самовоспроизводится).
        if (isProvenNoCallRequestError(error)) {
          store.releaseAssistantRequest(eventId);
          console.error(`[runtime] assistant answer request rejected locally event=${eventId} ${runtimeErrorSummary(error)}`);
          const delivered = await sendAssistantServiceReply(
            eventId, question, ASSISTANT_UNAVAILABLE_TEXT, 'boundary:request_invalid',
          );
          store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, claim: question.answerClaim, outcome: 'answered' });
          return { ...delivered, degraded: true, reason: error.code };
        }
        throw error;
      }
      // Единственное место, где текст написала модель — единственное место с
      // разметкой (см. `sendAssistantTurn`). Знание передаётся сюда же: в
      // стенограмме должно стоять то, что модель ДЕЙСТВИТЕЛЬНО получила, а не
      // то, что лаборатория найдёт по этому вопросу через неделю.
      const result = await sendAssistantTurn(eventId, question, answer, routing.route, {
        markup: true, knowledge: routing.knowledge,
      });
      store.completeAssistantRequest(eventId);
      store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, claim: question.answerClaim, outcome: 'answered' });
      // Обойдённая модерация обязана быть видна в квитанции хода, а не
      // подразумеваться из конфигурации: иначе журнал не отличает ответ
      // человеку от ответа синтетику.
      return moderation.reason ? { ...result, moderation: { reason: moderation.reason } } : result;
    } catch (error) {
      store.markAssistantRequestUncertain(eventId);
      store.completeAssistantQuestion({ chatId: question.chatId, messageId: question.messageId, claim: question.answerClaim, outcome: 'error' });
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
        syntheticBotIds: adapterConfig.syntheticBotIds,
      });
      const receiptId = eventId;
      const inboundClaim = store.claimInboundDelivery({
        receiptId, role, updateId: update.update_id,
        revisionIdentity: inboundRevisionIdentity(classified, update, adapterConfig.chatIds),
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
        const assistantMessage = role === BOT_ROLES.ASSISTANT
          ? update.message || update.edited_message : null;
        if (classified.kind === 'question') {
          // The classifier also accepts mentions and replies. Only a literal
          // empty /ask (optionally addressed to this bot) owns a deletable
          // command; a real question with /ask must always remain in the chat.
          classified.question.bareAskCommand = !update.edited_message && /^\s*\/ask(?:@[A-Za-z0-9_]+)?\s*$/i
            .test(assistantMessage?.text || '');
        }
        if (role === BOT_ROLES.ASSISTANT && update.edited_message
          && adapterConfig.chatIds.map(String).includes(String(assistantMessage?.chat?.id))
          && assistantMessage?.from?.id != null) {
          store.invalidateAssistantAskPrompt({
            chatId: assistantMessage.chat.id, userId: assistantMessage.from.id,
            commandMessageId: assistantMessage.message_id,
          });
        }
        const routingContext = {};
        let result;
        const scopedMessage = update.message || update.edited_message;
        const projection = (role === BOT_ROLES.ASSISTANT || role === BOT_ROLES.MODERATOR)
          && adapterConfig.chatIds.map(String).includes(String(scopedMessage?.chat?.id))
          ? buildJudgementEnvelope(config, update) : null;
        if (projection || classified.kind === 'comment' || classified.kind === 'question') {
          const observation = projection ? store.observeJudgementEnvelope({ envelope: projection, eventId, receiptId,
            snapshotTtlSec: config.moderatorRecoverySnapshotTtlSec }) : null;
          if (!observation?.current) {
            result = { kind: 'skipped', reason: observation?.reason || (observation?.row?.state === 'conflict'
              ? 'judgement_conflict' : 'stale_judgement') };
          } else if (projection.judgeEligible === false) {
            result = { kind: 'skipped', reason: classified.reason || 'revision_tombstone' };
          } else {
            // Reply observation precedes the judge. A slow judge must not turn
            // a received question into an idle timeout.
            const question = projection.question;
            if (question?.command === 'ask' && question.replyToAssistant && question.replyToMessageId && question.text?.trim()) {
              store.observeAssistantAskPromptReply({ chatId: question.chatId, userId: question.userId,
                promptMessageId: question.replyToMessageId });
            }
            const judged = await scheduleJudgement(observation.row);
            result = role === BOT_ROLES.ASSISTANT && question
              ? await handleAssistant(eventId, { ...question, judgementEventId: observation.row.event_id }, routingContext)
              : judged;
          }
        } else {
          result = classified.kind === 'pin_governance'
            ? await handlePinGovernance(eventId, classified.pin)
            : { kind: 'skipped', reason: classified.reason };
        }
        const response = { eventId, ...result,
          ...(routingContext.routingDiagnosis ? { routingDiagnosis: routingContext.routingDiagnosis } : {}) };
        const completed = store.completeInboundDelivery({
          claim: inboundClaim.claim,
          status: result.kind === 'skipped' ? 'skipped' : 'completed',
          result: response,
        });
        if (!completed.completed) return { kind: 'uncertain_delivery', eventId, receiptId, reason: 'claim_fenced', recoveryId: null };
        store.completeEvent(eventId, result.kind === 'skipped' ? 'skipped' : 'completed', response);
        return response;
      } catch (error) {
        // Падение обязано оставить след в обоих местах, где его будут искать:
        // в логе процесса и в базе. `error_code` остаётся машинным контрактом
        // (`runtime_error`), а человекочитаемая суть уходит в `error_text`.
        const summary = runtimeErrorSummary(error);
        console.error(`[runtime] handleUpdate failed role=${role} event=${eventId} ${summary}`);
        const marked = store.markInboundDeliveryUncertain({
          claim: inboundClaim.claim, errorCode: 'runtime_error', errorText: summary,
        });
        store.completeEvent(eventId, 'error', null, summary);
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
     * Recovery replays only provably pre-provider `safe_retry` work. A
     * provider-returned `decision_ready` row is resumed from its durable fixed
     * plan without calling the provider; its Guard receipt may be created or
     * reclaimed only while it remains `planned`. `calling`, `uncertain`,
     * `manual_review`, and `resolved` records never trigger a Telegram retry.
     */
    async recoverModeratorJudgements({ limit = 10, startup = false } = {}) {
      const quarantined = store.quarantineExpiredModeratorCalls({ allCalling: startup === true });
      const outcomes = [];
      const decisionOutcomes = [];
      const maximum = Math.max(1, Math.min(50, Number(limit) || 10));
      for (let index = 0; index < maximum; index++) {
        const claimed = store.claimNextModeratorJudgement({ leaseSec: moderatorLeaseSeconds() });
        if (!claimed.claimed) break;
        outcomes.push(await runModeratorJudgement(claimed.claim));
      }
      const attemptedDecisionIds = new Set();
      for (let index = 0; index < maximum; index++) {
        const job = store.nextDecisionReadyModeratorJudgement();
        if (!job || attemptedDecisionIds.has(job.event_id)) break;
        attemptedDecisionIds.add(job.event_id);
        decisionOutcomes.push(await recoverDecisionReadyModeratorJob(job));
      }
      return {
        ...quarantined,
        recovered: outcomes.length + decisionOutcomes.length,
        outcomes: [...outcomes, ...decisionOutcomes],
      };
    },
    moderatorRecoveryStatus({ limit = 50 } = {}) {
      const status = store.moderatorRecoveryStatus();
      return { states: status.states, jobs: store.listModeratorJudgements({ limit }) };
    },
    /** Durable, bounded UI expiry. It is separate from provider recovery so a
     * stalled safety/model call can never delay an already-due bare /ask. */
    expireAssistantAskPrompts,
  };
}
