/**
 * Question rewrite (input-layer step 5): when the first retrieval pass returns
 * no usable context, the question is restated in the vocabulary of the domain
 * and searched exactly once more. Every decision here is pure — whether a
 * second pass is warranted, whether a candidate rewrite is usable, and which of
 * the two packs wins — so the policy is testable without a database, without a
 * provider and without spending a model call.
 *
 * This module deliberately owns no transport. A rewrite lives above retrieval
 * and before the answer provider, so it is never a retry of a failed paid call;
 * the runtime's no-retry transport invariant stays untouched.
 */

import { normalizeForm } from './retrieval.mjs';

export const REWRITE_VERSION = '1.0.0';

/** Exactly one extra pass. The contract allows N; measurement showed the first
 * rewrite carries the whole effect, and a loop would multiply latency and cost
 * for a shrinking return. The constant states the bound rather than hiding it
 * in a loop condition. */
export const REWRITE_MAX_ATTEMPTS = 1;

export const REWRITE_MIN_CHARS = 3;
export const REWRITE_MAX_CHARS = 512;

/** Statuses whose pack carries no usable grounding, ordered worst first. */
export const REWRITE_TRIGGER_STATUSES = Object.freeze(['error', 'not_found', 'insufficient_context']);

// Status and confidence orderings used by the merge rule. Higher wins.
const STATUS_RANK = Object.freeze({
  error: 0, not_found: 1, insufficient_context: 2, ready: 3,
});
const CONFIDENCE_RANK = Object.freeze({ none: 0, low: 1, medium: 2, high: 3 });

export const REWRITE_REASONS = Object.freeze({
  DISABLED: 'rewrite_disabled',
  NOT_TRIGGERED: 'rewrite_not_triggered',
  PACK_MISSING: 'rewrite_pack_missing',
  BUDGET_EXHAUSTED: 'rewrite_budget_exhausted',
  PROVIDER_FAILED: 'rewrite_provider_failed',
  PROVIDER_UNAVAILABLE: 'rewrite_provider_unavailable',
  EMPTY: 'rewrite_empty',
  TOO_LONG: 'rewrite_too_long',
  UNCHANGED: 'rewrite_unchanged',
  NOT_A_STRING: 'rewrite_not_a_string',
  DECLINED: 'rewrite_declined',
});

function statusRank(status) {
  const rank = STATUS_RANK[String(status || '')];
  return rank === undefined ? 0 : rank;
}

function confidenceRank(confidence) {
  const rank = CONFIDENCE_RANK[String(confidence || '')];
  return rank === undefined ? 0 : rank;
}

/** Best entry score of a pack, used only to break a status/confidence tie. */
export function packBestScore(pack) {
  const selected = Array.isArray(pack?.selected) ? pack.selected : [];
  let best = 0;
  for (const item of selected) {
    const score = Number(item?.score);
    if (Number.isFinite(score) && score > best) best = score;
  }
  return best;
}

/**
 * Whether a second retrieval pass is warranted. The gate is deliberately narrow:
 * a `ready` pack is never re-searched, because paying a model call to improve an
 * answer the retriever already grounds trades cost for nothing measurable.
 */
export function shouldRewrite(pack, { enabled = false, attempts = 0, triggerStatuses = REWRITE_TRIGGER_STATUSES } = {}) {
  if (enabled !== true) return { rewrite: false, reason: REWRITE_REASONS.DISABLED };
  if (!pack || typeof pack !== 'object') return { rewrite: false, reason: REWRITE_REASONS.PACK_MISSING };
  if (attempts >= REWRITE_MAX_ATTEMPTS) {
    return { rewrite: false, reason: REWRITE_REASONS.BUDGET_EXHAUSTED };
  }
  if (!triggerStatuses.includes(String(pack.status || ''))) {
    return { rewrite: false, reason: REWRITE_REASONS.NOT_TRIGGERED };
  }
  return { rewrite: true, reason: null };
}

/**
 * A candidate rewrite is usable only when it is a bounded, non-empty string that
 * actually differs from the question. Anything else — an object, a refusal, an
 * essay, an echo — is rejected here rather than being searched, so a degenerate
 * model response costs one call and never a second wrong pack.
 */
export function validateRewrite(candidate, originalQuestion) {
  // A null candidate is a declined rewrite — the recorded rewriter has no entry
  // for this question, or the model chose not to offer one. Folding that into
  // NOT_A_STRING made a measurement unreadable: absence of a rewrite counted as
  // a malformed response.
  if (candidate == null) {
    return { valid: false, reason: REWRITE_REASONS.DECLINED, question: null };
  }
  if (typeof candidate !== 'string') {
    return { valid: false, reason: REWRITE_REASONS.NOT_A_STRING, question: null };
  }
  const trimmed = candidate.trim();
  if (trimmed.length < REWRITE_MIN_CHARS) {
    return { valid: false, reason: REWRITE_REASONS.EMPTY, question: null };
  }
  if (trimmed.length > REWRITE_MAX_CHARS) {
    return { valid: false, reason: REWRITE_REASONS.TOO_LONG, question: null };
  }
  if (normalizeForm(trimmed) === normalizeForm(String(originalQuestion ?? ''))) {
    return { valid: false, reason: REWRITE_REASONS.UNCHANGED, question: null };
  }
  return { valid: true, reason: null, question: trimmed };
}

/**
 * Which of the two packs is returned. The rule is explicit and total rather than
 * a heuristic: better status wins, then better confidence, then the higher best
 * entry score. A complete tie keeps the first pack, because the user's own
 * wording is the grounded default and a rewrite must earn its replacement.
 */
export function chooseBetterPack(first, second) {
  if (!second || typeof second !== 'object') return { pack: first, winner: 'first', reason: 'second_missing' };
  if (!first || typeof first !== 'object') return { pack: second, winner: 'second', reason: 'first_missing' };

  const statusDelta = statusRank(second.status) - statusRank(first.status);
  if (statusDelta !== 0) {
    return statusDelta > 0
      ? { pack: second, winner: 'second', reason: 'status' }
      : { pack: first, winner: 'first', reason: 'status' };
  }
  const confidenceDelta = confidenceRank(second.confidence) - confidenceRank(first.confidence);
  if (confidenceDelta !== 0) {
    return confidenceDelta > 0
      ? { pack: second, winner: 'second', reason: 'confidence' }
      : { pack: first, winner: 'first', reason: 'confidence' };
  }
  const scoreDelta = packBestScore(second) - packBestScore(first);
  if (scoreDelta > 0) return { pack: second, winner: 'second', reason: 'score' };
  return { pack: first, winner: 'first', reason: scoreDelta < 0 ? 'score' : 'tie' };
}

/**
 * The observability record attached to the returned pack. It states what was
 * tried and why the winner won, so a production pack can be read without
 * replaying the run.
 */
export function rewriteTrace({ attempted, rewrittenQuestion = null, reason = null, winner = null, firstStatus = null, secondStatus = null }) {
  return Object.freeze({
    attempted: attempted === true,
    max_attempts: REWRITE_MAX_ATTEMPTS,
    rewritten_question: rewrittenQuestion,
    reason,
    winner,
    first_status: firstStatus,
    second_status: secondStatus,
  });
}
