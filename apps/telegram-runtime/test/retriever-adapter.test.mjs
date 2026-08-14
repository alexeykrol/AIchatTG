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

// --- Step 5: question rewrite and the single second pass ---------------------

/**
 * A package whose FTS answers depend on the words actually searched, so a test
 * can prove that the second pass searched the rewritten question rather than
 * replaying the first one.
 */
function rewriteAwareDatabase({ hitToken, chunks, concepts = [], conceptUnits = [] }) {
  const searched = [];
  const matches = (expr) => String(expr).includes(hitToken);
  return {
    searched,
    close() {},
    prepare(sql) {
      if (sql.includes('COUNT(*) n FROM chunks_fts WHERE search_text MATCH')) {
        return { get: (expr) => ({ n: matches(expr) ? 3 : 0 }) };
      }
      if (sql.includes('COUNT(*) n FROM chunks_fts')) return { get: () => ({ n: 50 }) };
      if (sql.includes('FROM build_meta')) return { all: () => [] };
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
      if (sql.includes('FROM domains')) return { get: (id) => (id === 'ai' ? { 1: 1 } : undefined) };
      if (sql.includes('FROM docs_fts')) return { all: () => [] };
      if (sql.includes('ROW_NUMBER() OVER')) {
        return { all: (expr) => (matches(expr) ? chunks.map(
          (row) => ({ ...row, search_text: row.content, rank_score: -1 })) : []) };
      }
      if (sql.includes('AND c.unit_id = ?')) return { all: () => [] };
      if (sql.includes('chunks_fts MATCH')) {
        return {
          all: (expr) => { searched.push(expr); return matches(expr) ? chunks : []; },
        };
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
}

const REWRITE_BODY = 'передача контекста между сессиями требует сохранить состояние '
  + 'передача контекста выполняется файлом состояния передача контекста между сессиями';

function rewriteRetriever(overrides = {}, ports = {}) {
  const db = rewriteAwareDatabase({
    hitToken: 'контекст',
    chunks: [chunk('lesson:7:a:001', REWRITE_BODY, { unit_id: 'lesson:7' })],
    concepts: [{ domain_id: 'ai', canonical: 'передача контекста', n_units: 2 }],
    conceptUnits: [{
      domain_id: 'ai', canonical: 'передача контекста', unit_id: 'lesson:7',
      role: 'defined', n_hits: 3,
    }],
  });
  const retriever = createRetrieverAdapter(
    { databasePath: '/ai.db', rewriteEnabled: true, ...overrides },
    { openDatabase: () => db, ...ports },
  );
  return { db, retriever };
}

const MISS_QUESTION = 'как перетащить наработанное из старого чата';

test('Rewrite is off by default, so the first pack is returned untouched', async () => {
  const { db, retriever } = rewriteRetriever({ rewriteEnabled: false }, {
    rewriteQuestion: async () => 'передача контекста между сессиями',
  });
  const answer = await retriever.forQuestionWithRewrite({ question: MISS_QUESTION });

  assert.equal(answer.pack.rewrite_trace.attempted, false);
  assert.equal(answer.pack.rewrite_trace.reason, 'rewrite_disabled');
  assert.equal(db.searched.length, 1, 'a disabled rewrite performs exactly one search');
});

test('A grounded first pack is never re-searched and costs no model call', async () => {
  let calls = 0;
  const { db, retriever } = rewriteRetriever({}, {
    rewriteQuestion: async () => { calls += 1; return 'другой вопрос'; },
  });
  const answer = await retriever.forQuestionWithRewrite({
    question: 'что такое передача контекста между сессиями',
  });

  assert.equal(answer.pack.status, 'ready');
  assert.equal(answer.pack.rewrite_trace.attempted, false);
  assert.equal(answer.pack.rewrite_trace.reason, 'rewrite_not_triggered');
  assert.equal(calls, 0, 'a ready pack must not pay for a rewrite');
  assert.equal(db.searched.length, 1);
});

test('An ungrounded first pack triggers exactly one rewritten second pass', async () => {
  const seen = [];
  const { db, retriever } = rewriteRetriever({}, {
    rewriteQuestion: async (input) => {
      seen.push(input.question);
      return 'передача контекста между сессиями';
    },
  });
  const answer = await retriever.forQuestionWithRewrite({ question: MISS_QUESTION });

  assert.deepEqual(seen, [MISS_QUESTION], 'the rewriter is called once with the original question');
  assert.equal(answer.pack.status, 'ready');
  assert.equal(answer.pack.rewrite_trace.attempted, true);
  assert.equal(answer.pack.rewrite_trace.winner, 'second');
  assert.equal(answer.pack.rewrite_trace.first_status, 'not_found');
  assert.equal(answer.pack.rewrite_trace.second_status, 'ready');
  assert.equal(answer.pack.rewrite_trace.rewritten_question, 'передача контекста между сессиями');
  assert.equal(db.searched.length, 2, 'exactly two searches, never a loop');
  assert.ok(db.searched[1].includes('контекст'), 'the second pass searched the rewritten words');
});

test('A failed rewrite provider returns the first pack instead of an error', async () => {
  const { db, retriever } = rewriteRetriever({}, {
    rewriteQuestion: async () => { throw new Error('provider_transport_failed'); },
  });
  const answer = await retriever.forQuestionWithRewrite({ question: MISS_QUESTION });

  assert.equal(answer.available, true, 'a rewrite failure never denies the first result');
  assert.equal(answer.pack.status, 'not_found');
  assert.equal(answer.pack.rewrite_trace.attempted, true);
  assert.equal(answer.pack.rewrite_trace.reason, 'rewrite_provider_failed');
  assert.equal(db.searched.length, 1, 'a failed rewrite is not retried');
});

test('A rewriter that returns junk leaves the first pack in place', async () => {
  for (const [junk, reason] of [
    [null, 'rewrite_declined'],
    [{ text: 'x' }, 'rewrite_not_a_string'],
    ['  ', 'rewrite_empty'],
    ['я'.repeat(600), 'rewrite_too_long'],
    [MISS_QUESTION, 'rewrite_unchanged'],
  ]) {
    const { db, retriever } = rewriteRetriever({}, { rewriteQuestion: async () => junk });
    const answer = await retriever.forQuestionWithRewrite({ question: MISS_QUESTION });
    assert.equal(answer.pack.status, 'not_found', `junk ${reason} must not ground an answer`);
    assert.equal(answer.pack.rewrite_trace.reason, reason);
    assert.equal(db.searched.length, 1, `junk ${reason} must not cost a second search`);
  }
});

test('A second pass that finds nothing better keeps the original wording', async () => {
  const { db, retriever } = rewriteRetriever({}, {
    // A plausible but equally unmatched restatement: both passes miss.
    rewriteQuestion: async () => 'как забрать сделанное из прошлой переписки',
  });
  const answer = await retriever.forQuestionWithRewrite({ question: MISS_QUESTION });

  assert.equal(db.searched.length, 2);
  assert.equal(answer.pack.status, 'not_found');
  assert.equal(answer.pack.rewrite_trace.attempted, true);
  assert.equal(answer.pack.rewrite_trace.winner, 'first');
  assert.equal(answer.pack.rewrite_trace.reason, 'tie');
});

test('Without a rewriter port an enabled rewrite reports the absent provider', async () => {
  const { db, retriever } = rewriteRetriever({}, {});
  const answer = await retriever.forQuestionWithRewrite({ question: MISS_QUESTION });

  assert.equal(answer.pack.rewrite_trace.attempted, false);
  assert.equal(answer.pack.rewrite_trace.reason, 'rewrite_provider_unavailable');
  assert.equal(db.searched.length, 1);
});

test('An unavailable package is reported before any rewrite is considered', async () => {
  let calls = 0;
  const retriever = createRetrieverAdapter(
    { databasePath: '/ai.db', rewriteEnabled: true },
    { openDatabase: () => { throw new Error('EACCES'); }, rewriteQuestion: async () => { calls += 1; return 'x'; } },
  );
  const answer = await retriever.forQuestionWithRewrite({ question: MISS_QUESTION });

  assert.equal(answer.available, false);
  assert.equal(answer.reason, 'retriever_package_unreadable');
  assert.equal(answer.pack, null);
  assert.equal(calls, 0, 'a dead package never pays for a rewrite');
});

test('forQuestion keeps its exact contract and carries no rewrite trace', () => {
  const { db, retriever } = rewriteRetriever();
  const direct = retriever.forQuestion({ question: MISS_QUESTION });

  assert.equal(direct.available, true);
  assert.equal(direct.pack.status, 'not_found');
  assert.equal('rewrite_trace' in direct.pack, false);
  assert.equal(db.searched.length, 1);
});

/**
 * Billing contract, not cosmetics: a reason code that reaches the assistant
 * routing exit must be classified, and misclassifying it either charges a user
 * for silence or refunds a call that was actually paid. The retriever decides
 * every one of its codes locally, before the answer model; the rewrite step is
 * the sole place a code may follow a billable call, so `rewrite_provider_*`
 * must stay uncertain.
 */
test('Every retriever reason code is classified as a definitive routing exit', async () => {
  const { readFileSync } = await import('node:fs');
  const adapterSource = readFileSync(
    new URL('../src/retriever-adapter.mjs', import.meta.url), 'utf8');
  const runtimeSource = readFileSync(
    new URL('../src/runtime.mjs', import.meta.url), 'utf8');

  const emitted = [...new Set(
    [...adapterSource.matchAll(/'(retriever_[a-z_]+)'/g)].map((m) => m[1]))];
  assert.ok(emitted.length >= 5, 'the adapter still emits retriever reason codes');

  const classifier = runtimeSource.slice(
    runtimeSource.indexOf('function isDefinitiveAssistantRoutingExit'),
    runtimeSource.indexOf('function applyTelegramSafetySignals'));
  for (const code of emitted) {
    assert.ok(classifier.includes(`'${code}'`),
      `${code} must be classified in isDefinitiveAssistantRoutingExit`);
  }
  // A rewrite failure may already have been billed and must never refund quota.
  assert.equal(classifier.includes('rewrite_provider'), false,
    'a code that can follow a paid model call must not be definitive');
});

// --- Contract self-validation and citations ----------------------------------

/**
 * A package's own `contracts/` directory, supplied through the filesystem port
 * so the check can be proved without a package on disk.
 */
function contractPorts(schemas) {
  return {
    readFile(path) {
      const name = String(path).split('/').pop();
      if (!Object.hasOwn(schemas, name)) throw new Error(`ENOENT ${name}`);
      return JSON.stringify(schemas[name]);
    },
  };
}

const MINIMAL_PACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'status', 'entries'],
  properties: {
    schema_version: { const: 'kb_retrieval_pack_v1' },
    pack_id: { type: 'string' },
    pack_role: { type: 'string' },
    domain_id: { type: 'string' },
    package_version: { type: 'string' },
    status: { type: 'string' },
    entries: { type: 'array' },
    selected: { type: 'array' },
    gaps: { type: 'array' },
    contradictions: { type: 'array' },
    confidence: { type: 'string' },
    merge_hint: { type: 'object' },
    retrieval_trace: { type: 'object' },
    cache_trace: { type: 'object' },
    token_budget: { type: 'object' },
    latency_ms: { type: 'integer' },
  },
};

function groundedDatabase() {
  return fakeDatabase({
    chunks: [chunk('lesson:1:a:001', 'ии-агент это программа которая сама решает задачи ии-агент работает циклом')],
    concepts: [{ domain_id: 'ai', canonical: 'ии-агент', n_units: 3 }],
    conceptUnits: [{ domain_id: 'ai', canonical: 'ии-агент', unit_id: 'lesson:1', role: 'defined', n_hits: 4 }],
    meta: [{ scope: 'ai', source_signature: 'abc' }],
  });
}

test('A pack is validated against the schema shipped inside the package', () => {
  const retriever = createRetrieverAdapter(
    { databasePath: '/pkg/ai.db' },
    {
      openDatabase: () => groundedDatabase(),
      ...contractPorts({
        'retrieval_pack.v1.schema.json': MINIMAL_PACK_SCHEMA,
        'retrieval_request.v1.schema.json': { type: 'object' },
      }),
    },
  );
  assert.equal(retriever.contractStatus(), 'enforced');
  assert.equal(retriever.forQuestion({ question: 'что такое ии-агент?' }).pack.status, 'ready');
});

test('A pack that breaks its own contract is a reason code, not an answer', () => {
  // The build published a schema this projection cannot satisfy: a defect of our
  // code, caught before a paid call rather than sent to the model.
  const retriever = createRetrieverAdapter(
    { databasePath: '/pkg/ai.db' },
    {
      openDatabase: () => groundedDatabase(),
      ...contractPorts({
        'retrieval_pack.v1.schema.json': {
          ...MINIMAL_PACK_SCHEMA,
          required: [...MINIMAL_PACK_SCHEMA.required, 'a_field_we_do_not_emit'],
        },
        'retrieval_request.v1.schema.json': { type: 'object' },
      }),
    },
  );
  const answer = retriever.forQuestion({ question: 'что такое ии-агент?' });
  assert.deepEqual(answer, {
    available: false, reason: 'retriever_pack_contract_invalid', pack: null,
  });
});

test('A request that breaks its contract is refused before the search runs', () => {
  const retriever = createRetrieverAdapter(
    { databasePath: '/pkg/ai.db' },
    {
      openDatabase: () => groundedDatabase(),
      ...contractPorts({
        'retrieval_pack.v1.schema.json': MINIMAL_PACK_SCHEMA,
        'retrieval_request.v1.schema.json': {
          type: 'object', required: ['schema_version', 'impossible_field'],
        },
      }),
    },
  );
  assert.equal(retriever.forQuestion({ question: 'что такое ии-агент?' }).reason,
    'retriever_request_contract_invalid');
});

test('A package that ships no contracts is not validated against a substitute', () => {
  const retriever = createRetrieverAdapter(
    { databasePath: '/pkg/ai.db' },
    { openDatabase: () => groundedDatabase(), ...contractPorts({}) },
  );
  // `not_run` rather than a pass we never performed or a failure the pack never
  // caused: the contract lives in the artefact, and this artefact has none.
  assert.equal(retriever.contractStatus(), 'not_run');
  assert.equal(retriever.forQuestion({ question: 'что такое ии-агент?' }).pack.status, 'ready');
});

test('Validation can be switched off without touching code', () => {
  let reads = 0;
  const retriever = createRetrieverAdapter(
    { databasePath: '/pkg/ai.db', validatePacks: false },
    { openDatabase: () => groundedDatabase(), readFile() { reads += 1; return '{}'; } },
  );
  assert.equal(retriever.contractStatus(), 'disabled');
  assert.equal(reads, 0, 'a disabled check does not even read the schemas');
  assert.equal(retriever.forQuestion({ question: 'что такое ии-агент?' }).pack.status, 'ready');
});

test('The pack carries the config version its own contract requires', () => {
  const retriever = createRetrieverAdapter({ databasePath: '/ai.db' }, { openDatabase: () => groundedDatabase() });
  const { pack } = retriever.forQuestion({ question: 'что такое ии-агент?' });
  assert.match(pack.retrieval_trace.config_version, /^[a-f0-9]{12}$/);
});

test('Citations travel beside the contract pack, never inside its entries', () => {
  const db = groundedDatabase();
  const units = new Map([['lesson:1', {
    unit_id: 'lesson:1', title: 'Урок про агентов',
    canonical_url: 'https://alexeykrol.com/courses/ai_full/lessons/1/', url_state: 'confirmed',
  }]]);
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => (sql.includes('canonical_url, url_state FROM units')
    ? { get: (unitId) => units.get(unitId) }
    : originalPrepare(sql));

  const retriever = createRetrieverAdapter({ databasePath: '/ai.db' }, { openDatabase: () => db });
  const { pack } = retriever.forQuestion({ question: 'что такое ии-агент?' });

  // The schema declares entries as exactly {id, content}; a citation folded in
  // would make the pack fail its own contract.
  assert.deepEqual(Object.keys(pack.entries[0]).sort(), ['content', 'id']);
  assert.deepEqual(pack.citations['lesson:1:a:001'], {
    unitId: 'lesson:1',
    title: 'Урок про агентов',
    canonicalUrl: 'https://alexeykrol.com/courses/ai_full/lessons/1/',
  });
});

test('An unconfirmed lesson URL is never offered as a citation', () => {
  const db = groundedDatabase();
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => (sql.includes('canonical_url, url_state FROM units')
    ? {
      get: () => ({
        unit_id: 'lesson:1', title: 'Урок про агентов',
        canonical_url: 'https://alexeykrol.com/draft/', url_state: 'unconfirmed',
      }),
    }
    : originalPrepare(sql));

  const retriever = createRetrieverAdapter({ databasePath: '/ai.db' }, { openDatabase: () => db });
  const { pack } = retriever.forQuestion({ question: 'что такое ии-агент?' });
  // A broken link in an answer costs more than a missing one; the title still
  // survives so the reader knows which lesson was used.
  assert.deepEqual(pack.citations['lesson:1:a:001'], { unitId: 'lesson:1', title: 'Урок про агентов' });
});

test('The dictionary is exposed once so the veto and the search cannot disagree', () => {
  const retriever = createRetrieverAdapter({ databasePath: '/ai.db' }, { openDatabase: () => groundedDatabase() });
  const dictionary = retriever.dictionary();
  assert.equal(dictionary.domainId, 'ai');
  assert.ok(dictionary.concepts instanceof Map);
  assert.equal(dictionary.concepts.has('ии-агент'), true);
  assert.equal(retriever.unavailableReason(), null);
});
