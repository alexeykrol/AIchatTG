import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildProviderStack, fakeAnthropicTransport, parseArgs, priceFor, runOffline } from '../ask-offline.mjs';
import { fakeOpenAITransport } from '../lib/openai-transport.mjs';
import { createSpendGuard, inputTokenCeiling, SpendCapReached } from '../lib/spend-guard.mjs';

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

const OPENAI_ARGS = ['--vendor', 'openai', '--model', 'gpt-5.6-terra', '--effort', 'medium'];

test('OpenAI mock sends the production request and fixed context, appending only the supplied answer addendum', async (t) => {
  const { argv, out, source } = setup(t, (ids) => [
    { q: ids[0].q, question: questions[0], chunk_ids: ['chunk-1', 'chunk-0'] },
  ]);
  const addendum = 'Use the supplied passages.';
  const addendumPath = join(source, 'addendum.md');
  writeFileSync(addendumPath, `${addendum}\n`);
  const calls = [];
  const mockTransport = fakeOpenAITransport({ calls });
  await runOffline([...argv, ...OPENAI_ARGS, '--limit', '1'], { mockTransport });
  await runOffline([...argv, ...OPENAI_ARGS, '--limit', '1', '--prompt-addendum', addendumPath,
    '--out', join(out, 'with-addendum')], { mockTransport });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  const { body } = calls[0];
  const [system, user] = body.messages;
  assert.deepEqual(body, {
    model: 'gpt-5.6-terra', messages: [{ role: 'system', content: system.content }, { role: 'user', content: user.content }],
    max_completion_tokens: 2000, reasoning_effort: 'medium',
  });
  assert.ok(!system.content.includes(addendum));
  assert.deepEqual(JSON.parse(user.content).knowledge.entries, [
    { id: 'chunk-1', content: passages[1] }, { id: 'chunk-0', content: passages[0] },
  ]);
  assert.deepEqual(calls[1].body, {
    ...body, messages: [{ ...system, content: `${system.content}\n\n${addendum}` }, user],
  });
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.vendor, 'openai');
  assert.equal(manifest.endpoint_host, 'api.openai.com');
  assert.equal(manifest.model, body.model);
  assert.equal(manifest.effort, body.reasoning_effort);
  assert.ok(manifest.substitutions.includes('answer_uses_openai_chat_completions_directly'));
  assert.ok(!manifest.substitutions.includes('answer_model_is_claude_via_messages_shim_not_production_openai'));
  assert.match(manifest.price_usd_per_mtok.source, /developers\.openai\.com\/api\/docs\/pricing/);
  const row = JSON.parse(readFileSync(join(out, 'answers.jsonl'), 'utf8'));
  assert.equal(row.status, 'answered');
  assert.ok(row.input_tokens > row.cached_tokens && row.cached_tokens > 0);
  assert.equal(row.output_tokens, 40);
  assert.equal(row.reasoning_tokens, 20);
  assert.equal(row.stop_reason, 'stop');
  assert.equal(row.cost_usd, ((row.input_tokens - row.cached_tokens) * 2 + row.cached_tokens * 0.20 + 40 * 12) / 1e6);
});

test('OpenAI live stack uses the supplied key and limits the addendum to answer calls', async (t) => {
  const { source } = setup(t, () => []);
  const addendumPath = join(source, 'addendum.md');
  writeFileSync(addendumPath, 'Answer-only addendum.');
  const args = parseArgs(['--mode', 'live', ...OPENAI_ARGS, '--key-env', 'EVAL_TEST_OPENAI_KEY',
    '--cap-usd', '1', '--prompt-addendum', addendumPath]);
  const previousKey = process.env.EVAL_TEST_OPENAI_KEY;
  process.env.EVAL_TEST_OPENAI_KEY = 'dummy-test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.EVAL_TEST_OPENAI_KEY;
    else process.env.EVAL_TEST_OPENAI_KEY = previousKey;
  });
  const calls = [];
  const { provider } = buildProviderStack(args, { transport: async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({
      choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
    }) };
  } });
  await provider.analyze({ system: 'Analyzer instructions.', input: 'Input to analyze.' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer dummy-test-key');
  assert.equal(calls[0].body.messages[0].content, 'Analyzer instructions.');
  assert.equal(parseArgs([]).vendor, 'anthropic');
  assert.throws(() => parseArgs(['--vendor', 'other']), /--vendor must be anthropic or openai/);
  assert.throws(() => parseArgs([...OPENAI_ARGS, '--rewrite', 'claude-haiku-5-5']), /--rewrite is unsupported/);
});

test('OpenAI guard reserves before transport, settles cached usage, and retains unknown cost', async () => {
  const price = priceFor(parseArgs(OPENAI_ARGS));
  const request = { messages: [{ role: 'system', content: 'Инструкция' }], max_completion_tokens: 100, max_tokens: 10 };
  const ceiling = (inputTokenCeiling(request) * 2 + 100 * 12) / 1e6;
  const legacyRequest = { messages: request.messages, max_tokens: 30 };
  const legacyCeiling = (inputTokenCeiling(legacyRequest) * 2 + 30 * 12) / 1e6;
  const usage = { prompt_tokens: 60, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens: 50,
    completion_tokens_details: { reasoning_tokens: 25 }, total_tokens: 110 };
  const actual = (20 * 2 + 40 * 0.20 + 50 * 12) / 1e6;
  const guard = createSpendGuard({ capUsd: ceiling + actual + legacyCeiling / 2, price });
  let calls = 0;
  const fetch = guard.wrapFetch(async () => {
    calls += 1;
    assert.equal(guard.openReservationsUsd(), calls === 1 ? ceiling : legacyCeiling);
    return { ok: true, status: 200, json: async () => calls === 1 ? { usage } : {} };
  }, { vendor: 'openai' });
  await fetch('unused', { body: JSON.stringify(request) });
  assert.equal(guard.spentUsd(), actual);
  assert.deepEqual(guard.journal()[0].usage, usage);
  await fetch('unused', { body: JSON.stringify(legacyRequest) });
  assert.equal(guard.spentUsd(), actual + legacyCeiling);
  assert.equal(guard.openReservationsUsd(), 0);
  assert.equal(guard.journal()[1].costKnown, false);
  await assert.rejects(fetch('unused', { body: JSON.stringify(request) }), SpendCapReached);
  assert.equal(calls, 2);
});

test('OpenAI mock run stops before transport when the cap is too low', async (t) => {
  const { argv, out } = setup(t, (ids) => [
    { q: ids[0].q, question: questions[0], chunk_ids: ['chunk-0'] },
  ]);
  const calls = [];
  const previousExitCode = process.exitCode;
  try {
    await runOffline([...argv, ...OPENAI_ARGS, '--limit', '1', '--cap-usd', '0.000001'],
      { mockTransport: fakeOpenAITransport({ calls }) });
    assert.equal(process.exitCode, 4);
  } finally {
    process.exitCode = previousExitCode;
  }
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.answered_rows, 0);
  assert.equal(manifest.stopped_by_spend_guard.tag, 'Q001');
  assert.deepEqual(calls, []);
});
