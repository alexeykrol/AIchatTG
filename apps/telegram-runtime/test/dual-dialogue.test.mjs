import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { isCourseOperationsSupportQuestion, isCourseValueQuestion } from '@aichattg/telegram-core';
import { answerSystemPrompt } from '../src/provider-adapter.mjs';
import { STATE_CONTEXT_INSTRUCTION } from '../src/assistant-working-state.mjs';
import { DEFAULT_DOMAIN_CATALOG } from '../src/assistant-domains.mjs';
import { domainBoundaryReply } from '../src/assistant-domain-routing.mjs';
import {
  buildRolePackage, collapseWhitespace, renderRoleText, renderTranscript, runDualDialogue, withRoleInSystemMessage,
} from '../scripts/lib/dual-dialogue.mjs';
import {
  LEDGER_FIELDS, LedgerError, appendLedgerMessage, readLedger, textSha256, validateLedgerMessage,
} from '../scripts/lib/dialogue-ledger.mjs';
import { openDialogueStore } from '../scripts/lib/local-dialogue-store.mjs';
import { createManagedPackage } from './fixtures/managed-package.mjs';
import { EXPERT_RECORD, SKEPTIC_RECORD, buildScenario, writeDualFixtures } from './fixtures/dual-records.mjs';
import { questionDigest } from './fixtures/dual-provider-base.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const guard = join(fixtures, 'offline-guard.cjs');
const cli = resolve(here, '../scripts/local-dual-dialogue.mjs');
const EXPERT = 'assistant';
const SYNTHETIC = 'skeptic';
const EXPERT_BANK = ['Prompting teaches clear instructions', 'https://example.invalid/lesson', 'managed-offline-fixture'];
const SKEPTIC_PRIVATE = [...SKEPTIC_RECORD.intent.hides, SKEPTIC_RECORD.voice.emotion, ...SKEPTIC_RECORD.knowledge.life_experience,
  ...SKEPTIC_RECORD.knowledge.past_disappointments, ...SKEPTIC_RECORD.knowledge.vocabulary, SKEPTIC_RECORD.intent.wants, 'РОЛЬ УЧАСТНИКА'];

/**
 * Adapters inside a private methodology dir: thin wrappers over the pinned
 * fixtures, so a test can patch one stage or change one byte of an adapter.
 */
function methodology(root, { expertPatch = '', rolePatch = '' } = {}) {
  const dir = join(root, 'method'); mkdirSync(dir);
  const wrap = (name, source, patch) => {
    writeFileSync(join(dir, name), `import { createManagedProviders as base } from ${JSON.stringify(pathToFileURL(join(fixtures, source)).href)};
import { existsSync, writeFileSync } from 'node:fs';
const flag = ${JSON.stringify(join(root, `${name}.flag`))};
export function createManagedProviders(context) {
  const inner = base(context);
  const result = { provider: { ...inner.provider }, stateProvider: { ...inner.stateProvider } };
  ${patch}
  return result;
}
`);
    return join(dir, name);
  };
  return { dir, expert: wrap('expert.mjs', 'dual-expert-provider.mjs', expertPatch), role: wrap('role.mjs', 'dual-role-provider.mjs', rolePatch) };
}

function rig({ mode = 'off', turnLimit = 6, wrappers = null, stepLimit = 20 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dual-dialogue-test-'));
  const paths = writeDualFixtures(join(root, 'records'), { turnLimit });
  const packageDir = createManagedPackage(join(root, 'package'));
  const method = wrappers ? methodology(root, wrappers) : null;
  const options = { storageRoot: join(root, 'runs'), runId: 'run1', scenarioFile: paths.scenario,
    participants: {
      expert: { recordFile: paths.expertRecord, packageDir, methodologyDir: method ? method.dir : fixtures, adapterFile: method ? method.expert : join(fixtures, 'dual-expert-provider.mjs') },
      synthetic: { recordFile: paths.syntheticRecord, methodologyDir: method ? method.dir : fixtures, adapterFile: method ? method.role : join(fixtures, 'dual-role-provider.mjs') },
    },
    config: { analyzerMode: mode }, stepLimit };
  const callLog = join(root, 'calls.jsonl');
  return { root, paths, packageDir, method, options, callLog, runDir: join(root, 'runs', 'run1'),
    calls() { return existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []; },
    close() { rmSync(root, { recursive: true, force: true }); } };
}

/** A fresh process: the public CLI under the offline guard with a minimal environment. */
function fresh(fixture, overrides = {}, { expectStatus = 0 } = {}) {
  const request = join(fixture.root, 'request.json'); writeFileSync(request, JSON.stringify({ ...fixture.options, ...overrides }));
  const result = spawnSync(process.execPath, ['--require', guard, cli, '--request', request], {
    encoding: 'utf8', env: { PATH: dirname(process.execPath), TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', DUAL_FIXTURE_CALL_LOG: fixture.callLog }, timeout: 30000,
  });
  assert.equal(result.status, expectStatus, `${result.stderr}\n${result.stdout.slice(-700)}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

const ledgerLines = (fixture) => readFileSync(join(fixture.runDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const answersOf = (result, pid) => result.observations.filter((item) => item.participant === pid && item.stage === 'answer');
const inputsOf = (result, pid) => JSON.stringify(result.observations.filter((item) => item.participant === pid).map((item) => item.input));

for (const mode of ['off', 'dispatch']) test(`full run (${mode}): strict order, response-dependence, separation, no leak, canonical expert prompt, transcript`, async () => {
  const fixture = rig({ mode });
  try {
    const result = await runDualDialogue(fixture.options);
    assert.equal(result.status, 'completed'); assert.equal(result.error, null); assert.equal(result.pending, null);
    const messages = result.messages;
    assert.equal(messages.length, 6);
    // §4/§5: stimulus opens, strict alternation, chain of reply_to, hashes, receipts.
    assert.deepEqual(messages.map((m) => [m.seq, m.from, m.from_kind, m.to]), [
      [1, 'scenario', 'human', SYNTHETIC], [2, SYNTHETIC, 'agent', EXPERT], [3, EXPERT, 'agent', SYNTHETIC],
      [4, SYNTHETIC, 'agent', EXPERT], [5, EXPERT, 'agent', SYNTHETIC], [6, SYNTHETIC, 'agent', EXPERT]]);
    for (const [i, m] of messages.entries()) {
      assert.deepEqual(Object.keys(m), [...LEDGER_FIELDS]);
      assert.equal(m.message_id, `run1-${m.seq}`); assert.equal(m.text_sha256, textSha256(m.text));
      assert.equal(m.reply_to, i === 0 ? null : messages[i - 1].message_id);
      if (i === 0) assert.equal(m.receipt, null);
      else { assert.equal(m.receipt.status, 'completed'); assert.match(m.receipt.turn_id, new RegExp(`^run1:${m.from}:\\d+:assistant$`)); }
      assert.ok(!isCourseOperationsSupportQuestion(m.text) && !isCourseValueQuestion(m.text), `hint fired on seq ${m.seq}`);
    }
    assert.deepEqual(ledgerLines(fixture), messages);
    // §11.1: each generated message is derived from the actual previous text, not from a plan.
    for (const m of messages.slice(1)) assert.ok(m.text.includes(`на ${questionDigest(messages[m.seq - 2].text)}`), `seq ${m.seq} not derived from seq ${m.seq - 1}`);
    const expertAnswers = answersOf(result, EXPERT); const syntheticAnswers = answersOf(result, SYNTHETIC);
    assert.equal(expertAnswers.length, 2); assert.equal(syntheticAnswers.length, 3);
    assert.deepEqual(expertAnswers.map((o) => o.input.question), [messages[1].text, messages[3].text]);
    assert.deepEqual(syntheticAnswers.map((o) => o.input.question), [messages[0].text, messages[2].text, messages[4].text]);
    // The expert never sees the stimulus; the synthetic remembers its own opening as its turn.
    assert.ok(!inputsOf(result, EXPERT).includes(messages[0].text));
    assert.equal(syntheticAnswers[1].input.dialogue[0].question, messages[0].text);
    // §11.2: two runtime.db files, own identity (the user is the counterpart), own material.
    for (const [pid, userId] of [[EXPERT, '1002'], [SYNTHETIC, '1001']]) {
      const db = new Database(join(fixture.runDir, pid, 'runtime.db'), { readonly: true });
      const rows = db.prepare('SELECT chat_id, user_id, question, answer FROM runtime_assistant_answer_records ORDER BY created_at').all(); db.close();
      assert.equal(rows.length, pid === EXPERT ? 2 : 3);
      assert.ok(rows.every((row) => row.chat_id === '-100' && row.user_id === userId));
      assert.equal(result.manifest.participants[pid].identity.userId, userId);
      assert.deepEqual(rows.map((row) => row.answer), messages.filter((m) => m.from === pid).map((m) => m.text));
    }
    assert.ok(expertAnswers.every((o) => o.input.knowledge.entries.every((e) => e.id.startsWith('u'))));
    assert.ok(syntheticAnswers.every((o) => o.input.knowledge.entries.every((e) => /^(circumstance|life_|past_|vocab_|prof_)/.test(e.id))));
    // §11.5 / §7: leak probe over every provider input of each side.
    const syntheticInputs = inputsOf(result, SYNTHETIC); const expertInputs = inputsOf(result, EXPERT);
    for (const needle of [...EXPERT_BANK, result.manifest.participants[EXPERT].knowledge['knowledge.manifest.json'], '"trace"', 'served_by', 'pack_status', 'material_reason']) assert.ok(!syntheticInputs.includes(needle), `expert internals leaked to synthetic: ${needle}`);
    for (const needle of SKEPTIC_PRIVATE) assert.ok(!expertInputs.includes(needle), `synthetic record leaked to expert: ${needle}`);
    for (const observation of result.observations.filter((o) => o.participant === EXPERT)) assert.ok(!SKEPTIC_PRIVATE.some((needle) => observation.system.includes(needle)));
    // §11.7: the expert instance is the canonical assistant: same answer system prompt; the role sits only in the synthetic's answer stage.
    for (const o of expertAnswers) assert.equal(o.system, `${answerSystemPrompt(o.input)}\n\n${STATE_CONTEXT_INSTRUCTION}`);
    const roleText = readFileSync(join(fixture.runDir, SYNTHETIC, 'role.txt'), 'utf8');
    for (const o of syntheticAnswers) assert.equal(o.system, `${roleText}\n\n${answerSystemPrompt(o.input)}\n\n${STATE_CONTEXT_INSTRUCTION}`);
    for (const o of result.observations.filter((item) => item.participant === SYNTHETIC && item.stage !== 'answer')) assert.ok(!o.system.includes(roleText));
    assert.ok(!roleText.includes(messages[0].text));
    // Accounting: one attempt per provider call plus one state update per generated message; every call landed.
    const perMessage = mode === 'dispatch' ? ['analyze', 'answer', 'state'] : ['routeAssistant', 'answer', 'state'];
    assert.deepEqual(result.attempts.map((a) => `${a.participant}:${a.stage}`), messages.slice(1).flatMap((m) => perMessage.map((stage) => `${m.from}:${stage}`)));
    assert.ok(result.attempts.every((a) => ['returned', 'ok'].includes(a.status) && a.usage?.totalTokens === 18));
    assert.equal(result.instances[EXPERT].pairs.length, 2); assert.equal(result.instances[SYNTHETIC].pairs.length, 3);
    assert.deepEqual(result.instances[SYNTHETIC].pairs.map((p) => p.seq), [2, 4, 6]);
    assert.ok(result.instances[SYNTHETIC].pairs.every((p) => p.role === SYNTHETIC));
    // §11.8: readable transcript without internals; per-instance trace only holds that instance.
    const transcript = readFileSync(join(fixture.runDir, 'transcript.md'), 'utf8');
    assert.equal(transcript, renderTranscript({ manifest: result.manifest, messages, status: 'completed' }));
    const headings = transcript.split('\n').filter((line) => line.startsWith('## '));
    assert.deepEqual(headings, [
      '## 1 · сценарий (человек) → Скептик [skeptic]', '## 2 · Скептик [skeptic] (агент) → Ассистент [assistant]',
      '## 3 · Ассистент [assistant] (агент) → Скептик [skeptic]', '## 4 · Скептик [skeptic] (агент) → Ассистент [assistant]',
      '## 5 · Ассистент [assistant] (агент) → Скептик [skeptic]', '## 6 · Скептик [skeptic] (агент) → Ассистент [assistant]']);
    for (const m of messages) assert.ok(transcript.includes(m.text));
    for (const needle of ['working_state', 'trace', 'РОЛЬ УЧАСТНИКА', 'usage', ...EXPERT_BANK, ...SKEPTIC_PRIVATE]) assert.ok(!transcript.includes(needle), `internals in transcript: ${needle}`);
    for (const pid of [EXPERT, SYNTHETIC]) {
      const trace = readFileSync(join(fixture.runDir, pid, 'trace.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(trace.length > 0 && trace.every((item) => item.participant === pid));
    }
    // Manifest: hashes of both records, the scenario, the materialized role, code pins, provider fingerprints.
    const manifest = result.manifest;
    assert.equal(manifest.turn_limit, 6); assert.equal(manifest.scenario.sha256, textSha256(readFileSync(fixture.paths.scenario, 'utf8')));
    assert.equal(manifest.participants[SYNTHETIC].record.sha256, textSha256(readFileSync(fixture.paths.syntheticRecord, 'utf8')));
    assert.deepEqual(Object.keys(manifest.participants[SYNTHETIC].materialized).sort(), ['package/ai.db', 'package/knowledge.manifest.json', 'role.txt']);
    assert.equal(manifest.participants[SYNTHETIC].materialized['role.txt'], textSha256(roleText));
    assert.ok(['apps/telegram-runtime/src', 'apps/telegram-runtime/scripts', 'packages/telegram-core/src'].every((name) => Object.keys(manifest.pins.code[name]).length > 0));
    assert.equal(manifest.pins.node, process.version);
    assert.ok([EXPERT, SYNTHETIC].every((pid) => /^[a-f0-9]{64}$/.test(result.provider_pins[pid].assistant)));
    // Resume on a completed run: no adapters, no calls, nothing changes (§11.4).
    const repeated = await runDualDialogue({ ...fixture.options, resume: true });
    assert.equal(repeated.status, 'completed'); assert.deepEqual(repeated.attempts, result.attempts); assert.deepEqual(repeated.messages, messages);
  } finally { fixture.close(); }
});

test('fresh process between commit and hand-over: resume hands over the committed text without regenerating it (§11.3, §11.4)', async () => {
  const fixture = rig({ stepLimit: 1 });
  try {
    let crashed = false;
    await assert.rejects(runDualDialogue({ ...fixture.options, testHooks: { afterLedgerCommit() { crashed = true; throw new Error('crash'); } } }), /crash/);
    assert.ok(crashed);
    const committed = ledgerLines(fixture);
    assert.equal(committed.length, 2); assert.equal(committed[1].from, SYNTHETIC);
    const store = openDialogueStore(fixture.runDir, true);
    try { assert.equal(store.read().pending.phase, 'answer_pending'); assert.equal(store.read().pending.seq, 2); } finally { store.close(); }
    // Resume with no budget for new messages: the pending step is closed (memory of the author), nothing is regenerated.
    const closed = fresh(fixture, { resume: true, stepLimit: 0 });
    assert.equal(closed.status, 'paused'); assert.equal(closed.pending, null); assert.equal(closed.messages.length, 2);
    assert.deepEqual(closed.messages.slice(0, 2), committed);
    assert.deepEqual(fixture.calls().map((c) => `${c.participant}:${c.stage}`), ['skeptic:state']);
    assert.equal(closed.attempts.filter((a) => a.stage === 'answer').length, 1);
    // Next process: the expert receives exactly the committed seq 2 text.
    const next = fresh(fixture, { resume: true, stepLimit: 1 });
    assert.equal(next.status, 'paused'); assert.equal(next.messages.length, 3); assert.equal(next.messages[2].from, EXPERT);
    assert.deepEqual(fixture.calls().slice(1).map((c) => `${c.participant}:${c.stage}`), ['assistant:router', 'assistant:answer', 'assistant:state']);
    assert.equal(answersOf(next, EXPERT)[0].input.question, collapseWhitespace(committed[1].text));
    assert.ok(next.messages[2].text.includes(`на ${questionDigest(committed[1].text)}`));
    const done = fresh(fixture, { resume: true, stepLimit: 10 });
    assert.equal(done.status, 'completed'); assert.equal(done.messages.length, 6);
    const before = fixture.calls().length;
    const again = fresh(fixture, { resume: true, stepLimit: 10 });
    assert.equal(fixture.calls().length, before);
    assert.equal(again.status, 'completed'); assert.deepEqual(again.attempts, done.attempts); assert.deepEqual(again.messages, done.messages);
    assert.equal(ledgerLines(fixture).length, 6);
  } finally { fixture.close(); }
});

test('runtime answered but the process died before the ledger commit: resume commits from the receipt, no second answer', async () => {
  const fixture = rig({ stepLimit: 1 });
  try {
    await assert.rejects(runDualDialogue({ ...fixture.options, testHooks: { afterRuntimeAnswer() { throw new Error('crash'); } } }), /crash/);
    assert.equal(ledgerLines(fixture).length, 1);
    const resumed = fresh(fixture, { resume: true, stepLimit: 0 });
    assert.equal(resumed.status, 'paused'); assert.equal(resumed.messages.length, 2); assert.equal(resumed.pending, null);
    assert.deepEqual(fixture.calls().map((c) => c.stage), ['state']);
    assert.equal(resumed.attempts.filter((a) => a.stage === 'answer').length, 1);
    const db = new Database(join(fixture.runDir, SYNTHETIC, 'runtime.db'), { readonly: true });
    assert.equal(db.prepare('SELECT answer FROM runtime_assistant_answer_records').get().answer, resumed.messages[1].text); db.close();
  } finally { fixture.close(); }
});

test('manifest: any byte change of scenario, record, materialized role, package or adapter refuses resume (§11.6)', async () => {
  const fixture = rig({ wrappers: {}, stepLimit: 1 });
  try {
    const first = await runDualDialogue(fixture.options);
    assert.equal(first.status, 'paused'); assert.equal(first.messages.length, 2);
    const mutations = [
      ['scenario', fixture.paths.scenario, (raw) => raw.replace('"scenario_class": "content_trust"', '"scenario_class": "content_trust2"')],
      ['scenario turn_limit', fixture.paths.scenario, (raw) => raw.replace('"turn_limit": 6', '"turn_limit": 8')],
      ['record', fixture.paths.syntheticRecord, (raw) => raw.replace('"patience_turns": 3', '"patience_turns": 4')],
      ['role.txt', join(fixture.runDir, SYNTHETIC, 'role.txt'), (raw) => `${raw}\n`],
      ['package manifest', join(fixture.runDir, SYNTHETIC, 'package', 'knowledge.manifest.json'), (raw) => `${raw} `],
      ['expert package', join(fixture.packageDir, 'knowledge.manifest.json'), (raw) => `${raw} `],
      ['adapter', fixture.method.role, (raw) => `${raw}// changed\n`],
    ];
    for (const [name, file, mutate] of mutations) {
      const original = readFileSync(file, 'utf8');
      writeFileSync(file, mutate(original));
      await assert.rejects(runDualDialogue({ ...fixture.options, resume: true, stepLimit: 0 }), /dual_manifest_mismatch/, name);
      writeFileSync(file, original);
    }
    const intact = await runDualDialogue({ ...fixture.options, resume: true, stepLimit: 0 });
    assert.equal(intact.status, 'paused'); assert.equal(intact.messages.length, 2);
    assert.equal(fixture.calls().length, 0);
  } finally { fixture.close(); }
});

test('provider configuration fingerprint is pinned per participant', async () => {
  const fixture = rig({ wrappers: {}, stepLimit: 1 });
  try {
    await runDualDialogue(fixture.options);
    writeFileSync(fixture.method.expert, readFileSync(fixture.method.expert, 'utf8').replace('return result;', "result.provider.configurationFingerprint = 'a'.repeat(64); return result;"));
    await assert.rejects(runDualDialogue({ ...fixture.options, resume: true }), /dual_manifest_mismatch/);
  } finally { fixture.close(); }
});

test('failure answer of the expert: failed, everything committed stays, resume does not call anyone (§9)', async () => {
  const cases = [
    ['router garbage', `result.provider.routeAssistant = async () => ({ nonsense: true });`, /^runtime_answer_skipped:assistant_route_invalid$/],
    ['empty answer text', `const answer = result.provider.answer; result.provider.answer = async (input) => ({ ...(await answer(input)), text: '' });`, /^runtime_answer_failed:uncertain_delivery:/],
  ];
  for (const [name, expertPatch, error] of cases) {
    const fixture = rig({ wrappers: { expertPatch } });
    try {
      const result = await runDualDialogue(fixture.options);
      assert.equal(result.status, 'failed', name); assert.match(result.error, error, name);
      assert.equal(result.messages.length, 2); assert.equal(ledgerLines(fixture).length, 2);
      assert.equal(result.pending.phase, 'answer_pending'); assert.equal(result.pending.author, EXPERT);
      const again = fresh(fixture, { resume: true, stepLimit: 10 }, { expectStatus: 2 });
      assert.equal(again.status, 'failed'); assert.equal(fixture.calls().length, 0); assert.deepEqual(again.attempts, result.attempts);
    } finally { fixture.close(); }
  }
});

test('unknown outcome of an external call: uncertain, never a repeat', async () => {
  const fixture = rig({ wrappers: { expertPatch: `result.provider.answer = async () => { throw new Error('transport'); };` } });
  try {
    const result = await runDualDialogue(fixture.options);
    assert.equal(result.status, 'uncertain'); assert.equal(result.error, 'runtime_answer_unconfirmed:uncertain_delivery');
    assert.equal(result.messages.length, 2);
    assert.equal(result.attempts.at(-1).status, 'uncertain'); assert.equal(result.attempts.at(-1).stage, 'answer');
    const again = fresh(fixture, { resume: true, stepLimit: 10 }, { expectStatus: 2 });
    assert.equal(again.status, 'uncertain'); assert.equal(fixture.calls().length, 0);
  } finally { fixture.close(); }
});

test('boundary answer is legal visible text: abstention is committed and the run continues', async () => {
  // The router chooses a known domain, but the expert bank cannot ground the
  // synthetic's continuation. It must name a knowledge gap, not unknown scope.
  const fixture = rig({ wrappers: { rolePatch: `const answer = result.provider.answer; result.provider.answer = async (input) => ({ ...(await answer(input)), text: 'Ну ладно. А дальше что?' });` } });
  try {
    const result = await runDualDialogue(fixture.options);
    assert.equal(result.status, 'completed'); assert.equal(result.messages.length, 6);
    const boundary = domainBoundaryReply({ reason: 'domain_knowledge_missing',
      domainRoutes: [DEFAULT_DOMAIN_CATALOG.routeFor('content')] }, DEFAULT_DOMAIN_CATALOG).text;
    assert.equal(result.messages[2].from, EXPERT); assert.equal(result.messages[2].text, boundary);
    assert.match(boundary, /Вопрос относится к моей области/);
    assert.match(boundary, /нет достаточных сведений/);
    assert.equal(result.messages[2].receipt.status, 'completed');
    assert.ok(readFileSync(join(fixture.runDir, 'transcript.md'), 'utf8').includes(boundary));
  } finally { fixture.close(); }
});

test('known invalid updater response: state_pending keeps the committed message, repairState retries only the state', async () => {
  // The latch lives on disk: the first state call of the run breaks once, in whichever process it happens.
  const fixture = rig({ wrappers: { rolePatch: `const complete = result.stateProvider.complete;
    result.stateProvider.complete = async (request) => { if (!existsSync(flag)) { writeFileSync(flag, '1'); return { text: 'broken', usage: { totalTokens: 9 } }; } return complete(request); };` }, stepLimit: 1 });
  try {
    const pending = await runDualDialogue(fixture.options);
    assert.equal(pending.status, 'state_pending'); assert.equal(pending.messages.length, 2); assert.equal(pending.pending.phase, 'state_pending');
    const untouched = fresh(fixture, { resume: true, stepLimit: 10 }, { expectStatus: 2 });
    assert.equal(untouched.status, 'state_pending'); assert.equal(fixture.calls().length, 0);
    const repaired = fresh(fixture, { resume: true, repairState: true, stepLimit: 0 });
    assert.equal(repaired.status, 'paused'); assert.equal(repaired.pending, null); assert.equal(repaired.messages.length, 2);
    assert.deepEqual(fixture.calls().map((c) => `${c.participant}:${c.stage}`), ['skeptic:state']);
    assert.equal(repaired.attempts.filter((a) => a.stage === 'answer').length, 1);
    assert.equal(repaired.attempts.filter((a) => a.stage === 'state').length, 2);
  } finally { fixture.close(); }
});

test('one writer per run, no overwrite of an existing run, corrupt ledger refuses resume', async () => {
  const fixture = rig({ stepLimit: 1 });
  try {
    await runDualDialogue(fixture.options);
    await assert.rejects(runDualDialogue(fixture.options), /EEXIST/);
    const lease = openDialogueStore(fixture.runDir, true);
    try { await assert.rejects(runDualDialogue({ ...fixture.options, resume: true }), /managed_run_writer_busy/); } finally { lease.close(); }
    const ledger = join(fixture.runDir, 'ledger.jsonl');
    const original = readFileSync(ledger, 'utf8');
    writeFileSync(ledger, original.slice(0, -20));
    await assert.rejects(runDualDialogue({ ...fixture.options, resume: true }), /ledger_corrupt/);
    writeFileSync(ledger, original.replace('"seq":2', '"seq":3'));
    await assert.rejects(runDualDialogue({ ...fixture.options, resume: true }), /ledger_corrupt:ledger_seq_gap/);
    writeFileSync(ledger, original);
    assert.equal((await runDualDialogue({ ...fixture.options, resume: true, stepLimit: 0 })).status, 'paused');
    assert.ok(readdirSync(fixture.runDir).every((name) => !name.endsWith('.tmp')));
  } finally { fixture.close(); }
});

test('request validation: scenario, record and adapter placement are checked before anything runs', async () => {
  const fixture = rig();
  try {
    const scenario = JSON.parse(readFileSync(fixture.paths.scenario, 'utf8'));
    const withScenario = (patch) => { const file = join(fixture.root, 'bad-scenario.json'); writeFileSync(file, JSON.stringify(patch(structuredClone(scenario)))); return file; };
    await assert.rejects(runDualDialogue({ ...fixture.options, scenarioFile: withScenario((s) => { s.opening.to = EXPERT; return s; }) }), /dual_scenario_invalid:opening_to/);
    await assert.rejects(runDualDialogue({ ...fixture.options, scenarioFile: withScenario((s) => { delete s.case; return s; }) }), /dual_scenario_invalid:case/);
    await assert.rejects(runDualDialogue({ ...fixture.options, scenarioFile: withScenario((s) => { s.turn_limit = 1; return s; }) }), /dual_scenario_invalid:turn_limit/);
    await assert.rejects(runDualDialogue({ ...fixture.options, scenarioFile: withScenario((s) => { s.participants[1].record = 'other'; return s; }) }), /dual_record_mismatch/);
    const swapped = { ...fixture.options, participants: { ...fixture.options.participants, synthetic: { ...fixture.options.participants.synthetic, recordFile: fixture.paths.expertRecord } } };
    await assert.rejects(runDualDialogue(swapped), /dual_record_mismatch/);
    const outside = join(fixture.root, 'outside.mjs'); writeFileSync(outside, 'export function createManagedProviders() {}');
    await assert.rejects(runDualDialogue({ ...fixture.options, participants: { ...fixture.options.participants, synthetic: { ...fixture.options.participants.synthetic, adapterFile: outside } } }), /dual_adapter_outside_methodology/);
    await assert.rejects(runDualDialogue({ ...fixture.options, participants: { ...fixture.options.participants, synthetic: { ...fixture.options.participants.synthetic, userId: '1001' } } }), /dual_identity_invalid/);
    await assert.rejects(runDualDialogue({ ...fixture.options, config: { analyzerMode: 'off', extra: 1 } }), /dual_config_invalid/);
    await assert.rejects(runDualDialogue({ ...fixture.options, storageRoot: join(fixture.root, 'package') }), /dual_storage_overlaps_pins/);
    assert.ok(!existsSync(fixture.runDir));
  } finally { fixture.close(); }
});

test('role text is deterministic, carries the record and not the stimulus; injection touches only the answer stage', async () => {
  const role = renderRoleText(SKEPTIC_RECORD);
  assert.equal(role, renderRoleText(structuredClone(SKEPTIC_RECORD)));
  for (const needle of SKEPTIC_PRIVATE) assert.ok(role.includes(needle));
  assert.ok(!role.includes(buildScenario().opening.text));
  assert.throws(() => renderRoleText({ ...SKEPTIC_RECORD, voice: null }), /dual_record_invalid:voice/);
  const seen = [];
  const wrapped = withRoleInSystemMessage(async (_url, request) => { seen.push(JSON.parse(request.body)); return { ok: true }; }, 'ROLE', { answerModel: 'm-answer' });
  const body = (model) => JSON.stringify({ model, messages: [{ role: 'system', content: 'CANON' }, { role: 'user', content: '{}' }] });
  await wrapped('u', { body: body('m-answer') }); await wrapped('u', { body: body('m-router') });
  assert.equal(seen[0].messages[0].content, 'ROLE\n\nCANON'); assert.equal(seen[1].messages[0].content, 'CANON');
  assert.throws(() => withRoleInSystemMessage(async () => {}, '', { answerModel: 'x' }), /dual_role_text_required/);
  // The materialized bank: circumstance + every knowledge item, a concept per significant token, no confirmed URL.
  const root = mkdtempSync(join(tmpdir(), 'dual-role-package-'));
  try {
    const built = buildRolePackage(join(root, 'pkg'), { record: SKEPTIC_RECORD, scenario: buildScenario() });
    assert.equal(built.units, 5); assert.equal(built.domainId, 'skeptic');
    const db = new Database(join(root, 'pkg', 'ai.db'), { readonly: true });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM units WHERE url_state = 'confirmed'").get().n, 0);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM concepts WHERE canonical = 'prompting'").get().n === 1);
    db.close();
    assert.ok(JSON.parse(readFileSync(join(root, 'pkg', 'knowledge.manifest.json'), 'utf8')).format === 'aichattg-knowledge-manifest-v2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ledger: whitelist, strict order, integrity and atomic append', () => {
  const context = { runId: 'r', participants: [EXPERT, SYNTHETIC] };
  const at = '2026-09-06T00:00:00.000Z';
  const stimulus = { message_id: 'r-1', seq: 1, from: 'scenario', from_kind: 'human', to: SYNTHETIC, reply_to: null, text: 'hi', text_sha256: textSha256('hi'), committed_at: at, receipt: null };
  const reply = { message_id: 'r-2', seq: 2, from: SYNTHETIC, from_kind: 'agent', to: EXPERT, reply_to: 'r-1', text: 'yo', text_sha256: textSha256('yo'), committed_at: at, receipt: { turn_id: 't', status: 'completed' } };
  const ids = new Set(['r-1']);
  const bad = (patch, code, previous = stimulus) => {
    let error = null;
    try { validateLedgerMessage({ ...reply, ...patch }, { ...context, previous, messageIds: ids }); } catch (thrown) { error = thrown; }
    assert.ok(error instanceof LedgerError, `expected ${code}`); assert.equal(error.code, code, `${code}: ${error.message}`);
  };
  validateLedgerMessage(stimulus, context);
  validateLedgerMessage(reply, { ...context, previous: stimulus, messageIds: ids });
  bad({ trace: {} }, 'ledger_field_forbidden'); bad({ usage: {} }, 'ledger_field_forbidden'); bad({ extra: 1 }, 'ledger_field_unknown');
  bad({ seq: 3, message_id: 'r-3' }, 'ledger_seq_gap'); bad({ message_id: 'r-02' }, 'ledger_message_id_invalid');
  bad({ text_sha256: textSha256('other') }, 'ledger_text_hash_mismatch'); bad({ reply_to: 'r-9' }, 'ledger_reply_to_unknown');
  bad({ receipt: null }, 'ledger_receipt_invalid'); bad({ receipt: { turn_id: 't', status: 'completed', usage: 1 } }, 'ledger_receipt_invalid');
  bad({ from: EXPERT, to: SYNTHETIC }, 'ledger_turn_order_invalid'); bad({ to: SYNTHETIC }, 'ledger_addressee_invalid');
  bad({ from_kind: 'human' }, 'ledger_from_kind_invalid'); bad({ text: ' yo' }, 'ledger_text_invalid'); bad({ committed_at: 'yesterday' }, 'ledger_committed_at_invalid');
  bad({ from: 'scenario', from_kind: 'human' }, 'ledger_opening_invalid');
  assert.throws(() => validateLedgerMessage({ ...stimulus, to: 'scenario' }, context), /ledger_addressee_invalid/);
  const root = mkdtempSync(join(tmpdir(), 'dual-ledger-'));
  try {
    const file = join(root, 'ledger.jsonl');
    assert.deepEqual(readLedger(file, context), []);
    appendLedgerMessage(file, stimulus, context); appendLedgerMessage(file, reply, context);
    assert.deepEqual(readLedger(file, context).map((m) => m.message_id), ['r-1', 'r-2']);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8').split('\n')[1])), [...LEDGER_FIELDS]);
    assert.throws(() => appendLedgerMessage(file, reply, context), /ledger_seq_gap/);
    assert.deepEqual(readdirSync(root), ['ledger.jsonl']);
    appendFileSync(file, '{"message_id":"r-3"');
    assert.throws(() => readLedger(file, context), /ledger_corrupt:unterminated_line/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
