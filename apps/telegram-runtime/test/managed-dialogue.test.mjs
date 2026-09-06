import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { runManagedDialogue } from '../scripts/lib/managed-dialogue.mjs';
import { createManagedPackage } from './fixtures/managed-package.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const guard = join(fixtures, 'offline-guard.cjs');
const cli = resolve(here, '../scripts/local-dialogue.mjs');
function rig(mode = 'dispatch', count = 8) {
  const root = mkdtempSync(join(tmpdir(), 'managed-assistant-test-'));
  const options = { storageRoot: join(root, 'runs'), runId: 'run1',
    identity: { conversationId: 'conv1', participantId: 'expert1', chatId: '-100', userId: '7' },
    plan: Array.from({ length: count }, (_, i) => ({ id: `t${i}`, text: `prompting ${i === 0 ? 'budget=100' : i === 5 ? 'budget=200' : `step ${i}`}` })),
    packageDir: createManagedPackage(join(root, 'package')), methodologyDir: fixtures,
    adapterFile: join(fixtures, 'managed-provider.mjs'), config: { analyzerMode: mode }, maxSteps: 4 };
  return { root, options, close() { rmSync(root, { recursive: true, force: true }); } };
}
function fresh(rig, overrides = {}) {
  const request = join(rig.root, 'request.json'); writeFileSync(request, JSON.stringify({ ...rig.options, ...overrides }));
  const result = spawnSync(process.execPath, ['--require', guard, cli, '--request', request], {
    encoding: 'utf8', env: { PATH: dirname(process.execPath), TMPDIR: tmpdir(), LANG: 'en_US.UTF-8' }, timeout: 20000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-700)}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
for (const mode of ['dispatch', 'off']) test(`public CLI fresh-process ${mode} carries old state and corrections beyond three pairs`, () => {
  const fixture = rig(mode);
  try {
    const first = fresh(fixture); assert.equal(first.cursor, 2); assert.equal(first.status, 'paused');
    const resumed = fresh(fixture, { resume: true, maxSteps: 16 });
    assert.equal(resumed.cursor, 8); assert.equal(resumed.status, 'completed');
    const stage = mode === 'dispatch' ? 'analyzer' : 'router';
    for (const target of [stage, 'answer']) {
      const calls = resumed.observations.filter((item) => item.stage === target);
      assert.equal(calls.length, 8);
      assert.equal(calls[4].input.working_state.items[0].value, '100');
      assert.equal(calls[4].input.dialogue.length, 3);
      assert.ok(!JSON.stringify(calls[4].input.dialogue).includes('budget=100'));
      assert.equal(calls[6].input.working_state.items[0].value, '200');
      assert.match(calls[6].system, /current.*priority/);
    }
    const updates = resumed.observations.filter((item) => item.stage === 'state');
    assert.equal(updates.length, 8); assert.equal(updates[7].input.state.history, undefined);
    assert.equal(resumed.state.history[5].changes[0].before.value, '100');
    assert.equal(resumed.pairs.length, 8);
    assert.equal(resumed.attempts.filter((item) => item.stage === 'state').length, 8);
    assert.ok(resumed.attempts.every((item) => item.usage?.totalTokens === 18));
    const repeated = fresh(fixture, { resume: true });
    assert.deepEqual(repeated.attempts, resumed.attempts); assert.deepEqual(repeated.pairs, resumed.pairs);
  } finally { fixture.close(); }
});

test('runtime completion before sidecar commit reconciles in a fresh process without a second answer', async () => {
  const fixture = rig('dispatch', 1);
  try {
    await assert.rejects(runManagedDialogue({ ...fixture.options, testHooks: { afterRuntimeAnswer() { throw new Error('crash'); } } }), /crash/);
    const resumed = fresh(fixture, { resume: true });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.pairs.length, 1);
    assert.equal(resumed.attempts.filter((item) => item.stage === 'answer').length, 1);
    assert.equal(resumed.attempts.filter((item) => item.stage === 'state').length, 1);
  } finally { fixture.close(); }
});

test('known invalid updater response preserves answer and retries only state', async () => {
  const fixture = rig('off', 2);
  try {
    const method = join(fixture.root, 'method'); mkdirSync(method);
    const adapter = join(method, 'adapter.mjs');
    writeFileSync(adapter, `import { createManagedProviders as base } from ${JSON.stringify(pathToFileURL(join(fixtures, 'managed-provider.mjs')).href)};
      let first = true;
      export function createManagedProviders(context) { const result = base(context); const original = result.stateProvider.complete;
        result.stateProvider.complete = async (request) => { if (first) { first = false; return { text: 'broken', usage: { totalTokens: 9 } }; } return original(request); }; return result; }`);
    const options = { ...fixture.options, methodologyDir: method, adapterFile: adapter };
    const pending = await runManagedDialogue(options);
    assert.equal(pending.status, 'state_pending'); assert.equal(pending.cursor, 0);
    assert.ok(pending.pending.pair.assistant.text); assert.equal(pending.state.revision, 0);
    const blocked = await runManagedDialogue({ ...options, resume: true });
    assert.deepEqual(blocked.attempts, pending.attempts);
    const repaired = await runManagedDialogue({ ...options, resume: true, repairState: true, maxSteps: 1 });
    assert.equal(repaired.cursor, 1);
    assert.equal(repaired.attempts.filter((item) => item.stage === 'answer').length, 1);
    assert.equal(repaired.attempts.filter((item) => item.stage === 'state').length, 2);
    assert.equal(repaired.attempts.find((item) => item.stage === 'state').usage.totalTokens, 9);
  } finally { fixture.close(); }
});

test('interrupted updater and missing runtime evidence stop uncertain without retry', async () => {
  const fixture = rig('off', 1);
  try {
    await assert.rejects(runManagedDialogue({ ...fixture.options, testHooks: { beforeStateCommit() { throw new Error('crash'); } } }), /crash/);
    const db = new Database(join(fixture.options.storageRoot, 'run1', 'state.db'));
    const before = JSON.parse(db.prepare('SELECT payload FROM checkpoint').get().payload); db.close();
    const resumed = await runManagedDialogue({ ...fixture.options, resume: true, repairState: true });
    assert.equal(resumed.status, 'uncertain'); assert.equal(resumed.error, 'updater_interrupted_unknown_outcome');
    assert.deepEqual(resumed.attempts, before.attempts); assert.ok(resumed.pending.pair.assistant.text);
  } finally { fixture.close(); }
  const missing = rig('off', 1);
  try {
    await assert.rejects(runManagedDialogue({ ...missing.options, testHooks: { afterRuntimeAnswer() { throw new Error('crash'); } } }));
    const db = new Database(join(missing.options.storageRoot, 'run1', 'runtime.db'));
    db.prepare('DELETE FROM runtime_assistant_answer_records').run(); db.close();
    const result = await runManagedDialogue({ ...missing.options, resume: true });
    assert.equal(result.status, 'uncertain'); assert.equal(result.error, 'runtime_answer_outcome_unknown');
    assert.equal(result.attempts.filter((item) => item.stage === 'answer').length, 1);
  } finally { missing.close(); }
});

test('source TTL is filtered before updater and downstream without deleting audit receipts', async () => {
  const fixture = rig('off', 3);
  try {
    const start = await runManagedDialogue({ ...fixture.options, maxSteps: 2, now: () => 1800000000 });
    const next = await runManagedDialogue({ ...fixture.options, resume: true, now: () => 1800000000 + 604800 });
    assert.equal(start.state.items[0].evidence.timestamp, 1800000000);
    assert.equal(next.state.items[0].evidence.timestamp, 1800000000);
    assert.equal(next.usable_state.items.length, 0); assert.equal(next.pairs.length, 3);
    assert.equal(next.observations.filter((item) => item.stage === 'state')[1].input.state.items.length, 0);
    assert.equal(next.observations.filter((item) => item.stage === 'answer')[1].input.working_state.items.length, 0);
  } finally { fixture.close(); }
});

test('plan/config/knowledge/methodology/identity pin changes and concurrent writers fail closed', async () => {
  const fixture = rig();
  try {
    await runManagedDialogue(fixture.options);
    await assert.rejects(runManagedDialogue(fixture.options), /EEXIST/);
    for (const override of [{ config: { analyzerMode: 'off' } }, { identity: { ...fixture.options.identity, participantId: 'other' } },
      { plan: fixture.options.plan.map((item, i) => i ? item : { ...item, text: 'changed' }) }]) {
      await assert.rejects(runManagedDialogue({ ...fixture.options, ...override, resume: true }), /manifest_mismatch/);
    }
    const lease = new Database(join(fixture.options.storageRoot, 'run1', 'writer.db')); lease.exec('BEGIN EXCLUSIVE');
    await assert.rejects(runManagedDialogue({ ...fixture.options, resume: true }), /writer_busy/); lease.close();
    const manifestPath = join(fixture.options.packageDir, 'knowledge.manifest.json');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8') + '\n');
    await assert.rejects(runManagedDialogue({ ...fixture.options, resume: true }), /manifest_mismatch/);
  } finally { fixture.close(); }
});

test('maxTurns is a pinned overall cap; maxSteps pauses and resume cannot raise the cap', async () => {
  const fixture = rig('dispatch', 8);
  try {
    const options = { ...fixture.options, maxTurns: 2, maxSteps: 2 };
    const seed = await runManagedDialogue(options); assert.equal(seed.cursor, 1); assert.equal(seed.manifest.turn_limit, 2);
    const done = await runManagedDialogue({ ...options, resume: true, maxSteps: 16 });
    assert.equal(done.status, 'completed'); assert.equal(done.cursor, 2);
    const replay = await runManagedDialogue({ ...options, resume: true });
    assert.deepEqual(replay.attempts, done.attempts);
    await assert.rejects(runManagedDialogue({ ...options, resume: true, maxTurns: 3 }), /manifest_mismatch/);
  } finally { fixture.close(); }
});

test('methodology bytes changes are refused before calls', async () => {
  const fixture = rig('dispatch', 3);
  try {
    const dir = join(fixture.root, 'method'); mkdirSync(dir);
    const adapter = join(dir, 'adapter.mjs');
    writeFileSync(adapter, `export { createManagedProviders } from ${JSON.stringify(pathToFileURL(join(fixtures, 'managed-provider.mjs')).href)};`);
    const options = { ...fixture.options, methodologyDir: dir, adapterFile: adapter };
    await runManagedDialogue(options);
    writeFileSync(adapter, readFileSync(adapter, 'utf8') + '\n');
    await assert.rejects(runManagedDialogue({ ...options, resume: true }), /manifest_mismatch/);
  } finally { fixture.close(); }
});

test('failed answer creates no new state/pair and a changed provider route fails before another call', async () => {
  const fixture = rig('off', 3);
  try {
    const dir = join(fixture.root, 'method'); mkdirSync(dir);
    const adapter = join(dir, 'adapter.mjs');
    writeFileSync(adapter, `import { createManagedProviders as base } from ${JSON.stringify(pathToFileURL(join(fixtures, 'managed-provider.mjs')).href)};
      let routeChange = false;
      export function changeRoute() { routeChange = true; }
      export function createManagedProviders(context) { const result = base(context); const original = result.provider;
        result.provider = { ...original, configurationFingerprint: routeChange ? 'a'.repeat(64) : original.configurationFingerprint,
          async answer(input) { if (input.text.includes('step 1')) throw new Error('offline answer transport failure'); return original.answer(input); } };
        return result; }`);
    const options = { ...fixture.options, methodologyDir: dir, adapterFile: adapter, maxSteps: 2 };
    const seed = await runManagedDialogue(options); assert.equal(seed.cursor, 1);
    const failed = await runManagedDialogue({ ...options, resume: true });
    assert.equal(failed.status, 'uncertain'); assert.equal(failed.cursor, 1);
    assert.deepEqual(failed.state, seed.state); assert.deepEqual(failed.pairs, seed.pairs);
    const other = { ...options, runId: 'other' };
    await runManagedDialogue(other);
    (await import(pathToFileURL(adapter).href)).changeRoute();
    await assert.rejects(runManagedDialogue({ ...other, resume: true }), /provider_configuration_mismatch/);
  } finally { fixture.close(); }
});
