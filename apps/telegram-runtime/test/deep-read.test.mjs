import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  DEEP_READ_BUDGET, DEEP_READ_GATE, caseRecord, chapterOf, createAnthropicQuerySuggester, createJsonlCaseSink,
  createPackageReader, deepReadFromEnv, deepReadReceipt, gateVerdict, keyTerms, parseQueries, takeWithinBudget,
  termCoverage, withDeepRead,
} from '../src/deep-read.mjs';

// ------------------------------------------------------------------ fixtures

const LONG = 'Специалист меняет организацию, но не профессию. Торговец продаёт дороже рынка. ';

/** A tiny book: three chapters, passages p1..p9, links between some of them. */
function fakeBook() {
  const passages = new Map();
  const units = { u1: 'CH-01', u2: 'CH-02', u3: 'CH-03' };
  const add = (id, unitId, ord, content, tokens = 100) => passages.set(id, {
    id, unitId, ord, content, tokens, chapter: units[unitId], title: `${units[unitId]} (часть)`, canonicalUrl: null,
  });
  add('p1', 'u1', 1, 'Специалист уходит из организации, когда мало платят.');
  add('p2', 'u1', 2, 'Профессия — основа идентичности специалиста.');
  add('p3', 'u1', 3, 'Сосед третьего места.');
  add('p4', 'u2', 1, 'Торговец умеет продавать дороже рынка.');
  add('p5', 'u2', 2, 'Автор связывает роль торговца и касту профессионалов.');
  add('p6', 'u3', 1, 'Управленец берёт ответственность.');
  add('p7', 'u3', 2, 'Предприниматель рискует.');
  add('p8', 'u3', 3, 'Большой кусок.', 5_000);
  add('p9', 'u3', 4, 'Найдено повторным поиском.');
  const links = new Map([
    ['p1', [{ id: 'p5', type: 'qualifies' }, { id: 'p8', type: 'applies' }]],
    ['p5', [{ id: 'p1', type: 'qualifies' }]],
  ]);
  const byUnit = (u) => [...passages.values()].filter((p) => p.unitId === u).sort((a, b) => a.ord - b.ord);
  return {
    passage: (id) => passages.get(id) || null,
    linksOf: (id) => links.get(id) || [],
    neighbours(id, window = 1) {
      const p = passages.get(id);
      const list = byUnit(p.unitId);
      const i = list.findIndex((x) => x.id === id);
      const out = [];
      for (let d = 1; d <= window; d += 1) {
        if (list[i - d]) out.push(list[i - d]);
        if (list[i + d]) out.push(list[i + d]);
      }
      return out;
    },
    documentFrequency: () => 1,
    documents: passages.size,
  };
}

function fakeRetrieval(entryIds, { extra = {} } = {}) {
  const calls = [];
  const book = fakeBook();
  const retrieval = Object.freeze({
    available: true, reason: null, domainId: 'tcr', sourceId: 'course-knowledge-v2',
    async forQuestion(input) {
      calls.push(input);
      const ids = calls.length === 1 ? entryIds : (extra[input.question] || ['p9']);
      return Object.freeze({
        grounded: true, reason: null, domainId: 'tcr',
        knowledge: { sourceId: 'course-knowledge-v2', entries: ids.map((id) => ({ id, content: book.passage(id).content })) },
        pack: { status: 'ok' }, trace: Object.freeze({ status: 'ok' }),
      });
    },
    close() {},
  });
  return { retrieval, calls, book };
}

const HARD_GATE = { ...DEEP_READ_GATE, topK: 3, spreadMinChapters: 3, spreadDominantShare: 0.5 };

// ------------------------------------------------------------------ pure pieces

test('chapter key comes from the CH-NN title, else the unit id without its part suffix', () => {
  assert.equal(chapterOf('0955148bf523-01', 'CH-06 (часть 1/2)'), 'CH-06');
  assert.equal(chapterOf('0955148bf523-02', ''), '0955148bf523');
  assert.equal(chapterOf('5a0da6806bcf', null), '5a0da6806bcf');
});

test('term coverage counts question stems found in the texts and abstains on short questions', () => {
  const c = termCoverage('Специалист уходит, когда мало платят зарплату', ['Специалист уходит.']);
  assert.equal(c.terms >= 3, true);
  assert.equal(c.share > 0 && c.share < 1, true);
  assert.equal(termCoverage('Кто ты?', ['x']).share, null);
});

test('gate: hard only when tension, spread and low coverage fire together (requireAll)', () => {
  const book = fakeBook();
  const top = ['p1', 'p4', 'p6'].map((id) => book.passage(id));
  const question = 'Почему управленец кибернетика синергия эмпатия и логистика важны';
  const all = gateVerdict({ question, top, linksOf: book.linksOf }, HARD_GATE);
  assert.deepEqual(all.reasons, ['tension', 'spread', 'coverage']);
  assert.equal(all.hard, true);
  // Same pack without the tension link: two of three is not hard.
  const two = gateVerdict({ question, top, linksOf: () => [] }, HARD_GATE);
  assert.deepEqual(two.reasons, ['spread', 'coverage']);
  assert.equal(two.hard, false);
  // Any-signal variant stays available for experiments.
  assert.equal(gateVerdict({ question, top, linksOf: () => [] }, { ...HARD_GATE, requireAll: false }).hard, true);
  // One chapter dominates: no spread.
  const one = gateVerdict({ question, top: ['p1', 'p2', 'p3'].map((id) => book.passage(id)), linksOf: book.linksOf }, HARD_GATE);
  assert.equal(one.reasons.includes('spread'), false);
  assert.equal(one.measures.chapters, 1);
});

test('default gate constants are the documented ones', () => {
  assert.equal(DEEP_READ_GATE.requireAll, true);
  assert.deepEqual([...DEEP_READ_GATE.tensionTypes], ['contradicts', 'qualifies']);
  assert.equal(DEEP_READ_BUDGET.totalTokens, 6_000);
  assert.equal(DEEP_READ_BUDGET.pass3MaxOutputTokens <= 200, true);
});

test('expansion budget: dedupes, skips over-budget items without stopping, respects chars', () => {
  const cost = { a: 100, b: 5_000, c: 200, d: 100 };
  const r = takeWithinBudget([{ id: 'x' }, { id: 'a' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], {
    present: new Set(['x']), tokensLeft: 350, charsLeft: 1_000,
    costOf: (id) => cost[id] ?? null, charsOf: () => 100,
  });
  assert.deepEqual(r.accepted.map((c) => c.id), ['a', 'c']);
  assert.equal(r.tokens, 300);
  assert.equal(r.skippedBudget, 2);
  const narrow = takeWithinBudget([{ id: 'a' }, { id: 'c' }], { present: new Set(), tokensLeft: 10_000,
    charsLeft: 150, costOf: (id) => cost[id], charsOf: () => 100 });
  assert.deepEqual(narrow.accepted.map((c) => c.id), ['a']);
});

test('key terms skip question words and rank by tf × idf deterministically', () => {
  const terms = keyTerms({ question: 'Специалист и деньги', texts: ['Торговец торговец продаёт, специалист работает.'],
    documentFrequency: (s) => (s.startsWith('работ') ? 10 : 1), documents: 10, max: 3 });
  assert.equal(terms[0], 'торговец');
  assert.equal(terms.includes('специалист'), false);
});

test('pass-3 replies parse into at most three clean queries', () => {
  assert.deepEqual(parseQueries('1. автор связывает касту и роль\n- «условие выхода из касты»\n\nавтор связывает касту и роль\nчетвёртый запрос тут\nпятый'),
    ['автор связывает касту и роль', 'условие выхода из касты', 'четвёртый запрос тут']);
});

// ------------------------------------------------------------------ decorator

test('off returns the very same retrieval object (identical path by construction)', () => {
  const { retrieval } = fakeRetrieval(['p1']);
  assert.equal(withDeepRead(retrieval, { mode: 'off', reader: fakeBook() }), retrieval);
  assert.equal(deepReadFromEnv(retrieval, { env: {} }), retrieval);
  assert.equal(deepReadFromEnv(retrieval, { env: { TELEGRAM_RUNTIME_ASSISTANT_DEEP_READ: 'off' } }), retrieval);
  assert.equal(deepReadFromEnv(null, { env: { TELEGRAM_RUNTIME_ASSISTANT_DEEP_READ: 'on' } }), null);
  assert.throws(() => deepReadFromEnv(retrieval, { env: { TELEGRAM_RUNTIME_ASSISTANT_DEEP_READ: 'force' } }), /off or on/);
});

test('on, easy question: pass 1 only, entries untouched, no extra call', async () => {
  const { retrieval, calls } = fakeRetrieval(['p1', 'p2', 'p3']);
  let suggested = 0;
  const wrapped = withDeepRead(retrieval, { mode: 'on', reader: fakeBook(), gate: HARD_GATE,
    suggestQueries: async () => { suggested += 1; return { queries: [] }; }, log: () => {} });
  const r = await wrapped.forQuestion({ question: 'Специалист уходит из организации?', sessionId: 's' });
  assert.deepEqual(r.knowledge.entries.map((e) => e.id), ['p1', 'p2', 'p3']);
  assert.equal(r.trace.deepRead.hard, false);
  assert.equal(r.trace.deepRead.passes, 1);
  assert.equal(calls.length, 1);
  assert.equal(suggested, 0);
});

test('on, hard question: pass 2 reads around, pass 3 makes exactly one call, budget holds', async () => {
  const { retrieval, calls } = fakeRetrieval(['p1', 'p4', 'p6'], { extra: { 'автор связывает': ['p7', 'p5'] } });
  const suggestCalls = [];
  const sink = [];
  const wrapped = withDeepRead(retrieval, {
    mode: 'on', reader: fakeBook(), gate: HARD_GATE, log: () => {},
    suggestQueries: async (input) => { suggestCalls.push(input); return { queries: ['автор связывает'], usage: { inputTokens: 10, outputTokens: 5 } }; },
    caseSink: { write: (r) => sink.push(r) },
  });
  const question = 'Почему управленец кибернетика синергия эмпатия и логистика важны';
  const r = await wrapped.forQuestion({ question, sessionId: 's' });
  const dr = r.trace.deepRead;
  assert.equal(dr.hard, true);
  assert.equal(dr.passes, 3);
  assert.equal(dr.extraCalls, 1);
  assert.equal(suggestCalls.length, 1);
  const ids = r.knowledge.entries.map((e) => e.id);
  assert.deepEqual(ids.slice(0, 3), ['p1', 'p4', 'p6']);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  // neighbours of p1 (p2) and its qualifies link (p5) come in; p8 (5000 tokens) is over the pass-2 budget? no:
  // pass-2 budget 4500 < 5000 → skipped.
  assert.equal(ids.includes('p2'), true);
  assert.equal(ids.includes('p5'), true);
  assert.equal(ids.includes('p8'), false);
  assert.equal(ids.includes('p7'), true, 'pass-3 query result added');
  assert.equal(dr.addedTokens <= DEEP_READ_BUDGET.totalTokens, true);
  assert.equal(r.knowledge.entries.find((e) => e.id === 'p2').title, 'CH-01 (часть)');
  // re-search + one pass-3 query, each in its own session key
  assert.equal(calls.length, 3);
  assert.equal(calls[1].sessionId, 's#deep2');
  assert.equal(calls[2].sessionId, 's#deep3.0');
  assert.equal(sink.length, 1);
  assert.equal(sink[0].passes, 3);
  assert.deepEqual(sink[0].passage_ids, ids);
  const receipt = deepReadReceipt(dr);
  assert.equal(receipt.deep_read, true);
  assert.equal(receipt.extra_calls, 1);
  assert.deepEqual(receipt.added_passage_ids, dr.added.map((a) => a.id));
});

test('force reads deeply even when the gate is not hard, and records the gate verdict', async () => {
  const { retrieval } = fakeRetrieval(['p1', 'p2', 'p3']);
  const wrapped = withDeepRead(retrieval, { mode: 'force', reader: fakeBook(), gate: HARD_GATE, log: () => {} });
  const r = await wrapped.forQuestion({ question: 'Специалист уходит из организации?', sessionId: 's' });
  assert.equal(r.trace.deepRead.hard, false);
  assert.equal(r.trace.deepRead.read, true);
  assert.equal(r.trace.deepRead.passes >= 2, true);
});

test('ungrounded first pass is returned as is', async () => {
  const ungrounded = Object.freeze({ grounded: false, reason: 'x', knowledge: null, pack: null, trace: null });
  const retrieval = Object.freeze({ available: true, sourceId: 'course-knowledge-v2', forQuestion: async () => ungrounded, close() {} });
  const wrapped = withDeepRead(retrieval, { mode: 'on', reader: fakeBook(), log: () => {} });
  assert.equal(await wrapped.forQuestion({ question: 'q' }), ungrounded);
});

// ------------------------------------------------------------------ I/O pieces

test('package reader loads passages, neighbours and links from a package db', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deep-read-'));
  const path = join(dir, 'ai.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE units (unit_id TEXT, title TEXT, canonical_url TEXT, url_state TEXT);
    CREATE TABLE chunks (chunk_id TEXT, unit_id TEXT, ord INTEGER, content TEXT, token_count INTEGER, state TEXT);
    CREATE TABLE passage_links (type TEXT, a_chunk_id TEXT, b_chunk_id TEXT);
    INSERT INTO units VALUES ('u-01', 'CH-02 (часть 1/2)', 'https://x/a', 'confirmed');
    INSERT INTO chunks VALUES ('a', 'u-01', 1, 'Первый.', 10, 'canonical'), ('b', 'u-01', 2, 'Второй.', 12, 'canonical'),
      ('c', 'u-01', 3, 'Третий.', 0, 'canonical');
    INSERT INTO passage_links VALUES ('continues', 'a', 'c');`);
  db.close();
  const reader = createPackageReader(path);
  assert.equal(reader.documents, 3);
  assert.equal(reader.passage('a').chapter, 'CH-02');
  assert.equal(reader.passage('a').canonicalUrl, 'https://x/a');
  assert.equal(reader.passage('c').tokens > 0, true);
  assert.deepEqual(reader.neighbours('b').map((p) => p.id), ['a', 'c']);
  assert.deepEqual(reader.linksOf('c'), [{ id: 'a', type: 'continues' }]);
});

test('case sink writes JSONL and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deep-read-sink-'));
  const path = join(dir, 'sub', 'cases.jsonl');
  const sink = createJsonlCaseSink(path);
  assert.equal(sink.write(caseRecord({ question: '  Что  такое Каста? ', passageIds: ['a'], passes: 1, hard: false, at: 't' })), true);
  const row = JSON.parse(readFileSync(path, 'utf8').trim());
  assert.equal(row.question_normalized, 'что такое каста?');
  assert.equal(row.question_sha256.length, 64);
  const logs = [];
  const broken = createJsonlCaseSink(path, { append: () => { const e = new Error('x'); e.code = 'EACCES'; throw e; }, log: (l) => logs.push(l) });
  assert.equal(broken.write({}), false);
  assert.equal(broken.write({}), false);
  assert.equal(logs.length, 1);
});

test('pass-3 suggester sends one low-effort ≤200-token Messages call and survives failures', async () => {
  const sent = [];
  const ok = createAnthropicQuerySuggester({ endpoint: 'https://api.anthropic.com/v1/', apiKey: 'k', model: 'claude-sonnet-5-5' }, {
    fetchFn: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'запрос один\nзапрос два' }], usage: { input_tokens: 50, output_tokens: 9 } }) };
    },
  });
  const r = await ok({ question: 'Вопрос?', top: [{ content: 'Место.' }] });
  assert.deepEqual(r.queries, ['запрос один', 'запрос два']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent[0].body.max_tokens, 200);
  assert.equal(sent[0].body.output_config.effort, 'low');
  const failing = createAnthropicQuerySuggester({ endpoint: 'https://e/', apiKey: 'k', model: 'm' }, { fetchFn: async () => { throw new Error('down'); } });
  assert.deepEqual((await failing({ question: 'q', top: [] })).queries, []);
});
