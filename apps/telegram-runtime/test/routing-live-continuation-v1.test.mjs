import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { preflightContinuation, validateCarry, validateContinuationLease,
  continuationLeaseTemplate, runContinuation } from '../scripts/routing-live-continuation-v1.mjs';
import { parseCredentialConfig, POLICY } from '../scripts/routing-live-collector-v1.mjs';

const parentDir = new URL('../../../.handoffs/local/routing-live-collector-v1/', import.meta.url);
// These are artifact-bound admission tests for this one immutable experiment.
// A clean checkout has no ignored local captures and must not manufacture them.
const parentAvailable = existsSync(new URL('receipt.json', parentDir));
const admissionTest = (name, fn) => test(name, { skip: !parentAvailable && 'immutable local parent artifacts unavailable' }, fn);
const load = (name) => JSON.parse(readFileSync(new URL(name, parentDir), 'utf8'));
const manifest = parentAvailable ? load('manifest.json') : null;
const capture = parentAvailable ? load('capture.json') : null;
const receipt = parentAvailable ? load('receipt.json') : null;
const journal = parentAvailable ? readFileSync(new URL('journal.jsonl', parentDir), 'utf8').trim().split('\n').map(JSON.parse) : null;
const now = Date.parse('2026-09-15T08:59:00.000Z');
const remaining = manifest?.plan.requests.filter((r) => r.requiresModel).slice(48);
const snapshotParent = () => Object.fromEntries(readdirSync(parentDir).map((name) => [name,
  readFileSync(new URL(name, parentDir), 'utf8')]));
const clone = (value) => structuredClone(value);

admissionTest('carry admits exactly56 never-attempted keys and excludes all48 reservations, including uncertain48', () => {
  const carried = validateCarry(manifest.plan, journal, capture, receipt);
  assert.deepEqual(carried.remainingKeys, remaining.map((r) => r.key));
  assert.equal(carried.remainingKeys.length, 56);
  const reserved = new Set(journal.filter((r) => r.event === 'reserved').map((r) => r.key));
  assert.equal(reserved.size, 48);
  assert.ok(carried.remainingKeys.every((key) => !reserved.has(key)));
  assert.ok(!carried.remainingKeys.includes('blind-10:candidate:dispatch'));
});

admissionTest('carry rejects duplicate/gapped reservations, receipt count reset and invented uncertain response', () => {
  const duplicate = clone(journal); duplicate.splice(2, 0, clone(journal[0]));
  assert.throws(() => validateCarry(manifest.plan, duplicate, capture, receipt));
  const gap = clone(journal); gap.find((r) => r.event === 'reserved' && r.attempt === 2).attempt = 3;
  assert.throws(() => validateCarry(manifest.plan, gap, capture, receipt));
  assert.throws(() => validateCarry(manifest.plan, journal, capture, { ...receipt, attempts: 47 }));
  assert.throws(() => validateCarry(manifest.plan, journal, capture, { ...receipt, reservedCostUsd: 0 }));
  const invented = clone(capture);
  invented.records.push({ ...clone(capture.records[0]), key: 'blind-10:candidate:dispatch' });
  assert.throws(() => validateCarry(manifest.plan, journal, invented, receipt));
  const noFailure = journal.filter((r) => r.event !== 'stopped');
  assert.throws(() => validateCarry(manifest.plan, noFailure, capture, receipt));
});

admissionTest('continuation preflight only reads immutable parent artifacts and preserves original deadline', () => {
  const before = snapshotParent();
  const prepared = preflightContinuation({ now });
  const lease = continuationLeaseTemplate(prepared);
  assert.equal(lease.approved, false);
  assert.equal(lease.originalDeadline, manifest.deadline);
  assert.equal(lease.expiresAt, manifest.deadline);
  assert.deepEqual(snapshotParent(), before);
});

admissionTest('continuation lease rejects stale source, extended original deadline and altered carry authority', () => {
  const prepared = preflightContinuation({ now });
  const lease = { ...continuationLeaseTemplate(prepared), approved: true,
    issuedAt: new Date(now).toISOString(), expiresAt: manifest.deadline };
  assert.doesNotThrow(() => validateContinuationLease(lease, prepared, now));
  for (const patch of [
    { approved: false }, { candidateGitHEAD: '0'.repeat(40) }, { planDigest: '0'.repeat(64) },
    { expiresAt: new Date(Date.parse(manifest.deadline) + 1).toISOString() },
    { expiresAt: new Date(now - 1).toISOString() }, { maxCalls: 105 }, { maxBudgetUsd: 21 },
    { outputDir: `${lease.outputDir}-reset` }, { additionalRun: true },
  ]) assert.throws(() => validateContinuationLease({ ...lease, ...patch }, prepared, now));
  assert.throws(() => validateContinuationLease(lease, prepared, Date.parse(manifest.deadline)));
});

admissionTest('fake continuation calls only remaining keys, stops after one HTTP failure and cannot restart', async (t) => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'routing-continuation-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = preflightContinuation({ now });
  const prepared = { ...base, outputDir: resolve(root, 'continuation') };
  const lease = { ...continuationLeaseTemplate(prepared), approved: true,
    issuedAt: new Date(now).toISOString(), expiresAt: manifest.deadline };
  const config = parseCredentialConfig([
    'TELEGRAM_RUNTIME_PROVIDER_ENABLED=true', 'TELEGRAM_RUNTIME_PROVIDER_VENDOR=openai',
    'TELEGRAM_RUNTIME_PROVIDER_ENDPOINT=https://api.openai.com/v1',
    'TELEGRAM_RUNTIME_PROVIDER_API_KEY=fake-only-never-live',
    'TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MODEL=gpt-5.6-luna',
    'TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_REASONING_EFFORT=low',
    'TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MAX_OUTPUT_TOKENS=256',
  ].join('\n'));
  const parentBefore = snapshotParent();
  let calls = 0;
  const options = { prepared, now: () => now, currentPrepared: () => prepared,
    readConfig: () => config, progress() {}, async fetchFn(url, init) {
      assert.equal(url, POLICY.endpoint);
      const body = JSON.parse(init.body);
      const expected = remaining[calls++];
      const durable = readFileSync(resolve(prepared.outputDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(durable.at(-1).event, 'reserved');
      assert.equal(durable.at(-1).attempt, 48 + calls, 'carried count cannot reset before network');
      assert.equal(body.messages[0].content, expected.system);
      assert.equal(body.messages[1].content, expected.inputText);
      assert.equal(body.max_completion_tokens, expected.lane.endsWith(':router') ? 256 : 1536);
      if (calls === 2) return { ok: false, status: 429, headers: { get: () => null },
        text() { throw new Error('must not read raw HTTP error'); } };
      const content = JSON.stringify({ action: 'redirect', sourceId: null });
      return { ok: true, status: 200, headers: { get: () => 'req_fake' }, async text() {
        return JSON.stringify({ id: 'chatcmpl_fake', model: POLICY.model, service_tier: 'default',
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
      } };
    } };
  const result = await runContinuation(lease, options);
  assert.equal(calls, 2);
  assert.equal(result.summary.attempts, 50);
  assert.equal(result.summary.continuationAttempts, 2);
  assert.ok(result.summary.reservedCostUsd > receipt.reservedCostUsd);
  assert.ok(result.summary.uncertainCostUpperBoundUsd > receipt.uncertainCostUpperBoundUsd,
    'parent uncertain48 and new HTTP failure both retain reservations');
  const outputJournal = readFileSync(resolve(prepared.outputDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(outputJournal.slice(0, journal.length), journal);
  const reservations = outputJournal.filter((r) => r.event === 'reserved' && r.attempt > 48);
  assert.deepEqual(reservations.map((r) => r.key), remaining.slice(0, 2).map((r) => r.key));
  assert.deepEqual(reservations.map((r) => r.attempt), [49, 50]);
  const merged = JSON.parse(readFileSync(resolve(prepared.outputDir, 'capture.json'), 'utf8'));
  assert.equal(merged.records.length, 48);
  assert.deepEqual(merged.records.slice(0, 47), capture.records);
  assert.ok(!merged.records.some((r) => r.key === 'blind-10:candidate:dispatch'));
  assert.deepEqual(snapshotParent(), parentBefore);
  await assert.rejects(runContinuation(lease, options));
  assert.equal(calls, 2);
});

admissionTest('continuation body deadline and invalid model metadata stop without retry or credited classification', async (t) => {
  for (const mode of ['body-timeout', 'wrong-model']) {
    const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'routing-continuation-deadline-test-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const prepared = { ...preflightContinuation({ now }), outputDir: resolve(root, 'continuation') };
    const lease = { ...continuationLeaseTemplate(prepared), approved: true,
      issuedAt: new Date(now).toISOString(), expiresAt: manifest.deadline };
    let calls = 0;
    const result = await runContinuation(lease, { prepared, now: () => now, currentPrepared: () => prepared,
      progress() {}, readConfig: () => ({ enabled: 'true', vendor: 'openai', endpoint: 'https://api.openai.com/v1',
        model: POLICY.model, reasoningEffort: 'low', maxOutputTokens: '256', apiKey: 'fake-only-never-live' }),
      setTimer(callback, ms) { assert.equal(ms, 45_000); return setTimeout(callback, mode === 'body-timeout' ? 2 : ms); },
      async fetchFn() {
        calls += 1;
        return { ok: true, status: 200, headers: { get: () => 'req_fake' }, text: () => mode === 'body-timeout'
          ? new Promise(() => {}) : Promise.resolve(JSON.stringify({ id: 'chatcmpl_fake', model: 'gpt-unapproved',
            service_tier: 'default', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
              content: '{"action":"redirect","sourceId":null}' } }] })) };
      } });
    assert.equal(calls, 1);
    assert.equal(result.summary.status, 'stopped');
    assert.equal(result.summary.attempts, 49);
    assert.ok(result.summary.uncertainCostUpperBoundUsd > receipt.uncertainCostUpperBoundUsd);
    if (mode === 'wrong-model') {
      assert.equal(result.capture.records.at(-1).output, null);
      assert.equal(result.capture.records.at(-1).rawOutput, '{"action":"redirect","sourceId":null}');
      const comparison = JSON.parse(readFileSync(resolve(prepared.outputDir, 'comparison.json'), 'utf8'));
      assert.equal(comparison.rows.find((r) => r.key === remaining[0].key).status, 'invalid');
    } else assert.equal(result.capture.records.length, 47);
  }
});
