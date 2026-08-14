import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  ANTICIPATORY_MAX_INTENTS,
  CACHE_TTL_S,
  DOC_BONUS_MAX,
  DOC_LIMIT,
  DOC_PULL_BASE,
  ENTITY_LIMIT,
  ENTITY_PER_UNIT,
  FTS_LIMIT,
  MAX_ENTITY_CONCEPTS,
  NO_CONCEPT_MIN_UNITS,
  PACKS_PER_SESSION_MAX,
  PACK_SCHEMA_VERSION,
  SESSIONS_MAX,
  THRESHOLD_NOT_FOUND,
  TOPIC_SWITCH_MIN_OVERLAP,
  buildPack,
  buildTerms,
  createCandidate,
  createRun,
  decideStatus,
  entityBoostFor,
  exactFormRegExp,
  inflectedFormRegExp,
  isSignificant,
  matchConcepts,
  normalizeForm,
  normalizeText,
  notFoundGaps,
  scoreAndRank,
  selectWithinBudget,
  stemNgram,
  tailEligible,
  tailTerms,
  tokenize,
} from '@aichattg/telegram-core';
import { openReadOnlyRuntimeDatabase } from './database.mjs';

const DEFAULT_DOMAIN_ID = 'ai';
const DEFAULT_MAX_CONTEXT_TOKENS = 6_000;
const DEFAULT_MAX_ENTRIES = 12;

function unavailable(reason) {
  return Object.freeze({ available: false, reason, pack: null });
}

function errorPack(reason) {
  return Object.freeze({ available: false, reason, pack: null });
}

const SQL_CHUNK_COLUMNS = `c.chunk_id, c.unit_id, c.content, c.token_count,
  c.section_path, c.ord, c.overlap_prev, c.content_sha256`;

/**
 * All package I/O for the deterministic retriever: FTS lookups, concept links
 * and the session cache. The pure ranking logic lives in telegram-core, so this
 * module only turns SQL rows into candidates and reports reason codes instead
 * of throwing when a package is missing or malformed.
 */
export function createRetrieverAdapter(
  { databasePath, domainId = DEFAULT_DOMAIN_ID } = {},
  { openDatabase = openReadOnlyRuntimeDatabase, now = () => Date.now() / 1_000 } = {},
) {
  let db = null;
  let openReason = null;
  try {
    db = typeof databasePath === 'string' && databasePath
      ? openDatabase(databasePath)
      : null;
    if (!db) openReason = 'retriever_package_missing';
  } catch {
    db = null;
    openReason = 'retriever_package_unreadable';
  }

  let packageVersion = 'unbuilt';
  let nChunks = 0;
  let concepts = new Map();
  let conceptsStem = new Map();
  let maxConceptLen = 1;
  let statements = null;

  if (db && !openReason) {
    try {
      nChunks = db.prepare('SELECT COUNT(*) n FROM chunks_fts').get().n;
      const metaRows = db.prepare(
        'SELECT scope, source_signature FROM build_meta ORDER BY scope').all();
      packageVersion = metaRows.length
        ? createHash('sha1').update(metaRows
          .map((row) => `${row.scope}:${row.source_signature}`).join('|'))
          .digest('hex').slice(0, 16)
        : 'unbuilt';

      const linked = new Map();
      for (const row of db.prepare(
        `SELECT domain_id, canonical, COUNT(DISTINCT unit_id) n
           FROM concept_units GROUP BY domain_id, canonical`).all()) {
        linked.set(`${row.domain_id}\u0000${row.canonical}`, row.n);
      }
      for (const row of db.prepare(
        'SELECT domain_id, canonical, n_units FROM concepts').all()) {
        const norm = normalizeForm(row.canonical);
        if (!norm) continue;
        const current = concepts.get(norm);
        // A normalized-form collision between canonicals resolves the same way
        // the lab does: more units first, then canonical order.
        if (!current || row.n_units > current.nUnits
          || (row.n_units === current.nUnits && row.canonical > current.canonical)) {
          concepts.set(norm, {
            canonical: row.canonical,
            domainId: row.domain_id,
            nUnits: row.n_units,
            nLinked: linked.get(`${row.domain_id}\u0000${row.canonical}`) || 0,
          });
        }
      }
      const best = new Map();
      for (const [norm, meta] of concepts) {
        const key = stemNgram(norm);
        const rank = best.get(key);
        if (!rank || meta.nUnits > rank.nUnits
          || (meta.nUnits === rank.nUnits && meta.canonical > rank.canonical)) {
          best.set(key, { nUnits: meta.nUnits, canonical: meta.canonical });
          conceptsStem.set(key, norm);
        }
      }
      maxConceptLen = 1;
      for (const norm of concepts.keys()) {
        const len = norm.split(' ').length;
        if (len > maxConceptLen) maxConceptLen = len;
      }

      statements = {
        domain: db.prepare('SELECT 1 FROM domains WHERE domain_id = ?'),
        df: db.prepare(
          'SELECT COUNT(*) n FROM chunks_fts WHERE search_text MATCH ?'),
        fts: db.prepare(
          `SELECT ${SQL_CHUNK_COLUMNS}
             FROM chunks_fts f
             JOIN chunks c ON c.chunk_id = f.chunk_id
             JOIN units u ON u.unit_id = c.unit_id
             JOIN unit_domain d ON d.unit_id = c.unit_id
            WHERE chunks_fts MATCH ?
              AND u.state = 'canonical' AND c.state = 'canonical'
              AND d.domain_id = ?
            ORDER BY bm25(chunks_fts) LIMIT ?`),
        docs: db.prepare(
          `SELECT f.unit_id
             FROM docs_fts f
             JOIN units u ON u.unit_id = f.unit_id
             JOIN unit_domain d ON d.unit_id = f.unit_id
            WHERE docs_fts MATCH ?
              AND u.state = 'canonical' AND d.domain_id = ?
            ORDER BY bm25(docs_fts) LIMIT ?`),
        docPull: db.prepare(
          `SELECT ${SQL_CHUNK_COLUMNS}
             FROM chunks_fts f
             JOIN chunks c ON c.chunk_id = f.chunk_id
            WHERE chunks_fts MATCH ? AND c.unit_id = ?
              AND c.state = 'canonical'
            ORDER BY bm25(chunks_fts) LIMIT 2`),
      };
    } catch {
      openReason = 'retriever_package_invalid';
      statements = null;
    }
  }

  const dfCache = new Map();
  const sessions = new Map();

  function documentFrequency(term) {
    if (!dfCache.has(term.ftsExpr)) {
      dfCache.set(term.ftsExpr, statements.df.get(term.ftsExpr).n);
    }
    return dfCache.get(term.ftsExpr);
  }

  function conceptLinks(meta, domain) {
    const links = new Map();
    const rows = db.prepare(
      `SELECT cu.unit_id, cu.role, cu.n_hits
         FROM concept_units cu
         JOIN units u ON u.unit_id = cu.unit_id
         JOIN unit_domain d ON d.unit_id = cu.unit_id
        WHERE cu.domain_id = ? AND cu.canonical = ?
          AND u.state = 'canonical' AND d.domain_id = ?`)
      .all(meta.domainId, meta.canonical, domain);
    for (const row of rows) links.set(row.unit_id, { role: row.role, nHits: row.n_hits });
    return links;
  }

  function entityRows(phrase, unitIds) {
    const placeholders = unitIds.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM (
          SELECT hits.*, ROW_NUMBER() OVER (
                     PARTITION BY hits.unit_id
                     ORDER BY hits.rank_score, hits.chunk_id
                 ) AS rn
          FROM (
              SELECT c.chunk_id, c.unit_id, c.content, c.token_count,
                     c.section_path, c.ord, c.overlap_prev, c.content_sha256,
                     c.search_text, bm25(chunks_fts) AS rank_score
              FROM chunks_fts f
              JOIN chunks c ON c.chunk_id = f.chunk_id
              WHERE chunks_fts MATCH ?
                AND c.state = 'canonical'
                AND c.unit_id IN (${placeholders})
          ) hits)
        WHERE rn <= ?
        ORDER BY rank_score, chunk_id LIMIT ?`)
      .all(phrase, ...unitIds, ENTITY_PER_UNIT, ENTITY_LIMIT);
  }

  function runQuery(question, tail, domain, budget, maxEntries) {
    const run = createRun();
    const allTokens = tokenize(question);
    run.queryTerms = allTokens;
    const significant = allTokens.filter((token) => isSignificant(token));
    run.suppressed = allTokens.filter((token) => !isSignificant(token));
    run.dialogueTailUsed = tail.length > 0;
    const searchTokens = [...significant, ...tail.filter((t) => !significant.includes(t))];
    run.significant = searchTokens;

    const dictionary = { concepts, conceptsStem, maxConceptLen };
    run.conceptMatches = matchConcepts(allTokens, dictionary);
    for (const norm of matchConcepts(tail, dictionary)) {
      if (!run.conceptMatches.includes(norm)) run.conceptMatches.push(norm);
    }

    const terms = buildTerms(searchTokens, { documentFrequency, nChunks });
    const pool = new Map();
    const bodyCache = new Map();
    const body = (cand) => {
      if (!bodyCache.has(cand.chunkId)) {
        bodyCache.set(cand.chunkId, normalizeText(cand.content));
      }
      return bodyCache.get(cand.chunkId);
    };

    if (terms.length) {
      const expr = terms.map((term) => term.ftsExpr).join(' OR ');
      const rows = statements.fts.all(expr, domain, FTS_LIMIT);
      run.ftsCandidates = rows.length;
      rows.forEach((row, rank) => {
        const cand = createCandidate(row);
        cand.ftsRank = rank;
        cand.bm25Norm = (FTS_LIMIT - rank) / FTS_LIMIT;
        pool.set(cand.chunkId, cand);
      });

      const docRows = statements.docs.all(expr, domain, DOC_LIMIT);
      run.docCandidates = docRows.length;
      docRows.forEach((docRow, docRank) => {
        const weight = 1 - docRank / DOC_LIMIT;
        const unitCands = [...pool.values()].filter((c) => c.unitId === docRow.unit_id);
        if (unitCands.length) {
          for (const cand of unitCands) {
            cand.docBonus = Math.max(cand.docBonus, DOC_BONUS_MAX * weight);
            cand.docRank = docRank;
          }
          return;
        }
        for (const row of statements.docPull.all(expr, docRow.unit_id)) {
          const cand = createCandidate(row);
          cand.docRank = docRank;
          cand.docBonus = DOC_PULL_BASE * weight;
          if (!pool.has(cand.chunkId)) pool.set(cand.chunkId, cand);
        }
      });
    }

    // Entity path: concepts are ranked longest first, then rarest, so specific
    // terms win the limited slots over hub concepts and unlinked dictionary rows.
    const entityConcepts = run.conceptMatches
      .filter((norm) => concepts.get(norm) && concepts.get(norm).nLinked > 0)
      .sort((a, b) => {
        const lenDiff = b.split(' ').length - a.split(' ').length;
        if (lenDiff !== 0) return lenDiff;
        const linkDiff = concepts.get(a).nLinked - concepts.get(b).nLinked;
        if (linkDiff !== 0) return linkDiff;
        return a < b ? -1 : a > b ? 1 : 0;
      })
      .slice(0, MAX_ENTITY_CONCEPTS);

    const baseCache = new Map();
    for (const norm of entityConcepts) {
      const meta = concepts.get(norm);
      const links = conceptLinks(meta, domain);
      if (!links.size) continue;
      const unitIds = [...links.keys()].sort();
      const phrase = `"${norm.replaceAll('"', '""')}"`;
      const formRe = exactFormRegExp(norm);
      const inflRe = inflectedFormRegExp(norm);

      for (const row of entityRows(phrase, unitIds)) {
        const cand = pool.get(row.chunk_id) || createCandidate(row);
        if (!inflRe.test(body(cand))) {
          // The form is absent from the body. If it lives in the base
          // search_text it is a title-only pseudo hit and not entity evidence;
          // if it is absent there too, the hit came from a grounded enrichment
          // alias, which is accepted.
          if (!baseCache.has(cand.chunkId)) {
            baseCache.set(cand.chunkId, normalizeText(row.search_text || ''));
          }
          if (formRe.test(baseCache.get(cand.chunkId))) continue;
        }
        const link = links.get(cand.unitId);
        const boost = entityBoostFor(link.role, link.nHits);
        cand.entityBoost = Math.min(0.40, cand.entityBoost + boost);
        cand.entityNotes.push(`${norm}(${link.role},n_hits=${link.nHits})`);
        pool.set(cand.chunkId, cand);
        run.entityCandidates += 1;
      }
    }

    if (!pool.size) {
      run.gaps = notFoundGaps(terms, run.conceptMatches);
      return run;
    }

    const ranked = scoreAndRank([...pool.values()], terms, { body });
    run.mergedCount = pool.size;
    run.strongUnits = ranked.strongUnits;
    run.dedupRemoved = ranked.stats.dedupRemoved;
    run.diversityRemoved = ranked.stats.diversityRemoved;
    run.titleOnlyDemoted = ranked.stats.titleOnlyDemoted;
    run.tocDemoted = ranked.stats.tocDemoted;
    run.bestScore = ranked.ordered[0].score;
    run.bestCov = Math.max(...ranked.ordered.map((cand) => cand.cov));

    if (!run.conceptMatches.length && run.strongUnits < NO_CONCEPT_MIN_UNITS) {
      run.gaps = notFoundGaps(terms, run.conceptMatches);
      return run;
    }
    if (run.bestScore < THRESHOLD_NOT_FOUND) {
      run.gaps = notFoundGaps(terms, run.conceptMatches);
      return run;
    }

    const budgeted = selectWithinBudget(
      ranked.ordered, ranked.diverse, ranked.overflow, { budget, maxEntries });
    run.selected = budgeted.selected;
    run.usedTokens = budgeted.used;
    run.budgetSkipped = budgeted.budgetSkipped;
    run.neighborsAdded = budgeted.neighborsAdded;

    const decided = decideStatus({
      selected: run.selected,
      bestScore: run.bestScore,
      bestCov: run.bestCov,
      terms,
    });
    run.status = decided.status;
    run.confidence = decided.confidence;
    run.gaps = decided.gaps;
    return run;
  }

  function session(sessionId) {
    if (!sessions.has(sessionId)) {
      while (sessions.size >= SESSIONS_MAX) {
        sessions.delete(sessions.keys().next().value);
      }
      sessions.set(sessionId, { packs: new Map(), topics: null });
    }
    return sessions.get(sessionId);
  }

  function cacheKey(request, source, tail) {
    return createHash('sha1').update(JSON.stringify({
      ...source,
      mode: request.invocation_mode,
      domain: request.domain_id,
      budget: request.max_context_tokens,
      entries: request.max_entries,
      goal: request.retrieval_goal,
      policy: request.grounding_policy,
      tail,
    })).digest('hex');
  }

  return Object.freeze({
    /**
     * One question in, one contract pack out. Unknown domains and unopened
     * packages return a reason code rather than an exception, so the runtime
     * can degrade to an ungrounded route without a try/catch at the call site.
     */
    forQuestion({
      question,
      sessionId = 'runtime',
      domainId: requestDomain = domainId,
      maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS,
      maxEntries = DEFAULT_MAX_ENTRIES,
      dialogueTail = null,
    } = {}) {
      if (openReason) return unavailable(openReason);
      if (typeof question !== 'string' || !question.trim()) {
        return errorPack('retriever_question_invalid');
      }
      if (!statements.domain.get(requestDomain)) {
        return errorPack('retriever_domain_unknown');
      }

      const request = {
        schema_version: 'kb_retrieval_request_v1',
        invocation_mode: 'current_question',
        session_id: sessionId,
        domain_id: requestDomain,
        question,
        retrieval_goal: 'answer_user_question',
        grounding_policy: 'source_grounded',
        max_context_tokens: maxContextTokens,
        max_entries: maxEntries,
      };

      const sess = session(sessionId);
      const allTokens = tokenize(question);
      const significant = allTokens.filter((token) => isSignificant(token));
      const eligible = tailEligible(question, significant);
      const topicTokens = new Set(significant);

      let topicSwitch = false;
      if (!eligible && topicTokens.size && sess.topics !== null) {
        let shared = 0;
        for (const token of topicTokens) if (sess.topics.has(token)) shared += 1;
        if (shared / topicTokens.size < TOPIC_SWITCH_MIN_OVERLAP) {
          topicSwitch = true;
          sess.packs.clear();
        }
      }

      const tail = eligible ? tailTerms(dialogueTail) : [];
      const key = cacheKey(request, { q: allTokens.join(' ') }, tail);
      let cacheReason = 'no_cached_pack';
      const cached = sess.packs.get(key);
      if (cached) {
        if (now() - cached.at <= CACHE_TTL_S) {
          const pack = structuredClone(cached.pack);
          pack.cache_trace = {
            cache_hit: true, cache_reason: 'session_repeat', topic_switch_detected: false,
          };
          return Object.freeze({ available: true, reason: null, pack });
        }
        sess.packs.delete(key);
        cacheReason = 'expired';
      }
      if (topicSwitch) cacheReason = 'topic_switch_reset';

      const run = runQuery(question, tail, requestDomain, maxContextTokens, maxEntries);
      const pack = buildPack({
        request,
        run,
        packRole: 'fresh',
        subqueries: 0,
        packageVersion,
        packId: randomUUID().replaceAll('-', ''),
      });
      pack.cache_trace = {
        cache_hit: false, cache_reason: cacheReason, topic_switch_detected: topicSwitch,
      };

      sess.packs.set(key, { pack: structuredClone(pack), at: now() });
      while (sess.packs.size > PACKS_PER_SESSION_MAX) {
        sess.packs.delete(sess.packs.keys().next().value);
      }
      if (topicTokens.size) {
        const base = (topicSwitch || sess.topics === null) ? new Set() : sess.topics;
        sess.topics = new Set([...base, ...topicTokens]);
      }
      return Object.freeze({ available: true, reason: null, pack });
    },

    packageVersion() { return packageVersion; },

    close() { if (db) db.close(); },
  });
}

export { PACK_SCHEMA_VERSION, ANTICIPATORY_MAX_INTENTS };
