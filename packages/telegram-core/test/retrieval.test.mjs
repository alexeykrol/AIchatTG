import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DIVERSITY_K,
  buildTerms,
  byScoreThenId,
  createCandidate,
  decideStatus,
  entityBoostFor,
  exactFormRegExp,
  idfOf,
  inflectedFormRegExp,
  isSignificant,
  isTableOfContents,
  matchConcepts,
  normalizeForm,
  normalizeText,
  notFoundGaps,
  roundHalfEven,
  scoreAndRank,
  selectWithinBudget,
  selectionReason,
  stem,
  stemNgram,
  tailEligible,
  tailTerms,
  tokenize,
  tokensOf,
} from '../src/retrieval.mjs';

function dictionary(entries) {
  const concepts = new Map(entries.map(([norm, meta]) => [norm, {
    canonical: norm, domainId: 'ai', nUnits: 1, nLinked: 1, ...meta,
  }]));
  const conceptsStem = new Map();
  for (const norm of concepts.keys()) conceptsStem.set(stemNgram(norm), norm);
  const maxConceptLen = Math.max(1, ...[...concepts.keys()].map((n) => n.split(' ').length));
  return { concepts, conceptsStem, maxConceptLen };
}

function candidate(chunkId, overrides = {}) {
  return {
    ...createCandidate({
      chunk_id: chunkId, unit_id: overrides.unitId ?? 'lesson:1',
      content: overrides.content ?? 'тело чанка', token_count: overrides.tokenCount ?? 10,
      section_path: '', ord: overrides.ord ?? 1,
      overlap_prev: overrides.overlapPrev ?? 0,
      content_sha256: overrides.sha ?? chunkId,
    }),
    ...overrides,
  };
}

test('Normalization folds NFKC, ё and case while keeping line breaks as boundaries', () => {
  assert.equal(normalizeText('Ёлка\tи  Ёж'), 'елка и еж');
  assert.equal(normalizeText('строка\nдругая'), 'строка\nдругая');
  assert.equal(normalizeForm('  Ёлка\nи  Ёж  '), 'елка и еж');
  assert.equal(normalizeText('ﬁ'), 'fi');
});

test('Tokenizer keeps dotted and hyphenated technical forms but strips trailing punctuation', () => {
  // Tokenizing keeps stopwords; significance filtering happens downstream.
  assert.deepEqual(tokenize('Что такое make.com и n8n?'), ['что', 'такое', 'make.com', 'и', 'n8n']);
  assert.deepEqual(tokenize('rss-ленту'), ['rss-ленту']);
  assert.deepEqual(tokenize('привет!!!'), ['привет']);
  assert.deepEqual(tokenize('ИИ-агент'), ['ии-агент']);
  assert.deepEqual(tokenize('что_такое'), ['что_такое']);
});

test('Significance drops stopwords, generic question verbs, digits and single characters', () => {
  assert.equal(isSignificant('агент'), true);
  assert.equal(isSignificant('расскажи'), false);
  assert.equal(isSignificant('который'), false);
  assert.equal(isSignificant('2024'), false);
  assert.equal(isSignificant('и'), false);
  assert.equal(isSignificant('n8n'), true);
});

test('Stemming strips one inflection, respects minimum lengths and skips non-Cyrillic tokens', () => {
  assert.equal(stem('страхами'), 'страх');
  assert.equal(stem('жизнь'), 'жизн');
  assert.equal(stem('код'), null, 'shorter than STEM_MIN_TOKEN');
  assert.equal(stem('n8n'), null, 'digits are matched exactly');
  assert.equal(stem('make.com'), null);
  assert.equal(stem('сети'), null, 'four characters is below STEM_MIN_TOKEN');
  // A token that cannot be stemmed stays itself in the n-gram key, so
  // "нейронные сети" and "нейронная сеть" deliberately do not collapse.
  assert.equal(stemNgram('нейронные сети'), 'нейронн сети');
  assert.equal(stemNgram('нейронная сеть'), 'нейронн сеть');
});

test('Python round() half-to-even reads the exact binary value, not a rescaled copy', () => {
  // 0.99625 is really 0.99624999…, so it rounds down; 0.22625 is above the tie.
  assert.equal(roundHalfEven(0.99625, 4), 0.9962);
  assert.equal(roundHalfEven(0.22625, 4), 0.2263);
  assert.equal(roundHalfEven(0.94425, 4), 0.9443);
  assert.equal(roundHalfEven(0.00005, 4), 0.0001);
  assert.equal(roundHalfEven(0.12345, 4), 0.1235);
  assert.equal(roundHalfEven(0.56785, 4), 0.5678);
  assert.equal(roundHalfEven(2.00005, 4), 2);
});

test('Dictionary match prefers the longest n-gram and resolves oblique cases by stem key', () => {
  const dict = dictionary([['телега', {}], ['нейронная сеть', {}], ['сеть', {}]]);
  // "в телеге" is an oblique case of the alias and still resolves by stem key.
  assert.deepEqual(matchConcepts(['в', 'телеге'], dict), ['телега']);
  assert.deepEqual(
    matchConcepts(['нейронная', 'сеть'], dict), ['нейронная сеть'],
    'the longer concept consumes both tokens and suppresses the shorter one',
  );
  assert.deepEqual(matchConcepts(['сеть'], dict), ['сеть']);
});

test('An unmatched hyphenated token is retried by its parts', () => {
  const dict = dictionary([['rss', {}]]);
  assert.deepEqual(matchConcepts(['rss-ленту'], dict), ['rss']);
});

test('Terms degrade a hyphenated token unknown to the corpus into its significant parts', () => {
  const df = (term) => (term.ftsExpr.includes('rss-') ? 0 : 5);
  const terms = buildTerms(['rss-лентой'], { documentFrequency: df, nChunks: 100 });
  assert.deepEqual(terms.map((t) => t.token), ['rss', 'лентой']);

  const known = buildTerms(['агент'], { documentFrequency: () => 7, nChunks: 100 });
  assert.deepEqual(known.map((t) => t.token), ['агент']);
});

test('A stemmed term searches by FTS prefix and matches inflected forms in the body', () => {
  const [term] = buildTerms(['страхами'], { documentFrequency: () => 3, nChunks: 100 });
  assert.equal(term.ftsExpr, '"страх" *');
  assert.equal(term.bodyRe.test('свои страхи мешают'), true);
  assert.equal(term.bodyRe.test('бесстрашие'), false, 'must not match mid-word');

  const [exact] = buildTerms(['n8n'], { documentFrequency: () => 3, nChunks: 100 });
  assert.equal(exact.ftsExpr, '"n8n"');
});

test('The idf floor only rescues degenerate corpora where a term lives in every chunk', () => {
  assert.equal(idfOf(5_211, 5_212), 0.1);
  assert.ok(idfOf(2_015, 5_212) > 0.9);
});

test('Table-of-contents detection is line based and spares mixed content chunks', () => {
  const toc = ['- [Раздел один](#a)', '- [Раздел два](#b)', '- [Раздел три](#c)',
    '- [Раздел четыре](#d)'].join('\n');
  assert.equal(isTableOfContents(toc), true);
  assert.equal(isTableOfContents(`${toc}\nЗдесь живёт знание урока.\nИ ещё абзац текста.\nИ третий.`), false);
  assert.equal(isTableOfContents('- [Один](#a)\n- [Два](#b)'), false, 'needs at least four lines');
});

test('Entity boost saturates on hit count and rewards a defined role', () => {
  assert.equal(roundHalfEven(entityBoostFor('used', 0), 4), 0.22);
  assert.equal(roundHalfEven(entityBoostFor('defined', 0), 4), 0.30);
  assert.equal(roundHalfEven(entityBoostFor('used', 8), 4), 0.27);
  assert.equal(
    entityBoostFor('used', 40), entityBoostFor('used', 8),
    'frequency past the saturation point adds nothing',
  );
});

test('Entity form probes accept an inflected body hit but reject a mid-word substring', () => {
  assert.equal(inflectedFormRegExp('телега').test('пишу в телеге каждый день'), true);
  assert.equal(exactFormRegExp('телега').test('телега едет'), true);
  assert.equal(exactFormRegExp('телега').test('телегами'), false);
});

test('Title-only candidates are demoted and table-of-contents chunks damped', () => {
  const terms = [{ idf: 1, bodyRe: /агент/u, df: 1, token: 'агент' }];
  const titleOnly = candidate('c:1', { bm25Norm: 1, content: 'ничего по теме' });
  const { ordered, stats } = scoreAndRank([titleOnly], terms, { body: (c) => c.content });
  assert.equal(stats.titleOnlyDemoted, 1);
  assert.equal(ordered[0].titleOnly, true);
  // 0.20 rank weight, scaled by the 0.25 title-only factor.
  assert.equal(ordered[0].score, 0.05);
});

test('Coverage drives the score and equal scores break ties by chunk_id', () => {
  const terms = [{ idf: 1, bodyRe: /агент/u, df: 1, token: 'агент' }];
  const a = candidate('c:b', { content: 'агент работает' });
  const b = candidate('c:a', { content: 'агент работает', unitId: 'lesson:2', sha: 'other' });
  const { ordered } = scoreAndRank([a, b], terms, { body: (c) => c.content });
  assert.deepEqual(ordered.map((c) => c.chunkId), ['c:a', 'c:b']);
  assert.equal(ordered[0].cov, 1);
  assert.equal(ordered[0].score, 0.55);
});

test('Exact duplicates collapse by content hash and one unit cannot monopolize the pool', () => {
  const terms = [{ idf: 1, bodyRe: /агент/u, df: 1, token: 'агент' }];
  const pool = [
    candidate('c:1', { content: 'агент', sha: 'same' }),
    candidate('c:2', { content: 'агент', sha: 'same' }),
  ];
  const dedup = scoreAndRank(pool, terms, { body: (c) => c.content });
  assert.equal(dedup.stats.dedupRemoved, 1);
  assert.equal(dedup.ordered.length, 1);

  const many = Array.from({ length: DIVERSITY_K + 2 }, (_, i) => candidate(`c:${i}`, {
    content: 'агент', sha: `sha-${i}`, unitId: 'lesson:1',
  }));
  const diverse = scoreAndRank(many, terms, { body: (c) => c.content });
  assert.equal(diverse.diverse.length, DIVERSITY_K);
  assert.equal(diverse.stats.diversityRemoved, 2);
  assert.equal(diverse.overflow.length, 2);
});

test('Budget selection stops at max entries and skips candidates that do not fit', () => {
  const ordered = [
    candidate('c:1', { tokenCount: 60, score: 0.9 }),
    candidate('c:2', { tokenCount: 60, score: 0.8, sha: 'b' }),
    candidate('c:3', { tokenCount: 10, score: 0.7, sha: 'c' }),
  ];
  const result = selectWithinBudget(ordered, ordered, [], { budget: 75, maxEntries: 12 });
  assert.deepEqual(result.selected.map((c) => c.chunkId), ['c:1', 'c:3']);
  assert.equal(result.used, 70);
  assert.equal(result.budgetSkipped, 1, 'c:2 did not fit but c:3 still could');

  const capped = selectWithinBudget(ordered, ordered, [], { budget: 6_000, maxEntries: 1 });
  assert.equal(capped.selected.length, 1);
});

test('A section neighbour joins only with overlap and a meaningful score of its own', () => {
  const head = candidate('c:1', { ord: 1, score: 0.9, tokenCount: 10 });
  const weak = candidate('c:2', { ord: 2, score: 0.1, tokenCount: 10, overlapPrev: 5, sha: 'b' });
  const strong = candidate('c:2', { ord: 2, score: 0.5, tokenCount: 10, overlapPrev: 5, sha: 'b' });

  const skipped = selectWithinBudget([head], [head, weak], [], { budget: 6_000, maxEntries: 12 });
  assert.equal(skipped.neighborsAdded, 0);

  const added = selectWithinBudget([head], [head, strong], [], { budget: 6_000, maxEntries: 12 });
  assert.equal(added.neighborsAdded, 1);
  assert.equal(added.selected[1].reasonExtra, 'context_expansion_of=c:1');

  const noOverlap = candidate('c:2', { ord: 2, score: 0.5, tokenCount: 10, overlapPrev: 0, sha: 'b' });
  assert.equal(
    selectWithinBudget([head], [head, noOverlap], [], { budget: 6_000, maxEntries: 12 }).neighborsAdded,
    0,
  );
});

test('ready demands both a score and coverage of the question', () => {
  const terms = [{ token: 'агент', df: 3, idf: 1 }];
  const selected = [candidate('c:1', { cov: 0.9 }), candidate('c:2', { cov: 0.8 }),
    candidate('c:3', { cov: 0.7 })];

  const ready = decideStatus({ selected, bestScore: 0.8, bestCov: 0.9, terms });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.confidence, 'high');

  // A score built from entity and rank signals while the substance stays
  // uncovered is an honest partial context, not an answer.
  const partial = decideStatus({ selected, bestScore: 0.75, bestCov: 0.3, terms });
  assert.equal(partial.status, 'insufficient_context');
  assert.equal(partial.confidence, 'low');
  assert.match(partial.gaps.at(-1), /контекст частичен/);

  const lowScore = decideStatus({ selected, bestScore: 0.4, bestCov: 0.9, terms });
  assert.equal(lowScore.status, 'insufficient_context');
});

test('Confidence follows the coverage of the top fragment and the number of entries', () => {
  const terms = [];
  const three = [candidate('c:1', { cov: 0.9 }), candidate('c:2'), candidate('c:3')];
  assert.equal(decideStatus({ selected: three, bestScore: 0.9, bestCov: 0.9, terms }).confidence, 'high');

  const two = [candidate('c:1', { cov: 0.9 }), candidate('c:2')];
  assert.equal(
    decideStatus({ selected: two, bestScore: 0.9, bestCov: 0.9, terms }).confidence, 'medium',
    'high confidence also requires enough supporting entries',
  );

  const shallow = [candidate('c:1', { cov: 0.3 }), candidate('c:2'), candidate('c:3')];
  assert.equal(decideStatus({ selected: shallow, bestScore: 0.9, bestCov: 0.6, terms }).confidence, 'low');
});

test('Unknown terms and a missing dictionary match are reported as explicit gaps', () => {
  const terms = [{ token: 'хромодинамика', df: 0, idf: 5 }];
  const gaps = notFoundGaps(terms, []);
  assert.deepEqual(gaps, [
    "термин 'хромодинамика' не встречается в базе домена",
    'вопрос не совпал ни с одним концептом словаря домена',
  ]);
  assert.deepEqual(notFoundGaps([], ['агент']), [
    'термины вопроса не образуют достаточного покрытия в базе домена',
  ]);
});

test('Dialogue tail is borrowed only for short questions and follow-up openers', () => {
  assert.equal(tailEligible('а если он упадёт?', ['упадет']), true);
  assert.equal(tailEligible('это надолго?', ['надолго']), true);
  assert.equal(tailEligible('Что такое ИИ-агент и как он устроен?', ['ии-агент', 'устроен']), false);

  const tail = { user: 'расскажи про n8n', assistant: 'n8n это автоматизация нод' };
  assert.deepEqual(tailTerms(tail), ['n8n', 'автоматизация', 'нод']);
  assert.deepEqual(tailTerms(null), []);
});

test('Selection reason records the paths that produced a candidate', () => {
  const cand = candidate('c:1', {
    cov: 0.42, ftsRank: 3, docRank: 1, entityNotes: ['агент(defined,n_hits=4)'],
    reasonExtra: 'context_expansion_of=c:0',
  });
  assert.equal(
    selectionReason(cand),
    'context_expansion_of=c:0;entity:агент(defined,n_hits=4);fts_rank=3;doc_rank=1;cov=0.42',
  );
});

test('Token cost falls back to the word estimate only when the stored count is missing', () => {
  assert.equal(tokensOf(candidate('c:1', { tokenCount: 42 })), 42);
  assert.equal(tokensOf(candidate('c:2', { tokenCount: 0, content: 'одно два три четыре пять' })), 8);
});

test('Ranking comparator is a total order on score then chunk_id', () => {
  const rows = [
    { chunkId: 'b', score: 0.5 }, { chunkId: 'a', score: 0.5 }, { chunkId: 'c', score: 0.9 },
  ];
  assert.deepEqual([...rows].sort(byScoreThenId).map((r) => r.chunkId), ['c', 'a', 'b']);
});
