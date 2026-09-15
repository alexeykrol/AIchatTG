import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSettingsCandidateStore, SettingsCandidateError } from '../src/settings-candidates.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aichattg-settings-candidates-'));
  const config = {
    candidateRoot: root,
    runtimeModels: { answerMaxTokens: 2000 },
    assistantPolicy: {
      cooldownSec: 20, dailyPerUser: 20, syntheticDailyPerUser: 200,
      dialogueTurnLimit: 3, chatIds: ['-1001', '-1002'],
    },
  };
  return { root, store: createSettingsCandidateStore(config) };
}

test('settings changes create a new candidate version without changing released values', () => {
  const { root, store } = fixture();
  const before = store.read();
  const values = { ...before.released, cooldownSec: 30, pausedChatIds: ['-1001'] };
  const first = store.save({ values, baseDigest: before.baseDigest });
  assert.equal(first.runtimeApplied, false);
  assert.equal(store.read().released.cooldownSec, 20);
  assert.equal(store.read().candidate.cooldownSec, 30);
  assert.deepEqual(store.read().candidate.pausedChatIds, ['-1001']);
  assert.equal(readdirSync(join(root, 'settings')).length, 1);
  assert.throws(() => store.save({ values: { ...values, cooldownSec: 40 }, baseDigest: before.baseDigest }),
    (error) => error instanceof SettingsCandidateError && error.code === 'candidate_stale');
  const second = store.save({
    values: { ...store.read().candidate, cooldownSec: 40 }, baseDigest: store.read().baseDigest,
  });
  assert.notEqual(first.candidateDigest, second.candidateDigest);
  assert.equal(readdirSync(join(root, 'settings')).length, 2);
});

test('settings editor rejects unknown chats, extra fields and values outside runtime bounds', () => {
  const { store } = fixture();
  const before = store.read();
  const save = (values) => store.save({ values, baseDigest: before.baseDigest });
  assert.throws(() => save({ ...before.released, pausedChatIds: ['-999'] }),
    (error) => error instanceof SettingsCandidateError && error.code === 'settings_pausedChatIds_invalid');
  assert.throws(() => save({ ...before.released, answerMaxTokens: 4097 }),
    (error) => error instanceof SettingsCandidateError && error.code === 'settings_answerMaxTokens_invalid');
  assert.throws(() => save({ ...before.released, apiKey: 'secret' }),
    (error) => error instanceof SettingsCandidateError && error.code === 'settings_shape_invalid');
  assert.equal(store.read().candidate, null);
});
