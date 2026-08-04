import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const verifier = new URL('../verify-migration-bundle.mjs', import.meta.url);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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
      application: 'aichattg',
      service: 'aichattg-telegram-runtime',
      schema: 'runtime-sqlite-v1',
    },
    payload: {
      file: 'records.jsonl',
      sha256: sha256(payload),
      recordCount: payload.endsWith('\n') ? payload.split('\n').length - 1 : payload.split('\n').length,
    },
    authorization: {
      candidateSha: '89abcdef0123456789abcdef0123456789abcdef',
      controllerLeaseId: 'lease-20260803-01',
      productOwnerApprovalId: 'approval-20260803-01',
    },
    ...overrides,
  };
}

async function fixture(payload, overrides) {
  const directory = await mkdtemp(join(tmpdir(), 'aichattg-migration-'));
  const manifestPath = join(directory, 'bundle-manifest.json');
  await writeFile(join(directory, 'records.jsonl'), payload);
  await writeFile(manifestPath, JSON.stringify(manifest(payload, overrides)));
  return { directory, manifestPath };
}

function run(manifestPath) {
  return spawnSync(process.execPath, [verifier.pathname, '--manifest', manifestPath], { encoding: 'utf8' });
}

test('accepts a verified normalized JSONL bundle without printing records', async () => {
  const payload = '{"kind":"record"}\n{"kind":"record"}\n';
  const current = await fixture(payload);
  try {
    const result = run(current.manifestPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status":"verified"/u);
    assert.doesNotMatch(result.stdout, /"kind"/u);
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test('rejects a bundle that claims to contain a copied database', async () => {
  const current = await fixture('{"kind":"record"}\n', {
    source: {
      application: 'news-digest',
      commit: '0123456789abcdef0123456789abcdef01234567',
      exportType: 'approved-normalized-jsonl',
      databaseIncluded: true,
    },
  });
  try {
    const result = run(current.manifestPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not include a database/u);
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test('rejects a payload digest mismatch', async () => {
  const current = await fixture('{"kind":"record"}\n', {
    payload: {
      file: 'records.jsonl',
      sha256: '0'.repeat(64),
      recordCount: 1,
    },
  });
  try {
    const result = run(current.manifestPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /digest or record count/u);
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});
