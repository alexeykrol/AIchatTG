#!/usr/bin/env node
/**
 * Pre-deploy smoke of the REAL Assistant runtime path (not the eval shim).
 *
 * Assembly follows apps/telegram-runtime/src/server.mjs step by step:
 *   loadRuntimeConfig(env) -> loadDomainCatalog -> composeKnowledgeSlices(createKnowledgeAdapter)
 *   -> createKnowledgeRetrieval(config.assistantRetrieval) -> createProviderAdapter(config.provider)
 *   -> createTelegramRuntime -> handleUpdate('moderator') + handleUpdate('assistant').
 *
 * Substitutions (all at the network boundary, named in the output):
 *   1. OpenAI transport is fake: safety router gets a clean verdict, assistant
 *      router gets a scripted domain choice per question. No OpenAI call is made.
 *   2. Telegram transport is fake: the REAL telegram adapter renders the message
 *      (HTML, split, version footer); the fake fetch records the body.
 *   3. Moderator guard is a local stub (rights proven, sender not exempt).
 *   4. Store is a temporary SQLite file.
 * The answer call goes to the real Anthropic Messages API (capped, no retries).
 *
 * Run (repo root):
 *   set -a; eval "$(grep -E '^ANTHROPIC_API_KEY=' ../agi2claude/.env | sed 's/^ANTHROPIC_API_KEY=/EVAL_ANTHROPIC_KEY=/')"; set +a
 *   node scripts/aichattg/runtime-smoke.mjs [--package <dir>] [--dry]
 *
 * Two-slot mode (generic package registry, 2.4.48+):
 *   node scripts/aichattg/runtime-smoke.mjs --two-slot [--course-package <dir>] [--package <dir>] [--dry]
 * The course slot (built-in env, lexical) gets the old `ai` package, the book is
 * one registry entry (`book-tcr-v1`, hybrid live recipe). Both package dirs are
 * linked (directory symlinks, files untouched) into one temporary knowledge
 * root. Every question prints which slot served it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(REPO, 'apps/telegram-runtime/src');
const { loadRuntimeConfig } = await import(join(SRC, 'config.mjs'));
const { openRuntimeDatabase, createRuntimeStore } = await import(join(SRC, 'database.mjs'));
const { createProviderAdapter } = await import(join(SRC, 'provider-adapter.mjs'));
const { createKnowledgeAdapter } = await import(join(SRC, 'knowledge-adapter.mjs'));
const { assertSlicesAdmitted, composeKnowledgeSlices } = await import(join(SRC, 'knowledge-slices.mjs'));
const { createKnowledgeRetrieval } = await import(join(SRC, 'knowledge-retrieval.mjs'));
const { assertPackageSlotsAdmitted, bindRetrievalsToDomains } = await import(join(SRC, 'knowledge-packages.mjs'));
const { createTelegramAdapter } = await import(join(SRC, 'telegram-adapter.mjs'));
const { createTelegramRuntime } = await import(join(SRC, 'runtime.mjs'));
const { loadDomainCatalog } = await import(join(SRC, 'assistant-domains.mjs'));
const { ASSISTANT_RELEASE_LINE } = await import(join(SRC, 'assistant-release.mjs'));

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const DRY = args.includes('--dry');
const TWO_SLOT = args.includes('--two-slot');
// In a git worktree the ignored output/ and the sibling allcourses checkout live
// beside the main checkout, so defaults fall back to it when absent here.
const MAIN_REPO = REPO.includes(join('.claude', 'worktrees')) ? resolve(REPO, '..', '..', '..') : REPO;
const firstExisting = (...paths) => paths.find((path) => existsSync(path)) || paths[0];
const PACKAGE_DIR = resolve(argValue('--package', firstExisting(
  join(REPO, 'output/kb/tcr-passages-v1/pkg-hybrid-36b8db92318b'),
  join(MAIN_REPO, 'output/kb/tcr-passages-v1/pkg-hybrid-36b8db92318b'))));
const COURSE_PACKAGE_DIR = resolve(argValue('--course-package',
  join(MAIN_REPO, '..', 'allcourses/code/data/knowledge/packages/ai-140310bf9472')));
const EXPECTED_DIGEST = '36b8db92318b181686daff477eb9017b3a6f6e3be29d59fcd07c1e8a8c6df709';
const MAX_ANTHROPIC_CALLS = 5;
const PRICE_IN = 2 / 1e6;
const PRICE_OUT = 10 / 1e6;
const CHAT_ID = '-1001';
const ANSWER_MODEL = 'claude-sonnet-5-5';

// Scripted router choice per question = substitution 1. Domain ids come from
// the runtime catalog (content / operations / ... ); [] = no subject domain.
const QUESTIONS = TWO_SLOT ? [
  { q: 'Почему я пашу как проклятый, а бизнес не растёт?', domains: ['book'] },
  { q: 'Что такое RAG простыми словами?', domains: ['content'] },
  { q: 'Чем каста отличается от роли и может ли ИИ-агент помочь мне сменить роль?', domains: ['book', 'content'] },
  { q: 'Сколько стоит курс и как его оплатить?', domains: ['operations'] },
  { q: 'Как выбрать хорошего стоматолога?', domains: [] },
] : [
  { q: 'Почему я пашу как проклятый, а бизнес не растёт?', domains: ['content'] },
  { q: 'Что такое касты в теории каст и ролей и чем каста отличается от роли?', domains: ['content'] },
  { q: 'Сколько стоит курс и как его оплатить?', domains: ['operations'] },
  { q: 'Как выбрать хорошего стоматолога?', domains: [] },
  { q: 'Автор говорит, что каста — следствие, а роль — причина, но в другом месте пишет, что из касты почти не выбраться. Как это совместить?', domains: ['content'] },
];

const anthropicKey = String(process.env.EVAL_ANTHROPIC_KEY || '').trim();
if (!DRY && !anthropicKey) {
  console.error('EVAL_ANTHROPIC_KEY is not set; refusing to run live (use --dry for a no-model run)');
  process.exit(2);
}

const workdir = mkdtempSync(join(tmpdir(), 'aichattg-runtime-smoke-'));
// Two-slot: one temporary knowledge root holding links to both packages and the
// registry file. Package files are never copied or modified.
let KNOWLEDGE_ROOT = dirname(PACKAGE_DIR);
let COURSE_DIGEST = null;
if (TWO_SLOT) {
  if (!existsSync(join(COURSE_PACKAGE_DIR, 'knowledge.manifest.json'))) {
    console.error(`--two-slot needs the course package: ${COURSE_PACKAGE_DIR} (use --course-package <dir>)`);
    process.exit(2);
  }
  KNOWLEDGE_ROOT = join(workdir, 'knowledge');
  mkdirSync(KNOWLEDGE_ROOT);
  symlinkSync(COURSE_PACKAGE_DIR, join(KNOWLEDGE_ROOT, 'course'), 'dir');
  symlinkSync(PACKAGE_DIR, join(KNOWLEDGE_ROOT, 'book'), 'dir');
  COURSE_DIGEST = JSON.parse(readFileSync(join(COURSE_PACKAGE_DIR, 'knowledge.manifest.json'), 'utf8')).packageDigest;
  writeFileSync(join(KNOWLEDGE_ROOT, 'packages.json'), JSON.stringify([{
    sourceId: 'book-tcr-v1', manifestPath: 'book/knowledge.manifest.json', digestSha256: EXPECTED_DIGEST,
    retrieval: { mode: 'hybrid', maxEntries: 24, maxContextTokens: 6000, hybridMaxContextTokens: 12000,
      noConceptGate: 'pass', coverageText: 'content+alias', linkTypes: ['contradicts', 'qualifies'], linkMax: 4 },
  }], null, 2));
}
// Course slot in two-slot mode = the old production course recipe (env defaults:
// lexical, 12 entries, refuse gate, content coverage, no links).
const courseSlotEnv = TWO_SLOT ? {
  TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGE_MANIFEST_PATH: join(KNOWLEDGE_ROOT, 'course/knowledge.manifest.json'),
  TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGE_DIGEST_SHA256: COURSE_DIGEST,
  TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES: join(KNOWLEDGE_ROOT, 'packages.json'),
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_MODE: 'lexical',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_MAX_ENTRIES: '12',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_NO_CONCEPT_GATE: 'refuse',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_COVERAGE_TEXT: 'content',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_LINK_MAX: '0',
} : {};
const env = {
  TELEGRAM_RUNTIME_DATA_ROOT: workdir,
  TELEGRAM_RUNTIME_DATABASE_PATH: join(workdir, 'telegram-runtime.db'),
  TELEGRAM_RUNTIME_INGRESS_ENABLED: 'false',
  TELEGRAM_RUNTIME_MODERATION_MODE: 'shadow',
  TELEGRAM_RUNTIME_MODERATOR_BOT_TOKEN: '1000001:smoke-moderator',
  TELEGRAM_RUNTIME_MODERATOR_CHAT_IDS: CHAT_ID,
  TELEGRAM_RUNTIME_ASSISTANT_BOT_TOKEN: '1000002:smoke-assistant',
  TELEGRAM_RUNTIME_ASSISTANT_BOT_USERNAME: 'smoke_assistant_bot',
  TELEGRAM_RUNTIME_ASSISTANT_CHAT_IDS: CHAT_ID,
  TELEGRAM_RUNTIME_ASSISTANT_STUB_MODE: 'false',
  TELEGRAM_RUNTIME_ASSISTANT_KNOWLEDGE_ENABLED: 'true',
  TELEGRAM_RUNTIME_ASSISTANT_NEVER_REFUSE: 'true',
  TELEGRAM_RUNTIME_KNOWLEDGE_ROOT: KNOWLEDGE_ROOT,
  // As in production: v1 snapshot manifests point below the root; absent files
  // simply mean those sources are not admitted.
  TELEGRAM_RUNTIME_KNOWLEDGE_CONTENT_MANIFEST_PATH: join(KNOWLEDGE_ROOT, 'course-content.manifest.json'),
  TELEGRAM_RUNTIME_KNOWLEDGE_OPERATIONS_MANIFEST_PATH: join(KNOWLEDGE_ROOT, 'manifest.json'),
  TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGE_MANIFEST_PATH: join(PACKAGE_DIR, 'knowledge.manifest.json'),
  TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGE_DIGEST_SHA256: EXPECTED_DIGEST,
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_ENABLED: 'true',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_MODE: 'hybrid',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_MAX_ENTRIES: '24',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_MAX_CONTEXT_TOKENS: '6000',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_NO_CONCEPT_GATE: 'pass',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_COVERAGE_TEXT: 'content+alias',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_HYBRID_MAX_CONTEXT_TOKENS: '12000',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_LINK_TYPES: 'contradicts,qualifies',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_LINK_MAX: '4',
  TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_REWRITE_ENABLED: 'false',
  TELEGRAM_RUNTIME_PROVIDER_ENABLED: 'true',
  TELEGRAM_RUNTIME_PROVIDER_VENDOR: 'openai',
  TELEGRAM_RUNTIME_PROVIDER_ENDPOINT: 'https://api.openai.com/v1/',
  TELEGRAM_RUNTIME_PROVIDER_API_KEY: 'smoke-fake-openai-key-never-sent',
  TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_MODEL: 'gpt-5.6-terra',
  TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_REASONING_EFFORT: 'medium',
  TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_MAX_OUTPUT_TOKENS: '1024',
  TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MODEL: 'gpt-5.6-luna',
  TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_REASONING_EFFORT: 'low',
  TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MAX_OUTPUT_TOKENS: '256',
  TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_VENDOR: 'anthropic',
  TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MODEL: ANSWER_MODEL,
  TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_REASONING_EFFORT: 'low',
  TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MAX_OUTPUT_TOKENS: '2000',
  TELEGRAM_RUNTIME_ANTHROPIC_API_KEY: anthropicKey || 'smoke-dry-key-never-sent',
  TELEGRAM_RUNTIME_ANTHROPIC_ENDPOINT: 'https://api.anthropic.com/v1/',
  ORT_DISABLE_TELEMETRY: '1',
  ...courseSlotEnv,
};
process.env.ORT_DISABLE_TELEMETRY = '1';

// ---- network boundary -------------------------------------------------------
let anthropicCalls = 0;
const anthropicLog = [];
const openaiLog = [];
const telegramLog = [];
let current = null; // the question being processed

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fakeChatCompletion(model, content) {
  return jsonResponse(200, {
    id: 'chatcmpl-smoke', object: 'chat.completion', model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }, { 'x-request-id': 'smoke-fake' });
}

async function fetchFn(url, init = {}) {
  const href = String(url);
  const host = new URL(href).hostname;
  if (host === 'api.anthropic.com') {
    if (DRY) throw new Error('dry run: Anthropic call blocked');
    if (anthropicCalls >= MAX_ANTHROPIC_CALLS) throw new Error('smoke cap: Anthropic call budget exhausted');
    anthropicCalls += 1;
    const body = JSON.parse(init.body);
    const started = Date.now();
    const response = await globalThis.fetch(href, init);
    anthropicLog.push({ question: current?.q, status: response.status, ms: Date.now() - started,
      systemChars: String(body.system || '').length,
      inputChars: body.messages.map((m) => String(m.content).length).reduce((a, b) => a + b, 0) });
    return response;
  }
  if (host === 'api.openai.com') {
    const body = JSON.parse(init.body);
    const user = String(body.messages?.at(-1)?.content || '');
    let parsed = null;
    try { parsed = JSON.parse(user); } catch { parsed = null; }
    if (parsed && typeof parsed === 'object' && parsed.evidence_catalogue) {
      openaiLog.push({ kind: 'safety', model: body.model });
      return fakeChatCompletion(body.model, JSON.stringify({
        threat: { match: false, types: [], confidence: 0.99, evidence: [] },
        abuse: { match: false, types: [], confidence: 0.99, evidence: [] },
        target: 'none', context_used: false,
      }));
    }
    // Match only the non-system messages: the router's system prompt carries the
    // domain index, whose examples may repeat a smoke question verbatim.
    const turnText = JSON.stringify((body.messages || []).filter((m) => m.role !== 'system'));
    const scripted = QUESTIONS.filter((item) => user.includes(item.q) || turnText.includes(JSON.stringify(item.q).slice(1, -1)))
      .sort((a, b) => b.q.length - a.q.length)[0];
    if (scripted) {
      openaiLog.push({ kind: 'router', model: body.model, domains: scripted.domains });
      return fakeChatCompletion(body.model, JSON.stringify({ domains: scripted.domains, riskFlags: [] }));
    }
    openaiLog.push({ kind: 'unexpected', model: body.model });
    return jsonResponse(500, { error: { message: 'smoke: unexpected OpenAI request' } });
  }
  if (host === 'api.telegram.org') {
    const method = href.split('/').at(-1);
    const body = init.body ? JSON.parse(init.body) : {};
    telegramLog.push({ method, body, question: current?.q });
    if (method === 'getChatMember') return jsonResponse(200, { ok: true, result: { status: 'administrator', can_delete_messages: true, can_restrict_members: true } });
    if (method === 'sendMessage') return jsonResponse(200, { ok: true, result: { message_id: 50_000 + telegramLog.length, chat: { id: Number(body.chat_id) } } });
    return jsonResponse(200, { ok: true, result: true });
  }
  throw new Error(`smoke: network to ${host} is not allowed`);
}

// ---- assembly (mirrors server.mjs) ----------------------------------------
const started = Date.now();
const config = loadRuntimeConfig(env, { cwd: REPO });
const domainCatalog = loadDomainCatalog({ indexPath: config.assistantDomainIndexPath });
const database = openRuntimeDatabase(config.databasePath);
const composed = composeKnowledgeSlices(createKnowledgeAdapter(config.knowledge), {
  orgSlicePath: config.knowledge.slices.orgPath,
  valueSlicePath: config.knowledge.slices.valuePath,
});
assertSlicesAdmitted(composed.slices);
const retrievalLog = [];
const embedderCache = new Map();
const retrievalOptions = {
  knowledge: composed.baseKnowledge,
  embedderCache,
  log: (line) => { retrievalLog.push(line); console.warn(line); },
};
const contentRetrievalReal = createKnowledgeRetrieval(config.assistantRetrieval, retrievalOptions);
const retrievals = [];
// Observation wrapper only: forwards the call unchanged and records the trace
// plus the slot (the retrieval's own sourceId) that served it.
function observed(real) {
  return Object.freeze({
    ...real,
    async forQuestion(input) {
      const t0 = Date.now();
      const result = await real.forQuestion(input);
      retrievals.push({ question: current?.q, slot: real.sourceId || 'none', ms: Date.now() - t0,
        grounded: result.grounded, reason: result.reason,
        search: result.trace?.search || null, packEntries: result.pack?.entries?.length ?? 0 });
      return result;
    },
  });
}
const contentRetrieval = observed(contentRetrievalReal);
// Same slot assembly as server.mjs: registry slots + binding by domain source.
const packageSlots = composed.baseKnowledge.packageSlots?.() || [];
assertPackageSlotsAdmitted(packageSlots);
const slotRetrievals = new Map([[contentRetrievalReal.sourceId || 'course-knowledge-v2', contentRetrieval]]);
const slotReals = [contentRetrievalReal];
for (const slot of config.knowledge.packages.slots) {
  const real = createKnowledgeRetrieval({ ...slot.retrieval, sourceId: slot.sourceId, rewriteEnabled: false,
    validatePacks: config.assistantRetrieval.validatePacks }, retrievalOptions);
  slotReals.push(real);
  slotRetrievals.set(slot.sourceId, observed(real));
}
const sourceRetrievals = bindRetrievalsToDomains(domainCatalog, slotRetrievals);
const realProvider = createProviderAdapter(config.provider, { domainCatalog, fetchFn });
const answers = [];
const provider = Object.freeze({
  ...realProvider,
  async answer(payload) {
    const entries = payload?.knowledge?.entries || [];
    const record = { question: current?.q, entries: entries.length,
      chars: entries.reduce((sum, e) => sum + String(e.content || '').length, 0), route: payload?.route };
    const t0 = Date.now();
    try {
      const result = await realProvider.answer(payload);
      answers.push({ ...record, ms: Date.now() - t0, receipt: result.receipt });
      return result;
    } catch (error) {
      answers.push({ ...record, ms: Date.now() - t0, error: error?.code || error?.message, receipt: error?.receipt || null });
      throw error;
    }
  },
});
const guard = {
  async verifyEnforcement() { return { proven: true, status: 'administrator' }; },
  async senderDisposition() { return { proven: true, exempt: false, reason: null }; },
  async deleteMessage() { return { ok: true }; },
  async unpinMessage() { return { ok: true }; },
  async sendWarning() { return { ok: true }; },
  async banAuthor() { return { ok: true }; },
};
const runtime = createTelegramRuntime({
  config,
  store: createRuntimeStore(database),
  provider,
  domainCatalog,
  knowledge: composed.knowledge,
  contentRetrieval,
  sourceRetrievals,
  moderatorTelegram: createTelegramAdapter({ ...config.moderator, fetchFn }),
  guard,
  assistantTelegram: createTelegramAdapter({ ...config.assistant, fetchFn }),
  notifier: { async notify() { return { delivered: false, skipped: 'smoke' }; } },
});
const pkgManifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'knowledge.manifest.json'), 'utf8'));
console.log('=== runtime smoke ===');
console.log(`package=${relative(REPO, PACKAGE_DIR)} digest=${pkgManifest.packageDigest.slice(0, 12)} retrieval.available=${contentRetrievalReal.available} reason=${contentRetrievalReal.reason || 'none'}`);
for (const real of slotReals) {
  console.log(`slot ${real.sourceId || 'none'}: available=${real.available} reason=${real.reason || 'none'} domain=${real.domainId || 'none'} mode=${real.retrievalMode || 'n/a'} hybridLive=${real.hybridLive ?? 'n/a'} embedderShared=${real.embedderShared ?? 'n/a'}`);
}
for (const slot of packageSlots) {
  console.log(`registry ${slot.sourceId}: configured=${slot.configured} admitted=${slot.admitted} reason=${slot.reason || 'none'} digest=${slot.digest.slice(0, 12)}`);
}
console.log(`bindings: ${domainCatalog.domains.filter((d) => d.sourceKind === 'retrieval').map((d) => `${d.id}->${sourceRetrievals.get(d.sourceId)?.sourceId || 'none'}`).join(' ')}`);
console.log(`retrieval config: mode=${config.assistantRetrieval.retrievalMode} maxEntries=${config.assistantRetrieval.maxEntries} ctx=${config.assistantRetrieval.maxContextTokens} hybridCtx=${config.assistantRetrieval.hybridMaxContextTokens} gate=${config.assistantRetrieval.noConceptGate} coverage=${config.assistantRetrieval.coverageText} links=${config.assistantRetrieval.linkExpansion.types.join('+')}x${config.assistantRetrieval.linkExpansion.max}`);
console.log(`provider: answerVendor=${config.provider.answerVendor} model=${config.provider.modelTuples.assistantAnswer.model}/${config.provider.modelTuples.assistantAnswer.reasoningEffort}/${config.provider.modelTuples.assistantAnswer.maxOutputTokens}`);
console.log(`slices: ${composed.slices.map((s) => `${s.name}:configured=${s.configured},admitted=${s.admitted}`).join(' ')}`);
console.log(`release footer expected: ${ASSISTANT_RELEASE_LINE}; setup ${Date.now() - started} ms`);
console.log('substitutions: openai_transport_fake(safety=clean, router=scripted), telegram_transport_fake(real adapter render), moderator_guard_stub, tmp_sqlite');

let totalCost = 0;
for (const [index, item] of QUESTIONS.entries()) {
  current = item;
  const message = {
    message_id: 100 + index,
    chat: { id: Number(CHAT_ID), type: 'supergroup' },
    from: { id: 900_000 + index, first_name: `Smoke${index + 1}`, is_bot: false },
    date: Math.floor(Date.now() / 1000),
    text: `/ask ${item.q}`,
  };
  const t0 = Date.now();
  let result = null;
  let failure = null;
  try {
    await runtime.handleUpdate('moderator', { update_id: 10 + index * 2, message });
    result = await runtime.handleUpdate('assistant', { update_id: 11 + index * 2, message });
  } catch (error) {
    failure = error?.stack || String(error);
  }
  const ms = Date.now() - t0;
  const served = retrievals.filter((r) => r.question === item.q);
  const retrieval = served.at(-1) || null;
  const answer = answers.filter((a) => a.question === item.q).at(-1) || null;
  const sends = telegramLog.filter((t) => t.question === item.q && t.method === 'sendMessage');
  const delivered = sends.map((s) => String(s.body.text || '')).join('\n---\n');
  const lines = delivered.trim().split('\n');
  const footer = lines.at(-1) || '';
  const r = answer?.receipt || null;
  const cost = r ? (r.inputTokens || 0) * PRICE_IN + (r.outputTokens || 0) * PRICE_OUT : 0;
  totalCost += cost;
  console.log(`\n--- Q${index + 1}: ${item.q}`);
  console.log(`router(scripted)=${JSON.stringify(item.domains)} result.kind=${result?.kind ?? 'n/a'} route=${typeof result?.route === 'string' ? result.route : JSON.stringify(result?.route ?? null)} reason=${result?.reason ?? 'none'}`);
  console.log(`slots served: ${served.length ? served.map((r) => `${r.slot}(grounded=${r.grounded},entries=${r.packEntries})`).join(' + ') : 'none'}`);
  console.log(`retrieval: ${retrieval ? `slot=${retrieval.slot} mode=${retrieval.search?.mode ?? 'n/a'} fallback=${retrieval.search?.fallback ?? 'none'} vectorOnly=${retrieval.search?.vectorOnly ?? '-'} linksAdded=${retrieval.search?.linksAdded ?? '-'} grounded=${retrieval.grounded} reason=${retrieval.reason ?? 'none'} packEntries=${retrieval.packEntries} ${retrieval.ms}ms` : 'not called'}`);
  console.log(`answer input: ${answer ? `entries=${answer.entries} chars=${answer.chars}` : 'no model call'}${answer?.error ? ` ERROR=${answer.error}` : ''}`);
  if (r) console.log(`receipt: model=${r.modelId} http=${r.httpStatus} in=${r.inputTokens} out=${r.outputTokens} cacheRead=${r.cacheReadInputTokens ?? 0} cost=$${cost.toFixed(4)} modelLatency=${answer.ms}ms`);
  console.log(`telegram: ${sends.length} message(s), ${delivered.length} chars; footer="${footer}" footerOk=${footer.includes(ASSISTANT_RELEASE_LINE)}`);
  console.log(`latency total=${ms}ms`);
  console.log(`text[0..1200]:\n${delivered.slice(0, 1200)}`);
  if (failure) console.log(`RUNTIME ERROR: ${failure}`);
}
current = null;

console.log('\n=== totals ===');
console.log(`anthropic calls=${anthropicCalls}/${MAX_ANTHROPIC_CALLS} total cost=$${totalCost.toFixed(4)}`);
console.log(`openai fake calls: ${openaiLog.map((o) => o.kind).join(',') || 'none'}; unexpected=${openaiLog.filter((o) => o.kind === 'unexpected').length}`);
console.log(`retrieval log lines: ${retrievalLog.length ? retrievalLog.join(' | ') : 'none'}`);
for (const real of slotReals) real.close?.();
database.close();
rmSync(workdir, { recursive: true, force: true });
