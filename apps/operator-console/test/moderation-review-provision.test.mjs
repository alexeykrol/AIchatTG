import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { provisionModerationReview } from '../src/moderation-review-provision.mjs';
import { createModerationReviewStore } from '../src/moderation-review-store.mjs';
import { reviewCapturePolicy } from '../../../packages/telegram-core/src/moderation-review-config.mjs';

const NOW = Date.parse('2026-09-17T12:00:00.000Z');
const COUNTS = { retained: 0, pending: 0, reviewed: 0, patterns: 0 };
const SUCCESS = { status: 'provisioned', schemaVersion: 2, counts: COUNTS, collectionStarted: false, deliveryStarted: false };
const CLI = fileURLToPath(new URL('../src/moderation-review-provision.mjs', import.meta.url));
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(t, overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-provision-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = {
    contract: 'moderation-review-binding/v1', enabled: true, bindingId: 'synthetic_binding', epochId: 'synthetic_epoch',
    chatIds: ['-100101'], startAt: '2026-09-17T11:00:00.000Z', allowUserId: false, exemptBotIds: ['9001', '9002'],
    limits: { retentionMs: null, maxTextChars: 256, maxContextChars: 128, maxNoteChars: 256, maxObservations: 100 },
    maxEvents: 100, maxErasureReceipts: 100, maxInflight: 2, captureTimeoutMs: 100, ipcTimeoutMs: 100,
    notificationTimeoutMs: 1000, notificationIntervalMs: 1000, maxAlertsPerHour: 5,
    recipientChatId: '777001', reviewerPrincipal: 'synthetic-owner', consoleUrl: 'https://review.example.invalid',
    ipcRoot: join(root, 'ipc'), storeRoot: join(root, 'store'), deliveryEnabled: true, ...overrides,
  };
  const file = join(root, 'binding.json');
  const save = () => { writeFileSync(file, JSON.stringify(binding), { mode: 0o600 }); chmodSync(file, 0o600); };
  save();
  return { root, file, binding, save, database: join(binding.storeRoot, 'moderation-review.sqlite') };
}
function reopen(binding) {
  return createModerationReviewStore({ root: binding.storeRoot, mode: 'live', limits: binding.limits,
    capturePolicy: reviewCapturePolicy(binding), maxEvents: binding.maxEvents,
    maxErasureReceipts: binding.maxErasureReceipts, maxAlertsPerHour: binding.maxAlertsPerHour, now: () => NOW });
}

test('provisioning requires exactly one explicit flag and private binding path', (t) => {
  const f = fixture(t);
  for (const args of [[], [f.file], ['--provision'], ['--provision', ''], ['--force', f.file],
    ['--provision', f.file, '--force'], ['--provision', f.file, f.file], null, undefined, {}]) {
    assert.throws(() => provisionModerationReview(args), /review_provision_explicit_binding_required/u);
    assert.equal(existsSync(f.binding.storeRoot), false);
    assert.equal(existsSync(f.binding.ipcRoot), false);
  }
});

test('missing, invalid, nonprivate and symbolic binding files fail before any store creation', (t) => {
  const f = fixture(t);
  for (const path of ['relative-binding.json', join(f.root, 'absent.json'), f.root]) {
    assert.throws(() => provisionModerationReview(['--provision', path]), /review_binding_unavailable/u);
  }
  chmodSync(f.file, 0o644);
  assert.throws(() => provisionModerationReview(['--provision', f.file]), /review_binding_unavailable/u);
  f.save();
  const symbolic = join(f.root, 'symbolic.json'); symlinkSync(f.file, symbolic);
  assert.throws(() => provisionModerationReview(['--provision', symbolic]), /review_binding_unavailable/u);
  writeFileSync(f.file, '{"private":"malformed', { mode: 0o600 });
  assert.throws(() => provisionModerationReview(['--provision', f.file]), /review_binding_unavailable/u);
  f.binding.enabled = false; f.save();
  assert.throws(() => provisionModerationReview(['--provision', f.file]), /review_binding_unavailable/u);
  assert.equal(existsSync(f.binding.storeRoot), false);
  assert.equal(existsSync(f.binding.ipcRoot), false);
});

test('fresh provisioning creates valid private v2 store with all collection and delivery tables empty', (t) => {
  const f = fixture(t);
  assert.deepEqual(provisionModerationReview(['--provision', f.file]), SUCCESS);
  assert.equal(lstatSync(f.binding.storeRoot).mode & 0o777, 0o700);
  assert.equal(lstatSync(f.database).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.binding.storeRoot), ['moderation-review.sqlite']);
  assert.equal(existsSync(f.binding.ipcRoot), false);
  const db = new Database(f.database, { readonly: true });
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    for (const table of ['review_cases', 'review_observations', 'review_decisions', 'review_decision_evidence',
      'review_patterns', 'review_alerts', 'review_erasure_receipts', 'review_native_sources',
      'review_source_revisions', 'review_intake_events', 'review_dispatch_authorizations']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
    }
    assert.equal(db.prepare('SELECT intake_seq FROM review_intake_binding').get().intake_seq, 0);
    assert.deepEqual(db.prepare('SELECT hour,used FROM review_alert_budget').get(), { hour: 0, used: 0 });
  } finally { db.close(); }
  const store = reopen(f.binding);
  try { assert.deepEqual(store.status().counts, COUNTS); assert.equal(store.claimAlert(), null); }
  finally { store.close(); }
  assert.equal(existsSync(join(f.binding.storeRoot, '.review-owner')), false);
});

test('an existing empty private directory is acceptable, but its permissions are never silently repaired', (t) => {
  const fresh = fixture(t); mkdirSync(fresh.binding.storeRoot, { mode: 0o700 });
  assert.deepEqual(provisionModerationReview(['--provision', fresh.file]), SUCCESS);
  const unsafe = fixture(t); mkdirSync(unsafe.binding.storeRoot, { mode: 0o755 }); chmodSync(unsafe.binding.storeRoot, 0o755);
  assert.throws(() => provisionModerationReview(['--provision', unsafe.file]), /review_storage_invalid/u);
  assert.equal(lstatSync(unsafe.binding.storeRoot).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(unsafe.binding.storeRoot), []);
});

test('second provisioning refuses an existing store and preserves exact database bytes and metadata', (t) => {
  const f = fixture(t); provisionModerationReview(['--provision', f.file]);
  const before = digest(f.database), stat = lstatSync(f.database);
  assert.throws(() => provisionModerationReview(['--provision', f.file]), /review_provision_requires_fresh_store/u);
  assert.equal(digest(f.database), before);
  assert.equal(lstatSync(f.database).ino, stat.ino);
  assert.equal(lstatSync(f.database).mtimeMs, stat.mtimeMs);
  assert.deepEqual(readdirSync(f.binding.storeRoot), ['moderation-review.sqlite']);
  const store = reopen(f.binding); store.close();
});

test('nonempty, regular-file and direct symbolic store roots are preserved untouched', (t) => {
  const nonempty = fixture(t); mkdirSync(nonempty.binding.storeRoot, { mode: 0o700 });
  const sentinel = join(nonempty.binding.storeRoot, 'do-not-overwrite'); writeFileSync(sentinel, 'synthetic retained file');
  assert.throws(() => provisionModerationReview(['--provision', nonempty.file]), /review_provision_requires_fresh_store/u);
  assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic retained file');
  assert.deepEqual(readdirSync(nonempty.binding.storeRoot), ['do-not-overwrite']);
  const regular = fixture(t); writeFileSync(regular.binding.storeRoot, 'synthetic file');
  assert.throws(() => provisionModerationReview(['--provision', regular.file]), /review_provision_requires_fresh_store/u);
  assert.equal(readFileSync(regular.binding.storeRoot, 'utf8'), 'synthetic file');
  const symbolic = fixture(t), target = join(symbolic.root, 'target'); mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, symbolic.binding.storeRoot);
  assert.throws(() => provisionModerationReview(['--provision', symbolic.file]), /review_provision_root_unsafe/u);
  assert.deepEqual(readdirSync(target), []); assert.equal(lstatSync(symbolic.binding.storeRoot).isSymbolicLink(), true);
});

test('symbolic ancestor cannot redirect fresh provisioning outside the declared real root', (t) => {
  const f = fixture(t), target = join(f.root, 'target'), link = join(f.root, 'alias');
  mkdirSync(target, { mode: 0o700 }); symlinkSync(target, link);
  f.binding.storeRoot = join(link, 'fresh'); f.save();
  assert.throws(() => provisionModerationReview(['--provision', f.file]), /review_(?:provision|storage)_/u);
  assert.deepEqual(readdirSync(target), []);
  assert.equal(existsSync(join(f.root, 'store')), false);
});

test('provisioning does not invoke IPC listeners, timers, HTTP, fetch or a collection service', (t) => {
  const f = fixture(t), originals = { fetch: globalThis.fetch, interval: globalThis.setInterval,
    timeout: globalThis.setTimeout, listen: net.Server.prototype.listen, http: http.request, https: https.request };
  let effects = 0;
  const forbidden = () => { effects++; throw new Error('synthetic external effect forbidden'); };
  try {
    globalThis.fetch = forbidden; globalThis.setInterval = forbidden; globalThis.setTimeout = forbidden;
    net.Server.prototype.listen = forbidden; http.request = forbidden; https.request = forbidden;
    assert.deepEqual(provisionModerationReview(['--provision', f.file]), SUCCESS);
  } finally {
    globalThis.fetch = originals.fetch; globalThis.setInterval = originals.interval; globalThis.setTimeout = originals.timeout;
    net.Server.prototype.listen = originals.listen; http.request = originals.http; https.request = originals.https;
  }
  assert.equal(effects, 0); assert.equal(existsSync(f.binding.ipcRoot), false);
  assert.deepEqual(readdirSync(f.root).sort(), ['binding.json', 'store']);
});

test('CLI succeeds once offline and emits only generic failure text on repeated or invalid invocation', (t) => {
  const f = fixture(t);
  const invoke = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 5000 });
  const success = invoke(['--provision', f.file]);
  assert.equal(success.status, 0); assert.equal(success.stderr, ''); assert.deepEqual(JSON.parse(success.stdout), SUCCESS);
  const before = digest(f.database);
  for (const args of [[], ['--provision', f.file], ['--provision', join(f.root, 'absent.json')]]) {
    const result = invoke(args);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'review_provision_failed; preserve existing files and inspect offline');
    assert.equal(result.stderr.includes(f.root), false);
    assert.equal(result.stderr.includes('777001'), false);
    assert.equal(digest(f.database), before);
  }
});
