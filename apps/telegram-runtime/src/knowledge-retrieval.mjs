import {
  ASSISTANT_SOURCE_PACKAGES,
  DOMAIN_OUT_OF_SCOPE,
  createDomainRegistry,
  groundingFromPack,
  routeQuestionDomain,
} from '@aichattg/telegram-core';
import { createRetrieverAdapter } from './retriever-adapter.mjs';

/**
 * The assistant's path to the content domain: an admitted v2 package, the
 * deterministic retriever over it, and the code-owned domain veto in front of
 * both. It is the one place where "what may this question read" is decided.
 *
 * Why it exists as its own seam rather than inside runtime.mjs: the runtime owns
 * delivery, quota and billing, and it must be able to ask a single question —
 * "is this question grounded, and in what" — without knowing about SQLite,
 * concept dictionaries or pack schemas. Every answer it gets back is a reason
 * code, never an exception, because the runtime classifies exits by code.
 *
 * The operations source (`course-operations-v1`) is deliberately absent here: it
 * is a v1 text snapshot with no chunks, no dictionary and no domain, so the
 * retriever has nothing to search. It keeps its existing `forSource` path.
 */

const DEFAULT_MAX_CONTEXT_TOKENS = 6_000;
const DEFAULT_MAX_ENTRIES = 12;

function unavailable(reason) {
  return Object.freeze({ grounded: false, reason, knowledge: null, pack: null, domainId: null, trace: null });
}

/**
 * The domain the veto measures against is taken from the admitted package
 * manifest, not from the model. The router already names a source; asking it for
 * a domain id as well would add a claim the code would then have to check
 * against the same package anyway. Deriving it makes a cross-domain leak
 * structurally impossible rather than merely refused.
 */
export function createKnowledgeRetrieval(
  {
    sourceId = ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE,
    maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    rewriteEnabled = false,
    validatePacks = true,
  } = {},
  {
    knowledge = null,
    buildRetriever = createRetrieverAdapter,
    rewriteQuestion = null,
  } = {},
) {
  const admission = typeof knowledge?.forPackage === 'function'
    ? knowledge.forPackage(sourceId)
    : { available: false, reason: 'knowledge_adapter_missing', package: null };

  if (!admission?.available || !admission.package) {
    const reason = admission?.reason || 'knowledge_package_invalid';
    return Object.freeze({
      available: false,
      reason,
      domainId: null,
      forQuestion: async () => unavailable(reason),
      close() {},
    });
  }

  const pkg = admission.package;
  const retriever = buildRetriever(
    {
      databasePath: pkg.databasePath,
      domainId: pkg.domainId,
      rewriteEnabled,
      validatePacks,
    },
    rewriteQuestion ? { rewriteQuestion } : {},
  );

  const openReason = typeof retriever.unavailableReason === 'function'
    ? retriever.unavailableReason() : null;
  if (openReason) {
    return Object.freeze({
      available: false,
      reason: openReason,
      domainId: pkg.domainId,
      forQuestion: async () => unavailable(openReason),
      close() { retriever.close?.(); },
    });
  }

  // One dictionary, read once, shared by the search and the veto. Rebuilding it
  // here would allow the two to disagree about what a domain term is.
  const registry = createDomainRegistry([{
    ...(typeof retriever.dictionary === 'function' ? retriever.dictionary() : {}),
    domainId: pkg.domainId,
    sourceId: pkg.sourceId,
  }]);

  /**
   * One question in, one grounded answer-input out. The order is the contract's:
   * domain veto first (free, local, and it can refuse), retrieval second, the
   * silence gate third, projection last.
   */
  async function forQuestion({ question, sessionId = 'runtime', dialogueTail = null } = {}) {
    const decision = routeQuestionDomain(
      { question, claimedDomainId: pkg.domainId }, { registry });
    if (!decision.accepted) {
      return Object.freeze({
        grounded: false,
        reason: decision.reason,
        knowledge: null,
        pack: null,
        domainId: DOMAIN_OUT_OF_SCOPE,
        trace: Object.freeze({ domain: decision.reason, evidence: decision.evidence }),
      });
    }

    const answer = rewriteEnabled === true
      ? await retriever.forQuestionWithRewrite({
        question, sessionId, domainId: decision.domainId, maxContextTokens, maxEntries, dialogueTail,
      })
      : retriever.forQuestion({
        question, sessionId, domainId: decision.domainId, maxContextTokens, maxEntries, dialogueTail,
      });

    if (!answer.available || !answer.pack) {
      return unavailable(answer.reason || 'retriever_pack_missing');
    }

    const projected = groundingFromPack(answer.pack, { sourceId: pkg.sourceId, maxEntries });
    return Object.freeze({
      grounded: projected.grounded,
      reason: projected.reason,
      knowledge: projected.knowledge,
      pack: answer.pack,
      domainId: decision.domainId,
      trace: Object.freeze({
        domain: decision.reason,
        status: answer.pack.status,
        confidence: answer.pack.confidence,
        packageVersion: answer.pack.package_version,
        grounding: projected.trace,
        ...(answer.pack.rewrite_trace ? { rewrite: answer.pack.rewrite_trace } : {}),
      }),
    });
  }

  return Object.freeze({
    available: true,
    reason: null,
    domainId: pkg.domainId,
    sourceId: pkg.sourceId,
    forQuestion,
    close() { retriever.close?.(); },
  });
}
