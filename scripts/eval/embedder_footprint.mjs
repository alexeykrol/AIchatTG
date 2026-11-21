#!/usr/bin/env node
/**
 * Memory and latency of the question embedder alone (free, local).
 *
 *   node scripts/eval/embedder_footprint.mjs --package PKG_DIR --questions RUN_DIR/answers.jsonl [--n 50]
 *
 * Reports process RSS before load, after the lazy load + first query, and after N queries,
 * plus per-query latency (p50/p95/max). Question texts are not printed.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createEmbedder, PACKAGE_MODEL_FILES } from '../../apps/telegram-runtime/src/embedder.mjs';

const a = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const pkg = resolve(a.package);
const n = Number(a.n || 50);
const questions = readFileSync(resolve(a.questions), 'utf8').split('\n').filter(Boolean)
  .map((line) => JSON.parse(line).question).slice(0, n);
const mb = () => +(process.memoryUsage().rss / 2 ** 20).toFixed(1);

const before = mb();
const embedder = createEmbedder({
  modelPath: join(pkg, PACKAGE_MODEL_FILES.model),
  tokenizerPath: join(pkg, PACKAGE_MODEL_FILES.tokenizer),
  tokenizerConfigPath: join(pkg, PACKAGE_MODEL_FILES.tokenizerConfig),
});
const t0 = performance.now();
await embedder.embedOne(questions[0]);
const firstMs = performance.now() - t0;
const afterLoad = mb();
const lat = [];
let peak = afterLoad;
for (const q of questions) {
  const t = performance.now();
  await embedder.embedOne(q);
  lat.push(performance.now() - t);
  peak = Math.max(peak, mb());
}
lat.sort((x, y) => x - y);
console.log(JSON.stringify({
  platform: `${process.platform}/${process.arch}`, node: process.version,
  rssMb: { beforeLoad: before, afterLoadAndFirstQuery: afterLoad, afterQueries: mb(), peakDuringQueries: peak },
  queries: lat.length,
  latencyMs: {
    loadPlusFirst: +firstMs.toFixed(1), p50: +lat[Math.floor(lat.length / 2)].toFixed(1),
    p95: +lat[Math.floor(lat.length * 0.95)].toFixed(1), max: +lat[lat.length - 1].toFixed(1),
  },
}, null, 2));
