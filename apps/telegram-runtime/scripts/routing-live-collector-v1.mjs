#!/usr/bin/env node
/** One-shot, lease-gated routing measurements. No retry, resume or production path. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPlan, interpretRecorded, scoreRecorded } from './routing-only-eval.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '../../..');
const CASES = resolve(ROOT, 'docs/evaluation/routing-only-v1.json');
export const CREDENTIAL_PATH = '/Users/alexeykrolmini/Code/AIchatTG/apps/telegram-runtime/.env.provider.local';
export const POLICY = Object.freeze({
  scope: 'routing-only', endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-5.6-luna', reasoningEffort: 'low', routerMaxOutputTokens: 256,
  dispatchMaxOutputTokens: 1536, serviceTier: 'default', store: false, n: 1,
  maxCalls: 104, maxBudgetUsd: 20, maxInputTokens: 272_000,
  requestTimeoutMs: 45_000, runTimeoutMs: 1_200_000, maxLeaseMs: 86_400_000,
  inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.2,
});
const digest = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest('hex');
const fail = (code) => { throw new CollectorError(code); };
export class CollectorError extends Error {
  constructor(code) { super(`routing_collector:${code}`); this.code = code; }
}
const safeCode = (error) => error instanceof CollectorError ? error.code : 'local_io_or_source_failure';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const usd = (input, output) => (input * POLICY.inputUsdPerMillion + output * POLICY.outputUsdPerMillion) / 1_000_000;
const readCases = () => JSON.parse(readFileSync(CASES, 'utf8'));
const gitHead = (root) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function requestFor(request) {
  return { model: POLICY.model,
    messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.inputText }],
    reasoning_effort: POLICY.reasoningEffort,
    max_completion_tokens: request.lane.endsWith(':router') ? POLICY.routerMaxOutputTokens : POLICY.dispatchMaxOutputTokens,
    response_format: { type: 'json_object' }, service_tier: POLICY.serviceTier, store: false, n: 1 };
}

export function boundPlan(plan) {
  if (plan.requests.length !== 112 || plan.maxModelCalls !== POLICY.maxCalls
    || plan.requests.filter((r) => !r.requiresModel).length !== 8) fail('plan_call_count');
  const calls = plan.requests.filter((r) => r.requiresModel).map((r) => {
    if (typeof r.system !== 'string' || typeof r.inputText !== 'string'
      || digest(r.system) !== r.promptDigest || digest(r.inputText) !== r.inputDigest) fail('request_fingerprint');
    // UTF-8 bytes are a deliberately pessimistic token bound, plus framing.
    const inputTokensUpperBound = Buffer.byteLength(r.system, 'utf8') + Buffer.byteLength(r.inputText, 'utf8') + 2048;
    if (inputTokensUpperBound > POLICY.maxInputTokens) fail('input_bound');
    const outputTokensUpperBound = requestFor(r).max_completion_tokens;
    return { key: r.key, inputTokensUpperBound, outputTokensUpperBound,
      reservedCostUsd: usd(inputTokensUpperBound, outputTokensUpperBound) };
  });
  const maxCostUsd = calls.reduce((sum, r) => sum + r.reservedCostUsd, 0);
  if (maxCostUsd > POLICY.maxBudgetUsd) fail('whole_run_budget');
  return { calls, maxCostUsd, deterministicExcluded: 8 };
}

/** This default path never reads credentials, writes files or starts a request. */
export function preflight({ root = ROOT, data = readCases(), candidateGitHEAD = gitHead(root),
  collectorSHA256 = digest(readFileSync(SELF)) } = {}) {
  if (!/^[a-f0-9]{40}$/.test(candidateGitHEAD) || !/^[a-f0-9]{64}$/.test(collectorSHA256)) fail('source_identity');
  const plan = buildPlan(data);
  return { status: 'prepared', candidateGitHEAD, collectorSHA256, planDigest: plan.planDigest,
    credentialPath: CREDENTIAL_PATH, outputDir: resolve(root, '.handoffs/local/routing-live-collector-v1'),
    policy: POLICY, bounds: boundPlan(plan), plan, data };
}

export function leaseTemplate(prepared) {
  return { schemaVersion: 'routing-live-lease-v1', approved: false,
    candidateGitHEAD: prepared.candidateGitHEAD, planDigest: prepared.planDigest,
    collectorSHA256: prepared.collectorSHA256, issuedAt: null, expiresAt: null,
    credentialPath: prepared.credentialPath, outputDir: prepared.outputDir, ...POLICY };
}

export function validateLease(lease, prepared, now = Date.now()) {
  const expected = leaseTemplate(prepared);
  if (!object(lease) || Object.keys(lease).sort().join() !== Object.keys(expected).sort().join()) fail('lease_schema');
  for (const [key, value] of Object.entries(expected)) {
    if (['approved', 'issuedAt', 'expiresAt'].includes(key)) continue;
    if (lease[key] !== value) fail('lease_identity_or_policy');
  }
  const issued = Date.parse(lease.issuedAt), expires = Date.parse(lease.expiresAt);
  if (lease.approved !== true || typeof lease.issuedAt !== 'string' || typeof lease.expiresAt !== 'string'
    || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now
    || expires <= issued || expires - issued > POLICY.maxLeaseMs) fail('lease_expired_or_unapproved');
  return { issued, expires };
}

const CONFIG_KEYS = Object.freeze({
  TELEGRAM_RUNTIME_PROVIDER_ENABLED: 'enabled', TELEGRAM_RUNTIME_PROVIDER_VENDOR: 'vendor',
  TELEGRAM_RUNTIME_PROVIDER_ENDPOINT: 'endpoint', TELEGRAM_RUNTIME_PROVIDER_API_KEY: 'apiKey',
  TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MODEL: 'model',
  TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_REASONING_EFFORT: 'reasoningEffort',
  TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MAX_OUTPUT_TOKENS: 'maxOutputTokens',
});

/** Parse only the allowlisted provider assignments, never source/eval a shell file. */
export function parseCredentialConfig(text) {
  if (typeof text !== 'string' || text.length > 131_072) fail('credential_config_invalid');
  const config = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(.*)$/u.exec(line);
    if (!match || !Object.hasOwn(CONFIG_KEYS, match[1])) continue;
    const key = CONFIG_KEYS[match[1]];
    if (Object.hasOwn(config, key)) fail('credential_config_duplicate');
    let value = match[2].trim();
    if (/[$`\r\n\0]/u.test(value)) fail('credential_config_shell_syntax');
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      if (end < 1 || !/^(?:\s*#.*)?$/u.test(value.slice(end + 1))) fail('credential_config_quotes');
      value = value.slice(1, end);
    } else value = value.replace(/\s+#.*$/u, '').trim();
    if (!value || /[\s\\;|&<>]/u.test(value)) fail('credential_config_value');
    config[key] = value;
  }
  if (config.enabled !== 'true' || config.vendor !== 'openai'
    || !['https://api.openai.com/v1', 'https://api.openai.com/v1/'].includes(config.endpoint)
    || config.model !== POLICY.model || config.reasoningEffort !== POLICY.reasoningEffort
    || config.maxOutputTokens !== String(POLICY.routerMaxOutputTokens)
    || typeof config.apiKey !== 'string' || config.apiKey.length < 8) fail('credential_tuple_mismatch');
  return config;
}

function readCredentialConfig(path) {
  if (path !== CREDENTIAL_PATH || realpathSync(path) !== path || !lstatSync(path).isFile()) fail('credential_route');
  return parseCredentialConfig(readFileSync(path, 'utf8'));
}
function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableFile(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeAll(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
function writeAll(fd, text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
}
function safeId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,200}$/u.test(value) ? value : null; }

function usageOf(body, bound) {
  const u = body?.usage;
  if (!object(u) || !integer(u.prompt_tokens) || !integer(u.completion_tokens) || !integer(u.total_tokens)
    || u.total_tokens !== u.prompt_tokens + u.completion_tokens) fail('unknown_usage');
  if (u.prompt_tokens > bound.inputTokensUpperBound || u.completion_tokens > bound.outputTokensUpperBound) fail('usage_bound');
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined && (!integer(reasoning) || reasoning > u.completion_tokens)) fail('unknown_usage');
  // completion_tokens already includes reasoning; adding reasoning again would double-count.
  const inputDetails = {};
  for (const key of ['cached_tokens', 'cache_write_tokens']) {
    const count = u.prompt_tokens_details?.[key];
    if (count !== undefined) {
      if (!integer(count) || count > u.prompt_tokens) fail('unknown_usage');
      inputDetails[key] = count;
    }
  }
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, totalTokens: u.total_tokens,
    inputDetails, costUpperBoundUsd: usd(u.prompt_tokens, u.completion_tokens) };
}

async function responseBody(response) {
  // Bound the raw envelope too. Do not persist it, error bodies, or reasoning fields.
  const limit = 262_144;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const parts = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); fail('response_size'); }
        parts.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { fail('response_schema'); }
  }
  const text = await response.text();
  if (typeof text !== 'string' || Buffer.byteLength(text) > limit) fail('response_size');
  try { return JSON.parse(text); } catch { fail('response_schema'); }
}

async function callOnce(request, apiKey, timeoutMs, { fetchFn, setTimer, clearTimer }, receipt) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => { controller.abort(); reject(new CollectorError('request_timeout')); }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      let response;
      try {
        response = await fetchFn(POLICY.endpoint, { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(requestFor(request)), signal: controller.signal });
      } catch { fail('transport_failure'); }
      receipt.httpStatus = Number.isInteger(response?.status) ? response.status : null;
      receipt.requestId = safeId(response?.headers?.get?.('x-request-id'));
      if ([401, 403].includes(receipt.httpStatus)) fail('auth_failure');
      if (receipt.httpStatus !== 200 || response.ok !== true) fail('http_failure');
      try { return await responseBody(response); }
      catch (error) { if (error instanceof CollectorError) throw error; fail('response_body_failure'); }
    })()]);
  } finally { clearTimer(timer); controller.abort(); }
}

/** Dependency seams are for offline safety tests. The CLI supplies no overrides. */
export async function collect(lease, {
  prepared = preflight(), currentIdentity = () => preflight(), readCredentials = readCredentialConfig,
  fetchFn = globalThis.fetch, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  progress = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
} = {}) {
  validateLease(lease, prepared, now());
  validateLease(lease, currentIdentity(), now());
  const bounds = boundPlan(prepared.plan);
  const parent = dirname(prepared.outputDir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (realpathSync(parent) !== parent) fail('output_route');
  try { mkdirSync(prepared.outputDir, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('run_already_exists_no_resume'); throw error; }
  syncDirectory(parent);
  // Claim the one-shot directory BEFORE any credential access; even pre-request
  // failures consume this run identity and require an explicit new reviewed program.
  const started = now();
  const deadline = Math.min(started + POLICY.runTimeoutMs, Date.parse(lease.expiresAt));
  const manifest = { schemaVersion: 'routing-live-manifest-v1', lease, leaseDigest: digest(lease),
    startedAt: new Date(started).toISOString(), deadline: new Date(deadline).toISOString(),
    candidateGitHEAD: prepared.candidateGitHEAD, collectorSHA256: prepared.collectorSHA256,
    planDigest: prepared.planDigest, bounds, plan: prepared.plan,
    requests: prepared.plan.requests.filter((r) => r.requiresModel).map((r) => ({ key: r.key, body: requestFor(r) })) };
  durableFile(resolve(prepared.outputDir, 'manifest.json'), manifest);
  const manifestDigest = digest(manifest);
  const journalFd = openSync(resolve(prepared.outputDir, 'journal.jsonl'), 'ax', 0o600);
  syncDirectory(prepared.outputDir);
  const journal = (event) => { writeAll(journalFd, `${JSON.stringify(event)}\n`); fsyncSync(journalFd); };
  const capture = { schemaVersion: 'assistant-routing-capture-v1', origin: 'recorded',
    planDigest: prepared.planDigest, manifestDigest, records: [] };
  let attempts = 0, reservedCostUsd = 0, measuredCostUpperBoundUsd = 0, settledReservationsUsd = 0;
  let status = 'completed', stopCode = null;
  try {
    const config = readCredentials(lease.credentialPath);
    // Validate injected readers as well; no caller can accidentally bypass tuple checks.
    if (config.model !== POLICY.model || config.reasoningEffort !== POLICY.reasoningEffort
      || config.maxOutputTokens !== '256' || config.vendor !== 'openai'
      || !['https://api.openai.com/v1', 'https://api.openai.com/v1/'].includes(config.endpoint)
      || config.enabled !== 'true' || typeof config.apiKey !== 'string' || !config.apiKey) fail('credential_tuple_mismatch');
    for (const request of prepared.plan.requests.filter((r) => r.requiresModel)) {
      if (now() >= deadline) fail('run_deadline');
      validateLease(lease, currentIdentity(), now());
      const bound = bounds.calls[attempts];
      if (attempts >= POLICY.maxCalls || bound.key !== request.key
        || reservedCostUsd + bound.reservedCostUsd > POLICY.maxBudgetUsd) fail('attempt_budget');
      const receipt = { requestId: null, completionId: null, httpStatus: null,
        configuredModel: POLICY.model, responseModel: null, serviceTier: null, usage: null, retryCount: 0 };
      // Never release this cumulative reservation to fund another attempt.
      attempts += 1; reservedCostUsd += bound.reservedCostUsd;
      journal({ event: 'reserved', attempt: attempts, key: request.key, at: new Date(now()).toISOString(),
        ...bound, cumulativeReservedCostUsd: reservedCostUsd, manifestDigest,
        promptDigest: request.promptDigest, inputDigest: request.inputDigest, requestDigest: digest(requestFor(request)) });
      try {
        const remaining = deadline - now();
        if (remaining <= 0) fail('run_deadline');
        const body = await callOnce(request, config.apiKey, Math.min(POLICY.requestTimeoutMs, remaining),
          { fetchFn, setTimer, clearTimer }, receipt);
        if (!object(body)) fail('response_schema');
        receipt.completionId = safeId(body.id);
        receipt.responseModel = safeId(body.model);
        receipt.serviceTier = ['default', 'auto', 'flex', 'scale', 'priority'].includes(body.service_tier) ? body.service_tier : null;
        const output = body.choices?.[0]?.message?.content;
        const record = { key: request.key, caseId: request.caseId, lane: request.lane,
          promptDigest: request.promptDigest, inputDigest: request.inputDigest,
          output: typeof output === 'string' ? output : null, receipt };
        // Preserve final output even if provider metadata/semantic schema fails.
        capture.records.push(record);
        let validationError;
        try {
          if (body.model !== POLICY.model) fail('response_model_mismatch');
          if (body.service_tier !== POLICY.serviceTier) fail('response_tier_mismatch');
          receipt.usage = usageOf(body, bound);
          measuredCostUpperBoundUsd += receipt.usage.costUpperBoundUsd; settledReservationsUsd += bound.reservedCostUsd;
          if (!receipt.completionId || !Array.isArray(body.choices) || body.choices.length !== 1
            || body.choices[0].index !== 0 || body.choices[0].finish_reason !== 'stop'
            || body.choices[0].message?.role !== 'assistant' || body.choices[0].message?.refusal
            || body.choices[0].message?.tool_calls || typeof output !== 'string') fail('response_schema');
          let parsed; try { parsed = JSON.parse(output); } catch { fail('output_schema'); }
          if (!object(parsed) || interpretRecorded(prepared.data.cases.find((c) => c.id === request.caseId),
            request.lane, parsed).status !== 'evaluated') fail('output_schema');
        } catch (error) { validationError = error; }
        record.validation = validationError ? safeCode(validationError) : 'passed';
        // Preserve the exact final response, but never credit untrusted model,
        // tier, usage or envelope metadata as an evaluated classification.
        if (validationError) { record.rawOutput = record.output; record.output = null; }
        journal({ event: 'recorded', attempt: attempts, ...record });
        if (validationError) throw validationError;
        if (now() >= deadline) fail('run_deadline');
        progress({ status: 'running', attempts, recorded: capture.records.length,
          reservedCostUsd, measuredCostUpperBoundUsd });
      } catch (error) {
        journal({ event: 'stopped', attempt: attempts, key: request.key, code: safeCode(error), receipt });
        throw error;
      }
    }
  } catch (error) { status = 'stopped'; stopCode = safeCode(error); }
  finally { closeSync(journalFd); }
  const summary = { status, stopCode, attempts, recorded: capture.records.length,
    missingModelMeasurements: POLICY.maxCalls - capture.records.length, deterministicExcluded: 8,
    reservedCostUsd, measuredCostUpperBoundUsd, uncertainCostUpperBoundUsd: reservedCostUsd - settledReservationsUsd,
    totalCostUpperBoundUsd: measuredCostUpperBoundUsd + reservedCostUsd - settledReservationsUsd,
    manifestDigest, planDigest: prepared.planDigest, endedAt: new Date(now()).toISOString() };
  durableFile(resolve(prepared.outputDir, 'capture.json'), capture);
  // Score with the same evaluator; unavailable calls remain not_run, never successes.
  try { durableFile(resolve(prepared.outputDir, 'comparison.json'), scoreRecorded(prepared.data, capture)); }
  catch { summary.scoringStatus = 'inconclusive'; }
  durableFile(resolve(prepared.outputDir, 'receipt.json'), summary);
  progress(summary);
  return { summary, capture };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) {
      const prepared = preflight();
      console.log(JSON.stringify({ status: 'prepared', network: 'not_run', credentials: 'not_read',
        writes: 'not_run', maxCalls: prepared.bounds.calls.length, maxCostUsd: prepared.bounds.maxCostUsd,
        leaseTemplate: leaseTemplate(prepared) }, null, 2));
    } else if (args.length === 2 && args[0] === '--lease') {
      const lease = JSON.parse(readFileSync(resolve(args[1]), 'utf8'));
      const result = await collect(lease);
      if (result.summary.status !== 'completed') process.exitCode = 2;
    } else fail('usage_no_args_or_lease_file');
  } catch (error) { console.error(`routing_collector:${safeCode(error)}`); process.exitCode = 2; }
}
