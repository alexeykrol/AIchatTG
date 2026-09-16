import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import { safetyVerdict } from './safety-fixture.mjs';

// This expected counterexample is a RELEASE BLOCKER, not rollback approval.
// Never substitute the current core module into the historical runtime.
const OLD_SOURCE = 'a41518f4a4fd105cf19e7fc1a64fd35b77233084';
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../', import.meta.url));

const config = {
  moderationMode: 'live', assistantModerationWaitMs: 0, assistantModerationPollMs: 1,
  assistantCooldownSec: 0, assistantDailyPerUser: 100,
  assistantDialogueTurnLimit: 3, assistantDialogueTtlSec: 604800,
  moderator: { chatIds: ['-100'], botToken: '901:fixture', botUsername: 'moderator_bot', exemptBotIds: [] },
  assistant: { chatIds: ['-100'], botToken: '900:fixture', botUsername: 'assistant_bot', exemptBotIds: [] },
};

function update(updateId) {
  return { update_id: updateId, message: {
    message_id: 50, chat: { id: -100, type: 'supergroup' },
    from: { id: 7, is_bot: false }, text: '/ask Кто ты?',
  } };
}

function adapters(counters = null) {
  return {
    guard: {
      async senderDisposition() { if (counters) counters.guard++; return { proven: true, exempt: false, reason: null }; },
      async verifyEnforcement() { if (counters) counters.guard++; return { proven: true, status: 'administrator' }; },
    },
    assistantTelegram: { async sendMessage() { if (counters) counters.sends++; return { ok: true, data: { message_id: 100 } }; } },
    notifier: { async notify() { return { delivered: true }; } },
  };
}

async function exactOldSource(folder) {
  const historicalRoot = join(folder, 'old-source');
  mkdirSync(historicalRoot);
  assert.equal(execFileSync('git', ['rev-parse', `${OLD_SOURCE}^{commit}`], { cwd: REPO, encoding: 'utf8' }).trim(), OLD_SOURCE);
  const archive = execFileSync('git', ['archive', '--format=tar', OLD_SOURCE,
    'apps/telegram-runtime/src', 'packages/telegram-core'], { cwd: REPO, maxBuffer: 20 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', historicalRoot], { input: archive });
  const dependencies = join(historicalRoot, 'apps/telegram-runtime/node_modules');
  mkdirSync(join(dependencies, '@aichattg'), { recursive: true });
  symlinkSync(join(historicalRoot, 'packages/telegram-core'), join(dependencies, '@aichattg/telegram-core'));
  symlinkSync(realpathSync(join(RUNTIME, 'node_modules/better-sqlite3')), join(dependencies, 'better-sqlite3'));
  const source = join(historicalRoot, 'apps/telegram-runtime/src');
  return {
    database: await import(pathToFileURL(join(source, 'database.mjs')).href),
    runtime: await import(pathToFileURL(join(source, 'runtime.mjs')).href),
    provider: await import(pathToFileURL(join(source, 'provider-adapter.mjs')).href),
  };
}

test('exact old a41518f opens additive schema but rejudges a late Moderator webhook after new Assistant acceptance', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-rollback-proof-'));
  const historicalRoot = join(folder, 'old-source');
  mkdirSync(historicalRoot);
  let db;
  t.after(() => { db?.close(); rmSync(folder, { recursive: true, force: true }); });
  const actualCommit = execFileSync('git', ['rev-parse', `${OLD_SOURCE}^{commit}`], { cwd: REPO, encoding: 'utf8' }).trim();
  assert.equal(actualCommit, OLD_SOURCE);
  const archive = execFileSync('git', ['archive', '--format=tar', OLD_SOURCE,
    'apps/telegram-runtime/src', 'packages/telegram-core'], { cwd: REPO, maxBuffer: 20 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', historicalRoot], { input: archive });
  const dependencyRoot = join(historicalRoot, 'apps/telegram-runtime/node_modules');
  mkdirSync(join(dependencyRoot, '@aichattg'), { recursive: true });
  symlinkSync(join(historicalRoot, 'packages/telegram-core'), join(dependencyRoot, '@aichattg/telegram-core'));
  symlinkSync(realpathSync(join(RUNTIME, 'node_modules/better-sqlite3')), join(dependencyRoot, 'better-sqlite3'));

  const databasePath = join(folder, 'synthetic.sqlite');
  db = openRuntimeDatabase(databasePath);
  const newStore = createRuntimeStore(db);
  let newJudgements = 0;
  const currentRuntime = createTelegramRuntime({ config, store: newStore, ...adapters(), provider: {
    async moderate(input) {
      newJudgements++;
      return safetyVerdict({ message: input.text, context: {
        currentWeakStrikes: input.currentWeakStrikes, warningStage: input.warningStage,
      } });
    },
  } });
  assert.equal((await currentRuntime.handleUpdate('assistant', update(10))).kind, 'answered');
  assert.equal(newJudgements, 1);
  const envelopeBefore = db.prepare(`SELECT owner, event_id, verdict_fingerprint FROM runtime_judgement_envelopes
    WHERE revision_identity = '-100:50:original'`).get();
  assert.equal(envelopeBefore.owner, 'assistant');
  assert.equal(envelopeBefore.event_id, 'assistant:10');
  assert.ok(envelopeBefore.verdict_fingerprint);
  assert.equal(newStore.getModeratorJudgement('assistant:10').state, 'resolved');
  db.close();
  db = null;

  // Both runtime and core are immutable exact Git sources. Only the locally
  // installed native SQLite dependency is reused; all transports are fakes.
  const oldSrc = join(historicalRoot, 'apps/telegram-runtime/src');
  const oldDatabase = await import(pathToFileURL(join(oldSrc, 'database.mjs')).href);
  const oldRuntime = await import(pathToFileURL(join(oldSrc, 'runtime.mjs')).href);
  db = oldDatabase.openRuntimeDatabase(databasePath);
  const oldStore = oldDatabase.createRuntimeStore(db);
  assert.deepEqual(db.prepare(`SELECT owner, event_id, verdict_fingerprint FROM runtime_judgement_envelopes
    WHERE revision_identity = '-100:50:original'`).get(), envelopeBefore,
  'old schema initialization opens without destroying the additive ownership evidence');
  let oldJudgements = 0;
  const downgraded = oldRuntime.createTelegramRuntime({ config, store: oldStore, ...adapters(), provider: {
    async moderate() {
      oldJudgements++;
      return { safetyRoute: 'clean', abuseLevel: null, confidence: 1, reason: 'fixture', modelId: 'offline-old' };
    },
  } });
  const late = await downgraded.handleUpdate('moderator', update(20));
  assert.equal(late.kind, 'moderated');
  assert.equal(oldJudgements, 1, 'unsafe downgrade executes a second semantic judgement for the accepted native message');
  assert.equal(db.prepare(`SELECT count(*) AS n FROM runtime_moderator_judgement_jobs
    WHERE event_id IN ('assistant:10', 'moderator:20')`).get().n, 2);
  assert.equal(db.prepare(`SELECT count(*) AS n FROM runtime_moderation_records
    WHERE chat_id = '-100' AND message_id = '50'`).get().n, 2);
  assert.equal((await downgraded.handleUpdate('moderator', update(20))).kind, 'moderated');
  assert.equal(oldJudgements, 1, 'old receipt dedupe still works; cross-role ownership is the missing fence');
});

for (const scenario of ['accepted', 'pending', 'recovered_pending', 'calling', 'unknown', 'expired_snapshot', 'conflicting_pending']) {
  test(`forward upgrade quarantines exact old ${scenario} native ownership before a late Assistant webhook`, async (t) => {
    const folder = mkdtempSync(join(tmpdir(), `aichattg-forward-${scenario}-`));
    let db;
    t.after(() => { db?.close(); rmSync(folder, { recursive: true, force: true }); });
    const old = await exactOldSource(folder);
    const path = join(folder, 'synthetic.sqlite');
    let time = 1000;
    db = old.database.openRuntimeDatabase(path);
    const oldStore = old.database.createRuntimeStore(db, { now: () => time });
    let oldCalls = 0;
    const oldRuntime = old.runtime.createTelegramRuntime({
      config: { ...config, moderatorRecoverySnapshotTtlSec: 60, moderatorRecoveryBackoffSec: 0 },
      store: oldStore, ...adapters(), provider: { async moderate() {
        oldCalls++;
        if (scenario === 'calling') return new Promise(() => {}); // synthetic process crash: callback never resumes
        if (scenario === 'unknown') throw new Error('synthetic unknown provider result');
        if (scenario !== 'accepted') throw new old.provider.ProviderUnavailableError('provider_disabled');
        return { safetyRoute: 'clean', abuseLevel: null, confidence: 1, reason: 'fixture', modelId: 'offline-old' };
      } },
    });
    const original = oldRuntime.handleUpdate('moderator', update(20));
    if (scenario === 'calling') await new Promise((resolve) => setImmediate(resolve));
    else await original;
    assert.equal(oldCalls, 1);
    if (scenario === 'conflicting_pending') {
      await oldRuntime.handleUpdate('moderator', update(21));
      assert.equal(oldCalls, 2);
    }
    if (scenario === 'expired_snapshot') {
      time += 61;
      await oldRuntime.recoverModeratorJudgements({ limit: 2 });
      assert.equal(oldStore.getModeratorJudgement('moderator:20').snapshot_sha256, 'expired');
    }
    assert.equal(oldStore.getModeratorJudgement('moderator:20').state,
      scenario === 'accepted' ? 'resolved' : scenario.includes('pending') ? 'safe_retry'
        : scenario === 'calling' ? 'calling' : 'manual_review');
    let before = oldStore.getAssistantDisposition({ chatId: '-100', messageId: '50' });
    db.close(); db = null;

    db = openRuntimeDatabase(path);
    const store = createRuntimeStore(db, { now: () => time });
    assert.deepEqual(db.prepare('SELECT * FROM runtime_judgement_legacy_natives').all(), [
      { chat_id: '-100', message_id: '50' },
    ], 'upgrade quarantine retains native identifiers only, not legacy judgement bodies');
    for (const sql of [
      'SELECT 1 FROM runtime_judgement_legacy_natives WHERE chat_id = ? AND message_id = ?',
      'SELECT event_id FROM runtime_judgement_legacy_jobs WHERE chat_id = ? AND message_id = ? LIMIT 2',
    ]) assert.match(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('-100', '50')[0].detail, /SEARCH .*USING.*INDEX/);
    const counters = { provider: 0, guard: 0, sends: 0 };
    const upgradedProvider = { async moderate(input) {
        counters.provider++;
        return safetyVerdict({ message: input.text, context: {
          currentWeakStrikes: input.currentWeakStrikes, warningStage: input.warningStage,
        } });
    } };
    const runtime = createTelegramRuntime({ config: { ...config, moderatorRecoveryBackoffSec: 0 },
      store, ...adapters(counters), provider: upgradedProvider,
    });
    if (scenario === 'recovered_pending') {
      time++;
      assert.equal((await runtime.recoverModeratorJudgements({ limit: 2 })).recovered, 1);
      assert.equal(counters.provider, 1);
      before = store.getAssistantDisposition({ chatId: '-100', messageId: '50' });
    }
    const beforeLateCounters = { ...counters };
    const late = await runtime.handleUpdate('assistant', update(30));
    assert.equal(late.kind, 'skipped');
    assert.equal(late.reason, 'legacy_native_quarantined');
    assert.deepEqual(counters, beforeLateCounters);
    assert.deepEqual(store.getAssistantDisposition({ chatId: '-100', messageId: '50' }), before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM runtime_judgement_envelopes').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM runtime_moderator_judgement_jobs').get().n,
      scenario === 'conflicting_pending' ? 2 : 1);
    const edited = update(32);
    edited.edited_message = { ...edited.message, edit_date: 2000, text: '/ask Измененный вопрос' };
    delete edited.message;
    assert.equal((await runtime.handleUpdate('assistant', edited)).reason, 'legacy_native_quarantined');
    assert.deepEqual(counters, beforeLateCounters);

    if (scenario === 'pending') {
      time++;
      assert.equal((await runtime.recoverModeratorJudgements({ limit: 2 })).recovered, 1);
      assert.equal(counters.provider, 1, 'only original proved-not-called legacy job may recover');
      assert.equal(store.getModeratorJudgement('moderator:20').state, 'resolved');
      const recoveredDisposition = store.getAssistantDisposition({ chatId: '-100', messageId: '50' });
      const recoveredCounts = { ...counters };
      const afterRecovery = await runtime.handleUpdate('assistant', update(31));
      assert.equal(afterRecovery.reason, 'legacy_native_quarantined');
      assert.deepEqual(counters, recoveredCounts);
      assert.deepEqual(store.getAssistantDisposition({ chatId: '-100', messageId: '50' }), recoveredDisposition);
    }
    if (scenario === 'calling' || scenario === 'conflicting_pending') {
      time++;
      await runtime.recoverModeratorJudgements({ limit: 5, startup: true });
      assert.deepEqual(counters, beforeLateCounters, 'unknown/conflicting legacy calls cannot cross provider or Guard boundary');
      assert.ok(db.prepare('SELECT state FROM runtime_moderator_judgement_jobs').all()
        .every((row) => row.state === 'manual_review'));
    }

    // The quarantine is native-scoped, not a global switch disabling new work.
    const newNative = update(50);
    newNative.message.message_id = 51;
    const beforeFresh = { ...counters };
    assert.equal((await runtime.handleUpdate('assistant', newNative)).kind, 'answered');
    assert.equal(counters.provider, beforeFresh.provider + 1);
    assert.equal(counters.sends, beforeFresh.sends + 1);
    const indexesBeforeRestart = db.prepare('SELECT * FROM runtime_judgement_legacy_jobs ORDER BY event_id').all();
    db.close(); db = null;
    db = openRuntimeDatabase(path);
    const restartedStore = createRuntimeStore(db, { now: () => time });
    assert.deepEqual(db.prepare('SELECT * FROM runtime_judgement_legacy_jobs ORDER BY event_id').all(), indexesBeforeRestart);
    assert.deepEqual(db.prepare('SELECT * FROM runtime_judgement_legacy_natives').all(), [{ chat_id: '-100', message_id: '50' }]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM runtime_judgement_envelopes').get().n, 1);
    const restartedRuntime = createTelegramRuntime({ config, store: restartedStore,
      ...adapters(counters), provider: upgradedProvider });
    const beforeRestartLate = { ...counters };
    assert.equal((await restartedRuntime.handleUpdate('assistant', update(60))).reason, 'legacy_native_quarantined');
    assert.deepEqual(counters, beforeRestartLate);
  });
}
