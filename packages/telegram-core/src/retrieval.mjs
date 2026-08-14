/**
 * Deterministic lexical retrieval logic, ported from the knowledge lab's
 * retrieval.py 1.1.0. Every function here is pure: normalization, stemming,
 * dictionary matching, scoring, dedup, diversity, budget selection and the
 * status gates. All database and filesystem access lives in the runtime
 * adapter, so this module can be evaluated without a package on disk.
 */

export const RETRIEVAL_VERSION = '1.1.0';

// Scoring weights. Coverage is the dominant absolute signal; rank-based
// signals only separate candidates inside one FTS result set, so their
// weights stay below ENTITY_BASE: a dictionary hit outranks pure lexical
// overlap at equal coverage.
export const W_COV = 0.55;
export const W_BM25 = 0.20;
export const ENTITY_BASE = 0.22;
export const ENTITY_DEFINED_BONUS = 0.08;
export const ENTITY_NHITS_MAX = 0.05;
export const ENTITY_NHITS_SAT = 8;
export const ENTITY_CAP = 0.40;
export const DOC_BONUS_MAX = 0.05;
export const DOC_PULL_BASE = 0.15;
export const TITLE_ONLY_FACTOR = 0.25;
export const TOC_MIN_ANCHORS = 3;
export const TOC_LINE_SHARE = 0.6;
export const TOC_FACTOR = 0.30;

// Negative gate and status thresholds. A question that matches no concept is
// almost certainly out of domain; it survives only when several units carry
// strong coverage, which separates a narrow real topic from a stray metaphor.
export const NO_CONCEPT_COV_MIN = 0.60;
export const NO_CONCEPT_MIN_UNITS = 2;
export const THRESHOLD_NOT_FOUND = 0.30;
export const THRESHOLD_READY = 0.60;
export const READY_MIN_COV = 0.50;
export const MIN_ENTRIES = 1;

export const CONF_HIGH_COV = 0.80;
export const CONF_HIGH_MIN_ENTRIES = 3;
export const CONF_MED_COV = 0.50;

export const FTS_LIMIT = 150;
export const DOC_LIMIT = 10;
export const ENTITY_PER_UNIT = 2;
export const ENTITY_LIMIT = 400;
export const MAX_ENTITY_CONCEPTS = 4;
export const DIVERSITY_K = 3;
export const NEIGHBOR_MIN_SCORE = 0.30;

export const STEM_MIN_TOKEN = 5;
export const STEM_MIN_BASE = 4;
export const IDF_FLOOR = 0.1;

export const CACHE_TTL_S = 300;
export const TOPIC_SWITCH_MIN_OVERLAP = 0.20;
export const TAIL_MIN_SIG = 2;
export const TAIL_MAX_TERMS = 8;
export const ANTICIPATORY_MAX_INTENTS = 3;
export const SESSIONS_MAX = 64;
export const PACKS_PER_SESSION_MAX = 16;

export const PACK_SCHEMA_VERSION = 'kb_retrieval_pack_v1';
export const REQUEST_SCHEMA_VERSION = 'kb_retrieval_request_v1';

const STOP_RU = new Set(`
а без более больше будет будто буквально бы был была были было быть в важная важно
важный вам вас ваш вдруг ведь весь вещей вещи вещь видим видите внимание во вообще
вопрос вопросы вот впрочем времени время все всегда всего всем всеми всех всю вся всё
вчера вы где где-то говорил говорила говорить говорю говоря грубо да давайте даже далее
дальше два действительно делаем делает делать деле для до должен должна должны допустим
другие другой думаете думаю его ее ей ему если естественно есть еще ещё её же за забыли
завтра затем зачем здесь знаете значит знаю зрения и из или им именно иногда итак итог
итоге итогом их к каждая каждое каждый как какая какая-то какие какие-то какое какое-то
какой какой-то когда количество конечно короче которая которое котором которые который
которых кстати кто кто-то куда куда-то ли лучше любой между менее меньше меня места
месте место мне могут можем может можете можно мой момент моменты мочь моя мы на над
надо наконец например нас наш не него нее ней некая некий некое некоторые нельзя
неправильно несколько нет ни нибудь никогда ним них ничего но ну нужен нужна нужно о об
образом обратите объяснили объясню объясняет обычно один одна одно он она они оно опять
от ответ ответы очень очереди очередь перед плохо по под получается получите получить
помните помощью понимаете понимать поняли понятно после посмотреть посмотрите потом
потому почему почему-то почти поэтому правильно практически при пример примеры про
просто простым простыми против раз разберем разберём рассмотрим реально редко рода с
сам самом свой свою сделали сделать себе себя сегодня сейчас скажу сказал сказать слова
словами слово случае случай случаях случится смотреть смотрите смысл смысле снова со
собственно совсем соответственно сторона стороны счету так такая также такие таким
такое такой там твой тебя тем теми теперь тех типа то тогда того тоже той только том
тому тот точки три ту тут ты у увидите уж уже условно фактически хорошо хотим хотите
хоть хотят хочу части часто часть чего чей чем через что что-то чтоб чтобы чуть чье чья
штука штуки эти это этого этой этом этот эту я является являются языком
`.trim().split(/\s+/));

// Generic question words carry intent ("расскажи", "объясни"), not topic: they
// are suppressed for search but still reported in the trace.
const GENERIC_QUESTION_WORDS = new Set(`
расскажи расскажите объясни объясните поясни поясните покажи покажите скажи
скажите подскажи подскажите опиши опишите назови назовите перечисли перечислите
сравни сравните приведи приведите помоги помогите дай дайте хочу хотелось
интересно узнать
`.trim().split(/\s+/));

// Inflectional suffixes for the dictionary-free stemmer, longest first. Only
// frequent Russian inflection; derivational suffixes are deliberately kept.
const STEM_SUFFIXES = Object.freeze(`
иями ями ами иях ях ах ией ей ой ою ею ует уют яет яют ает ают ится ется
аться яться иться ешь ишь ете ите ем им ут ют ат ят ий ый ая яя ое ее ые ие
ого его ому ему ыми ими ых их ую юю ов ев ам ям ом ы и а я о е у ю ь ся сь
`.trim().split(/\s+/).sort((a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0)));

const FOLLOWUP_LEADS = Object.freeze([
  'а если', 'и если', 'а что', 'и что', 'а как', 'и как',
  'а почему', 'и почему', 'а дальше', 'и дальше',
]);
const PRONOUN_LEADS = new Set('он она оно они это этот эта тот там тут'.split(' '));

// Python's `re` module treats `\w` as [letters, digits, underscore]; the JS
// equivalent needs the `u` flag plus explicit classes to include Cyrillic.
const WORD_CHAR = '[\\p{L}\\p{N}_]';
// Python's `[^\W_]` is "word char except underscore"; the token may then carry
// further word chars, dots, apostrophes and hyphens ("make.com", "rss-ленту").
const RE_TOKEN_PY = /[\p{L}\p{N}][\p{L}\p{N}_.'-]*/gu;
const RE_CYRILLIC_TOKEN = /^[а-яе][а-яе-]*$/u;
const RE_SPACES = /[ \t]+/g;
const RE_ALL_WS = /\s+/g;
const RE_TOC_LINE = /^\s*[-*]\s*\[[^\]]*\]\(#[^)]*\)\s*$/;
const RE_TRAIL_STRIP = /[.'-]+$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Text normalized for matching: NFKC, ё→е, lowercase, horizontal whitespace
 * collapsed. Line breaks survive on purpose — a break is a structural boundary
 * and a phrase must not match across it.
 */
export function normalizeText(value) {
  const nfkc = String(value ?? '').normalize('NFKC');
  return nfkc.replaceAll('ё', 'е').replaceAll('Ё', 'Е').toLowerCase()
    .replace(RE_SPACES, ' ');
}

/** Canonical dictionary key: normalizeText plus every whitespace run to one space. */
export function normalizeForm(value) {
  return normalizeText(value).replace(RE_ALL_WS, ' ').trim();
}

/** Normalized tokens, mirroring the lab's RE_TOKEN plus trailing `.'-` strip. */
export function tokenize(text) {
  const normalized = normalizeForm(text);
  const out = [];
  for (const match of normalized.matchAll(RE_TOKEN_PY)) {
    const token = match[0].replace(RE_TRAIL_STRIP, '');
    if (token) out.push(token);
  }
  return out;
}

export function isSignificant(token) {
  return token.length >= 2 && !/^\d+$/.test(token)
    && !STOP_RU.has(token) && !GENERIC_QUESTION_WORDS.has(token);
}

/**
 * Stem base for prefix search, or null when the token must be matched exactly
 * (latin, digits, too short). One inflectional suffix is stripped, longest
 * first, and the base never falls below STEM_MIN_BASE.
 */
export function stem(token) {
  if (token.length < STEM_MIN_TOKEN || !RE_CYRILLIC_TOKEN.test(token)) return null;
  for (const suffix of STEM_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= STEM_MIN_BASE) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return null;
}

/**
 * Stem key of an n-gram: both the question and the dictionary run through this
 * one function, so "question stems differently than the key" cannot happen.
 */
export function stemNgram(normalized) {
  return normalized.split(' ').map((token) => stem(token) || token).join(' ');
}

/** A chunk that is a lesson table of contents rather than knowledge. */
export function isTableOfContents(text) {
  const lines = String(text ?? '').trim().split('\n').filter((line) => line.trim());
  if (lines.length < 4) return false;
  const tocLines = lines.filter((line) => RE_TOC_LINE.test(line)).length;
  if (tocLines < TOC_MIN_ANCHORS) return false;
  return tocLines / lines.length > TOC_LINE_SHARE;
}

const EXACT_BUFFER = new DataView(new ArrayBuffer(8));

/**
 * The exact decimal expansion of a finite double, reconstructed from its IEEE
 * bits. Every binary fraction terminates in base 10, so this is finite and
 * lossless — unlike toFixed(), which stops at 20 places.
 */
function exactDecimalOf(value) {
  EXACT_BUFFER.setFloat64(0, value);
  const bits = EXACT_BUFFER.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const mantissa = bits & 0xf_ffff_ffff_ffffn;
  const significand = exponent === 0 ? mantissa : mantissa | 0x10_0000_0000_0000n;
  const power = (exponent === 0 ? 1 : exponent) - 1075;
  if (power >= 0) return (significand << BigInt(power)).toString();
  // value = significand / 2^-power, and 1/2^n = 5^n / 10^n exactly.
  const shift = -power;
  const scaled = significand * 5n ** BigInt(shift);
  const digits = scaled.toString().padStart(shift + 1, '0');
  const intPart = digits.slice(0, digits.length - shift);
  const fracPart = digits.slice(digits.length - shift);
  return `${intPart}.${fracPart}`;
}

/**
 * Python's round() half-to-even applies to the exact binary value, not to a
 * rescaled copy: 0.99625 is really 0.99624999… and rounds down, while 0.22625
 * is 0.22625000…1 and rounds up. Multiplying by 10^4 first would flatten both
 * into a true tie and answer one of them wrong, so the decision reads the
 * exact decimal expansion of the double and only ties go half-to-even.
 */
export function roundHalfEven(value, digits = 4) {
  if (!Number.isFinite(value)) return value;
  // BigInt reconstruction of the exact binary fraction: toFixed() caps at 20
  // decimals and would truncate 0.00005 to a false tie, hiding the digits that
  // actually place it above the midpoint.
  const [intPart, fracPart = ''] = exactDecimalOf(Math.abs(value)).split('.');
  const sign = value < 0 ? -1 : 1;
  const keep = fracPart.slice(0, digits);
  const rest = fracPart.slice(digits);
  let magnitude = Number(`${intPart}.${keep}`);
  const step = 10 ** -digits;
  const firstRest = rest[0] ?? '0';
  const restBeyond = rest.slice(1).replace(/0+$/, '');
  if (firstRest > '5' || (firstRest === '5' && restBeyond !== '')) {
    magnitude = Number((magnitude + step).toFixed(digits));
  } else if (firstRest === '5') {
    const lastKept = Number(keep[digits - 1] ?? intPart[intPart.length - 1] ?? '0');
    if (lastKept % 2 !== 0) magnitude = Number((magnitude + step).toFixed(digits));
  }
  return sign * Number(magnitude.toFixed(digits));
}

/**
 * A search term: the FTS expression, the body-occurrence probe and its idf.
 * A stemmed term searches by prefix and matches any inflected continuation.
 */
export function createTerm(token, base) {
  const quoted = `"${(base || token).replaceAll('"', '""')}"`;
  const core = base
    ? `${escapeRegExp(base)}${WORD_CHAR}*`
    : escapeRegExp(token);
  return {
    token,
    base: base ?? null,
    ftsExpr: base ? `${quoted} *` : quoted,
    bodyRe: new RegExp(`(?<!${WORD_CHAR})${core}(?!${WORD_CHAR})`, 'u'),
    df: 0,
    idf: 0,
  };
}

/** Inverse document frequency with a floor that only matters for tiny corpora. */
export function idfOf(df, nChunks) {
  return Math.max(IDF_FLOOR, Math.log((nChunks + 1) / (1 + df)));
}

/**
 * Greedy left-to-right dictionary match, longest n-grams first. At each length
 * the exact form wins over the stem key, and an unmatched hyphenated token is
 * retried by its parts so "rss-ленту" still reaches the concept "rss".
 */
export function matchConcepts(tokens, { concepts, conceptsStem, maxConceptLen }) {
  const out = [];
  const consumed = new Set();
  const maxN = Math.min(maxConceptLen, 4);
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (let n = maxN; n >= 1; n -= 1) {
      if (i + n > tokens.length) continue;
      const gram = tokens.slice(i, i + n).join(' ');
      const norm = concepts.has(gram) ? gram : conceptsStem.get(stemNgram(gram));
      if (norm != null) {
        if (!out.includes(norm)) out.push(norm);
        for (let k = i; k < i + n; k += 1) consumed.add(k);
        i += n;
        matched = true;
        break;
      }
    }
    if (!matched) i += 1;
  }
  for (let j = 0; j < tokens.length; j += 1) {
    const token = tokens[j];
    if (consumed.has(j) || !token.includes('-')) continue;
    const parts = token.split('-').filter(Boolean);
    for (const norm of matchConcepts(parts, { concepts, conceptsStem, maxConceptLen })) {
      if (!out.includes(norm)) out.push(norm);
    }
  }
  return out;
}

/**
 * Search terms. A hyphenated token unknown to the corpus as a whole (df=0)
 * degrades to its significant parts: the FTS phrase "rss-ленту" tokenizes to
 * two words and never matches, which used to mute both coverage and the
 * dictionary route.
 */
export function buildTerms(tokens, { documentFrequency, nChunks }) {
  const terms = [];
  const seen = new Set();
  const add = (token) => {
    if (seen.has(token)) return null;
    seen.add(token);
    const term = createTerm(token, stem(token));
    term.df = documentFrequency(term);
    term.idf = idfOf(term.df, nChunks);
    return term;
  };
  for (const token of tokens) {
    const term = add(token);
    if (term === null) continue;
    if (term.df === 0 && token.includes('-')) {
      const parts = token.split('-').filter((part) => isSignificant(part));
      if (parts.length) {
        for (const part of parts) {
          const sub = add(part);
          if (sub !== null) terms.push(sub);
        }
        continue;
      }
    }
    terms.push(term);
  }
  return terms;
}

/** Deterministic ranking order: score descending, then chunk_id ascending. */
export function byScoreThenId(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
}

export function entityBoostFor(role, nHits) {
  return ENTITY_BASE
    + (role === 'defined' ? ENTITY_DEFINED_BONUS : 0)
    + (ENTITY_NHITS_MAX * Math.min(nHits, ENTITY_NHITS_SAT)) / ENTITY_NHITS_SAT;
}

/**
 * Inflected form probe for the entity guard: each token of the concept becomes
 * its stem prefix, so an oblique case in the body still counts as a real
 * occurrence of the concept rather than a title-only pseudo hit.
 */
export function inflectedFormRegExp(norm) {
  const parts = norm.split(' ').map((token) => `${escapeRegExp(stem(token) || token)}${WORD_CHAR}*`);
  return new RegExp(`(?<!${WORD_CHAR})${parts.join('\\s+')}(?!${WORD_CHAR})`, 'u');
}

export function exactFormRegExp(norm) {
  return new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(norm)}(?!${WORD_CHAR})`, 'u');
}

export function selectionReason(cand) {
  const parts = [];
  if (cand.reasonExtra) parts.push(cand.reasonExtra);
  if (cand.entityNotes.length) parts.push(`entity:${cand.entityNotes.join(',')}`);
  if (cand.ftsRank !== null) parts.push(`fts_rank=${cand.ftsRank}`);
  if (cand.docRank !== null) parts.push(`doc_rank=${cand.docRank}`);
  if (cand.titleOnly) parts.push('title_only');
  parts.push(`cov=${cand.cov.toFixed(2)}`);
  return parts.join(';');
}

export function createCandidate(row) {
  return {
    chunkId: row.chunk_id,
    unitId: row.unit_id,
    content: row.content,
    tokenCount: row.token_count,
    sectionPath: row.section_path || '',
    ord: row.ord,
    overlapPrev: row.overlap_prev || 0,
    contentSha256: row.content_sha256 || '',
    bm25Norm: 0,
    cov: 0,
    docBonus: 0,
    entityBoost: 0,
    entityNotes: [],
    ftsRank: null,
    docRank: null,
    titleOnly: false,
    score: 0,
    reasonExtra: '',
  };
}

export function notFoundGaps(terms, concepts) {
  const gaps = terms.filter((term) => term.df === 0)
    .map((term) => `термин '${term.token}' не встречается в базе домена`);
  if (!concepts.length) gaps.push('вопрос не совпал ни с одним концептом словаря домена');
  if (!gaps.length) {
    gaps.push('термины вопроса не образуют достаточного покрытия в базе домена');
  }
  return gaps;
}

/** Word count and the chunker's words × 1.6 token estimate, used only when token_count is NULL. */
export function approxTokens(nWords) { return Math.floor((nWords * 8) / 5); }
export function countWords(text) { return (String(text ?? '').match(/[\p{L}\p{N}_]+/gu) || []).length; }

export function tokensOf(cand) {
  if (cand.tokenCount) return cand.tokenCount;
  return approxTokens(countWords(cand.content));
}

/**
 * Score every pooled candidate, then dedup, diversify and rank them. Ranking
 * uses the raw score: capping at 1.0 here collapsed strong candidates into a
 * plateau where chunk_id alphabet decided the order. The contract cap is
 * applied when the pack is assembled.
 */
export function scoreAndRank(pool, terms, { body }) {
  const totalIdf = terms.reduce((sum, term) => sum + term.idf, 0);
  const strongUnits = new Set();
  const stats = { titleOnlyDemoted: 0, tocDemoted: 0, dedupRemoved: 0, diversityRemoved: 0 };

  for (const cand of pool) {
    if (totalIdf > 0) {
      const text = body(cand);
      const covered = terms.reduce(
        (sum, term) => (term.bodyRe.test(text) ? sum + term.idf : sum), 0);
      cand.cov = covered / totalIdf;
    }
    if (cand.cov >= NO_CONCEPT_COV_MIN) strongUnits.add(cand.unitId);
    let base = W_COV * cand.cov + W_BM25 * cand.bm25Norm + cand.docBonus;
    if (cand.cov === 0 && cand.entityBoost === 0) {
      cand.titleOnly = true;
      stats.titleOnlyDemoted += 1;
      base *= TITLE_ONLY_FACTOR;
    } else if (isTableOfContents(body(cand))) {
      stats.tocDemoted += 1;
      base *= TOC_FACTOR;
    }
    cand.score = roundHalfEven(base + cand.entityBoost, 4);
  }

  const bySha = new Map();
  for (const cand of [...pool].sort(byScoreThenId)) {
    const key = cand.contentSha256 || cand.chunkId;
    if (bySha.has(key)) stats.dedupRemoved += 1;
    else bySha.set(key, cand);
  }

  const perUnit = new Map();
  const diverse = [];
  const overflow = [];
  for (const cand of [...bySha.values()].sort(byScoreThenId)) {
    const used = perUnit.get(cand.unitId) || 0;
    if (used >= DIVERSITY_K) {
      overflow.push(cand);
      stats.diversityRemoved += 1;
    } else {
      perUnit.set(cand.unitId, used + 1);
      diverse.push(cand);
    }
  }

  const ordered = [...diverse].sort(byScoreThenId);
  return { ordered, diverse, overflow, strongUnits: strongUnits.size, stats };
}

/**
 * Fill the token budget by descending score, then extend with the immediately
 * following chunk of the same section when that neighbour earns a meaningful
 * score of its own.
 */
export function selectWithinBudget(ordered, diverse, overflow, { budget, maxEntries }) {
  const selected = [];
  let used = 0;
  let budgetSkipped = 0;
  for (const cand of ordered) {
    if (selected.length >= maxEntries) break;
    const cost = tokensOf(cand);
    if (used + cost > budget) { budgetSkipped += 1; continue; }
    selected.push(cand);
    used += cost;
  }

  const neighbourIndex = new Map();
  for (const cand of [...diverse, ...overflow]) {
    neighbourIndex.set(`${cand.unitId} ${cand.ord}`, cand);
  }
  const chosen = new Set(selected.map((cand) => cand.chunkId));
  let neighborsAdded = 0;
  for (const cand of [...selected]) {
    if (selected.length >= maxEntries) break;
    const neighbour = neighbourIndex.get(`${cand.unitId} ${cand.ord + 1}`);
    if (!neighbour || chosen.has(neighbour.chunkId) || neighbour.overlapPrev <= 0
      || neighbour.score < NEIGHBOR_MIN_SCORE) continue;
    const cost = tokensOf(neighbour);
    if (used + cost > budget) continue;
    neighbour.reasonExtra = `context_expansion_of=${cand.chunkId}`;
    selected.push(neighbour);
    chosen.add(neighbour.chunkId);
    used += cost;
    neighborsAdded += 1;
  }
  return { selected, used, budgetSkipped, neighborsAdded };
}

/**
 * Status and confidence. ready demands both score and coverage: a score built
 * from entity and rank signals while the substance of the question is covered
 * by nothing is an honest insufficient_context, not an answer.
 */
export function decideStatus({ selected, bestScore, bestCov, terms }) {
  const unmatched = terms.filter((term) => term.df === 0).map((term) => term.token);
  const termGaps = unmatched.map((token) => `термин '${token}' не встречается в базе домена`);

  if (selected.length < MIN_ENTRIES || bestScore < THRESHOLD_READY || bestCov < READY_MIN_COV) {
    const gaps = [...termGaps];
    if (bestCov < READY_MIN_COV) {
      gaps.push(`покрытие вопроса лучшим фрагментом ${bestCov.toFixed(2)} < `
        + `${READY_MIN_COV.toFixed(2)} — контекст частичен`);
    }
    if (!gaps.length) {
      gaps.push(`материал по вопросу слаб: best_score=${bestScore.toFixed(2)}, `
        + `записей ${selected.length}`);
    }
    return { status: 'insufficient_context', confidence: 'low', gaps };
  }

  const topCov = selected.length ? selected[0].cov : 0;
  let confidence = 'low';
  if (topCov >= CONF_HIGH_COV && selected.length >= CONF_HIGH_MIN_ENTRIES) confidence = 'high';
  else if (topCov >= CONF_MED_COV) confidence = 'medium';
  return { status: 'ready', confidence, gaps: termGaps };
}

/** A short question or a follow-up opener may borrow terms from the dialogue tail. */
export function tailEligible(question, significant) {
  const norm = normalizeForm(question);
  const first = norm ? norm.split(' ', 1)[0] : '';
  return significant.length < TAIL_MIN_SIG
    || FOLLOWUP_LEADS.some((lead) => norm.startsWith(lead))
    || PRONOUN_LEADS.has(first);
}

export function tailTerms(tail) {
  if (!tail) return [];
  const seen = [];
  for (const token of tokenize(`${tail.user}\n${tail.assistant}`)) {
    if (isSignificant(token) && !seen.includes(token)) seen.push(token);
    if (seen.length >= TAIL_MAX_TERMS) break;
  }
  return seen;
}

/**
 * The contract projection of one run. Ranking used the raw score; the pack caps
 * it at 1.0 because the schema bounds it, and entries carry the chunk text.
 */
export function buildPack({ request, run, packRole, subqueries, packageVersion, packId }) {
  const mergeHint = packRole === 'fresh'
    ? { merge_priority: 'primary', staleness_risk: 'low' }
    : { merge_priority: 'supporting', staleness_risk: 'medium' };
  return {
    schema_version: PACK_SCHEMA_VERSION,
    pack_id: packId,
    pack_role: packRole,
    domain_id: request.domain_id,
    package_version: packageVersion,
    status: run.status,
    entries: run.selected.map((cand) => ({ id: cand.chunkId, content: cand.content })),
    selected: run.selected.map((cand) => ({
      chunk_id: cand.chunkId,
      score: Math.min(1, cand.score),
      selection_reason: selectionReason(cand),
    })),
    gaps: run.gaps,
    contradictions: [],
    confidence: run.confidence,
    merge_hint: mergeHint,
    retrieval_trace: {
      query_terms: run.queryTerms,
      significant_terms: run.significant,
      suppressed_generic: run.suppressed,
      concept_matches: run.conceptMatches,
      entity_path_candidates: run.entityCandidates,
      fts_path_candidates: run.ftsCandidates,
      doc_path_candidates: run.docCandidates,
      merged_count: run.mergedCount,
      dedup_removed: run.dedupRemoved,
      diversity_removed: run.diversityRemoved,
      strong_units: run.strongUnits,
      dialogue_tail_used: run.dialogueTailUsed,
      subqueries,
      reranking: {
        weights: {
          w_cov: W_COV,
          w_bm25: W_BM25,
          entity_cap: ENTITY_CAP,
          doc_bonus_max: DOC_BONUS_MAX,
          title_only_factor: TITLE_ONLY_FACTOR,
          toc_factor: TOC_FACTOR,
        },
        title_only_demoted: run.titleOnlyDemoted,
        toc_demoted: run.tocDemoted,
        neighbors_added: run.neighborsAdded,
        budget_skipped: run.budgetSkipped,
      },
    },
    cache_trace: { cache_hit: false, cache_reason: null, topic_switch_detected: false },
    token_budget: { requested: request.max_context_tokens, used: run.usedTokens },
    latency_ms: 0,
  };
}

/** Empty run shape, so a gated question and a scored one produce the same pack fields. */
export function createRun() {
  return {
    queryTerms: [], significant: [], suppressed: [], conceptMatches: [],
    entityCandidates: 0, ftsCandidates: 0, docCandidates: 0, mergedCount: 0,
    dedupRemoved: 0, diversityRemoved: 0, strongUnits: 0, titleOnlyDemoted: 0,
    tocDemoted: 0, neighborsAdded: 0, budgetSkipped: 0, dialogueTailUsed: false,
    selected: [], status: 'not_found', confidence: 'none', gaps: [],
    usedTokens: 0, bestScore: 0, bestCov: 0,
  };
}
