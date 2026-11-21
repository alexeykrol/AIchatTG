#!/usr/bin/env node
/**
 * Parity of the production hybrid retriever (Node, quantized embedder) against the offline
 * recipe (Python fp32: hybrid_candidates.py + expand_links.py). Free, local, no model calls.
 *
 *   node scripts/eval/hybrid_parity.mjs --package PKG_DIR --offline RUN_DIR --out OUT_RUN_DIR \
 *        [--lexical LEX_RUN_DIR] [--max-entries 24] [--max-context-tokens 6000] \
 *        [--link-types contradicts,qualifies] [--link-max 4] [--hybrid-tokens 60000]
 *
 * For every question of OFFLINE/answers.jsonl it runs createKnowledgeRetrieval (hybrid, links,
 * no-concept gate pass, coverage content+alias — the offline lexical settings) through the
 * offline-harness admission stub and compares the chunk lists:
 *   mean Jaccard, share identical as sets, share identical in order, recall of offline ids.
 * With --lexical it also checks the lexical stage alone against the lexical run (exact match).
 * OUT_RUN_DIR gets answers.jsonl (offline rows with Node chunk_ids) + manifest.json, so
 * scripts/eval/passage_coverage.py can measure it like any run. Question texts are only
 * passed through, never printed.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createKnowledgeRetrieval } from '../../apps/telegram-runtime/src/knowledge-retrieval.mjs';
import { packageKnowledge } from './lib/answer-path.mjs';

function args(argv) {
  const out = {
    'max-entries': '24', 'max-context-tokens': '6000', 'link-types': 'contradicts,qualifies',
    'link-max': '4', 'hybrid-tokens': '60000',
  };
  for (let i = 2; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['package', 'offline', 'out']) if (!out[k]) throw new Error(`--${k} is required`);
  return out;
}

const rowsOf = (dir) => readFileSync(join(dir, 'answers.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const idsOf = (result) => (result?.knowledge?.entries || []).map((e) => e.id);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function compare(nodeLists, offLists) {
  const jac = []; const rec = []; let sameSet = 0; let sameOrder = 0;
  nodeLists.forEach((n, i) => {
    const o = offLists[i];
    const ns = new Set(n); const os = new Set(o);
    const inter = [...os].filter((x) => ns.has(x)).length;
    const union = new Set([...ns, ...os]).size;
    jac.push(union ? inter / union : 1);
    rec.push(os.size ? inter / os.size : 1);
    if (inter === os.size && ns.size === os.size) sameSet += 1;
    if (n.length === o.length && n.every((x, j) => x === o[j])) sameOrder += 1;
  });
  return {
    questions: nodeLists.length, meanJaccard: +mean(jac).toFixed(4), meanRecallOfOffline: +mean(rec).toFixed(4),
    minRecall: +Math.min(...rec).toFixed(4), identicalSets: sameSet, identicalOrder: sameOrder,
  };
}

async function main() {
  const a = args(process.argv);
  const pkg = resolve(a.package);
  const maxEntries = Number(a['max-entries']);
  const maxContextTokens = Number(a['max-context-tokens']);
  const knowledge = packageKnowledge({ databasePath: join(pkg, 'ai.db'), domainId: 'tcr' });
  const base = { maxEntries, maxContextTokens, validatePacks: true, noConceptGate: 'pass', coverageText: 'content+alias' };
  const offline = rowsOf(resolve(a.offline));
  const report = {};

  if (a.lexical) {
    const lexical = createKnowledgeRetrieval(base, { knowledge });
    const lexRows = rowsOf(resolve(a.lexical));
    const lists = [];
    for (const row of lexRows) lists.push(idsOf(await lexical.forQuestion({ question: row.question, sessionId: `p:${row.q}` })));
    report.lexicalStage = compare(lists, lexRows.map((r) => r.chunk_ids || []));
    lexical.close();
  }

  const hybrid = createKnowledgeRetrieval({
    ...base, retrievalMode: 'hybrid', hybridMaxContextTokens: Number(a['hybrid-tokens']),
    linkExpansion: { types: a['link-types'].split(','), max: Number(a['link-max']) },
  }, { knowledge });
  if (!hybrid.available) throw new Error(`retrieval unavailable: ${hybrid.reason}`);
  const lists = []; const latencies = []; const modes = {};
  for (const row of offline) {
    const t0 = performance.now();
    const result = await hybrid.forQuestion({ question: row.question, sessionId: `h:${row.q}` });
    latencies.push(performance.now() - t0);
    const mode = result.trace?.search?.mode || 'none';
    modes[mode] = (modes[mode] || 0) + 1;
    lists.push(idsOf(result));
  }
  hybrid.close();
  report.hybridLinks = compare(lists, offline.map((r) => r.chunk_ids || []));
  report.modes = modes;
  const sorted = [...latencies].sort((x, y) => x - y);
  report.latencyMs = {
    first: +latencies[0].toFixed(1),
    p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(1),
    p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
  };
  report.rssMb = +(process.memoryUsage().rss / 2 ** 20).toFixed(1);

  const out = resolve(a.out);
  mkdirSync(out, { recursive: true });
  copyFileSync(join(resolve(a.offline), 'manifest.json'), join(out, 'manifest.json'));
  writeFileSync(join(out, 'answers.jsonl'), offline.map((row, i) => JSON.stringify({ ...row, chunk_ids: lists[i] })).join('\n') + '\n');
  writeFileSync(join(out, 'parity.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
