/**
 * Step 1 of the answer pipeline: the code-owned veto over the model's domain
 * choice. The model proposes a domain, deterministic evidence from the question
 * either sustains that claim or refuses it. Nothing here reads a database or
 * calls a model: the caller supplies the registry and the measured signals, so
 * the whole decision is testable offline.
 *
 * The registry is data, not branches. A second domain is a new entry plus its
 * own concept dictionary, never a new code path.
 */

import { matchConcepts, tokenize, isSignificant } from './retrieval.mjs';

export const DOMAIN_ROUTING_VERSION = '1.0.0';

/**
 * The out-of-scope verdict is a first-class domain id, not a null. A caller
 * that forgets to handle it gets an unknown source rather than a silent pass.
 */
export const DOMAIN_OUT_OF_SCOPE = 'out_of_scope';

export const DOMAIN_ROUTE_REASONS = Object.freeze({
  ACCEPTED: 'domain_accepted',
  CLAIM_MISSING: 'domain_claim_missing',
  CLAIM_UNKNOWN: 'domain_claim_unknown',
  QUESTION_INVALID: 'domain_question_invalid',
  NO_SIGNAL: 'domain_no_signal',
  REGISTRY_EMPTY: 'domain_registry_empty',
  EVIDENCE_UNAVAILABLE: 'domain_evidence_unavailable',
});

// A claim survives on measured evidence only. Both gates are deliberately
// low: this layer refuses a question that gives the domain *nothing*, it does
// not try to predict retrieval quality. The gate that decides whether an
// answer is possible at all is the retriever's coverage gate, measured by the
// gold set; duplicating a strict threshold here would silence questions the
// retriever can still serve.
export const DOMAIN_MIN_CONCEPT_HITS = 1;
export const DOMAIN_MIN_SIGNIFICANT_TOKENS = 1;

function frozenDecision(decision) {
  return Object.freeze({
    ...decision,
    evidence: Object.freeze({ ...decision.evidence }),
  });
}

function evidence({ concepts = [], significantTokens = 0, domainId = null } = {}) {
  return {
    domainId,
    conceptHits: concepts.length,
    concepts: Object.freeze([...concepts]),
    significantTokens,
  };
}

function rejected(reason, detail) {
  return frozenDecision({
    accepted: false,
    domainId: DOMAIN_OUT_OF_SCOPE,
    claimedDomainId: detail.claimedDomainId ?? null,
    reason,
    evidence: evidence(detail),
  });
}

/**
 * A registry entry pairs a domain id with the dictionary the veto measures
 * against. `concepts`/`conceptsStem` are exactly the maps the retriever adapter
 * already builds from the admitted package, so the veto and the search agree on
 * what a domain term is by construction rather than by convention.
 */
export function createDomainRegistry(domains = []) {
  const entries = new Map();
  for (const domain of Array.isArray(domains) ? domains : []) {
    const domainId = typeof domain?.domainId === 'string' ? domain.domainId.trim() : '';
    if (!domainId || domainId === DOMAIN_OUT_OF_SCOPE || entries.has(domainId)) continue;
    const concepts = domain.concepts instanceof Map ? domain.concepts : new Map();
    const conceptsStem = domain.conceptsStem instanceof Map ? domain.conceptsStem : new Map();
    const maxConceptLen = Number.isSafeInteger(domain.maxConceptLen) && domain.maxConceptLen > 0
      ? domain.maxConceptLen : 1;
    entries.set(domainId, Object.freeze({
      domainId,
      sourceId: typeof domain.sourceId === 'string' && domain.sourceId ? domain.sourceId : null,
      concepts,
      conceptsStem,
      maxConceptLen,
      // A domain whose dictionary never loaded must not silently accept every
      // claim: an empty dictionary can produce no evidence, so the veto reports
      // `domain_evidence_unavailable` instead of a false out-of-scope verdict.
      ready: concepts.size > 0,
    }));
  }
  return Object.freeze({
    size: entries.size,
    has(domainId) { return entries.has(String(domainId ?? '')); },
    get(domainId) { return entries.get(String(domainId ?? '')) || null; },
    list() { return Object.freeze([...entries.keys()]); },
  });
}

/**
 * Deterministic evidence for one domain: which of its concepts the question
 * actually names, and how many significant tokens it carries at all. This is
 * the same dictionary match the retriever uses for its entity route, so a
 * question the veto calls signal-free is one the search could not route either.
 */
export function measureDomainSignal(question, entry) {
  const tokens = tokenize(question);
  const significantTokens = tokens.filter((token) => isSignificant(token)).length;
  if (!entry?.ready) {
    return { concepts: [], significantTokens, domainId: entry?.domainId ?? null };
  }
  const concepts = matchConcepts(tokens, {
    concepts: entry.concepts,
    conceptsStem: entry.conceptsStem,
    maxConceptLen: entry.maxConceptLen,
  });
  return { concepts, significantTokens, domainId: entry.domainId };
}

/**
 * The veto itself. The model's proposal is an input, never an authority: an
 * unknown domain, an empty question or a question that names no concept of the
 * claimed domain all resolve to out_of_scope. A wrong domain therefore yields
 * an honest abstention instead of an answer drawn from a foreign package.
 */
export function routeQuestionDomain(
  { question, claimedDomainId } = {},
  { registry, minConceptHits = DOMAIN_MIN_CONCEPT_HITS,
    minSignificantTokens = DOMAIN_MIN_SIGNIFICANT_TOKENS } = {},
) {
  if (!registry || typeof registry.get !== 'function' || registry.size === 0) {
    return rejected(DOMAIN_ROUTE_REASONS.REGISTRY_EMPTY, { claimedDomainId: claimedDomainId ?? null });
  }
  const text = typeof question === 'string' ? question.trim() : '';
  if (!text) {
    return rejected(DOMAIN_ROUTE_REASONS.QUESTION_INVALID, { claimedDomainId: claimedDomainId ?? null });
  }
  const claimed = typeof claimedDomainId === 'string' ? claimedDomainId.trim() : '';
  if (!claimed) return rejected(DOMAIN_ROUTE_REASONS.CLAIM_MISSING, { claimedDomainId: null });
  if (claimed === DOMAIN_OUT_OF_SCOPE) {
    // The model may decline on its own. Code never overrides a refusal upward:
    // the veto only ever lowers access, mirroring the routing barrier above it.
    return rejected(DOMAIN_ROUTE_REASONS.CLAIM_MISSING, { claimedDomainId: claimed });
  }
  const entry = registry.get(claimed);
  if (!entry) return rejected(DOMAIN_ROUTE_REASONS.CLAIM_UNKNOWN, { claimedDomainId: claimed });

  const signal = measureDomainSignal(text, entry);
  if (!entry.ready) {
    return rejected(DOMAIN_ROUTE_REASONS.EVIDENCE_UNAVAILABLE, { ...signal, claimedDomainId: claimed });
  }
  if (signal.significantTokens < minSignificantTokens || signal.concepts.length < minConceptHits) {
    return rejected(DOMAIN_ROUTE_REASONS.NO_SIGNAL, { ...signal, claimedDomainId: claimed });
  }
  return frozenDecision({
    accepted: true,
    domainId: entry.domainId,
    claimedDomainId: claimed,
    reason: DOMAIN_ROUTE_REASONS.ACCEPTED,
    evidence: evidence(signal),
  });
}

/**
 * Every rejection above is reached before any paid call, so each one returns
 * the user's quota. Kept beside the reasons themselves so a new code cannot be
 * added without deciding its billing class.
 */
export function isDefinitiveDomainRouteReason(reason) {
  const code = String(reason || '');
  return code === DOMAIN_ROUTE_REASONS.CLAIM_MISSING
    || code === DOMAIN_ROUTE_REASONS.CLAIM_UNKNOWN
    || code === DOMAIN_ROUTE_REASONS.QUESTION_INVALID
    || code === DOMAIN_ROUTE_REASONS.NO_SIGNAL
    || code === DOMAIN_ROUTE_REASONS.REGISTRY_EMPTY
    || code === DOMAIN_ROUTE_REASONS.EVIDENCE_UNAVAILABLE;
}
