/**
 * Deep read: a second (and at most third) look into the book, only for hard
 * questions.
 *
 * Owner's method (2026-11-21): the plugin is stronger because it searches
 * several times and reads around the first hits. We do the same, but only for
 * hard questions — they are rare. The book is finite, so a 2nd–3rd pass is
 * enough. The result goes into the question/answer case base.
 *
 * Shape (a decorator around createKnowledgeRetrieval; the answer call itself is
 * unchanged and stays single):
 *   pass 1 — the current retrieval, as is;
 *   gate   — code, no model call: is this pack "hard"? (DEEP_READ_GATE);
 *   pass 2 — only if hard: deterministic reading around the top passages
 *            (same-unit neighbours ±1, every passage-link type, one re-search
 *            whose query is the key terms of the top passages), deduped and
 *            bounded by DEEP_READ_BUDGET;
 *   pass 3 — only if pass 2 still flags: ONE cheap model call that names 1–3
 *            short search queries for what is missing; they are run and their
 *            passages added under the same budget. Never more than one extra
 *            model call per question.
 * Judgement (what is missing) is the model's; bookkeeping (dedupe, budget,
 * order, ids) is this code's.
 *
 * Off (the default) returns the wrapped retrieval object itself, so the
 * behaviour is identical to the path without this module by construction.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  GROUNDING_CHAR_RESERVE, GROUNDING_MAX_CHARS, groundingFromPack, isSignificant, normalizeForm, stem, tokenize,
} from '@aichattg/telegram-core';
import { openReadOnlyRuntimeDatabase } from './database.mjs';
import { ANTHROPIC_API_VERSION, anthropicRequestFor } from './provider-adapter.mjs';

export const DEEP_READ_MODES = Object.freeze(['off', 'on']);
// `force` exists for experiments only (the harness): every grounded question is
// read deeply, the gate verdict is still measured and recorded. Not accepted
// from the production environment.
const WRAP_MODES = Object.freeze([...DEEP_READ_MODES, 'force']);

/**
 * Gate thresholds. Three signals are measured; a pack is "hard" only when ALL
 * THREE fire (`requireAll`):
 *  - tension:  a `contradicts`/`qualifies` passage link touches one of the first
 *              `tensionTopK` passages (the book itself says something "but" here);
 *  - spread:   the first `topK` passages come from ≥ `spreadMinChapters`
 *              chapters and no chapter holds ≥ `spreadDominantShare` of them
 *              (the answer is scattered, no single home);
 *  - coverage: fewer than `coverageMin` of the question's significant terms
 *              occur (by stem) in the first `topK` passages, counted only when
 *              the question has ≥ `coverageMinTerms` such terms.
 * Pass 3 runs only when, after pass 2, coverage is still low or the tension
 * signal fired (the missing piece is then typically the author's own linking
 * passage, which words of the question do not reach).
 * Rarity was set on the whole 100-question set at $0, not tuned on outcomes:
 * any single signal fired on 91/100 questions, all three together on 16/100
 * (docs/reports/2026-11-21-deep-read/README.md).
 */
export const DEEP_READ_GATE = Object.freeze({
  topK: 6,
  tensionTopK: 2,
  tensionTypes: Object.freeze(['contradicts', 'qualifies']),
  spreadMinChapters: 4,
  spreadDominantShare: 0.34,
  coverageMin: 0.5,
  coverageMinTerms: 3,
  requireAll: true,
});

/** Expansion bounds. Tokens are the package's own `chunks.token_count`. */
export const DEEP_READ_BUDGET = Object.freeze({
  expandTopK: 4,            // passages whose surroundings pass 2 reads
  neighbourWindow: 1,       // same unit, ord ± 1
  pass2Tokens: 4_500,       // pass 2 may add at most this much
  totalTokens: 6_000,       // pass 2 + pass 3 together
  researchTerms: 6,         // key terms in the pass-2 re-search query
  researchTake: 4,          // new passages taken from that re-search
  pass3Queries: 3,
  pass3Take: 3,             // new passages taken per pass-3 query
  pass3MaxOutputTokens: 200,
  pass3ExcerptChars: 400,
  // Serialized knowledge must stay under the grounding cap and leave room in the
  // 60k provider input for the question and the dialogue tail.
  maxKnowledgeChars: Math.min(48_000, GROUNDING_MAX_CHARS - GROUNDING_CHAR_RESERVE),
});

const LINK_PRIORITY = Object.freeze({ qualifies: 0, contradicts: 1, continues: 2, applies: 3 });

/** Chapter key of a unit: `CH-06` from the title, else the unit id without its `-NN` part suffix. */
export function chapterOf(unitId, title = '') {
  const m = /^\s*(CH-\d+)/i.exec(String(title || ''));
  if (m) return m[1].toUpperCase();
  return String(unitId || '').replace(/-\d+$/, '');
}

/** Stems of the significant tokens of a text. */
export function stemSet(text) {
  const out = new Set();
  for (const token of tokenize(text)) if (isSignificant(token)) out.add(stem(token) || token);
  return out;
}

/** Share of the question's significant stems found in `texts`; null when the question has too few. */
export function termCoverage(question, texts, { minTerms = DEEP_READ_GATE.coverageMinTerms } = {}) {
  const terms = [...stemSet(question)];
  if (terms.length < minTerms) return { share: null, terms: terms.length, covered: null };
  const present = new Set();
  for (const text of texts) for (const s of stemSet(text)) present.add(s);
  const covered = terms.filter((t) => present.has(t)).length;
  return { share: covered / terms.length, terms: terms.length, covered };
}

/**
 * The gate. Pure: `top` = the first passages of the pack in order, each
 * `{ id, content, chapter }`; `linksOf(id)` = its passage links `[{ id, type }]`.
 */
export function gateVerdict({ question, top, linksOf }, gate = DEEP_READ_GATE) {
  const reasons = [];
  const head = top.slice(0, gate.topK);
  const tensionTypes = new Set(gate.tensionTypes);
  const tension = head.slice(0, gate.tensionTopK)
    .flatMap((p) => linksOf(p.id).filter((l) => tensionTypes.has(l.type)).map((l) => `${l.type}:${p.id}`));
  if (tension.length) reasons.push('tension');

  const byChapter = new Map();
  for (const p of head) byChapter.set(p.chapter, (byChapter.get(p.chapter) || 0) + 1);
  const dominant = head.length ? Math.max(0, ...byChapter.values()) / head.length : 0;
  const spread = head.length >= gate.topK && byChapter.size >= gate.spreadMinChapters
    && dominant < gate.spreadDominantShare;
  if (spread) reasons.push('spread');

  const coverage = termCoverage(question, head.map((p) => p.content), { minTerms: gate.coverageMinTerms });
  if (coverage.share !== null && coverage.share < gate.coverageMin) reasons.push('coverage');

  return Object.freeze({
    hard: gate.requireAll ? reasons.length === 3 : reasons.length > 0,
    reasons,
    measures: Object.freeze({
      tensionLinks: tension.length, chapters: byChapter.size, dominantShare: Number(dominant.toFixed(3)),
      coverage: coverage.share === null ? null : Number(coverage.share.toFixed(3)),
      questionTerms: coverage.terms,
    }),
  });
}

/**
 * Key terms of the top passages for the pass-2 re-search: significant cyrillic
 * stems not in the question, ranked by tf (in the top passages) × idf (over the
 * package). Returns surface forms (first seen) joined later into one query.
 */
export function keyTerms({ question, texts, documentFrequency, documents, max = DEEP_READ_BUDGET.researchTerms }) {
  const asked = stemSet(question);
  const tf = new Map();
  const surface = new Map();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      if (!isSignificant(token) || token.length < 5 || !/^[а-яё-]+$/u.test(token)) continue;
      const s = stem(token) || token;
      if (asked.has(s)) continue;
      tf.set(s, (tf.get(s) || 0) + 1);
      if (!surface.has(s)) surface.set(s, token);
    }
  }
  const n = Math.max(1, documents);
  return [...tf.entries()]
    .map(([s, f]) => ({ s, score: f * Math.log((n + 1) / (1 + (documentFrequency(s) || 0))) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0))
    .slice(0, max)
    .map((x) => surface.get(x.s));
}

/**
 * Take candidates in order, skipping what is present, until the token budget
 * or the char budget is hit. Pure bookkeeping; returns the accepted list and
 * what was skipped and why.
 */
export function takeWithinBudget(candidates, { present, tokensLeft, charsLeft, costOf, charsOf }) {
  const accepted = [];
  let tokens = 0;
  let chars = 0;
  let skippedBudget = 0;
  const seen = new Set(present);
  for (const c of candidates) {
    if (!c || seen.has(c.id)) continue;
    const cost = costOf(c.id);
    const width = charsOf(c.id);
    if (cost == null) continue;
    if (tokens + cost > tokensLeft || chars + width > charsLeft) { skippedBudget += 1; continue; }
    seen.add(c.id);
    accepted.push(c);
    tokens += cost;
    chars += width;
  }
  return { accepted, tokens, chars, skippedBudget };
}

/** Parse the pass-3 reply: up to `max` short query lines, no numbering, deduped. */
export function parseQueries(text, max = DEEP_READ_BUDGET.pass3Queries) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, '').replace(/^["«]|["»]$/gu, '').trim();
    if (line.length < 3 || line.length > 160) continue;
    if (out.some((q) => q.toLowerCase() === line.toLowerCase())) continue;
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * All the package facts deep read needs, loaded once (a book-sized package:
 * hundreds of passages). Read-only; closed with the retrieval.
 */
export function createPackageReader(databasePath, { openDatabase = openReadOnlyRuntimeDatabase } = {}) {
  const db = openDatabase(databasePath);
  try {
    const units = new Map(db.prepare('SELECT unit_id, title, canonical_url, url_state FROM units').all()
      .map((u) => [u.unit_id, u]));
    const rows = db.prepare(
      "SELECT chunk_id, unit_id, ord, content, token_count FROM chunks WHERE state = 'canonical' ORDER BY unit_id, ord",
    ).all();
    let links = [];
    try {
      links = db.prepare('SELECT type, a_chunk_id AS a, b_chunk_id AS b FROM passage_links ORDER BY rowid').all();
    } catch { links = []; }
    const passages = new Map();
    const byUnit = new Map();
    for (const r of rows) {
      const unit = units.get(r.unit_id) || {};
      const p = {
        id: r.chunk_id, unitId: r.unit_id, ord: r.ord, content: r.content,
        tokens: Number.isFinite(r.token_count) && r.token_count > 0 ? r.token_count : Math.ceil(r.content.length / 4),
        chapter: chapterOf(r.unit_id, unit.title), title: unit.title || null,
        canonicalUrl: unit.url_state === 'confirmed' && String(unit.canonical_url || '').startsWith('https://')
          ? unit.canonical_url : null,
      };
      passages.set(p.id, p);
      if (!byUnit.has(p.unitId)) byUnit.set(p.unitId, []);
      byUnit.get(p.unitId).push(p);
    }
    const linkMap = new Map();
    const push = (x, y, type) => {
      if (!linkMap.has(x)) linkMap.set(x, []);
      linkMap.get(x).push({ id: y, type });
    };
    for (const l of links) { push(l.a, l.b, l.type); push(l.b, l.a, l.type); }
    const df = new Map();
    for (const p of passages.values()) for (const s of stemSet(p.content)) df.set(s, (df.get(s) || 0) + 1);
    return Object.freeze({
      passage: (id) => passages.get(id) || null,
      linksOf: (id) => linkMap.get(id) || [],
      neighbours(id, window = 1) {
        const p = passages.get(id);
        if (!p) return [];
        const list = byUnit.get(p.unitId) || [];
        const i = list.findIndex((x) => x.id === id);
        const out = [];
        for (let d = 1; d <= window; d += 1) {
          if (list[i - d]) out.push(list[i - d]);
          if (list[i + d]) out.push(list[i + d]);
        }
        return out;
      },
      documentFrequency: (s) => df.get(s) || 0,
      documents: passages.size,
    });
  } finally {
    db.close();
  }
}

function entryChars(p) {
  return JSON.stringify({ id: p.id, content: p.content, ...(p.title ? { title: p.title } : {}),
    ...(p.canonicalUrl ? { canonicalUrl: p.canonicalUrl } : {}) }).length;
}

/** The pass-3 prompt. Russian, as the book and the questions are. */
export const DEEP_READ_QUERY_SYSTEM = [
  'Ты помогаешь искать по одной книге. Тебе дан вопрос читателя и начала мест, которые уже найдены.',
  'Назови от одного до трёх коротких поисковых запросов (3–8 слов каждый) для того, чего в найденном',
  'не хватает для полного ответа: например, место, где автор сам связывает две позиции, объясняет',
  'условие или исключение, или прямо отвечает на вопрос. Только запросы, по одному в строке,',
  'без нумерации и пояснений.',
].join(' ');

export function deepReadQueryInput(question, top, excerptChars = DEEP_READ_BUDGET.pass3ExcerptChars) {
  const lines = top.map((p, i) => `[${i + 1}] ${String(p.content).replace(/\s+/gu, ' ').slice(0, excerptChars)}`);
  return `Вопрос: ${question}\n\nНайденные места:\n${lines.join('\n')}`;
}

/**
 * The one extra model call, on the answer vendor (Anthropic Messages), low
 * effort, ≤ 200 output tokens. Returns `{ queries, usage }`; never throws —
 * a failed call is `{ queries: [], error }` and deep read keeps pass 2.
 */
export function createAnthropicQuerySuggester({
  endpoint, apiKey, model, reasoningEffort = 'low',
  maxOutputTokens = DEEP_READ_BUDGET.pass3MaxOutputTokens, timeoutMs = 30_000,
}, { fetchFn = globalThis.fetch } = {}) {
  const base = String(endpoint || '').replace(/\/?$/, '/');
  return async function suggestQueries({ question, top }) {
    let res;
    try {
      res = await fetchFn(`${base}messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_API_VERSION },
        body: JSON.stringify(anthropicRequestFor({
          tuple: { model, reasoningEffort }, system: DEEP_READ_QUERY_SYSTEM,
          input: deepReadQueryInput(question, top), maxOutputTokens,
        })),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { return { queries: [], error: 'transport_failed', usage: null }; }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const usage = body?.usage ? {
      inputTokens: (body.usage.input_tokens || 0) + (body.usage.cache_read_input_tokens || 0)
        + (body.usage.cache_creation_input_tokens || 0),
      outputTokens: body.usage.output_tokens || 0,
    } : null;
    if (!res?.ok || !Array.isArray(body?.content)) return { queries: [], error: `http_${res?.status || 0}`, usage };
    const text = body.content.filter((b) => b?.type === 'text').map((b) => b.text).join('');
    return { queries: parseQueries(text), error: null, usage };
  };
}

/** The answer-receipt projection of a deep-read trace (no question text). */
export function deepReadReceipt(trace) {
  if (!trace || typeof trace !== 'object') return null;
  return Object.freeze({
    deep_read: trace.read === true,
    gate_hard: trace.hard === true,
    gate_reasons: Array.isArray(trace.reasons) ? [...trace.reasons] : [],
    passes: Number(trace.passes) || 1,
    added_passage_ids: Array.isArray(trace.added) ? trace.added.map((a) => a.id) : [],
    added_tokens: Number(trace.addedTokens) || 0,
    extra_calls: Number(trace.extraCalls) || 0,
    extra_usage: trace.extraUsage ?? null,
  });
}

/** Case-base record: no raw user id, the question normalized and hashed. */
export function caseRecord({ question, passageIds, passes, hard, reasons = [], at = new Date().toISOString() }) {
  const normalized = normalizeForm(question);
  return {
    schema: 'aichattg_case_v1', at,
    question_sha256: createHash('sha256').update(normalized).digest('hex'),
    question_normalized: normalized,
    passage_ids: [...passageIds], passes, deep_read: Boolean(hard), gate_reasons: [...reasons],
  };
}

/**
 * Local JSONL sink for the case base (design: a `write(record)` interface; a
 * database table can implement the same later). Never throws into the answer
 * path: a failed write is logged once per error code.
 */
export function createJsonlCaseSink(path, { append = appendFileSync, mkdir = mkdirSync, log = (l) => console.warn(l) } = {}) {
  const failed = new Set();
  return Object.freeze({
    path,
    write(record) {
      try {
        mkdir(dirname(path), { recursive: true });
        append(path, `${JSON.stringify(record)}\n`);
        return true;
      } catch (error) {
        const code = String(error?.code || 'case_sink_error');
        if (!failed.has(code)) { failed.add(code); log(`[deep-read] case sink write failed (${code})`); }
        return false;
      }
    },
  });
}

/**
 * Wrap a knowledge retrieval with deep read. `mode: 'off'` returns `retrieval`
 * itself. `suggestQueries` (optional) is the pass-3 port; without it pass 3 is
 * skipped and recorded as such. `caseSink` (optional) receives one record per
 * grounded question.
 */
export function withDeepRead(retrieval, {
  mode = 'off', databasePath = null, reader = null, sourceId = null,
  suggestQueries = null, caseSink = null, gate = DEEP_READ_GATE, budget = DEEP_READ_BUDGET,
  log = (line) => console.warn(line),
} = {}) {
  if (!WRAP_MODES.includes(mode)) throw new TypeError('deep read mode must be off, on or force');
  if (mode === 'off' || !retrieval || retrieval.available !== true) return retrieval;
  let book = reader;
  if (!book) {
    try { book = createPackageReader(databasePath); } catch (error) {
      log(`[deep-read] package unreadable (${String(error?.code || error?.message || 'error').slice(0, 80)}); deep read off`);
      return retrieval;
    }
  }

  function project(passages, status) {
    const citations = Object.fromEntries(passages.map((p) => [p.id, {
      ...(p.title ? { title: p.title } : {}), ...(p.canonicalUrl ? { canonicalUrl: p.canonicalUrl } : {}),
    }]));
    const projected = groundingFromPack({ status, entries: passages.map((p) => ({ id: p.id, content: p.content })), citations },
      { sourceId: sourceId || retrieval.sourceId, maxEntries: 128 });
    return projected.knowledge?.entries || [];
  }

  async function search(query, sessionId) {
    try {
      const r = await retrieval.forQuestion({ question: query, sessionId, dialogueTail: null });
      return r?.knowledge?.entries || [];
    } catch { return []; }
  }

  async function forQuestion(input = {}) {
    const first = await retrieval.forQuestion(input);
    if (!first?.grounded || !first.knowledge?.entries?.length) return first;
    const question = String(input.question || '');
    const sessionId = String(input.sessionId || 'runtime');
    const entries = first.knowledge.entries;
    const top = entries.map((e) => book.passage(e.id)).filter(Boolean);
    const verdict = gateVerdict({ question, top, linksOf: book.linksOf }, gate);
    const read = verdict.hard || mode === 'force';
    const trace = { mode, hard: verdict.hard, read, reasons: verdict.reasons, measures: verdict.measures,
      passes: 1, added: [], extraCalls: 0, extraUsage: null, pass3: null };
    let finalEntries = entries;

    if (read) {
      const present = new Set(entries.map((e) => e.id));
      let charsUsed = entries.reduce((n, e) => n + JSON.stringify(e).length, 0);
      const costOf = (id) => book.passage(id)?.tokens ?? null;
      const charsOf = (id) => { const p = book.passage(id); return p ? entryChars(p) : Infinity; };

      // Pass 2: reading around the top passages, then one key-term re-search.
      const expandTop = top.slice(0, budget.expandTopK);
      const candidates = [];
      for (const p of expandTop) {
        for (const n of book.neighbours(p.id, budget.neighbourWindow)) candidates.push({ id: n.id, via: p.id, how: 'neighbour' });
        const links = [...book.linksOf(p.id)].sort((a, b) => (LINK_PRIORITY[a.type] ?? 9) - (LINK_PRIORITY[b.type] ?? 9));
        for (const l of links) candidates.push({ id: l.id, via: p.id, how: `link:${l.type}` });
      }
      const terms = keyTerms({ question, texts: expandTop.map((p) => p.content),
        documentFrequency: book.documentFrequency, documents: book.documents, max: budget.researchTerms });
      if (terms.length) {
        const found = (await search(terms.join(' '), `${sessionId}#deep2`))
          .filter((e) => !present.has(e.id)).slice(0, budget.researchTake);
        for (const e of found) candidates.push({ id: e.id, via: null, how: 'research' });
      }
      const pass2 = takeWithinBudget(candidates, { present, tokensLeft: budget.pass2Tokens,
        charsLeft: budget.maxKnowledgeChars - charsUsed, costOf, charsOf });
      for (const c of pass2.accepted) present.add(c.id);
      charsUsed += pass2.chars;
      trace.passes = 2;
      trace.added.push(...pass2.accepted.map((c) => ({ id: c.id, pass: 2, how: c.how, via: c.via })));
      trace.researchTerms = terms;
      trace.budgetSkipped = pass2.skippedBudget;

      // Pass 3: only if coverage is still low after pass 2, or the book signalled tension.
      const enlarged = [...top.slice(0, gate.topK), ...pass2.accepted.map((c) => book.passage(c.id))];
      const after = termCoverage(question, enlarged.map((p) => p.content), { minTerms: gate.coverageMinTerms });
      const stillFlags = verdict.measures.tensionLinks > 0
        || (after.share !== null && after.share < gate.coverageMin);
      trace.coverageAfterPass2 = after.share === null ? null : Number(after.share.toFixed(3));
      if (stillFlags && typeof suggestQueries === 'function') {
        trace.extraCalls = 1;
        const suggested = await suggestQueries({ question, top: top.slice(0, gate.topK) });
        trace.extraUsage = suggested?.usage ?? null;
        const queries = Array.isArray(suggested?.queries) ? suggested.queries.slice(0, budget.pass3Queries) : [];
        trace.pass3 = { queries, error: suggested?.error ?? null };
        const found = [];
        for (const [i, q] of queries.entries()) {
          const got = (await search(q, `${sessionId}#deep3.${i}`)).filter((e) => !present.has(e.id)).slice(0, budget.pass3Take);
          for (const e of got) found.push({ id: e.id, via: null, how: 'pass3' });
        }
        const pass3 = takeWithinBudget(found, { present, tokensLeft: budget.totalTokens - pass2.tokens,
          charsLeft: budget.maxKnowledgeChars - charsUsed, costOf, charsOf });
        trace.passes = 3;
        trace.added.push(...pass3.accepted.map((c) => ({ id: c.id, pass: 3, how: c.how, via: null })));
        trace.budgetSkipped += pass3.skippedBudget;
      } else if (stillFlags) {
        trace.pass3 = { queries: [], error: 'pass3_unavailable' };
      }
      const addedPassages = trace.added.map((a) => book.passage(a.id)).filter(Boolean);
      finalEntries = [...entries, ...project(addedPassages, first.pack?.status || 'ok')];
      trace.addedTokens = addedPassages.reduce((n, p) => n + p.tokens, 0);
      log(`[deep-read] hard=${verdict.reasons.join('+')} passes=${trace.passes} added=${trace.added.length} tokens=${trace.addedTokens} extraCalls=${trace.extraCalls}`);
    }

    if (caseSink) {
      caseSink.write(caseRecord({ question, passageIds: finalEntries.map((e) => e.id), passes: trace.passes,
        hard: read, reasons: verdict.reasons }));
    }
    const frozenTrace = Object.freeze({ ...(first.trace || {}), deepRead: Object.freeze(trace) });
    return Object.freeze({
      ...first,
      knowledge: finalEntries === entries ? first.knowledge : { ...first.knowledge, entries: finalEntries },
      trace: frozenTrace,
    });
  }

  return Object.freeze({ ...retrieval, forQuestion, deepRead: mode });
}

/**
 * Runtime switch, read from the environment beside config.mjs so this module
 * stays independent of the shared config file:
 *   TELEGRAM_RUNTIME_ASSISTANT_DEEP_READ          off|on (default off)
 *   TELEGRAM_RUNTIME_ASSISTANT_DEEP_READ_PASS3    off|on (default on; only with deep read on)
 *   TELEGRAM_RUNTIME_ASSISTANT_CASE_BASE_PATH     local JSONL path; empty = no case base
 * Pass 3 uses the answer vendor's Anthropic endpoint and key and the answer
 * model at low effort; without an Anthropic answer vendor pass 3 is skipped.
 */
export function deepReadFromEnv(retrieval, { env = process.env, knowledge = null, provider = null, log } = {}) {
  const mode = String(env.TELEGRAM_RUNTIME_ASSISTANT_DEEP_READ || 'off').trim().toLowerCase();
  if (!DEEP_READ_MODES.includes(mode)) throw new Error('TELEGRAM_RUNTIME_ASSISTANT_DEEP_READ must be off or on');
  if (mode === 'off' || !retrieval || retrieval.available !== true) return retrieval;
  const admission = knowledge?.forPackage?.(retrieval.sourceId);
  const databasePath = admission?.package?.databasePath || null;
  const pass3 = String(env.TELEGRAM_RUNTIME_ASSISTANT_DEEP_READ_PASS3 || 'on').trim().toLowerCase() !== 'off';
  const answerTuple = provider?.modelTuples?.assistantAnswer;
  const suggestQueries = pass3 && provider?.answerVendor === 'anthropic' && provider.anthropicApiKey && answerTuple?.model
    ? createAnthropicQuerySuggester({ endpoint: provider.anthropicEndpoint, apiKey: provider.anthropicApiKey,
      model: answerTuple.model, reasoningEffort: 'low' })
    : null;
  const casePath = String(env.TELEGRAM_RUNTIME_ASSISTANT_CASE_BASE_PATH || '').trim();
  return withDeepRead(retrieval, {
    mode, databasePath, suggestQueries, caseSink: casePath ? createJsonlCaseSink(casePath, log ? { log } : {}) : null,
    ...(log ? { log } : {}),
  });
}
