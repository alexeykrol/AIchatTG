import assert from 'node:assert/strict';
import test from 'node:test';
import { createRetrieverAdapter } from '../src/retriever-adapter.mjs';

// A hand-built stand-in for the package database: statements are matched by the
// shape of their SQL so the adapter's own query wiring stays under test.
function fakeDatabase({ chunks = [], concepts = [], conceptUnits = [], docs = [], domains = ['ai'], meta = [], df = 5 } = {}) {
  const calls = [];
  const closed = { value: false };
  return {
    calls,
    closed,
    close() { closed.value = true; },
    prepare(sql) {
      calls.push(sql.replace(/\s+/g, ' ').trim().slice(0, 60));
      if (sql.includes('COUNT(*) n FROM chunks_fts WHERE search_text MATCH')) {
        return { get: () => ({ n: df }) };
      }
      if (sql.includes('COUNT(*) n FROM chunks_fts')) {
        return { get: () => ({ n: chunks.length || 1 }) };
      }
      if (sql.includes('FROM build_meta')) return { all: () => meta };
      if (sql.includes('COUNT(DISTINCT unit_id) n')) {
        return { all: () => conceptUnits.map((row) => ({ ...row, n: 1 })) };
      }
      if (sql.includes('cu.unit_id, cu.role, cu.n_hits')) {
        return {
          all: (domainId, canonical) => conceptUnits.filter(
            (row) => row.domain_id === domainId && row.canonical === canonical),
        };
      }
      if (sql.includes('n_units FROM concepts')) return { all: () => concepts };
      if (sql.includes('FROM domains')) {
        return { get: (id) => (domains.includes(id) ? { 1: 1 } : undefined) };
      }
      if (sql.includes('FROM docs_fts')) return { all: () => docs };
      if (sql.includes('ROW_NUMBER() OVER')) {
        return { all: () => conceptUnits.flatMap((link) => chunks
          .filter((chunk) => chunk.unit_id === link.unit_id)
          .map((chunk) => ({ ...chunk, search_text: chunk.content, rank_score: -1 }))) };
      }
      if (sql.includes('AND c.unit_id = ?')) return { all: () => [] };
      if (sql.includes('chunks_fts MATCH')) return { all: () => chunks };
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
}

function chunk(id, content, overrides = {}) {
  return {
    chunk_id: id,
    unit_id: overrides.unit_id ?? 'lesson:1',
    content,
    token_count: overrides.token_count ?? 20,
    section_path: '',
    ord: overrides.ord ?? 1,
    overlap_prev: overrides.overlap_prev ?? 0,
    content_sha256: overrides.sha ?? id,
  };
}

test('A missing package path is reported as a reason code instead of throwing', () => {
  const retriever = createRetrieverAdapter({}, { openDatabase: () => { throw new Error('nope'); } });
  assert.deepEqual(retriever.forQuestion({ question: 'что такое агент' }), {
    available: false, reason: 'retriever_package_missing', pack: null,
  });
});

test('An unreadable package degrades to a reason code and never opens a fallback', () => {
  let opened = 0;
  const retriever = createRetrieverAdapter(
    { databasePath: '/nonexistent/ai.db' },
    { openDatabase: () => { opened += 1; throw new Error('EACCES'); } },
  );
  assert.deepEqual(retriever.forQuestion({ question: 'что такое агент' }), {
    available: false, reason: 'retriever_package_unreadable', pack: null,
  });
  assert.equal(opened, 1, 'the adapter does not retry another path');
});

test('A package whose schema does not answer the bootstrap queries stays unavailable', () => {
  const retriever = createRetrieverAdapter(
    { databasePath: '/ai.db' },
    { openDatabase: () => ({ prepare() { throw new Error('no such table'); }, close() {} }) },
  );
  assert.equal(retriever.forQuestion({ question: 'агент' }).reason, 'retriever_package_invalid');
});

test('An unknown domain and a blank question are refused before any search', () => {
  const db = fakeDatabase({ chunks: [chunk('lesson:1:a:001', 'агент это программа')] });
  const retriever = createRetrieverAdapter(
    { databasePath: '/ai.db' }, { openDatabase: () => db },
  );
  assert.equal(retriever.forQuestion({ question: 'агент', domainId: 'physics' }).reason,
    'retriever_domain_unknown');
  assert.equal(retriever.forQuestion({ question: '   ' }).reason, 'retriever_question_invalid');
  assert.equal(retriever.forQuestion({}).reason, 'retriever_question_invalid');
});

test('A question with no dictionary match and no corroborating coverage is not_found', () => {
  const db = fakeDatabase({
    chunks: [chunk('lesson:1:a:001', 'сегодня мы готовим борщ на обед')],
    concepts: [],
  });
  const retriever = createRetrieverAdapter({ databasePath: '/ai.db' }, { openDatabase: () => db });
  const answer = retriever.forQuestion({ question: 'как приготовить борщ из хромодинамики' });

  assert.equal(answer.available, true);
  assert.equal(answer.pack.status, 'not_found');
  assert.equal(answer.pack.entries.length, 0);
  assert.ok(answer.pack.gaps.includes('вопрос не совпал ни с одним концептом словаря домена'));
});

test('A grounded question returns a contract pack with entries, trace and capped scores', () => {
  const body = 'ии-агент это программа которая сама решает задачи ии-агент работает циклом';
  const db = fakeDatabase({
    chunks: [chunk('lesson:1:a:001', body)],
    concepts: [{ domain_id: 'ai', canonical: 'ии-агент', n_units: 3 }],
    conceptUnits: [{ domain_id: 'ai', canonical: 'ии-агент', unit_id: 'lesson:1', role: 'defined', n_hits: 4 }],
    meta: [{ scope: 'ai', source_signature: 'abc' }],
  });
  const retriever = createRetrieverAdapter({ databasePath: '/ai.db' }, { openDatabase: () => db });
  const { pack } = retriever.forQuestion({ question: 'что такое ии-агент?' });

  assert.equal(pack.schema_version, 'kb_retrieval_pack_v1');
  assert.equal(pack.status, 'ready');
  assert.deepEqual(pack.entries, [{ id: 'lesson:1:a:001', content: body }]);
  assert.deepEqual(pack.retrieval_trace.concept_matches, ['ии-агент']);
  assert.equal(pack.retrieval_trace.query_terms.includes('ии-агент'), true);
  assert.ok(pack.selected[0].score <= 1, 'the contract caps the score even when the raw score exceeds it');
  assert.match(pack.selected[0].selection_reason, /entity:ии-агент\(defined,n_hits=4\)/);
  assert.equal(pack.token_budget.requested, 6_000);
  assert.equal(pack.package_version.length, 16);
  assert.equal(pack.cache_trace.cache_hit, false);
});

test('A repeated question inside one session is served from cache until the TTL expires', () => {
  const db = fakeDatabase({
    chunks: [chunk('lesson:1:a:001', 'ии-агент это программа которая решает задачи сама')],
    concepts: [{ domain_id: 'ai', canonical: 'ии-агент', n_units: 3 }],
    conceptUnits: [{ domain_id: 'ai', canonical: 'ии-агент', unit_id: 'lesson:1', role: 'used', n_hits: 2 }],
  });
  let clock = 1_000;
  const retriever = createRetrieverAdapter(
    { databasePath: '/ai.db' }, { openDatabase: () => db, now: () => clock },
  );

  const first = retriever.forQuestion({ question: 'что такое ии-агент', sessionId: 's1' });
  assert.equal(first.pack.cache_trace.cache_hit, false);

  const second = retriever.forQuestion({ question: 'что такое ии-агент', sessionId: 's1' });
  assert.equal(second.pack.cache_trace.cache_hit, true);
  assert.equal(second.pack.cache_trace.cache_reason, 'session_repeat');
  assert.deepEqual(second.pack.entries, first.pack.entries);

  clock += 301;
  const expired = retriever.forQuestion({ question: 'что такое ии-агент', sessionId: 's1' });
  assert.equal(expired.pack.cache_trace.cache_hit, false);
  assert.equal(expired.pack.cache_trace.cache_reason, 'expired');
});

test('Sessions are isolated and a topic change resets the cached packs', () => {
  const db = fakeDatabase({
    chunks: [chunk('lesson:1:a:001', 'ии-агент это программа которая решает задачи сама')],
    concepts: [{ domain_id: 'ai', canonical: 'ии-агент', n_units: 3 }],
    conceptUnits: [{ domain_id: 'ai', canonical: 'ии-агент', unit_id: 'lesson:1', role: 'used', n_hits: 2 }],
  });
  const retriever = createRetrieverAdapter({ databasePath: '/ai.db' }, { openDatabase: () => db });

  retriever.forQuestion({ question: 'что такое ии-агент', sessionId: 's1' });
  assert.equal(
    retriever.forQuestion({ question: 'что такое ии-агент', sessionId: 's2' }).pack.cache_trace.cache_hit,
    false, 'another session does not read the first session cache',
  );

  const switched = retriever.forQuestion({
    question: 'сколько стоит подписка вордпресс хостинга', sessionId: 's1',
  });
  assert.equal(switched.pack.cache_trace.topic_switch_detected, true);
  assert.equal(switched.pack.cache_trace.cache_reason, 'topic_switch_reset');
});

test('The adapter exposes a frozen surface and closes the database it opened', () => {
  const db = fakeDatabase({ chunks: [chunk('lesson:1:a:001', 'агент')] });
  const retriever = createRetrieverAdapter({ databasePath: '/ai.db' }, { openDatabase: () => db });
  assert.equal(Object.isFrozen(retriever), true);
  retriever.close();
  assert.equal(db.closed.value, true);
});

test('The read-only package opener is the production default port', async () => {
  const source = await import('node:fs').then(({ readFileSync }) => readFileSync(
    new URL('../src/retriever-adapter.mjs', import.meta.url), 'utf8'));
  assert.match(source, /openDatabase = openReadOnlyRuntimeDatabase/);
});
