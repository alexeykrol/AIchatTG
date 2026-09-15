import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { boundPlan, collect, CREDENTIAL_PATH, leaseTemplate, parseCredentialConfig, POLICY,
  preflight, requestFor, validateLease } from '../scripts/routing-live-collector-v1.mjs';

const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clock = Date.parse('2026-09-15T12:00:00Z');
const configText = [
  'TELEGRAM_RUNTIME_PROVIDER_ENABLED=true', 'TELEGRAM_RUNTIME_PROVIDER_VENDOR=openai',
  'TELEGRAM_RUNTIME_PROVIDER_ENDPOINT=https://api.openai.com/v1',
  'TELEGRAM_RUNTIME_PROVIDER_API_KEY=fake-only-never-live',
  'TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MODEL=gpt-5.6-luna',
  'TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_REASONING_EFFORT=low',
  'TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MAX_OUTPUT_TOKENS=256',
].join('\n');
const verdict = (topics = ['out_of_corpus']) => ({ topics, topics_evidence: '', context_dependent: false,
  level: { hypothesis: 'none', confidence: 'high', evidence: '' },
  intent: { kind: 'explicit', confidence: 'high', evidence: '' }, risk_flags: [] });
const outputFor = (request) => request.lane.endsWith(':dispatch') ? verdict()
  : request.lane.startsWith('baseline:') ? { action: 'redirect', sourceId: null } : { domains: [] };

function fixture(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'routing-collector-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prepared = preflight({ root, candidateGitHEAD: 'a'.repeat(40) });
  const lease = { ...leaseTemplate(prepared), approved: true,
    issuedAt: new Date(clock - 1000).toISOString(), expiresAt: new Date(clock + POLICY.runTimeoutMs).toISOString() };
  let credentialReads = 0, fetches = 0;
  const modelRequests = prepared.plan.requests.filter((r) => r.requiresModel);
  const options = { prepared, currentIdentity: () => prepared, now: () => clock, progress() {},
    readCredentials(path) {
      credentialReads += 1; assert.equal(path, CREDENTIAL_PATH); return parseCredentialConfig(configText);
    },
    async fetchFn(url, init) {
      const request = modelRequests[fetches++];
      assert.equal(url, POLICY.endpoint);
      assert.equal(init.redirect, 'error');
      assert.deepEqual(JSON.parse(init.body), requestFor(request));
      const journal = readFileSync(resolve(prepared.outputDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(journal.at(-1).event, 'reserved', 'fsynced reservation must exist before every fake network request');
      assert.equal(journal.at(-1).attempt, fetches);
      return response(request);
    } };
  return { root, prepared, lease, options, modelRequests,
    counts: () => ({ credentialReads, fetches }) };
}
function response(request, override = {}) {
  const envelope = { id: 'chatcmpl_fake', model: POLICY.model, service_tier: 'default',
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      completion_tokens_details: { reasoning_tokens: 10 } },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
      content: JSON.stringify(outputFor(request)), reasoning_content: 'MUST_NOT_PERSIST' } }], ...override };
  return { status: 200, ok: true, headers: { get: () => 'req_fake' }, async text() { return JSON.stringify(envelope); } };
}
const file = (f, name) => JSON.parse(readFileSync(resolve(f.prepared.outputDir, name), 'utf8'));

test('default preflight is read-only and freezes exact bytes, tuple, fingerprints and conservative whole-run cost', (t) => {
  const f = fixture(t);
  assert.equal(f.prepared.bounds.calls.length, 104);
  assert.equal(f.prepared.bounds.deterministicExcluded, 8);
  assert.ok(Math.abs(f.prepared.bounds.maxCostUsd - 0.5045423) < 1e-12);
  assert.equal(leaseTemplate(f.prepared).approved, false);
  assert.deepEqual(f.counts(), { credentialReads: 0, fetches: 0 });
  assert.deepEqual(readdirSync(f.root), []);
  for (const request of f.modelRequests) {
    const body = requestFor(request);
    assert.deepEqual(Object.keys(body).sort(), ['model', 'messages', 'reasoning_effort', 'max_completion_tokens',
      'response_format', 'service_tier', 'store', 'n'].sort());
    assert.equal(body.max_completion_tokens, request.lane.endsWith(':router') ? 256 : 1536);
    assert.equal(body.n, 1); assert.equal(body.store, false); assert.equal(body.service_tier, 'default');
    assert.equal(hash(body.messages[0].content), request.promptDigest);
    assert.equal(hash(body.messages[1].content), request.inputDigest);
  }
});

test('leases reject expiry, future issue, overlong duration, source/plan/collector/path drift and policy expansion before any read/write/request', async (t) => {
  const f = fixture(t);
  for (const patch of [
    { approved: false }, { candidateGitHEAD: 'b'.repeat(40) }, { planDigest: '0'.repeat(64) },
    { collectorSHA256: '0'.repeat(64) }, { credentialPath: '/tmp/other-project-key' },
    { outputDir: `${f.prepared.outputDir}-reset` }, { maxCalls: 105 }, { maxBudgetUsd: 21 },
    { model: 'another-model' }, { serviceTier: 'auto' }, { n: 2 }, { store: true },
    { expiresAt: new Date(clock).toISOString() }, { issuedAt: new Date(clock + 1).toISOString() },
    { expiresAt: new Date(clock + POLICY.maxLeaseMs + 1).toISOString() }, { extra: true },
  ]) await assert.rejects(collect({ ...f.lease, ...patch }, f.options), /lease_/);
  await assert.rejects(collect(f.lease, { ...f.options,
    currentIdentity: () => ({ ...f.prepared, collectorSHA256: '1'.repeat(64) }) }), /lease_identity/);
  assert.deepEqual(f.counts(), { credentialReads: 0, fetches: 0 });
  assert.deepEqual(readdirSync(f.root), []);
});

test('config is an allowlist, rejects shell expressions/duplicates/foreign tuple and does not inspect unrelated assignments', () => {
  assert.equal(parseCredentialConfig(`${configText}\nUNRELATED_SECRET=$(never-executed)` ).model, POLICY.model);
  assert.equal(parseCredentialConfig(configText.replace('=low', '="low" # valid')).reasoningEffort, 'low');
  for (const text of [configText.replace('=low', '=$(printf low)'),
    configText.replace('=low', '=high'), configText.replace('=256', '=512'),
    configText.replace('api.openai.com', 'other.invalid'),
    `${configText}\nTELEGRAM_RUNTIME_PROVIDER_API_KEY=duplicate`,
    configText.replace('fake-only-never-live', 'fake;command'),
  ]) assert.throws(() => parseCredentialConfig(text), /credential_/);
});

test('auth error reserves exactly one attempt, never reads error body, never retries and retains missing measurements', async (t) => {
  const f = fixture(t); let calls = 0;
  const result = await collect(f.lease, { ...f.options, fetchFn: async () => {
    calls += 1;
    assert.equal(file(f, 'manifest.json').planDigest, f.prepared.planDigest);
    assert.match(readFileSync(resolve(f.prepared.outputDir, 'journal.jsonl'), 'utf8'), /"event":"reserved"/);
    return { status: 401, ok: false, headers: { get: () => 'req_auth' }, text() { throw new Error('SECRET_ERROR_BODY'); } };
  } });
  assert.equal(calls, 1); assert.equal(result.summary.stopCode, 'auth_failure');
  assert.equal(result.summary.attempts, 1); assert.equal(result.capture.records.length, 0);
  assert.equal(result.summary.uncertainCostUpperBoundUsd, f.prepared.bounds.calls[0].reservedCostUsd);
  assert.equal(file(f, 'comparison.json').rows.filter((r) => r.status === 'not_run').length, 104);
  assert.ok(!readFileSync(resolve(f.prepared.outputDir, 'journal.jsonl'), 'utf8').includes('SECRET_ERROR_BODY'));
  await assert.rejects(collect(f.lease, f.options), /run_already_exists_no_resume/);
  assert.equal(f.counts().credentialReads, 1, 'repeat rejection occurs before another credential read');
});

test('transport failure and other HTTP errors are terminal, with full uncertain reservation', async (t) => {
  for (const mode of ['throw', 'redirect', 'rate-limit']) {
    const f = fixture(t); let calls = 0;
    const result = await collect(f.lease, { ...f.options, fetchFn: async () => {
      calls += 1;
      if (mode === 'throw') throw new Error('secret transport details');
      return { status: mode === 'redirect' ? 302 : 429, ok: false, headers: { get: () => null } };
    } });
    assert.equal(calls, 1);
    assert.equal(result.summary.stopCode, mode === 'throw' ? 'transport_failure' : 'http_failure');
    assert.equal(result.summary.totalCostUpperBoundUsd, f.prepared.bounds.calls[0].reservedCostUsd);
  }
});

test('deadline covers fetch and body even if fake transport ignores abort, with no retry', async (t) => {
  for (const hang of ['fetch', 'body']) {
    const f = fixture(t); let calls = 0;
    const result = await collect(f.lease, { ...f.options,
      setTimer(callback, ms) { assert.equal(ms, 45_000); return setTimeout(callback, 2); },
      fetchFn: async () => {
        calls += 1;
        if (hang === 'fetch') return new Promise(() => {});
        return { status: 200, ok: true, headers: { get: () => null }, text: () => new Promise(() => {}) };
      } });
    assert.equal(calls, 1); assert.equal(result.summary.stopCode, 'request_timeout');
    assert.equal(result.summary.attempts, 1); assert.equal(result.summary.recorded, 0);
  }
});

test('invalid final classification is preserved, scored invalid and stops immediately', async (t) => {
  const f = fixture(t); let calls = 0;
  const invalid = '{"domains":["invented"]}';
  const result = await collect(f.lease, { ...f.options, fetchFn: async () => {
    calls += 1;
    return response(f.modelRequests[0], { choices: [{ index: 0, finish_reason: 'stop',
      message: { role: 'assistant', content: invalid } }] });
  } });
  assert.equal(calls, 1); assert.equal(result.summary.stopCode, 'output_schema');
  assert.equal(result.capture.records[0].rawOutput, invalid);
  assert.equal(result.capture.records[0].output, null);
  assert.equal(file(f, 'capture.json').records[0].validation, 'output_schema');
  assert.equal(file(f, 'comparison.json').rows.filter((r) => r.status === 'invalid').length, 1);
});

test('mixed out_of_corpus candidate dispatch remains captured invalid, while pure out_of_corpus is valid', async (t) => {
  const f = fixture(t); let calls = 0;
  const target = f.modelRequests.findIndex((r) => r.lane === 'candidate:dispatch');
  const result = await collect(f.lease, { ...f.options, fetchFn: async () => {
    const request = f.modelRequests[calls++];
    return response(request, calls - 1 === target ? { choices: [{ index: 0, finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify(verdict(['out_of_corpus', 'content'])) } }] } : {});
  } });
  assert.equal(calls, target + 1); assert.equal(result.summary.stopCode, 'output_schema');
  assert.deepEqual(JSON.parse(result.capture.records.at(-1).rawOutput).topics, ['out_of_corpus', 'content']);
});

test('unknown usage, token overruns, wrong model/tier, truncation and malformed envelopes stop without retries', async (t) => {
  for (const [patch, expected] of [
    [{ usage: null }, 'unknown_usage'],
    [{ usage: { prompt_tokens: 100, completion_tokens: 257, total_tokens: 357 } }, 'usage_bound'],
    [{ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 999 } }, 'unknown_usage'],
    [{ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      completion_tokens_details: { reasoning_tokens: 21 } } }, 'unknown_usage'],
    [{ model: 'gpt-unapproved' }, 'response_model_mismatch'],
    [{ service_tier: 'priority' }, 'response_tier_mismatch'],
    [{ service_tier: undefined }, 'response_tier_mismatch'],
    [{ choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '{}' } }] }, 'response_schema'],
    [{ choices: [] }, 'response_schema'],
  ]) {
    const f = fixture(t); let calls = 0;
    const result = await collect(f.lease, { ...f.options, fetchFn: async () => {
      calls += 1; return response(f.modelRequests[0], patch);
    } });
    assert.equal(calls, 1); assert.equal(result.summary.stopCode, expected);
    assert.equal(result.capture.records[0].output, null);
    assert.equal(file(f, 'comparison.json').rows.filter((r) => r.status === 'invalid').length, 1);
  }
});

test('conservative per-input, whole-run, call-count and fingerprint bounds are mandatory before network', (t) => {
  const f = fixture(t);
  const clone = () => structuredClone(f.prepared.plan);
  const oversized = clone();
  oversized.requests[0].system = 'a'.repeat(272_000);
  oversized.requests[0].promptDigest = hash(oversized.requests[0].system);
  // Choose a requiresModel request rather than a deterministic exclusion.
  const modelIndex = oversized.requests.findIndex((r) => r.requiresModel);
  oversized.requests[modelIndex].system = 'a'.repeat(272_000);
  oversized.requests[modelIndex].promptDigest = hash(oversized.requests[modelIndex].system);
  assert.throws(() => boundPlan(oversized), /input_bound/);
  const budget = clone();
  for (const r of budget.requests.filter((r) => r.requiresModel)) {
    r.system = 'a'.repeat(250_000); r.promptDigest = hash(r.system);
  }
  assert.ok(boundPlan(budget).maxCostUsd <= POLICY.maxBudgetUsd,
    'even104 near-input-limit calls fit the separately approved20USD ceiling');
  const mismatch = clone(); mismatch.requests[modelIndex].inputText += ' ';
  assert.throws(() => boundPlan(mismatch), /request_fingerprint/);
  const extra = clone(); extra.maxModelCalls += 1;
  assert.throws(() => boundPlan(extra), /plan_call_count/);
});

test('source drift and whole-run deadline between calls stop, preserving earlier records', async (t) => {
  for (const mode of ['source', 'deadline']) {
    const f = fixture(t); let calls = 0;
    const result = await collect(f.lease, { ...f.options,
      currentIdentity: () => calls && mode === 'source' ? { ...f.prepared, planDigest: '0'.repeat(64) } : f.prepared,
      now: () => clock + (calls && mode === 'deadline' ? POLICY.runTimeoutMs : 0),
      fetchFn: async () => response(f.modelRequests[calls++]) });
    assert.equal(calls, 1); assert.equal(result.summary.recorded, 1);
    assert.equal(result.summary.stopCode, mode === 'source' ? 'lease_identity_or_policy' : 'run_deadline');
  }
});

test('full fake success makes exactly104 sequential requests, persists immutable fingerprints and counts reasoning once', async (t) => {
  const f = fixture(t);
  const result = await collect(f.lease, f.options);
  assert.deepEqual(f.counts(), { credentialReads: 1, fetches: 104 });
  assert.equal(result.summary.status, 'completed'); assert.equal(result.summary.attempts, 104);
  assert.equal(result.summary.missingModelMeasurements, 0);
  assert.equal(result.summary.uncertainCostUpperBoundUsd, 0);
  assert.ok(Math.abs(result.summary.measuredCostUpperBoundUsd - 104 * (100 * 0.25 + 20 * 1.2) / 1_000_000) < 1e-12);
  assert.equal(file(f, 'comparison.json').rows.filter((r) => r.status === 'not_run').length, 0);
  const manifest = file(f, 'manifest.json');
  assert.equal(hash(manifest), result.summary.manifestDigest);
  assert.equal(manifest.leaseDigest, hash(f.lease));
  assert.deepEqual(manifest.plan, f.prepared.plan);
  assert.equal(manifest.requests.length, 104);
  const journal = readFileSync(resolve(f.prepared.outputDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(journal.filter((r) => r.event === 'reserved').length, 104);
  assert.equal(journal.filter((r) => r.event === 'recorded').length, 104);
  assert.equal(journal.at(-1).receipt.responseModel, POLICY.model);
  for (const name of readdirSync(f.prepared.outputDir)) {
    assert.equal(statSync(resolve(f.prepared.outputDir, name)).mode & 0o777, 0o600);
    const content = readFileSync(resolve(f.prepared.outputDir, name), 'utf8');
    assert.ok(!content.includes('fake-only-never-live'));
    assert.ok(!content.includes('MUST_NOT_PERSIST'));
    assert.ok(!content.includes('reasoning_content'));
  }
  assert.equal(statSync(f.prepared.outputDir).mode & 0o777, 0o700);
  await assert.rejects(collect(f.lease, f.options), /run_already_exists_no_resume/);
  assert.equal(file(f, 'receipt.json').manifestDigest, result.summary.manifestDigest);
  assert.ok(existsSync(resolve(f.prepared.outputDir, 'capture.json')));
});
