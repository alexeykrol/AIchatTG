#!/usr/bin/env node
/** One separately leased continuation of NEVER reserved keys. No retries. */
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preflight, requestFor, parseCredentialConfig, POLICY, CREDENTIAL_PATH } from './routing-live-collector-v1.mjs';
import { interpretRecorded, scoreRecorded } from './routing-only-eval.mjs';
const SELF = fileURLToPath(import.meta.url), ROOT = resolve(dirname(SELF), '../../..');
const PARENT = resolve(ROOT, '.handoffs/local/routing-live-collector-v1');
const DEADLINE = '2026-09-15T09:11:38.999Z';
const PARENT_HASHES = Object.freeze({
  'manifest.json': 'ea84705079d09b88133ecfcd6da9a28293d0fb654202ed7e59a6161191d9aa45',
  'journal.jsonl': 'd21ce362f25bfe6b91edc4a86e6af596b5e227efc29a33588b282f2f5e1406b4',
  'capture.json': '8b9e3e31620e46e727155c025d6cab22a3426d9864273063e07b7525b317c918',
  'receipt.json': '118e228387cbcde52743ef7801cc0be8cc8353286243b3ecca76aa4c2e0354e5',
  'comparison.json': 'acdcd2e4010fcc07d4b3b16b6a40b5b63c08966130fd233fef76b948c6e5a89d',
  'cost-summary.json': '32e0b1bb2deabf7111650e442f3c5d4fdd8b82b89d08ce747e2de49fe4e98d57',
});
const hash = (v) => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
class Stop extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new Stop(code); };
const codeOf = (e) => e instanceof Stop ? e.code : 'local_or_source_failure';
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const safeId = (v) => typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,200}$/.test(v) ? v : null;

export function validateCarry(plan, journal, capture, receipt) {
  const model = plan.requests.filter((r) => r.requiresModel);
  const reserved = journal.filter((r) => r.event === 'reserved');
  const recorded = journal.filter((r) => r.event === 'recorded');
  if (model.length !== 104 || reserved.length !== 48 || recorded.length !== 47 || capture.records.length !== 47
    || receipt.status !== 'stopped' || receipt.stopCode !== 'transport_failure' || receipt.attempts !== 48
    || capture.planDigest !== plan.planDigest || receipt.planDigest !== plan.planDigest) fail('parent_counts_or_state');
  for (let i = 0; i < 48; i++) {
    if (reserved[i].attempt !== i + 1 || reserved[i].key !== model[i].key
      || reserved[i].promptDigest !== model[i].promptDigest || reserved[i].inputDigest !== model[i].inputDigest) fail('parent_reserved_prefix');
    if (i < 47 && (capture.records[i].key !== model[i].key || capture.records[i].validation !== 'passed'
      || recorded[i].key !== model[i].key || recorded[i].output !== capture.records[i].output)) fail('parent_recorded_prefix');
  }
  if (reserved[47].key !== 'blind-10:candidate:dispatch' || journal.at(-1).code !== 'transport_failure'
    || journal.at(-1).attempt !== 48) fail('parent_uncertain_identity');
  const reservedUsd = reserved.reduce((n, r) => n + r.reservedCostUsd, 0);
  const measuredUsd = capture.records.reduce((n, r) => n + r.receipt?.usage?.costUpperBoundUsd, 0);
  const uncertainUsd = reserved[47].reservedCostUsd;
  for (const [actual, expected] of [[receipt.reservedCostUsd, reservedUsd],
    [receipt.measuredCostUpperBoundUsd, measuredUsd], [receipt.uncertainCostUpperBoundUsd, uncertainUsd],
    [receipt.totalCostUpperBoundUsd, measuredUsd + uncertainUsd],
    [reserved[47].cumulativeReservedCostUsd, reservedUsd]]) {
    if (!Number.isFinite(actual) || !Number.isFinite(expected) || actual < 0 || Math.abs(actual - expected) > 1e-12) fail('parent_cost_carry');
  }
  const remainingKeys = model.slice(48).map((r) => r.key);
  if (new Set(model.map((r) => r.key)).size !== 104 || remainingKeys.length !== 56) fail('remaining_keys');
  return { remainingKeys, remainingKeysDigest: hash(remainingKeys), carryAttempts: 48 };
}

export function preflightContinuation({ now = Date.now() } = {}) {
  const original = preflight();
  if (original.collectorSHA256 !== '6ff77d67661904aa633c3d021d9955f5c35030214df403951a62112b67845905') fail('original_collector_changed');
  const files = {};
  for (const [name, expected] of Object.entries(PARENT_HASHES)) {
    const raw = readFileSync(resolve(PARENT, name));
    if (hash(raw) !== expected) fail('parent_file_changed');
    files[name] = raw.toString('utf8');
  }
  const parentManifest = JSON.parse(files['manifest.json']);
  const capture = JSON.parse(files['capture.json']), receipt = JSON.parse(files['receipt.json']);
  const journal = files['journal.jsonl'].trim().split('\n').map(JSON.parse);
  if (hash(parentManifest) !== '909d15b8f4e120842402cfd4cce61faa2464c3430627d8650dcf5047d957a9a8'
    || parentManifest.deadline !== DEADLINE || hash(parentManifest.plan) !== hash(original.plan)
    || now >= Date.parse(DEADLINE)) fail('parent_plan_or_deadline');
  const carry = validateCarry(original.plan, journal, capture, receipt);
  const remainingBounds = original.bounds.calls.slice(48);
  const maxCombinedReservedUsd = receipt.reservedCostUsd + remainingBounds.reduce((n, r) => n + r.reservedCostUsd, 0);
  if (maxCombinedReservedUsd > 20) fail('combined_budget');
  return { ...original, collectorSHA256: hash(readFileSync(SELF)), originalDeadline: DEADLINE,
    parentHashes: PARENT_HASHES, parentManifestDigest: hash(parentManifest), ...carry,
    parentCapture: capture, parentReceipt: receipt, parentJournal: journal,
    remainingBounds, maxCombinedReservedUsd,
    outputDir: resolve(ROOT, '.handoffs/local/routing-live-continuation-v1') };
}

export function continuationLeaseTemplate(p) {
  return { schemaVersion: 'routing-continuation-lease-v1', approved: false,
    candidateGitHEAD: p.candidateGitHEAD, collectorSHA256: p.collectorSHA256, planDigest: p.planDigest,
    parentHashes: p.parentHashes, parentManifestDigest: p.parentManifestDigest,
    remainingKeysDigest: p.remainingKeysDigest, carryAttempts: 48, continuationMaxAttempts: 56,
    originalDeadline: DEADLINE, outputDir: p.outputDir, credentialPath: CREDENTIAL_PATH,
    issuedAt: null, expiresAt: DEADLINE, ...POLICY };
}
export function validateContinuationLease(lease, p, now = Date.now()) {
  const expected = continuationLeaseTemplate(p);
  if (!obj(lease) || Object.keys(lease).sort().join() !== Object.keys(expected).sort().join()) fail('lease_schema');
  for (const [k, v] of Object.entries(expected)) {
    if (!['approved', 'issuedAt', 'expiresAt'].includes(k) && hash(lease[k]) !== hash(v)) fail('lease_identity');
  }
  const issued = Date.parse(lease.issuedAt), expires = Date.parse(lease.expiresAt);
  if (lease.approved !== true || !Number.isFinite(issued) || !Number.isFinite(expires)
    || issued > now || expires <= now || expires <= issued || expires > Date.parse(DEADLINE)
    || now >= Date.parse(DEADLINE)) fail('lease_expired_or_unapproved');
}
function writeAll(fd, value) {
  const b = Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  let pos = 0; while (pos < b.length) pos += writeSync(fd, b, pos, b.length - pos);
  fsyncSync(fd);
}
function save(path, value) { const fd = openSync(path, 'wx', 0o600); try { writeAll(fd, value); } finally { closeSync(fd); } }
function syncDir(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function usageOf(body, bound) {
  const u = body.usage;
  if (!obj(u) || !integer(u.prompt_tokens) || !integer(u.completion_tokens) || !integer(u.total_tokens)
    || u.total_tokens !== u.prompt_tokens + u.completion_tokens) fail('unknown_usage');
  if (u.prompt_tokens > bound.inputTokensUpperBound || u.completion_tokens > bound.outputTokensUpperBound) fail('usage_bound');
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined && (!integer(reasoning) || reasoning > u.completion_tokens)) fail('unknown_usage');
  const inputDetails = {};
  for (const k of ['cached_tokens', 'cache_write_tokens']) if (u.prompt_tokens_details?.[k] !== undefined) {
    const n = u.prompt_tokens_details[k]; if (!integer(n) || n > u.prompt_tokens) fail('unknown_usage'); inputDetails[k] = n;
  }
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, totalTokens: u.total_tokens, inputDetails,
    costUpperBoundUsd: (u.prompt_tokens * .25 + u.completion_tokens * 1.2) / 1e6 };
}
async function bodyOf(response) {
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), parts = []; let size = 0;
    try { while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 262144) { void reader.cancel(); fail('response_size'); }
      parts.push(Buffer.from(value));
    } } finally { reader.releaseLock(); }
    text = Buffer.concat(parts).toString('utf8');
  } else text = await response.text();
  if (typeof text !== 'string' || Buffer.byteLength(text) > 262144) fail('response_size');
  try { return JSON.parse(text); } catch { fail('response_schema'); }
}
async function oneRequest(request, key, ms, fetchFn, receipt, setTimer, clearTimer) {
  const abort = new AbortController(); let timer;
  const timeout = new Promise((_, reject) => { timer = setTimer(() => {
    abort.abort(); reject(new Stop('request_timeout')); }, ms); });
  try { return await Promise.race([timeout, (async () => {
    let r; try { r = await fetchFn(POLICY.endpoint, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(requestFor(request)), signal: abort.signal }); } catch { fail('transport_failure'); }
    receipt.httpStatus = Number.isInteger(r?.status) ? r.status : null;
    receipt.requestId = safeId(r?.headers?.get?.('x-request-id'));
    if ([401, 403].includes(r?.status)) fail('auth_failure');
    if (r?.status !== 200 || r?.ok !== true) fail('http_failure');
    return bodyOf(r);
  })()]); } finally { clearTimer(timer); abort.abort(); }
}

export async function runContinuation(lease, { prepared = preflightContinuation(),
  currentPrepared = () => preflightContinuation(), now = Date.now, fetchFn = globalThis.fetch,
  setTimer = setTimeout, clearTimer = clearTimeout,
  readConfig = () => { if (realpathSync(CREDENTIAL_PATH) !== CREDENTIAL_PATH) fail('credential_route');
    return parseCredentialConfig(readFileSync(CREDENTIAL_PATH, 'utf8')); },
  progress = (r) => console.log(JSON.stringify(r)),
} = {}) {
  validateContinuationLease(lease, prepared, now()); validateContinuationLease(lease, currentPrepared(), now());
  if (realpathSync(dirname(prepared.outputDir)) !== dirname(prepared.outputDir)) fail('output_route');
  try { mkdirSync(prepared.outputDir, { mode: 0o700 }); } catch { fail('continuation_exists_or_io'); }
  syncDir(dirname(prepared.outputDir));
  const manifest = { schemaVersion: 'routing-continuation-manifest-v1', lease, leaseDigest: hash(lease),
    planDigest: prepared.planDigest, plan: prepared.plan, parentHashes: prepared.parentHashes,
    parentManifestDigest: prepared.parentManifestDigest, remainingKeys: prepared.remainingKeys,
    remainingKeysDigest: prepared.remainingKeysDigest, candidateGitHEAD: prepared.candidateGitHEAD,
    collectorSHA256: prepared.collectorSHA256, startedAt: new Date(now()).toISOString(), deadline: DEADLINE,
    carry: prepared.parentReceipt };
  save(resolve(prepared.outputDir, 'manifest.json'), manifest);
  const manifestDigest = hash(manifest);
  const fd = openSync(resolve(prepared.outputDir, 'journal.jsonl'), 'ax', 0o600);
  for (const event of prepared.parentJournal) writeAll(fd, event);
  writeAll(fd, { event: 'continuation_started', manifestDigest, carriedAttempts: 48 }); syncDir(prepared.outputDir);
  const capture = { schemaVersion: 'assistant-routing-capture-v1', origin: 'recorded',
    planDigest: prepared.planDigest, manifestDigest, records: structuredClone(prepared.parentCapture.records) };
  let attempts = 48, reserved = prepared.parentReceipt.reservedCostUsd;
  let measured = prepared.parentReceipt.measuredCostUpperBoundUsd;
  let uncertain = prepared.parentReceipt.uncertainCostUpperBoundUsd;
  let status = 'completed', stopCode = null;
  const deadline = Math.min(Date.parse(DEADLINE), Date.parse(lease.expiresAt));
  try {
    const config = readConfig();
    if (config.model !== POLICY.model || config.reasoningEffort !== 'low' || config.maxOutputTokens !== '256'
      || config.vendor !== 'openai' || config.enabled !== 'true' || typeof config.apiKey !== 'string' || !config.apiKey
      || !['https://api.openai.com/v1', 'https://api.openai.com/v1/'].includes(config.endpoint)) fail('credential_tuple_mismatch');
    for (const [index, key] of prepared.remainingKeys.entries()) {
      validateContinuationLease(lease, currentPrepared(), now());
      const request = prepared.plan.requests.find((r) => r.key === key), bound = prepared.remainingBounds[index];
      if (now() >= deadline || attempts >= 104 || !request || bound.key !== key
        || reserved + bound.reservedCostUsd > 20) fail('deadline_or_budget');
      attempts++; reserved += bound.reservedCostUsd; uncertain += bound.reservedCostUsd;
      writeAll(fd, { event: 'reserved', attempt: attempts, key, at: new Date(now()).toISOString(), ...bound,
        cumulativeReservedCostUsd: reserved, manifestDigest, promptDigest: request.promptDigest,
        inputDigest: request.inputDigest, requestDigest: hash(requestFor(request)) });
      const receipt = { httpStatus: null, requestId: null, completionId: null, configuredModel: POLICY.model,
        responseModel: null, serviceTier: null, usage: null, retryCount: 0 };
      try {
        const remainingMs = deadline - now(); if (remainingMs <= 0) fail('run_deadline');
        const body = await oneRequest(request, config.apiKey, Math.min(45000, remainingMs), fetchFn, receipt, setTimer, clearTimer);
        if (!obj(body)) fail('response_schema');
        receipt.completionId = safeId(body.id); receipt.responseModel = safeId(body.model);
        receipt.serviceTier = ['default', 'auto', 'flex', 'priority'].includes(body.service_tier) ? body.service_tier : null;
        const raw = body.choices?.[0]?.message?.content;
        const record = { key, caseId: request.caseId, lane: request.lane, promptDigest: request.promptDigest,
          inputDigest: request.inputDigest, output: typeof raw === 'string' ? raw : null, receipt };
        capture.records.push(record); let invalid = null;
        try {
          if (body.model !== POLICY.model || body.service_tier !== 'default') fail('model_or_tier_mismatch');
          receipt.usage = usageOf(body, bound); measured += receipt.usage.costUpperBoundUsd; uncertain -= bound.reservedCostUsd;
          if (!receipt.completionId || !Array.isArray(body.choices) || body.choices.length !== 1 || body.choices[0].index !== 0
            || body.choices[0].finish_reason !== 'stop' || body.choices[0].message?.role !== 'assistant'
            || body.choices[0].message?.refusal || body.choices[0].message?.tool_calls || typeof raw !== 'string') fail('response_schema');
          let parsed; try { parsed = JSON.parse(raw); } catch { fail('output_schema'); }
          if (!obj(parsed) || interpretRecorded(prepared.data.cases.find((c) => c.id === request.caseId), request.lane, parsed).status !== 'evaluated') fail('output_schema');
        } catch (e) { invalid = e; }
        record.validation = invalid ? codeOf(invalid) : 'passed';
        if (invalid) { record.rawOutput = record.output; record.output = null; }
        writeAll(fd, { event: 'recorded', attempt: attempts, ...record }); if (invalid) throw invalid;
        if (now() >= deadline) fail('run_deadline');
        progress({ status: 'running', cumulativeAttempts: attempts, cumulativeRecorded: capture.records.length,
          costUpperBoundUsd: measured + uncertain });
      } catch (e) { writeAll(fd, { event: 'stopped', attempt: attempts, key, code: codeOf(e), receipt }); throw e; }
    }
  } catch (e) { status = 'stopped'; stopCode = codeOf(e); }
  finally { closeSync(fd); }
  const summary = { status, stopCode, attempts, continuationAttempts: attempts - 48, recorded: capture.records.length,
    missingModelMeasurements: 104 - capture.records.length, deterministicExcluded: 8,
    reservedCostUsd: reserved, measuredCostUpperBoundUsd: measured, uncertainCostUpperBoundUsd: uncertain,
    totalCostUpperBoundUsd: measured + uncertain, manifestDigest, planDigest: prepared.planDigest,
    endedAt: new Date(now()).toISOString(), originalDeadline: DEADLINE };
  save(resolve(prepared.outputDir, 'capture.json'), capture);
  save(resolve(prepared.outputDir, 'comparison.json'), scoreRecorded(prepared.data, capture));
  save(resolve(prepared.outputDir, 'receipt.json'), summary); syncDir(prepared.outputDir);
  progress(summary); return { summary, capture };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (!args.length) { const p = preflightContinuation(); console.log(JSON.stringify({ status: 'prepared', network: 'not_run',
      remainingKeys: p.remainingKeys, maxCombinedReservedUsd: p.maxCombinedReservedUsd, leaseTemplate: continuationLeaseTemplate(p) }, null, 2)); }
    else if (args.length === 2 && args[0] === '--lease') { const r = await runContinuation(JSON.parse(readFileSync(args[1], 'utf8')));
      if (r.summary.status !== 'completed') process.exitCode = 2; }
    else fail('usage');
  } catch (e) { console.error(`routing_continuation:${codeOf(e)}`); process.exitCode = 2; }
}
