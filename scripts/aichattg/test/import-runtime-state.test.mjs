import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openRuntimeDatabase } from '../../../apps/telegram-runtime/src/database.mjs';
import { importRuntimeState } from '../import-runtime-state.mjs';

const importer = new URL('../import-runtime-state.mjs', import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function records() {
  return [
    {
      type: 'moderation.v1', recordId: 'moderation-0001', eventId: 'moderator:41', updateId: 41,
      chatId: '-10001', messageId: '51', platformMessageId: '-10001:51', userId: '71',
      verdict: 'clean', confidence: 0.98, reasonCode: 'clean', mode: 'shadow', action: 'none', createdAt: 1_720_000_001,
    },
    {
      type: 'assistant_question_claim.v1', recordId: 'claim-0001', chatId: '-10001', messageId: '51',
      outcome: 'answered', claimedAt: 1_720_000_002, completedAt: 1_720_000_003,
    },
    {
      type: 'weak_strike.v1', recordId: 'strike-0001', chatId: '-10001', userId: '71', weakStrikes: 2, updatedAt: 1_720_000_004,
    },
  ];
}

function manifest(payload, overrides = {}) {
  return {
    format: 'aichattg-migration-bundle-v1',
    bundleId: 'bundle-20260803-01',
    source: {
      application: 'news-digest',
      commit: '0123456789abcdef0123456789abcdef01234567',
      exportType: 'approved-normalized-jsonl',
      databaseIncluded: false,
    },
    target: {
      application: 'aichattg', service: 'aichattg-telegram-runtime', schema: 'runtime-sqlite-v1',
    },
    payload: {
      file: 'records.jsonl', sha256: sha256(payload), recordCount: payload.split('\n').filter(Boolean).length,
    },
    authorization: {
      candidateSha, controllerLeaseId: 'lease-20260803-01', productOwnerApprovalId: 'approval-20260803-01',
    },
    ...overrides,
  };
}

async function fixture(inputRecords = records(), overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aichattg-state-import-'));
  const payload = `${inputRecords.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const manifestPath = join(directory, 'bundle-manifest.json');
  await writeFile(join(directory, 'records.jsonl'), payload);
  await writeFile(manifestPath, JSON.stringify(manifest(payload, overrides)));
  return { directory, manifestPath, databasePath: join(directory, 'telegram-runtime.db') };
}

function run(current, mode = '--dry-run') {
  return spawnSync(process.execPath, [
    importer.pathname, '--manifest', current.manifestPath, '--database', current.databasePath,
    '--expected-candidate-sha', candidateSha, mode,
  ], { encoding: 'utf8' });
}

test('dry-run validates a state-only bundle without creating a target SQLite file', async () => {
  const current = await fixture();
  try {
    const result = run(current);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, 'dry_run');
    assert.equal(receipt.targetState, 'absent');
    assert.deepEqual(receipt.records, {
      'moderation.v1': 1, 'assistant_question_claim.v1': 1, 'weak_strike.v1': 1,
    });
    assert.equal(existsSync(current.databasePath), false);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /-10001|"clean"/u);
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test('apply writes an atomic state receipt and a repeat is idempotent', async () => {
  const current = await fixture();
  try {
    const first = run(current, '--apply');
    assert.equal(first.status, 0, first.stderr);
    const receipt = JSON.parse(first.stdout);
    assert.equal(receipt.status, 'applied');
    assert.equal(receipt.changes.inboundEvents, 1);
    assert.equal(receipt.changes.assistantQuestionClaims, 1);
    assert.doesNotMatch(`${first.stdout}${first.stderr}`, /-10001|"clean"/u);

    const db = openRuntimeDatabase(current.databasePath);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runtime_inbound_events').get().count, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runtime_moderation_records').get().count, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runtime_assistant_question_claims').get().count, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runtime_moderation_weak_strikes').get().count, 1);
      const audit = db.prepare('SELECT bundle_id, payload_sha256, record_summary_json FROM runtime_migration_receipts').get();
      assert.equal(audit.bundle_id, 'bundle-20260803-01');
      assert.match(audit.payload_sha256, /^[0-9a-f]{64}$/u);
      assert.doesNotMatch(audit.record_summary_json, /-10001|"clean"/u);
    } finally {
      db.close();
    }

    const second = run(current, '--apply');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).status, 'already_applied');
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test('a target duplicate conflict rolls back every record in the bundle', async () => {
  const conflicting = records();
  conflicting[1] = { ...conflicting[1], outcome: 'skipped' };
  const current = await fixture(conflicting);
  const db = openRuntimeDatabase(current.databasePath);
  try {
    db.prepare(`INSERT INTO runtime_assistant_question_claims
      (chat_id, message_id, status, outcome, claimed_at, completed_at) VALUES (?, ?, 'completed', 'answered', ?, ?)`)
      .run('-10001', '51', 1_720_000_002, 1_720_000_003);
  } finally {
    db.close();
  }
  try {
    const result = run(current, '--apply');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /target conflict for an Assistant question claim/u);
    const after = openRuntimeDatabase(current.databasePath);
    try {
      assert.equal(after.prepare('SELECT COUNT(*) AS count FROM runtime_inbound_events').get().count, 0);
      assert.equal(after.prepare('SELECT COUNT(*) AS count FROM runtime_moderation_records').get().count, 0);
      assert.equal(after.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runtime_migration_receipts'").get().count, 0);
    } finally {
      after.close();
    }
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test('rejects unsupported personal-content fields without echoing their value', async () => {
  const unsafe = records();
  unsafe[0] = { ...unsafe[0], question: 'private words must never be logged or imported' };
  const current = await fixture(unsafe);
  try {
    const result = run(current);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsupported or missing field/u);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private words/u);
    assert.equal(existsSync(current.databasePath), false);
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test('refuses a manifest whose candidate is not the current AIchatTG Git head before any write', async () => {
  const current = await fixture(records(), {
    authorization: {
      candidateSha: 'fedcba9876543210fedcba9876543210fedcba98',
      controllerLeaseId: 'lease-20260803-01', productOwnerApprovalId: 'approval-20260803-01',
    },
  });
  try {
    await assert.rejects(
      importRuntimeState({
        manifestPath: current.manifestPath, databasePath: current.databasePath,
        expectedCandidateSha: 'fedcba9876543210fedcba9876543210fedcba98',
      }),
      /current AIchatTG Git HEAD/u,
    );
    assert.equal(existsSync(current.databasePath), false);
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test('does not alter a non-runtime SQLite target before rejecting it', async () => {
  const current = await fixture();
  await writeFile(current.databasePath, 'this is not an SQLite database');
  try {
    const before = await readFile(current.databasePath);
    const result = run(current, '--apply');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a database/u);
    assert.deepEqual(await readFile(current.databasePath), before);
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});
