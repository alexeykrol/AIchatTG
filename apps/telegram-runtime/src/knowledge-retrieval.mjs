import {
  ASSISTANT_SOURCE_PACKAGES,
  DOMAIN_OUT_OF_SCOPE,
  DOMAIN_ROUTE_REASONS,
  createDomainRegistry,
  groundingFromPack,
  routeQuestionDomain,
} from '@aichattg/telegram-core';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRetrieverAdapter } from './retriever-adapter.mjs';
import { createEmbedder, PACKAGE_MODEL_FILES } from './embedder.mjs';

/**
 * The question embedder for hybrid mode. The model must sit inside the admitted
 * package (its sha256 is then proven by admission, like ai.db); a package
 * without `files` (offline harness stub) is accepted when the files exist, and
 * the model digest is computed here so the retriever can still check it against
 * the digest recorded beside the passage vectors.
 */
function hybridEmbedderFor(pkg, { buildEmbedder, embedderCache = null, exists = existsSync, readFile = readFileSync }) {
  const root = typeof pkg.root === 'string' && pkg.root ? pkg.root : dirname(String(pkg.databasePath || ''));
  const paths = Object.fromEntries(Object.entries(PACKAGE_MODEL_FILES).map(([k, rel]) => [k, join(root, rel)]));
  let modelSha256 = null;
  let shareKey = null;
  if (Array.isArray(pkg.files)) {
    const listed = new Map(pkg.files.map((file) => [file.path, file.sha256]));
    if (!Object.values(PACKAGE_MODEL_FILES).every((rel) => listed.has(rel))) {
      return { embedder: null, reason: 'embedder_model_not_in_package', modelSha256: null };
    }
    modelSha256 = listed.get(PACKAGE_MODEL_FILES.model);
    // Admission proved every listed digest, so equal digests mean byte-identical
    // model + tokenizer: one in-process session can serve every such package.
    shareKey = Object.values(PACKAGE_MODEL_FILES).map((rel) => listed.get(rel)).join(':');
  } else {
    if (!Object.values(paths).every((path) => exists(path))) {
      return { embedder: null, reason: 'embedder_model_missing', modelSha256: null };
    }
    modelSha256 = createHash('sha256').update(readFile(paths.model)).digest('hex');
  }
  // Memory bound across N hybrid slots: the embedder is lazy (nothing loads
  // before the first question) and shared per identical model files.
  if (shareKey && embedderCache && embedderCache.has(shareKey)) {
    return { embedder: embedderCache.get(shareKey), reason: null, modelSha256, shared: true };
  }
  const embedder = buildEmbedder({
    modelPath: paths.model, tokenizerPath: paths.tokenizer, tokenizerConfigPath: paths.tokenizerConfig,
  });
  if (shareKey && embedderCache) embedderCache.set(shareKey, embedder);
  return { embedder, reason: null, modelSha256, shared: false };
}

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
    // Opt-in, off by default: lets a no-signal question reach the paid rewrite
    // step too. Production sets it from
    // TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_REWRITE_ON_NO_SIGNAL (config.mjs);
    // server.mjs passes `config.assistantRetrieval` through unchanged.
    rewriteOnNoSignal = false,
    noConceptGate,
    coverageText,
    validatePacks = true,
    // Hybrid search + passage links (config.mjs retrievalSearchConfig). The
    // defaults keep the lexical retriever exactly as before.
    retrievalMode = 'lexical',
    hybridMaxContextTokens,
    linkExpansion = null,
  } = {},
  {
    knowledge = null,
    buildRetriever = createRetrieverAdapter,
    rewriteQuestion = null,
    buildEmbedder = createEmbedder,
    // Optional Map shared by every slot built in one process (server.mjs).
    embedderCache = null,
    log = (line) => console.warn(line),
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
  const hybrid = retrievalMode === 'hybrid'
    ? hybridEmbedderFor(pkg, { buildEmbedder, embedderCache })
    : { embedder: null, reason: null, modelSha256: null };
  if (retrievalMode === 'hybrid' && hybrid.reason) {
    log(`[knowledge-retrieval] hybrid unavailable (slot=${sourceId}): ${hybrid.reason}; lexical only`);
  }
  // Never throws: a failed embedding is logged once per reason code and the
  // question is answered lexically. The question text is never logged.
  const embedFailures = new Set();
  async function embedQuestion(text) {
    if (!hybrid.embedder) return null;
    try {
      return await hybrid.embedder.embedOne(text);
    } catch (error) {
      const code = String(error?.code || error?.message || 'embedder_error').slice(0, 120);
      if (!embedFailures.has(code)) {
        embedFailures.add(code);
        log(`[knowledge-retrieval] embedder failed (${code}); lexical fallback`);
      }
      return null;
    }
  }
  const linksOn = Boolean(linkExpansion && linkExpansion.max > 0);
  // Lexical without links passes exactly the options it always passed.
  const searchOptions = retrievalMode === 'lexical' && !linksOn ? {} : {
    retrievalMode,
    ...(hybridMaxContextTokens !== undefined ? { hybridMaxContextTokens } : {}),
    ...(linksOn ? { linkExpansion } : {}),
    ...(hybrid.modelSha256 ? { vectorModelSha256: hybrid.modelSha256 } : {}),
  };
  const retriever = buildRetriever(
    {
      databasePath: pkg.databasePath,
      domainId: pkg.domainId,
      rewriteEnabled,
      validatePacks,
      ...(noConceptGate !== undefined ? { noConceptGate } : {}),
      ...(coverageText !== undefined ? { coverageText } : {}),
      ...searchOptions,
    },
    {
      ...(rewriteQuestion ? { rewriteQuestion } : {}),
      ...(hybrid.embedder ? { embedQuestion, log } : {}),
    },
  );
  const search = typeof retriever.searchStatus === 'function' ? retriever.searchStatus() : null;
  const hybridLive = Boolean(hybrid.embedder) && search?.hybrid === true;
  // The projection cap follows what the retriever may return: the fused width
  // plus the linked passages it may append.
  const groundingEntries = Math.min(128, maxEntries + (search?.links ? search.linkMax : 0));

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
    // No-signal is the one refusal the search may overrule. The dictionary
    // measures named concepts, and a gold-set run proved that a served, in-domain
    // question can look exactly like a foreign one at this layer (9 of 23
    // no-signal gold questions were answerable — dictionary blindness, not
    // topic). So no-signal alone never abstains: the retriever looks anyway
    // (local and free), and only when its own coverage gate also finds nothing
    // do both layers agree on the out-of-coverage verdict. Every other refusal
    // (unknown claim, empty registry, unreadable dictionary) stays terminal.
    const noSignal = !decision.accepted
      && decision.reason === DOMAIN_ROUTE_REASONS.NO_SIGNAL;
    if (!decision.accepted && !noSignal) {
      return Object.freeze({
        grounded: false,
        reason: decision.reason,
        knowledge: null,
        pack: null,
        domainId: DOMAIN_OUT_OF_SCOPE,
        trace: Object.freeze({ slot: pkg.sourceId, domain: decision.reason, evidence: decision.evidence }),
      });
    }

    // The rewrite step may call a paid provider. By default a no-signal question
    // has not yet earned one: its confirmation pass stays purely local, preserving
    // the veto's original guarantee that no money is spent before a positive
    // signal. That guarantee holds by default and is waived only by the explicit
    // `rewriteOnNoSignal: true` option; even then the retriever itself calls the
    // rewriter only after its free local search came back weak. The verdict,
    // reasons and traces below are the same either way.
    const rewriteAllowed = rewriteEnabled === true && (!noSignal || rewriteOnNoSignal === true);
    const queryVector = hybridLive ? await embedQuestion(question) : null;
    const vectorInput = queryVector ? { queryVector } : {};
    const answer = rewriteAllowed
      ? await retriever.forQuestionWithRewrite({
        question, sessionId, domainId: pkg.domainId, maxContextTokens, maxEntries, dialogueTail, ...vectorInput,
      })
      : retriever.forQuestion({
        question, sessionId, domainId: pkg.domainId, maxContextTokens, maxEntries, dialogueTail, ...vectorInput,
      });

    if (!answer.available || !answer.pack) {
      return unavailable(answer.reason || 'retriever_pack_missing');
    }

    const projected = groundingFromPack(answer.pack, { sourceId: pkg.sourceId, maxEntries: groundingEntries });
    // Both layers refused: the question names no domain concept AND the corpus
    // holds nothing for it. That pair is the positive out-of-coverage verdict,
    // surfaced as the domain reason so the reply layer can tell "topic not
    // covered" apart from "hole inside a covered topic" (grounding_not_found).
    if (noSignal && !projected.grounded) {
      return Object.freeze({
        grounded: false,
        reason: DOMAIN_ROUTE_REASONS.NO_SIGNAL,
        knowledge: null,
        pack: answer.pack,
        domainId: DOMAIN_OUT_OF_SCOPE,
        trace: Object.freeze({
          slot: pkg.sourceId,
          domain: decision.reason,
          evidence: decision.evidence,
          status: answer.pack.status,
          grounding: projected.trace,
          ...answer.trace,
        }),
      });
    }
    return Object.freeze({
      grounded: projected.grounded,
      reason: projected.reason,
      knowledge: projected.knowledge,
      pack: answer.pack,
      domainId: pkg.domainId,
      trace: Object.freeze({
        slot: pkg.sourceId,
        domain: decision.reason,
        status: answer.pack.status,
        confidence: answer.pack.confidence,
        packageVersion: answer.pack.package_version,
        grounding: projected.trace,
        ...(answer.pack.rewrite_trace ? { rewrite: answer.pack.rewrite_trace } : {}),
        ...answer.trace,
      }),
    });
  }

  return Object.freeze({
    available: true,
    reason: null,
    domainId: pkg.domainId,
    sourceId: pkg.sourceId,
    retrievalMode,
    hybridLive,
    embedderShared: hybrid.shared === true,
    forQuestion,
    close() { retriever.close?.(); },
  });
}
