#!/usr/bin/env node
/**
 * Ask the AIchatTG assistant answer branch the donor stand's 100 questions, offline (no Telegram).
 * Run with Node 20 (better-sqlite3 is built for it): `~/.nvm/versions/node/v20.20.0/bin/node`.
 *
 * Modes:
 *   --mode retrieval   $0. Retrieval + routing only, all questions; writes retrieval-report.{json,md}
 *                      (recall@12 of gold records by kind, refusals, both sides on conflicting cases).
 *   --mode mock        $0. Full answer path with the production provider adapter, the Anthropic shim and
 *                      the spend guard, over a FAKE transport; global fetch is replaced by a thrower, so a
 *                      single outbound call fails the run. Writes answers.{jsonl,md}.
 *   --mode live        PAID. Same path over the real Anthropic Messages API. Requires
 *                      --key-env <ENV NAME> and --cap-usd <tranche cap>; the spend guard stops the run
 *                      before any call whose cost ceiling would cross the cap.
 *
 * Common options: --package <package dir or ai.db> (default: output/eval/tcr-book/build.json),
 *   --donor <agi2claude root> (default ~/Code/agi2claude), --out <dir>, --limit N, --only Q001,Q007,
 *   --model claude-sonnet-5-5 --effort low --max-output-tokens 2000 --anthropic-version 2023-06-01,
 *   --price-input / --price-output (USD per MTok; required for a model without a published price here),
 *   --already-spent-usd (money of the same tranche spent before this run).
 *
 * Experiment levers (mock / live only; each off by default, so a run without them is the baseline):
 *   --rewrite <model>          production query rewrite (input-layer step 5, off in production) switched on:
 *                              `createRewriterAdapter` -> `createKnowledgeRetrieval({ rewriteEnabled: true })`,
 *                              exactly as server.mjs wires it, its transport through the same Anthropic shim and
 *                              the same spend guard (journal rows `kind: "rewrite"`). Production still skips
 *                              the rewrite on no-signal questions (see --rewrite-no-signal). --rewrite-effort (default `minimal`, the
 *                              production default; the shim maps it to Anthropic `low`), --rewrite-price-input /
 *                              --rewrite-price-output (required for a model without a published price here).
 *   --rewrite-no-signal        (only with --rewrite) passes `rewriteOnNoSignal: true` to createKnowledgeRetrieval:
 *                              no-signal questions may be rewritten too (still only when the free local search is
 *                              weak). Off in production; recorded in manifest.retrieval and manifest.rewrite.
 *   --prompt-addendum <file>   the file's text appended (after a blank line) to the end of the production answer
 *                              system prompt, in the shim; the file's sha256 goes to the manifest.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createProviderAdapter, answerSystemPrompt } from '../../apps/telegram-runtime/src/provider-adapter.mjs';
import { createRewriterAdapter, REWRITE_SYSTEM_PROMPT } from '../../apps/telegram-runtime/src/rewriter-adapter.mjs';
import { DOMAIN_ROUTE_REASONS } from '../../packages/telegram-core/src/index.mjs';
import { SAFETY_PROVIDER_TUPLE } from '../../apps/telegram-runtime/src/provider-adapter.mjs';
import { DEFAULT_DOMAIN_CATALOG } from '../../apps/telegram-runtime/src/assistant-domains.mjs';
import { createOfflineAssistant, SUBSTITUTIONS, RETRIEVAL_MAX_ENTRIES, RETRIEVAL_MAX_CONTEXT_TOKENS } from './lib/answer-path.mjs';
import { ADAPTER_PLACEHOLDER_KEY, ANTHROPIC_MESSAGES_BASE, DEFAULT_ANTHROPIC_VERSION, createAnthropicChatShim } from './lib/anthropic-shim.mjs';
import { PUBLISHED_PRICES, createSpendGuard } from './lib/spend-guard.mjs';
import { loadQuestions, renderAnswersMarkdown, retrievalReport, renderRetrievalMarkdown } from './lib/eval-io.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// The donor stand's bot answered with this model and effort (agi2claude config.yaml profiles.normal ->
// models.agent; its exp-baseline-bot ledger: 116 of 123 agent calls were claude-sonnet-5-5 / low).
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_EFFORT = 'low';
// Production answer tuple default (infra/aichattg/docker-compose.yml ..._ANSWER_MAX_OUTPUT_TOKENS:-2000).
export const DEFAULT_MAX_OUTPUT_TOKENS = 2000;
// Production rewrite effort default (config.mjs TELEGRAM_RUNTIME_REWRITE_REASONING_EFFORT || 'minimal').
export const DEFAULT_REWRITE_EFFORT = 'minimal';
const PRICE_SOURCE = 'claude-api skill shared/models.md (Claude Code 2.1.326 bundle), read 2026-11-19';

export function parseArgs(argv) {
  const a = {
    mode: 'retrieval', packagePath: null, donor: join(homedir(), 'Code', 'agi2claude'), out: null, limit: null,
    only: null, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    anthropicVersion: DEFAULT_ANTHROPIC_VERSION, keyEnv: null, capUsd: null, priceInput: null, priceOutput: null,
    alreadySpentUsd: 0, rewrite: null, rewriteEffort: DEFAULT_REWRITE_EFFORT, rewritePriceInput: null,
    rewritePriceOutput: null, promptAddendum: null, rewriteNoSignal: false,
  };
  const booleans = { '--rewrite-no-signal': 'rewriteNoSignal' };
  const map = {
    '--mode': 'mode', '--package': 'packagePath', '--donor': 'donor', '--out': 'out', '--limit': 'limit',
    '--only': 'only', '--model': 'model', '--effort': 'effort', '--max-output-tokens': 'maxOutputTokens',
    '--anthropic-version': 'anthropicVersion', '--key-env': 'keyEnv', '--cap-usd': 'capUsd',
    '--price-input': 'priceInput', '--price-output': 'priceOutput', '--already-spent-usd': 'alreadySpentUsd',
    '--rewrite': 'rewrite', '--rewrite-effort': 'rewriteEffort', '--rewrite-price-input': 'rewritePriceInput',
    '--rewrite-price-output': 'rewritePriceOutput', '--prompt-addendum': 'promptAddendum',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (booleans[flag]) {
      if (inline !== undefined) throw new Error(`${flag} takes no value`);
      a[booleans[flag]] = true;
      continue;
    }
    const key = map[flag];
    if (!key) throw new Error(`unknown option ${flag}`);
    a[key] = inline ?? argv[++i];
  }
  for (const k of ['limit', 'maxOutputTokens', 'capUsd', 'priceInput', 'priceOutput', 'alreadySpentUsd',
    'rewritePriceInput', 'rewritePriceOutput']) {
    if (a[k] != null) a[k] = Number(a[k]);
  }
  if (!['retrieval', 'mock', 'live'].includes(a.mode)) throw new Error('--mode must be retrieval, mock or live');
  if ((a.rewrite || a.promptAddendum) && a.mode === 'retrieval') {
    throw new Error('--rewrite and --prompt-addendum need --mode mock or live (they go through the spend guard)');
  }
  if (a.rewrite != null && !String(a.rewrite).trim()) throw new Error('--rewrite needs a model id');
  if (a.rewriteNoSignal && a.rewrite == null) throw new Error('--rewrite-no-signal is valid only together with --rewrite <model>');
  if (a.only) a.only = new Set(String(a.only).split(',').map((s) => s.trim()));
  return a;
}

function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

export function resolveDatabase(packagePath) {
  if (packagePath) {
    const p = resolve(packagePath);
    return statSync(p).isDirectory() ? join(p, 'ai.db') : p;
  }
  const build = join(REPO, 'output', 'eval', 'tcr-book', 'build.json');
  if (!existsSync(build)) throw new Error('no package: run scripts/eval/book_to_master.py first or pass --package');
  return JSON.parse(readFileSync(build, 'utf8')).database;
}

export function priceFor(args) {
  const published = PUBLISHED_PRICES[args.model];
  if (args.priceInput != null || args.priceOutput != null) {
    if (!(args.priceInput > 0) || !(args.priceOutput > 0)) throw new Error('give both --price-input and --price-output');
    return { input: args.priceInput, output: args.priceOutput, source: 'command line' };
  }
  if (!published) throw new Error(`no published price for ${args.model}: pass --price-input and --price-output`);
  return { ...published, source: PRICE_SOURCE };
}

/** Price of the rewrite model: published table, or both --rewrite-price-* flags. */
export function rewritePriceFor(args) {
  if (args.rewritePriceInput != null || args.rewritePriceOutput != null) {
    if (!(args.rewritePriceInput > 0) || !(args.rewritePriceOutput > 0)) {
      throw new Error('give both --rewrite-price-input and --rewrite-price-output');
    }
    return { input: args.rewritePriceInput, output: args.rewritePriceOutput, source: 'command line' };
  }
  const published = PUBLISHED_PRICES[args.rewrite];
  if (!published) throw new Error(`no published price for ${args.rewrite}: pass --rewrite-price-input and --rewrite-price-output`);
  return { ...published, source: PRICE_SOURCE };
}

/** The addendum file: text (trailing whitespace trimmed) + sha256 of the file bytes. */
export function readPromptAddendum(path) {
  const abs = resolve(path);
  const bytes = readFileSync(abs);
  const text = bytes.toString('utf8').replace(/\s+$/, '');
  if (!text.trim()) throw new Error(`--prompt-addendum ${path} is empty`);
  return { path: abs, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, text };
}

/** Provider config for the production adapter. Safety tuple is mandatory by validation, never used here. */
export function providerConfig(args) {
  const tuple = { model: args.model, reasoningEffort: args.effort, maxOutputTokens: args.maxOutputTokens };
  return {
    enabled: true, vendor: 'openai', endpoint: ANTHROPIC_MESSAGES_BASE, apiKey: ADAPTER_PLACEHOLDER_KEY,
    requestTimeoutMs: 120_000,
    modelTuples: {
      moderatorSafety: { model: SAFETY_PROVIDER_TUPLE.model, reasoningEffort: SAFETY_PROVIDER_TUPLE.reasoningEffort,
        maxOutputTokens: SAFETY_PROVIDER_TUPLE.routerMaxOutputTokens },
      assistantRouter: tuple,
      assistantAnswer: tuple,
    },
  };
}

/** A Messages-API transport that never leaves the process: a short deterministic answer + usage. */
export function fakeAnthropicTransport({ calls = [] } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const input = Buffer.byteLength(JSON.stringify(body.messages), 'utf8') >> 2;
    // The answer adapter sends a JSON user message; the rewriter sends the bare question (+ a hint line).
    let text;
    try { text = `[mock] ответ на вопрос: ${JSON.parse(body.messages[0].content).question}`; } catch {
      text = `${String(body.messages[0].content).split('\n')[0]} определение термины`;
    }
    return {
      ok: true, status: 200, headers: { get: (n) => (n === 'request-id' ? 'req_mock' : null) },
      json: async () => ({
        id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
        content: [{ type: 'text', text }],
        usage: { input_tokens: input, output_tokens: 40 },
      }),
    };
  };
}

/**
 * The whole answer stack for a mode: guard(transport) <- shim <- production adapter.
 * With --rewrite, a second chain guard(transport, kind rewrite) <- shim (no addendum) <- production rewriter;
 * one guard, so both share the cap. Returns { provider, rewriteQuestion, guard, price, rewritePrice, addendum }.
 */
export function buildProviderStack(args, { transport, journalPath = null, catalog = DEFAULT_DOMAIN_CATALOG } = {}) {
  const price = priceFor(args);
  const capUsd = args.mode === 'live' ? args.capUsd : (args.capUsd ?? 1_000_000);
  const guard = createSpendGuard({ capUsd, price, journalPath, alreadySpentUsd: args.alreadySpentUsd || 0 });
  let current = null;
  const guarded = guard.wrapFetch(transport, { tagOf: () => current });
  let apiKey = ADAPTER_PLACEHOLDER_KEY;
  if (args.mode === 'live') {
    if (!args.keyEnv) throw new Error('--key-env <ENV NAME> is required in live mode');
    apiKey = process.env[args.keyEnv];
    if (!apiKey) throw new Error(`environment variable ${args.keyEnv} is empty`);
  }
  const addendum = args.promptAddendum ? readPromptAddendum(args.promptAddendum) : null;
  const shim = createAnthropicChatShim({ apiKey, fetchFn: guarded, anthropicVersion: args.anthropicVersion,
    ...(addendum ? { systemAddendum: addendum.text } : {}) });
  const provider = createProviderAdapter(providerConfig(args), { fetchFn: shim, domainCatalog: catalog });
  let rewriteQuestion = null;
  let rewritePrice = null;
  if (args.rewrite) {
    rewritePrice = rewritePriceFor(args);
    const rewriteGuarded = guard.wrapFetch(transport, { tagOf: () => current, kind: 'rewrite', price: rewritePrice });
    const rewriteShim = createAnthropicChatShim({ apiKey, fetchFn: rewriteGuarded, anthropicVersion: args.anthropicVersion });
    // server.mjs: the rewriter shares the provider endpoint and key; here both are the shim's.
    rewriteQuestion = createRewriterAdapter({
      enabled: true, endpoint: ANTHROPIC_MESSAGES_BASE, apiKey: ADAPTER_PLACEHOLDER_KEY,
      model: args.rewrite, reasoningEffort: args.rewriteEffort,
    }, { fetchFn: rewriteShim });
  }
  return { provider, rewriteQuestion, guard, price, rewritePrice, addendum, setTag: (t) => { current = t; } };
}

/** Manifest block for --rewrite: wiring, effort mapping, price, counts and cost apart from the answers. */
export function rewriteSummary(rows, stack, args) {
  const calls = stack.guard.journal().filter((j) => j.event === 'call' && j.kind === 'rewrite');
  const reasons = rows.filter((r) => r.rewrite_reason).reduce((m, r) => ({ ...m, [r.rewrite_reason]: (m[r.rewrite_reason] || 0) + 1 }), {});
  return {
    model: args.rewrite, effort_production: args.rewriteEffort,
    effort_sent: args.rewriteEffort === 'minimal' ? 'low (shim maps minimal -> low, the lowest Anthropic effort)'
      : args.rewriteEffort === 'none' ? 'thinking between_tools (Sonnet 5.5 only)' : args.rewriteEffort,
    max_output_tokens: 128, system_prompt_sha256: sha256(REWRITE_SYSTEM_PROMPT),
    price_usd_per_mtok: stack.rewritePrice,
    rewrite_on_no_signal: Boolean(args.rewriteNoSignal),
    skipped_no_signal: rows.filter((r) => r.rewrite_skipped_no_signal).length,
    no_signal_questions: rows.filter((r) => r.domain_signal === DOMAIN_ROUTE_REASONS.NO_SIGNAL).length,
    no_signal_attempted: rows.filter((r) => r.rewrite_no_signal_attempted).length,
    attempted: rows.filter((r) => r.rewrite_attempted).length,
    reasons, winners: rows.filter((r) => r.rewrite_winner).reduce((m, r) => ({ ...m, [r.rewrite_winner]: (m[r.rewrite_winner] || 0) + 1 }), {}),
    calls: calls.length, cost_usd: calls.reduce((n, j) => n + j.costUsd, 0),
    answer_cost_usd: stack.guard.journal().filter((j) => j.event === 'call' && j.kind !== 'rewrite').reduce((n, j) => n + j.costUsd, 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'live' && !(args.capUsd > 0)) throw new Error('--cap-usd <tranche cap> is required in live mode');
  const databasePath = resolveDatabase(args.packagePath);
  const donor = resolve(args.donor.replace(/^~(?=\/)/, homedir()));
  let questions = loadQuestions(donor);
  if (args.only) questions = questions.filter((q) => args.only.has(q.q));
  if (args.limit) questions = questions.slice(0, args.limit);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(args.out || join(REPO, 'output', 'eval', 'runs', `${stamp}-${args.mode}`));
  mkdirSync(out, { recursive: true });

  if (args.mode === 'mock') {
    // Proof of zero network: any use of the real fetch throws and marks the run failed.
    globalThis.fetch = async () => { throw new Error('network_forbidden_in_mock_mode'); };
  }
  const stack = args.mode === 'retrieval' ? null : buildProviderStack(args, {
    transport: args.mode === 'live' ? globalThis.fetch : fakeAnthropicTransport(),
    journalPath: join(out, 'journal.jsonl'),
  });
  const assistant = createOfflineAssistant({ databasePath, provider: stack?.provider ?? null,
    rewriteQuestion: stack?.rewriteQuestion ?? null,
    ...(args.rewriteNoSignal ? { rewriteOnNoSignal: true } : {}) });
  const rows = [];
  let stoppedBy = null;
  try {
    for (const q of questions) {
      stack?.setTag(q.q);
      const t0 = Date.now();
      const r = await assistant.ask(q.question, { userId: `eval-${q.q}` });
      const diag = args.mode === 'retrieval' ? await assistant.diagnose(q.question, { userId: `eval-${q.q}` }) : null;
      if (stack?.guard.stopped()) { stoppedBy = stack.guard.stopped(); break; }
      const tagged = stack ? stack.guard.journal().filter((j) => j.tag === q.q && j.event === 'call') : [];
      const journal = tagged.filter((j) => j.kind !== 'rewrite');
      const rewriteCalls = tagged.filter((j) => j.kind === 'rewrite');
      const rw = r.trace?.rewrite ?? null;
      rows.push({
        q: q.q, case_id: q.case_id, kind: q.kind, question: q.question,
        status: args.mode === 'retrieval' ? (r.status === 'not_called' ? 'retrieved' : r.status) : r.status,
        answer: r.answer, unit_ids: r.unitIds, chunk_ids: r.chunkIds, gold_units: q.gold_units,
        route_reason: r.routeReason, error: r.error ?? null, pack_status: r.trace?.status ?? null,
        confidence: r.trace?.confidence ?? null, domain_signal: r.trace?.domain ?? null,
        input_tokens: r.receipt?.inputTokens ?? null, output_tokens: r.receipt?.outputTokens ?? null,
        stop_reason: journal.at(-1)?.stopReason ?? null,
        cost_usd: journal.length ? journal.reduce((n, j) => n + j.costUsd, 0) : (stack ? 0 : null),
        latency_ms: Date.now() - t0,
        ...(diag ? { diagnostics: diag } : {}),
        ...(stack?.rewriteQuestion ? {
          rewrite_skipped_no_signal: !args.rewriteNoSignal && r.trace?.domain === DOMAIN_ROUTE_REASONS.NO_SIGNAL,
          // A refused no-signal trace carries no rewrite block (production traces unchanged), so the
          // attempt is also read from the journal: a rewrite call tagged with this question.
          rewrite_no_signal_attempted: r.trace?.domain === DOMAIN_ROUTE_REASONS.NO_SIGNAL
            && (rw?.attempted === true || rewriteCalls.length > 0),
          rewrite_attempted: rw?.attempted ?? false, rewrite_reason: rw?.reason ?? null,
          rewrite_question: rw?.rewrittenQuestion ?? null, rewrite_winner: rw?.winner ?? null,
          rewrite_calls: rewriteCalls.length, rewrite_cost_usd: rewriteCalls.reduce((n, j) => n + j.costUsd, 0),
        } : {}),
      });
    }
  } finally { assistant.close(); }

  const sample = { route: DEFAULT_DOMAIN_CATALOG.routeFor('content'),
    knowledge: { sourceId: 'course-knowledge-v2', entries: [{ id: 'x', content: 'x' }] } };
  const manifest = {
    mode: args.mode, created_at: new Date().toISOString(), questions: questions.length, answered_rows: rows.length,
    stopped_by_spend_guard: stoppedBy,
    aichattg_git_sha: (() => { try { return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD']).toString().trim(); } catch { return null; } })(),
    database: databasePath, database_sha256: sha256File(databasePath),
    retrieval: { maxEntries: RETRIEVAL_MAX_ENTRIES, maxContextTokens: RETRIEVAL_MAX_CONTEXT_TOKENS,
      rewrite: Boolean(stack?.rewriteQuestion),
      rewrite_on_no_signal: Boolean(args.rewriteNoSignal) },
    domain_catalog_digest: DEFAULT_DOMAIN_CATALOG.digest,
    answer_system_prompt_sha256: sha256(answerSystemPrompt(sample, DEFAULT_DOMAIN_CATALOG)),
    substitutions: [...SUBSTITUTIONS, ...(args.mode === 'retrieval' ? ['answer_model_not_called'] : []),
      ...(args.mode === 'mock' ? ['answer_transport_is_fake_no_network'] : []),
      ...(args.mode !== 'retrieval' ? ['answer_model_is_claude_via_messages_shim_not_production_openai'] : [])],
    donor: { root: donor, cases_sha256: sha256File(join(donor, 'evals/golden/cases.jsonl')),
      id_map_sha256: sha256File(join(donor, 'evals/baseline/id_map.json')) },
    ...(stack ? {
      model: args.model, effort: args.effort, max_output_tokens: args.maxOutputTokens,
      anthropic_version: args.anthropicVersion, price_usd_per_mtok: stack.price,
      cap_usd: args.mode === 'live' ? args.capUsd : null, spent_usd: stack.guard.spentUsd(),
      already_spent_usd: args.alreadySpentUsd || 0,
    } : {}),
    ...(stack?.rewriteQuestion ? { rewrite: rewriteSummary(rows, stack, args) } : {}),
    ...(stack?.addendum ? { prompt_addendum: { path: stack.addendum.path, sha256: stack.addendum.sha256,
      bytes: stack.addendum.bytes, placement: 'end of answer system prompt, after a blank line' } } : {}),
  };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, 'answers.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (args.mode === 'retrieval') {
    const report = retrievalReport(rows);
    writeFileSync(join(out, 'retrieval-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(out, 'retrieval-report.md'), renderRetrievalMarkdown(report, manifest));
    console.log(JSON.stringify({ out, summary: report.summary }, null, 1));
  } else {
    if (stack.rewriteQuestion) {
      // Recall with the rewrite in the loop: the same report as --mode retrieval, over the answered run.
      const report = retrievalReport(rows);
      writeFileSync(join(out, 'retrieval-report.json'), `${JSON.stringify(report, null, 2)}\n`);
      writeFileSync(join(out, 'retrieval-report.md'), renderRetrievalMarkdown(report, manifest));
    }
    writeFileSync(join(out, 'answers.md'), renderAnswersMarkdown(rows, { title: `AIchatTG assistant, ${args.model}/${args.effort} (${args.mode})` }));
    const by = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
    console.log(JSON.stringify({ out, rows: rows.length, statuses: by, spent_usd: stack.guard.spentUsd(), stopped: stoppedBy,
      ...(manifest.rewrite ? { rewrite: manifest.rewrite } : {}),
      ...(manifest.prompt_addendum ? { prompt_addendum_sha256: manifest.prompt_addendum.sha256 } : {}) }));
  }
  if (stoppedBy) process.exitCode = 4;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error?.stack || String(error)); process.exitCode = 1; });
}
