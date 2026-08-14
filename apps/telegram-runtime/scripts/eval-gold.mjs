#!/usr/bin/env node
/**
 * Gold-set harness for the ported retriever: it reproduces the lab's metric
 * accounting (any-of gold units, not_found counts as a miss, abstention over
 * unanswerable questions) so the Node port can be compared to the Python
 * reference by number rather than by impression.
 *
 * Usage:
 *   node apps/telegram-runtime/scripts/eval-gold.mjs \
 *     --db <package.db> --gold <ai.gold.jsonl> [--split dev|heldout|all]
 *     [--dump out.json] [--rewrite] [--rewrite-fixture rewrites.json]
 *
 * Without --rewrite the harness performs exactly one local retrieval pass per
 * question and spends nothing, so its numbers are the deterministic baseline
 * that any change must reproduce. --rewrite additionally measures input-layer
 * step 5; it needs either a recorded fixture or provider credentials in the
 * environment, and it is never the default precisely because a paid, non
 * deterministic default would make the baseline unfalsifiable.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRetrieverAdapter } from '../src/retriever-adapter.mjs';
import { createRecordedRewriter, createRewriterAdapter } from '../src/rewriter-adapter.mjs';

const GATES = Object.freeze([
  ['recall_at_5', 0.90],
  ['recall_at_10', 0.95],
  ['mrr_at_10', 0.75],
  ['abstention', 0.95],
]);
const GATE_EPS = 1e-12;
const TOP_UNITS_REPORT = 10;
const FORBIDDEN_K = 5;

function parseArgs(argv) {
  const args = {
    split: 'dev', domain: 'ai', maxContextTokens: 6_000, maxEntries: 12, dump: null,
    rewrite: false, rewriteFixture: null,
  };
  // `--rewrite` is a bare flag, so the pairwise walk cannot assume every option
  // consumes a value.
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--rewrite') { args.rewrite = true; continue; }
    const value = argv[i + 1];
    i += 1;
    if (key === '--db') args.db = value;
    else if (key === '--gold') args.gold = value;
    else if (key === '--split') args.split = value;
    else if (key === '--domain') args.domain = value;
    else if (key === '--max-context-tokens') args.maxContextTokens = Number(value);
    else if (key === '--max-entries') args.maxEntries = Number(value);
    else if (key === '--dump') args.dump = value;
    else if (key === '--rewrite-fixture') args.rewriteFixture = value;
  }
  return args;
}

/**
 * The rewriter used by --rewrite. A fixture is preferred because a measurement
 * that cannot be repeated is not a measurement; live credentials are the
 * fallback for producing such a fixture in the first place.
 */
function buildRewriter(args, env) {
  if (args.rewriteFixture) {
    return {
      rewriteQuestion: createRecordedRewriter(JSON.parse(readFileSync(args.rewriteFixture, 'utf8'))),
      source: `fixture:${args.rewriteFixture}`,
    };
  }
  const rewriteQuestion = createRewriterAdapter({
    enabled: true,
    endpoint: String(env.TELEGRAM_RUNTIME_PROVIDER_ENDPOINT || ''),
    apiKey: String(env.TELEGRAM_RUNTIME_PROVIDER_API_KEY || ''),
    model: String(env.TELEGRAM_RUNTIME_REWRITE_MODEL || ''),
    reasoningEffort: String(env.TELEGRAM_RUNTIME_REWRITE_REASONING_EFFORT || 'minimal'),
  });
  return { rewriteQuestion, source: `provider:${env.TELEGRAM_RUNTIME_REWRITE_MODEL}` };
}

function unitOfChunk(chunkId) {
  const parts = chunkId.split(':');
  return parts.length <= 2 ? chunkId : parts.slice(0, parts.length - 2).join(':');
}

function uniqueUnits(pack) {
  const seen = [];
  for (const entry of pack.entries) {
    const unit = unitOfChunk(entry.id);
    if (!seen.includes(unit)) seen.push(unit);
  }
  return seen;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function round4(value) {
  return value == null ? null : Number.parseFloat(value.toFixed(4));
}

function scoreQuestion(record, pack) {
  const ranked = uniqueUnits(pack);
  const out = {
    query_id: record.query_id,
    category: record.category,
    question: record.question,
    answerable: record.answerable,
    status: pack.status,
    confidence: pack.confidence,
    top_units: ranked.slice(0, TOP_UNITS_REPORT),
    entries: pack.entries.map((entry) => entry.id),
    selected: pack.selected.map((sel) => ({
      chunk_id: sel.chunk_id, score: sel.score, reason: sel.selection_reason,
    })),
    concept_matches: pack.retrieval_trace.concept_matches,
    query_terms: pack.retrieval_trace.query_terms,
    significant_terms: pack.retrieval_trace.significant_terms,
    fts_path_candidates: pack.retrieval_trace.fts_path_candidates,
    doc_path_candidates: pack.retrieval_trace.doc_path_candidates,
    entity_path_candidates: pack.retrieval_trace.entity_path_candidates,
    merged_count: pack.retrieval_trace.merged_count,
    dedup_removed: pack.retrieval_trace.dedup_removed,
    diversity_removed: pack.retrieval_trace.diversity_removed,
    strong_units: pack.retrieval_trace.strong_units,
    title_only_demoted: pack.retrieval_trace.reranking.title_only_demoted,
    toc_demoted: pack.retrieval_trace.reranking.toc_demoted,
    neighbors_added: pack.retrieval_trace.reranking.neighbors_added,
    budget_skipped: pack.retrieval_trace.reranking.budget_skipped,
    gaps: pack.gaps,
    used_tokens: pack.token_budget.used,
  };
  const forbidden = new Set(record.forbidden_units);
  out.forbidden_in_top5 = ranked.slice(0, FORBIDDEN_K).filter((u) => forbidden.has(u));
  if (record.answerable) {
    const gold = new Set(record.gold_units);
    let rank = null;
    for (let i = 0; i < ranked.length; i += 1) {
      if (gold.has(ranked[i])) { rank = i + 1; break; }
    }
    if (pack.status === 'not_found' || pack.status === 'error') rank = null;
    out.gold_rank = rank;
    out.hit_at_5 = rank !== null && rank <= 5;
    out.hit_at_10 = rank !== null && rank <= 10;
    out.rr_at_10 = rank !== null && rank <= 10 ? 1 / rank : 0;
  } else {
    out.abstained = pack.status !== 'ready';
  }
  return out;
}

function aggregate(results) {
  const ans = results.filter((r) => r.answerable);
  const una = results.filter((r) => !r.answerable);
  return {
    n: results.length,
    n_answerable: ans.length,
    n_unanswerable: una.length,
    recall_at_5: mean(ans.map((r) => Number(r.hit_at_5))),
    recall_at_10: mean(ans.map((r) => Number(r.hit_at_10))),
    mrr_at_10: mean(ans.map((r) => r.rr_at_10)),
    abstention: mean(una.map((r) => Number(r.abstained))),
    forbidden_violations: results.reduce((sum, r) => sum + r.forbidden_in_top5.length, 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.gold) {
    console.error('usage: eval-gold.mjs --db <package.db> --gold <ai.gold.jsonl> [--split dev] [--rewrite]');
    return 2;
  }

  const records = readFileSync(args.gold, 'utf8').split('\n')
    .filter((line) => line.trim()).map((line) => JSON.parse(line));
  const subset = args.split === 'all' ? records
    : records.filter((r) => (args.split === 'dev' ? !r.held_out : r.held_out));

  const rewriter = args.rewrite ? buildRewriter(args, process.env) : null;
  const retriever = createRetrieverAdapter(
    { databasePath: args.db, domainId: args.domain, rewriteEnabled: args.rewrite },
    rewriter ? { rewriteQuestion: rewriter.rewriteQuestion } : {},
  );

  const results = [];
  const rewriteStats = { attempted: 0, applied: 0, byReason: new Map() };
  const started = Date.now();
  for (const record of subset) {
    const input = {
      question: record.question,
      sessionId: `eval:${record.query_id}`,
      domainId: args.domain,
      maxContextTokens: args.maxContextTokens,
      maxEntries: args.maxEntries,
    };
    // Without --rewrite the harness takes exactly the original code path, so a
    // baseline run cannot drift through the step-5 wrapper.
    const answer = args.rewrite
      ? await retriever.forQuestionWithRewrite(input)
      : retriever.forQuestion(input);
    if (!answer.available) {
      console.error(`retriever unavailable: ${answer.reason}`);
      return 2;
    }
    const trace = answer.pack.rewrite_trace;
    if (trace) {
      if (trace.attempted) rewriteStats.attempted += 1;
      if (trace.winner === 'second') rewriteStats.applied += 1;
      const reason = String(trace.reason ?? 'none');
      rewriteStats.byReason.set(reason, (rewriteStats.byReason.get(reason) || 0) + 1);
    }
    const scored = scoreQuestion(record, answer.pack);
    if (trace) scored.rewrite = trace;
    results.push(scored);
  }
  const elapsed = Date.now() - started;
  retriever.close();

  const overall = aggregate(results);
  if (args.dump) {
    writeFileSync(args.dump, JSON.stringify(results, null, 1), 'utf8');
  }

  console.log(`вопросов: ${overall.n} (answerable ${overall.n_answerable} / `
    + `unanswerable ${overall.n_unanswerable})`);
  for (const [name, threshold] of GATES) {
    const value = overall[name];
    const status = value == null ? 'not_run'
      : (value + GATE_EPS >= threshold ? 'passed' : 'failed');
    const shown = value == null ? '—' : round4(value).toFixed(4);
    console.log(`  ${name.padEnd(20)} ≥ ${threshold.toFixed(2)}  значение ${shown.padStart(7)}  ${status}`);
  }
  console.log(`forbidden_violations: ${overall.forbidden_violations}`);
  if (args.rewrite) {
    const reasons = [...rewriteStats.byReason.entries()]
      .sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name}=${n}`).join(' ');
    console.log(`переформулировка (${rewriter.source}): попыток ${rewriteStats.attempted}, `
      + `принято вторых паков ${rewriteStats.applied}`);
    console.log(`  причины: ${reasons}`);
  }
  console.log(`время: ${(elapsed / 1_000).toFixed(1)} с`);
  return 0;
}

process.exit(await main());
