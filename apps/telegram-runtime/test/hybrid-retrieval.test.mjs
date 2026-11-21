import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  expandLinks, linkNeighbours, passagePieces, rrfFuse, sentenceWindows, vectorRanking,
} from '../src/hybrid-retrieval.mjs';
import {
  createCompactTokenizer, createEmbedder, meanPoolNormalize, PACKAGE_MODEL_FILES, truncateIds,
} from '../src/embedder.mjs';
import { createRetrieverAdapter } from '../src/retriever-adapter.mjs';
import { createKnowledgeRetrieval } from '../src/knowledge-retrieval.mjs';
import { loadRuntimeConfig } from '../src/config.mjs';

// ---------------------------------------------------------------- pure pieces

test('sentence windows match the offline recipe: 3 sentences, stride 2, collapsed spaces', () => {
  assert.deepEqual(sentenceWindows(''), []);
  assert.deepEqual(sentenceWindows('Один.  Два!\nТри?'), ['Один. Два! Три?']);
  assert.deepEqual(sentenceWindows('A. B. C. D. E.'), ['A. B. C.', 'C. D. E.']);
  // Python range(0, n-3+1, 2) with n=6 → starts 0, 2 only.
  assert.deepEqual(sentenceWindows('A. B. C. D. E. F.'), ['A. B. C.', 'C. D. E.']);
  assert.deepEqual(sentenceWindows('Многоточие… дальше. Конец'), ['Многоточие… дальше. Конец']);
});

test('passage pieces are the windows plus every non-blank alias line, unstripped', () => {
  assert.deepEqual(passagePieces('A. B.', 'card one\n\n  \n card two'), ['A. B.', 'card one', ' card two']);
  assert.deepEqual(passagePieces('A.', 'x', { includeAlias: false }), ['A.']);
});

test('RRF fusion: 1/(60+rank+1), equal weights, vector depth cap, ties keep lexical first', () => {
  const fused = rrfFuse(['a', 'b', 'c'], ['c', 'd', 'e', 'f'], { vectorDepth: 3, top: 4 });
  assert.deepEqual(fused.map((f) => f.id), ['c', 'a', 'b', 'd']);
  assert.equal(fused[0].score, 1 / 63 + 1 / 61);
  assert.equal(fused[0].lexRank, 2);
  assert.equal(fused[0].vecRank, 0);
  assert.equal(fused[3].lexRank, null);
  // 'f' is past the vector depth and never enters; 'b' (1/62) and 'd' (1/62) tie → lexical first.
  assert.equal(fused.find((f) => f.id === 'f'), undefined);
  assert.deepEqual(rrfFuse([], ['x', 'y'], { vectorDepth: 6, top: 1 }).map((f) => f.id), ['x']);
});

test('vector ranking: best piece per passage, stable ties, optional allow-list', () => {
  const index = {
    ids: ['p0', 'p1', 'p2'],
    owner: Int32Array.from([0, 0, 1, 2]),
    matrix: Float32Array.from([1, 0, 0, 1, 0, 1, 0, 1]),
    dim: 2,
  };
  const ranked = vectorRanking(index, Float32Array.from([0, 1]));
  assert.deepEqual(ranked.map((r) => r.id), ['p0', 'p1', 'p2']);
  assert.equal(ranked[0].score, 1);
  assert.deepEqual(vectorRanking(index, Float32Array.from([0, 1]), { allowed: new Set(['p2']) }).map((r) => r.id), ['p2']);
});

test('link expansion is undirected, typed, deduplicated and capped', () => {
  const nb = linkNeighbours([
    { type: 'contradicts', a: 'x', b: 'y' },
    { type: 'continues', a: 'x', b: 'z' },
    { type: 'qualifies', a: 'w', b: 'x' },
    { type: 'qualifies', a: 'y', b: 'v' },
  ], ['contradicts', 'qualifies']);
  assert.deepEqual(expandLinks(['x'], nb, 4).map((l) => l.id), ['y', 'w']);
  assert.deepEqual(expandLinks(['x', 'y'], nb, 4).map((l) => l.id), ['w', 'v']);
  assert.deepEqual(expandLinks(['x', 'y'], nb, 1).map((l) => l.id), ['w']);
  assert.equal(expandLinks(['x'], nb, 4)[0].type, 'contradicts');
});

// ---------------------------------------------------------------- embedder

test('truncation keeps <s>, the first max-2 tokens and </s>', () => {
  assert.deepEqual(truncateIds([0, 5, 6, 2], 8), [0, 5, 6, 2]);
  assert.deepEqual(truncateIds([0, 5, 6, 7, 8, 2], 4), [0, 5, 6, 2]);
});

test('mean pooling honours the attention mask and L2-normalizes', () => {
  // batch 1, seq 3, dim 2; third token is padding.
  const [vec] = meanPoolNormalize(Float32Array.from([3, 0, 1, 0, 100, 100]), [1, 1, 0], 1, 3, 2);
  assert.deepEqual(Array.from(vec), [1, 0]);
});

test('embedder loads lazily, once, single-threaded; a load failure is a rejected promise', async () => {
  const created = [];
  const fakeOrt = {
    Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } },
    InferenceSession: {
      async create(path, options) {
        created.push({ path, options });
        return {
          inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
          outputNames: ['last_hidden_state'],
          async run(feeds) {
            const [batch, seq] = feeds.input_ids.dims;
            const data = new Float32Array(batch * seq * 2);
            for (let i = 0; i < batch * seq; i += 1) data[i * 2] = Number(feeds.input_ids.data[i]);
            return { last_hidden_state: { dims: [batch, seq, 2], data } };
          },
        };
      },
    },
  };
  const tokenizer = { encode: (text) => ({ ids: [0, ...[...text].map(() => 7), 2] }) };
  const embedder = createEmbedder(
    { modelPath: '/m.onnx', tokenizerPath: '/t.json' },
    { loadOrt: async () => fakeOrt, loadTokenizer: async () => tokenizer },
  );
  assert.equal(created.length, 0, 'nothing is loaded before the first call');
  const [a, b] = await embedder.embed(['ab', 'abcd']);
  await embedder.embedOne('x');
  assert.equal(created.length, 1);
  assert.equal(created[0].options.intraOpNumThreads, 1);
  assert.equal(created[0].options.interOpNumThreads, 1);
  assert.deepEqual(Array.from(a), [1, 0]);
  assert.deepEqual(Array.from(b), [1, 0]);

  const broken = createEmbedder(
    { modelPath: '/m.onnx', tokenizerPath: '/t.json' },
    { loadOrt: async () => { throw new Error('no_binary'); }, loadTokenizer: async () => tokenizer },
  );
  await assert.rejects(broken.embedOne('x'), /no_binary/);
  await assert.rejects(broken.embedOne('x'), /no_binary/);
});

test('compact Unigram tokenizer gives the same ids as the stock one', async () => {
  const { Tokenizer } = await import('@huggingface/tokenizers');
  const vocab = [['<s>', 0], ['<pad>', 0], ['</s>', 0], ['<unk>', 0], ['▁', -2], ['▁при', -3], ['вет', -3],
    ['▁привет', -2.5], ['▁мир', -2.8], ['м', -6], ['и', -6], ['р', -6], ['п', -6], ['в', -6], ['е', -6], ['т', -6],
    ['▁м', -5], ['ир', -4.5], ['<mask>', 0]];
  const json = () => ({
    version: '1.0', truncation: null, padding: null,
    added_tokens: [
      { id: 0, content: '<s>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
      { id: 2, content: '</s>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
      { id: 18, content: '<mask>', single_word: false, lstrip: true, rstrip: false, normalized: false, special: true },
    ],
    normalizer: null,
    pre_tokenizer: { type: 'Metaspace', replacement: '▁', add_prefix_space: true, prepend_scheme: 'always' },
    post_processor: {
      type: 'TemplateProcessing',
      single: [{ SpecialToken: { id: '<s>', type_id: 0 } }, { Sequence: { id: 'A', type_id: 0 } }, { SpecialToken: { id: '</s>', type_id: 0 } }],
      pair: [],
      special_tokens: { '<s>': { id: '<s>', ids: [0], tokens: ['<s>'] }, '</s>': { id: '</s>', ids: [2], tokens: ['</s>'] } },
    },
    decoder: null,
    model: { type: 'Unigram', unk_id: 3, vocab },
  });
  const config = { eos_token: '</s>' };
  const stock = new Tokenizer(json(), config);
  const compact = createCompactTokenizer(Tokenizer, json(), config);
  for (const text of ['привет мир', 'мир привет', 'прив', 'xyz мир', '<mask> мир', '']) {
    assert.deepEqual(compact.encode(text).ids, stock.encode(text).ids, text);
  }
  assert.equal(compact.model.trie.constructor, Object, 'the character trie is not kept');
});

// Real quantized model: only when a built hybrid package is named (never downloads).
const REAL_PACKAGE = process.env.AICHATTG_HYBRID_PACKAGE_DIR || '';
test('real quantized MiniLM: 384-d unit vectors, paraphrases closer than strangers',
  { skip: !(REAL_PACKAGE && existsSync(join(REAL_PACKAGE, PACKAGE_MODEL_FILES.model))) && 'set AICHATTG_HYBRID_PACKAGE_DIR' },
  async () => {
    const embedder = createEmbedder({
      modelPath: join(REAL_PACKAGE, PACKAGE_MODEL_FILES.model),
      tokenizerPath: join(REAL_PACKAGE, PACKAGE_MODEL_FILES.tokenizer),
      tokenizerConfigPath: join(REAL_PACKAGE, PACKAGE_MODEL_FILES.tokenizerConfig),
    });
    const [a, b, c] = await embedder.embed(['Как найти работу?', 'Где искать работу?', 'Рецепт борща']);
    assert.equal(a.length, 384);
    const dot = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
    assert.ok(Math.abs(dot(a, a) - 1) < 1e-4);
    assert.ok(dot(a, b) > dot(a, c));
  });

// ---------------------------------------------------------------- retriever over a real SQLite fixture

const VEC = { u1: [0, 0, 1, 0], u2: [0, 0, 0, 1], u3: [1, 0, 0, 0], u4: [0, 1, 0, 0] };

function hybridPackage({ vectors = true, links = true, modelSha = 'model-sha' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hybrid-pkg-'));
  const db = new Database(join(dir, 'ai.db'));
  db.exec(`CREATE TABLE build_meta (scope TEXT, source_signature TEXT);
    INSERT INTO build_meta VALUES ('fixture','1');
    CREATE TABLE domains (domain_id TEXT); INSERT INTO domains VALUES ('ai');
    CREATE TABLE concepts (domain_id TEXT, canonical TEXT, n_units INTEGER);
    INSERT INTO concepts VALUES ('ai','prompting',2);
    CREATE TABLE concept_units (domain_id TEXT, canonical TEXT, unit_id TEXT, role TEXT, n_hits INTEGER);
    CREATE TABLE units (unit_id TEXT, state TEXT, title TEXT, canonical_url TEXT, url_state TEXT);
    CREATE TABLE chunks (chunk_id TEXT, unit_id TEXT, content TEXT, token_count INTEGER, section_path TEXT, ord INTEGER, overlap_prev INTEGER, content_sha256 TEXT, state TEXT, search_text TEXT, search_alias TEXT);
    CREATE TABLE unit_domain (unit_id TEXT, domain_id TEXT);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED, search_text);
    CREATE VIRTUAL TABLE docs_fts USING fts5(unit_id UNINDEXED, search_text);`);
  const texts = {
    u1: 'Prompting teaches clear instructions and conditions for an AI model. Prompting prompting.',
    u2: 'Prompting basics for a model.',
    u3: 'Совсем другой текст про карьеру и выбор.',
    u4: 'Ещё один текст про ремесло и мастерство.',
  };
  for (const [unit, content] of Object.entries(texts)) {
    db.prepare('INSERT INTO units VALUES (?, ?, ?, ?, ?)').run(unit, 'canonical', `T ${unit}`, null, null);
    db.prepare('INSERT INTO unit_domain VALUES (?, ?)').run(unit, 'ai');
    if (unit === 'u1' || unit === 'u2') db.prepare('INSERT INTO concept_units VALUES (?, ?, ?, ?, ?)').run('ai', 'prompting', unit, 'explains', 3);
    db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`${unit}:s:001`, unit, content, 20, '[]', 1, 0,
      createHash('sha256').update(content).digest('hex'), 'canonical', content, '');
    db.prepare('INSERT INTO chunks_fts VALUES (?, ?)').run(`${unit}:s:001`, content);
    db.prepare('INSERT INTO docs_fts VALUES (?, ?)').run(unit, content);
  }
  if (vectors) {
    db.exec(`CREATE TABLE passage_vectors (chunk_id TEXT, piece_ord INTEGER, dim INTEGER, vec BLOB);
      CREATE TABLE passage_vectors_meta (key TEXT PRIMARY KEY, value TEXT)`);
    db.prepare('INSERT INTO passage_vectors_meta VALUES (?, ?)').run('model_sha256', modelSha);
    for (const [unit, v] of Object.entries(VEC)) {
      db.prepare('INSERT INTO passage_vectors VALUES (?, ?, ?, ?)').run(`${unit}:s:001`, 0, 4, Buffer.from(Float32Array.from(v).buffer));
    }
  }
  if (links) {
    db.exec('CREATE TABLE passage_links (type TEXT, a_chunk_id TEXT, b_chunk_id TEXT)');
    db.prepare('INSERT INTO passage_links VALUES (?, ?, ?)').run('contradicts', 'u3:s:001', 'u4:s:001');
    db.prepare('INSERT INTO passage_links VALUES (?, ?, ?)').run('continues', 'u1:s:001', 'u4:s:001');
  }
  db.close();
  return dir;
}

const QUESTION = 'prompting instructions';
const silent = () => {};

test('lexical default is unchanged: same entries as an explicit lexical retriever, no search trace', () => {
  const dir = hybridPackage();
  const plain = createRetrieverAdapter({ databasePath: join(dir, 'ai.db'), domainId: 'ai', validatePacks: false });
  const explicit = createRetrieverAdapter({ databasePath: join(dir, 'ai.db'), domainId: 'ai', validatePacks: false,
    retrievalMode: 'lexical' });
  const a = plain.forQuestion({ question: QUESTION, maxEntries: 3, queryVector: Float32Array.from(VEC.u3) });
  const b = explicit.forQuestion({ question: QUESTION, maxEntries: 3 });
  assert.deepEqual(a.pack.entries, b.pack.entries);
  assert.deepEqual(a.pack.entries.map((e) => e.id), ['u1:s:001', 'u2:s:001']);
  assert.equal(a.trace, undefined, 'no trace object is added in lexical mode');
  assert.equal(plain.searchStatus().hybrid, false);
});

test('hybrid fuses the vector ranking into the lexical selection and appends linked passages', () => {
  const dir = hybridPackage();
  const retriever = createRetrieverAdapter({
    databasePath: join(dir, 'ai.db'), domainId: 'ai', validatePacks: false, retrievalMode: 'hybrid',
    linkExpansion: { types: ['contradicts'], max: 1 }, vectorModelSha256: 'model-sha',
  }, { log: silent });
  assert.equal(retriever.searchStatus().hybrid, true);
  const answer = retriever.forQuestion({ question: QUESTION, maxEntries: 3, queryVector: Float32Array.from(VEC.u3) });
  // lexical u1(0) u2(1); vector u3(0) u1(1) u2(2) u4(3) → u1, u2, u3 ; + u4 by contradicts(u3).
  assert.deepEqual(answer.pack.entries.map((e) => e.id), ['u1:s:001', 'u2:s:001', 'u3:s:001', 'u4:s:001']);
  assert.match(answer.pack.selected[2].selection_reason, /hybrid:rrf=.*lex_rank=-;vec_rank=0/);
  assert.match(answer.pack.selected[3].selection_reason, /link:contradicts_of=u3:s:001/);
  assert.equal(answer.pack.selected[2].score, 1);
  assert.deepEqual({ ...answer.trace.search }, { mode: 'hybrid', lexical: 2, vectorOnly: 1, linksAdded: 1, budgetSkipped: 0 });
});

test('hybrid without a usable query vector answers lexically for that question', () => {
  const dir = hybridPackage();
  const retriever = createRetrieverAdapter({ databasePath: join(dir, 'ai.db'), domainId: 'ai', validatePacks: false,
    retrievalMode: 'hybrid' }, { log: silent });
  const answer = retriever.forQuestion({ question: QUESTION, maxEntries: 3, queryVector: Float32Array.from([1, 0]) });
  assert.deepEqual(answer.pack.entries.map((e) => e.id), ['u1:s:001', 'u2:s:001']);
  assert.deepEqual({ ...answer.trace.search }, { mode: 'lexical', fallback: 'query_vector_missing' });
});

test('vectors from another model, or no vectors at all, keep hybrid off with a reason', () => {
  const logs = [];
  const mismatch = createRetrieverAdapter({ databasePath: join(hybridPackage(), 'ai.db'), domainId: 'ai',
    retrievalMode: 'hybrid', vectorModelSha256: 'other' }, { log: (l) => logs.push(l) });
  assert.equal(mismatch.searchStatus().hybridReason, 'search_vectors_model_mismatch');
  const missing = createRetrieverAdapter({ databasePath: join(hybridPackage({ vectors: false }), 'ai.db'), domainId: 'ai',
    retrievalMode: 'hybrid' }, { log: (l) => logs.push(l) });
  assert.equal(missing.searchStatus().hybridReason, 'search_vectors_missing');
  assert.equal(logs.length, 2);
  const answer = missing.forQuestion({ question: QUESTION, maxEntries: 3, queryVector: Float32Array.from(VEC.u3) });
  assert.equal(answer.available, true);
  assert.deepEqual(answer.pack.entries.map((e) => e.id), ['u1:s:001', 'u2:s:001']);
});

test('the explicit refuse gate is never overruled by vectors', () => {
  const dir = hybridPackage();
  const retriever = createRetrieverAdapter({ databasePath: join(dir, 'ai.db'), domainId: 'ai', validatePacks: false,
    retrievalMode: 'hybrid', noConceptGate: 'refuse' }, { log: silent });
  const answer = retriever.forQuestion({ question: 'карьера выбор ремесло', maxEntries: 3, queryVector: Float32Array.from(VEC.u3) });
  assert.equal(answer.pack.status, 'not_found');
  assert.deepEqual(answer.pack.entries, []);
  const pass = createRetrieverAdapter({ databasePath: join(dir, 'ai.db'), domainId: 'ai', validatePacks: false,
    retrievalMode: 'hybrid', noConceptGate: 'pass' }, { log: silent });
  const passed = pass.forQuestion({ question: 'карьера выбор ремесло', maxEntries: 3, queryVector: Float32Array.from(VEC.u3) });
  assert.equal(passed.pack.entries[0].id, 'u3:s:001');
});

// ---------------------------------------------------------------- knowledge-retrieval wiring

function packageWithModel(dir) {
  mkdirSync(join(dir, 'model'));
  for (const rel of Object.values(PACKAGE_MODEL_FILES)) writeFileSync(join(dir, rel), 'fake');
  return dir;
}
const stubKnowledge = (dir, extra = {}) => ({
  forPackage: () => ({ available: true, reason: null,
    package: { databasePath: join(dir, 'ai.db'), domainId: 'ai', sourceId: 'course-knowledge-v2', ...extra } }),
});
const FAKE_SHA = createHash('sha256').update('fake').digest('hex');

test('a failing embedder degrades to lexical, logs once per reason, never throws', async () => {
  const dir = packageWithModel(hybridPackage({ modelSha: FAKE_SHA }));
  const logs = [];
  const retrieval = createKnowledgeRetrieval(
    { maxEntries: 3, retrievalMode: 'hybrid', validatePacks: false, noConceptGate: 'pass' },
    { knowledge: stubKnowledge(dir), log: (l) => logs.push(l),
      buildEmbedder: () => ({ embedOne: async () => { throw new Error('onnx_session_failed'); } }) },
  );
  for (let i = 0; i < 3; i += 1) {
    const result = await retrieval.forQuestion({ question: QUESTION, sessionId: `s${i}` });
    assert.equal(result.grounded, true);
    assert.deepEqual(result.knowledge.entries.map((e) => e.id), ['u1:s:001', 'u2:s:001']);
  }
  assert.equal(logs.filter((l) => l.includes('onnx_session_failed')).length, 1);
});

test('a working embedder makes the knowledge layer hybrid; grounding cap includes the links', async () => {
  const dir = packageWithModel(hybridPackage({ modelSha: FAKE_SHA }));
  const retrieval = createKnowledgeRetrieval(
    { maxEntries: 3, retrievalMode: 'hybrid', validatePacks: false, noConceptGate: 'pass',
      linkExpansion: { types: ['contradicts'], max: 1 } },
    { knowledge: stubKnowledge(dir), log: silent,
      buildEmbedder: () => ({ embedOne: async () => Float32Array.from(VEC.u3) }) },
  );
  const result = await retrieval.forQuestion({ question: QUESTION, sessionId: 'x' });
  assert.deepEqual(result.knowledge.entries.map((e) => e.id), ['u1:s:001', 'u2:s:001', 'u3:s:001', 'u4:s:001']);
  assert.equal(result.trace.search.mode, 'hybrid');
});

test('an admitted package whose manifest does not list the model keeps hybrid off', async () => {
  const dir = packageWithModel(hybridPackage({ modelSha: FAKE_SHA }));
  const logs = [];
  let built = 0;
  const retrieval = createKnowledgeRetrieval(
    { maxEntries: 3, retrievalMode: 'hybrid', validatePacks: false, noConceptGate: 'pass' },
    { knowledge: stubKnowledge(dir, { root: dir, files: [{ path: 'ai.db', sha256: 'x' }] }), log: (l) => logs.push(l),
      buildEmbedder: () => { built += 1; return { embedOne: async () => Float32Array.from(VEC.u3) }; } },
  );
  const result = await retrieval.forQuestion({ question: QUESTION, sessionId: 'x' });
  assert.equal(built, 0);
  assert.ok(logs.some((l) => l.includes('embedder_model_not_in_package')));
  assert.deepEqual(result.knowledge.entries.map((e) => e.id), ['u1:s:001', 'u2:s:001']);
});

// ---------------------------------------------------------------- config

test('config: retrieval search defaults reproduce the lexical retriever', () => {
  const config = loadRuntimeConfig({}, { cwd: '/tmp' });
  const r = config.assistantRetrieval;
  assert.equal(r.retrievalMode, 'lexical');
  assert.equal(r.noConceptGate, 'refuse');
  assert.equal(r.coverageText, 'content');
  assert.equal(r.hybridMaxContextTokens, 12_000);
  assert.deepEqual(r.linkExpansion, { types: ['contradicts', 'qualifies'], max: 0 });
});

test('config: the offline recipe is expressible and invalid values fail fast', () => {
  const r = loadRuntimeConfig({
    TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_MODE: 'hybrid',
    TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_NO_CONCEPT_GATE: 'pass',
    TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_COVERAGE_TEXT: 'content+alias',
    TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_MAX_ENTRIES: '24',
    TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_LINK_MAX: '4',
  }, { cwd: '/tmp' }).assistantRetrieval;
  assert.equal(r.retrievalMode, 'hybrid');
  assert.equal(r.maxEntries, 24);
  assert.deepEqual(r.linkExpansion, { types: ['contradicts', 'qualifies'], max: 4 });
  for (const [name, value] of [
    ['TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_MODE', 'vector'],
    ['TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_NO_CONCEPT_GATE', 'maybe'],
    ['TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_COVERAGE_TEXT', 'alias'],
    ['TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_LINK_TYPES', 'contradicts,friends'],
    ['TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_LINK_MAX', '17'],
    ['TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_HYBRID_MAX_CONTEXT_TOKENS', '100'],
  ]) {
    assert.throws(() => loadRuntimeConfig({ [name]: value }, { cwd: '/tmp' }), new RegExp(name), name);
  }
  assert.throws(() => loadRuntimeConfig({
    TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_LINK_TYPES: '', TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_LINK_MAX: '2',
  }, { cwd: '/tmp' }), /LINK_MAX > 0 requires/);
});
