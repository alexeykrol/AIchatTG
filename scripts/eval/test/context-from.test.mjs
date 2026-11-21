import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fakeAnthropicTransport, parseArgs, runOffline } from '../ask-offline.mjs';

const runtimeRequire = createRequire(new URL('../../../apps/telegram-runtime/package.json', import.meta.url));
const Database = runtimeRequire('better-sqlite3');
const questions = ['What does the book say about planning?', 'How does the book describe feedback?',
  'What does the book say about review?', 'How does the book describe practice?'];
const passages = ['  First passage\nwith exact whitespace.  ', 'Second passage.', 'Unselected passage.'];

function setup(t, chunksByQuestion) {
  const scratch = fileURLToPath(new URL('../../../output/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'context-from-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, 'ai.db');
  const db = new Database(database);
  try {
    db.exec(`CREATE TABLE build_meta (scope TEXT, source_signature TEXT);
      CREATE TABLE units (unit_id TEXT PRIMARY KEY, title TEXT, canonical_url TEXT, url_state TEXT);
      CREATE TABLE chunks (chunk_id TEXT PRIMARY KEY, unit_id TEXT, content TEXT, token_count INTEGER);`);
    const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
    passages.forEach((content, i) => insert.run(`chunk-${i}`, `actual-unit-${i}`, content, 100));
  } finally { db.close(); }

  const donor = join(root, 'donor');
  const source = join(root, 'source');
  const out = join(root, 'out');
  const kind = 'answerable';
  const ids = questions.map((_, i) => ({ q: `Q00${i + 1}`, case_id: `case-${i}`, kind }));
  const write = (file, data) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  };
  const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  write(join(donor, 'evals/baseline/id_map.json'), JSON.stringify(ids));
  write(join(donor, 'evals/golden/cases.jsonl'), jsonl(ids.map((row, i) => ({
    id: row.case_id, kind, question: questions[i], support: [],
  }))));
  const sourceFile = join(source, 'answers.jsonl');
  write(sourceFile, jsonl(chunksByQuestion(ids)));
  const argv = ['--mode', 'mock', '--package', database, '--donor', donor, '--out', out, '--context-from', source];
  return { argv, out, source, sourceFile };
}

test('fixed context sends exact ordered and deduplicated passages, bypasses budgets and records provenance', async (t) => {
  const { argv, out, source, sourceFile } = setup(t, (ids) => [
    { q: ids[0].q, question: questions[0], chunk_ids: ['chunk-1', 'chunk-0', 'chunk-1'] },
    { q: ids[1].q, question: questions[1], chunk_ids: [] },
  ]);
  const calls = [];
  await runOffline([...argv, '--limit', '2', '--max-entries', '1', '--max-context-tokens', '1',
    '--rewrite', 'claude-haiku-5-5', '--rewrite-no-signal'], { mockTransport: fakeAnthropicTransport({ calls }) });
  assert.equal(calls.length, 2);
  const request = JSON.parse(calls[0].body.messages[0].content);
  assert.deepEqual(request.knowledge.entries, [
    { id: 'chunk-1', content: passages[1] }, { id: 'chunk-0', content: passages[0] },
  ]);
  const empty = JSON.parse(calls[1].body.messages[0].content);
  assert.equal(empty.knowledge, null);
  assert.equal(empty.knowledgeGap, 'in_domain_gap');
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.retrieval.context_from, {
    path: source, sha256: createHash('sha256').update(readFileSync(sourceFile)).digest('hex'),
  });
  const rows = readFileSync(join(out, 'answers.jsonl'), 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((row) => [row.context_from, row.pack_status, row.chunk_ids, row.unit_ids]), [
    [true, 'ready', ['chunk-1', 'chunk-0'], ['actual-unit-1', 'actual-unit-0']],
    [true, 'not_found', [], []],
  ]);
});

test('all selected questions are validated before any provider call', async (t) => {
  const { argv, out } = setup(t, (ids) => [
    { q: ids[0].q, question: questions[0], chunk_ids: ['chunk-0'] },
    { q: ids[2].q, question: `${questions[2]} `, chunk_ids: [] },
    { q: ids[3].q, question: questions[3], chunk_ids: ['chunk-1', 'missing-chunk'] },
  ]);
  const calls = [];
  await assert.rejects(runOffline(argv, { mockTransport: fakeAnthropicTransport({ calls }) }),
    /Q002: missing question ID\nQ003: question text differs\nQ004: unknown chunk IDs: missing-chunk/);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(out), false);
});

test('context-from requires a run directory in all modes', () => {
  for (const mode of ['retrieval', 'mock', 'live']) {
    assert.equal(parseArgs(['--mode', mode, '--context-from', 'run']).contextFrom, 'run');
  }
  assert.throws(() => parseArgs(['--context-from']), /needs a run directory/);
  assert.throws(() => parseArgs(['--context-from', '--mode', 'mock']), /needs a run directory/);
});
