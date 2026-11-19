/**
 * The paid answer branch of the assistant (`apps/telegram-runtime/src/runtime.mjs`, the block after quota
 * reservation: route -> resolveDomainSelection -> abstain reply | modelProvider.answer), without Telegram,
 * without the runtime SQLite and without the router model. Production modules are imported, not copied.
 *
 * Substitutions (each is reported in the run manifest):
 *   - knowledge admission: a stub `forPackage()` returns the eval package database directly; the manifest
 *     check of `knowledge-adapter.mjs` is skipped (the package is built locally by book_to_master.py);
 *   - router: a fixed selection `{ routes: [catalog.routeFor('content')] }` instead of the router model;
 *     the exact-example hints of the catalog still apply as in production;
 *   - dialogue history empty, no working state, no analyzer, no moderation, no address detection, no quota;
 *   - delivery (footer, Markdown rendering, chunking for Telegram) is not applied: the text is the model's.
 * Retrieval business logic is unchanged: 12 entries / 6000 tokens, rewrite off, packs validated.
 */
import { createKnowledgeRetrieval } from '../../../apps/telegram-runtime/src/knowledge-retrieval.mjs';
import {
  domainBoundaryReply, domainQuestionHints, resolveDomainSelection,
} from '../../../apps/telegram-runtime/src/assistant-domain-routing.mjs';
import { DEFAULT_DOMAIN_CATALOG } from '../../../apps/telegram-runtime/src/assistant-domains.mjs';
import { assistantAbstentionReply } from '../../../apps/telegram-runtime/src/assistant-policy.mjs';
import { ASSISTANT_SOURCE_PACKAGES, unitOfChunkId } from '../../../packages/telegram-core/src/index.mjs';

export const RETRIEVAL_MAX_ENTRIES = 12;
export const RETRIEVAL_MAX_CONTEXT_TOKENS = 6_000;
export const EVAL_CHAT_ID = 'eval';
export const EVAL_USER_ID = 'eval';
export const SUBSTITUTIONS = Object.freeze([
  'knowledge_admission_stubbed_manifest_check_skipped',
  'router_fixed_to_content_domain_catalog_hints_still_apply',
  'dialogue_empty_no_working_state_no_analyzer',
  'no_telegram_no_moderation_no_quota_no_runtime_sqlite',
  'delivery_formatting_and_release_footer_not_applied',
]);

/** Admission stub: the one thing `createKnowledgeRetrieval` reads from the knowledge adapter. */
export function packageKnowledge({ databasePath, domainId = 'tcr', sourceId = ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE }) {
  const pkg = Object.freeze({ databasePath, domainId, sourceId });
  return Object.freeze({
    forPackage: (id) => (id === sourceId
      ? { available: true, reason: null, package: pkg }
      : { available: false, reason: 'knowledge_source_invalid', package: null }),
    forSource: () => ({ available: false, reason: 'knowledge_identity_missing', snapshot: null }),
  });
}

/** Record ids behind the knowledge entries handed to the model (registry entries are not records). */
export function usedIds(knowledge) {
  const chunkIds = (knowledge?.entries || []).map((e) => e.id).filter((id) => !id.startsWith('registry:'));
  return { chunkIds, unitIds: [...new Set(chunkIds.map((id) => unitOfChunkId(id)))] };
}

export function createOfflineAssistant({
  databasePath, domainId = 'tcr', provider = null, catalog = DEFAULT_DOMAIN_CATALOG,
  maxEntries = RETRIEVAL_MAX_ENTRIES, maxContextTokens = RETRIEVAL_MAX_CONTEXT_TOKENS,
}) {
  const retrieval = createKnowledgeRetrieval(
    { maxEntries, maxContextTokens, rewriteEnabled: false, validatePacks: true },
    { knowledge: packageKnowledge({ databasePath, domainId }) },
  );
  if (!retrieval.available) throw new Error(`retrieval unavailable: ${retrieval.reason}`);
  // runtime.mjs: the compatibility adapter maps the content retrieval under the content source id.
  const retrievals = new Map([[ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT, retrieval]]);
  const route = catalog.routeFor('content');
  if (!route) throw new Error('catalog has no content domain');

  // Every question is a fresh conversation: its own session key, so the retriever's per-session pack cache
  // and topic continuity never carry one question into the next (production keys sessions by chat:user).
  async function routeQuestion(text, { userId = EVAL_USER_ID } = {}) {
    const question = { text, chatId: EVAL_CHAT_ID, userId };
    const hints = domainQuestionHints(text, catalog);
    const selection = { routes: [route], riskFlags: [], legacy: false };
    return resolveDomainSelection(selection, {
      catalog, knowledge: packageKnowledge({ databasePath, domainId }), retrievals, question, dialogue: [], hints,
    });
  }

  /** One question through the answer branch. Never throws for a provider failure: it is a status. */
  async function ask(text, { userId = EVAL_USER_ID } = {}) {
    const routing = await routeQuestion(text, { userId });
    const ids = usedIds(routing.knowledge);
    const base = { ...ids, routeReason: routing.reason ?? null, trace: routing.trace ?? null };
    if (routing.error) return { status: 'error', error: routing.error, answer: '', ...base };
    if (routing.abstain === true) {
      const reply = domainBoundaryReply(routing, catalog) || assistantAbstentionReply(routing.reason);
      return { status: 'abstained', answer: reply.text, replyRoute: reply.route, ...base };
    }
    if (!provider) return { status: 'not_called', answer: '', ...base };
    try {
      const answer = await provider.answer({
        text, chatId: EVAL_CHAT_ID, userId, dialogue: [],
        route: routing.route, knowledge: routing.knowledge, domainRoutes: routing.domainRoutes,
        domainCoverage: routing.domainCoverage, missingDomains: routing.missingDomains,
        riskFlags: routing.riskFlags, registryDigest: routing.registryDigest,
      });
      const textOut = typeof answer?.text === 'string' ? answer.text : '';
      return { status: textOut.trim() ? 'answered' : 'empty', answer: textOut, receipt: answer?.receipt ?? null, ...base };
    } catch (error) {
      if (error?.name === 'SpendCapReached') throw error;
      return { status: 'provider_error', error: error?.code || error?.message || String(error),
        answer: '', receipt: error?.receipt ?? null, ...base };
    }
  }

  /** $0 diagnostics: why the retriever said what it said (gates of retriever-adapter runQuery). */
  async function diagnose(text, { userId = EVAL_USER_ID } = {}) {
    const r = await retrieval.forQuestion({ question: text, sessionId: `diag:${userId}` });
    const t = r.pack?.retrieval_trace || {};
    return {
      grounded: r.grounded, reason: r.reason, packStatus: r.pack?.status ?? null,
      conceptMatches: (t.concept_matches || []).length, strongUnits: t.strong_units ?? null,
      ftsCandidates: t.fts_path_candidates ?? null, mergedCount: t.merged_count ?? null,
      topScore: r.pack?.selected?.[0]?.score ?? null, significantTerms: (t.significant_terms || []).length,
      tokenBudget: r.pack?.token_budget ?? null,
      gaps: r.pack?.gaps || [],
    };
  }

  return Object.freeze({ ask, routeQuestion, diagnose, close: () => retrieval.close() });
}
