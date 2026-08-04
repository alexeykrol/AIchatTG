import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import {
  createStartToken,
  createSiteOnboardingToken,
  decryptPrivateValue,
  decryptUpdateBody,
  encryptPrivateValue,
  encryptUpdateBody,
  privateValueFingerprint,
  sha256,
} from '../src/security.mjs';
import { openExistingStore } from '../src/ops-store.mjs';
import { GatekeeperStore } from '../src/store.mjs';

const temporaryDirectories = [];

function createTempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-gatekeeper-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function addInvitation(store) {
  return store.createInvitation({
    id: '11111111-1111-4111-8111-111111111111',
    chatId: '-1003840653970',
    user: { id: 196267257, first_name: 'Алексей', username: 'alexeykrol' },
    startTokenVersion: 1,
    startTokenSha256: sha256('opaque-token'),
    expiresAt: '2026-08-03T00:00:00.000Z',
    now: '2026-08-02T20:00:00.000Z',
  });
}

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('GatekeeperStore recovery', () => {
  test('operations fail closed instead of creating a missing database', () => {
    const directory = createTempDirectory();
    const dataRoot = path.join(directory, 'data');
    fs.mkdirSync(dataRoot, { mode: 0o700 });
    assert.throws(() => openExistingStore({
      GATEKEEPER_DATA_ROOT: dataRoot,
      GATEKEEPER_DATABASE_PATH: 'missing.sqlite',
    }), /does not exist/);
    assert.equal(fs.readdirSync(dataRoot).length, 0);
  });

  test('fails fast on an unversioned pre-release schema', () => {
    const directory = createTempDirectory();
    const databasePath = path.join(directory, 'old.sqlite');
    const old = new Database(databasePath);
    old.exec('CREATE TABLE gatekeeper_updates (update_id TEXT PRIMARY KEY, outcome TEXT)');
    old.close();
    assert.throws(() => new GatekeeperStore(databasePath), /unversioned Gatekeeper database is incompatible/);
  });

  test('migrates the exclusive v1 database additively and preserves invitations', () => {
    const directory = createTempDirectory();
    const databasePath = path.join(directory, 'v1.sqlite');
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE gatekeeper_metadata (
        application_id TEXT PRIMARY KEY CHECK (application_id = 'telegram-gatekeeper'),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1)
      );
      CREATE TABLE gatekeeper_events (
        event_key TEXT PRIMARY KEY, source TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
        user_id TEXT NOT NULL, chat_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE gatekeeper_invitations (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL,
        first_name TEXT, last_name TEXT, username TEXT,
        start_token_version INTEGER NOT NULL, start_token_sha256 TEXT NOT NULL UNIQUE,
        start_token_expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'contact_established', 'completed')),
        group_send_state TEXT NOT NULL CHECK (group_send_state IN ('none', 'intent', 'sent', 'failed', 'inconclusive')),
        group_send_attempts INTEGER NOT NULL DEFAULT 0, group_message_id TEXT,
        group_send_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        contact_established_at TEXT, completed_at TEXT, UNIQUE(chat_id, user_id)
      );
      CREATE TABLE gatekeeper_updates (
        update_id TEXT PRIMARY KEY, received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        raw_body_ciphertext TEXT NOT NULL, raw_body_iv TEXT NOT NULL, raw_body_tag TEXT NOT NULL,
        raw_body_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('processing', 'processed', 'failed', 'inconclusive')),
        attempts INTEGER NOT NULL DEFAULT 1, outcome TEXT, last_error TEXT
      );
      INSERT INTO gatekeeper_metadata VALUES ('telegram-gatekeeper', 1);
      INSERT INTO gatekeeper_events (
        event_key, source, payload_sha256, user_id, chat_id, created_at
      ) VALUES (
        'external:tribute-legacy-event', 'external_webhook', 'legacy-payload',
        '196267257', '-1003840653970', '2026-08-02T20:00:00.000Z'
      );
      INSERT INTO gatekeeper_invitations (
        id, chat_id, user_id, start_token_version, start_token_sha256,
        start_token_expires_at, status, group_send_state, created_at, updated_at
      ) VALUES (
        '11111111-1111-4111-8111-111111111111', '-1003840653970', '196267257',
        1, 'legacy-hash', '2026-08-03T00:00:00.000Z', 'pending', 'sent',
        '2026-08-02T20:00:00.000Z', '2026-08-02T20:00:00.000Z'
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = new GatekeeperStore(databasePath);
    try {
      assert.equal(migrated.db.pragma('user_version', { simple: true }), 3);
      assert.equal(migrated.findInvitationByUser('-1003840653970', 196267257).id,
        '11111111-1111-4111-8111-111111111111');
      assert.equal(migrated.findPrivateEmail('11111111-1111-4111-8111-111111111111'), undefined);
      assert.equal(migrated.hasEventSource({
        source: 'tribute', userId: 196267257, chatId: '-1003840653970',
      }), false);
      assert.equal(migrated.claimEvent({
        eventKey: 'external:tribute-legacy-event',
        source: 'tribute',
        payloadSha256: 'legacy-payload',
        userId: 196267257,
        chatId: '-1003840653970',
        now: '2026-08-03T00:00:00.000Z',
      }), 'duplicate');
      assert.equal(migrated.hasEventSource({
        source: 'tribute', userId: 196267257, chatId: '-1003840653970',
      }), true);
    } finally {
      migrated.close();
    }
  });

  test('creates a WAL-aware backup that contains committed rows', async () => {
    const directory = createTempDirectory();
    const source = path.join(directory, 'source.sqlite');
    const backup = path.join(directory, 'backup.sqlite');
    const store = new GatekeeperStore(source);
    addInvitation(store);
    await store.backup(backup);
    store.close();

    const restored = new GatekeeperStore(backup);
    try {
      assert.equal(restored.findInvitationByUser('-1003840653970', 196267257).status, 'pending');
    } finally {
      restored.close();
    }
  });

  test('surfaces and explicitly resolves uncertain group delivery', () => {
    const store = new GatekeeperStore(':memory:');
    try {
      const invitation = addInvitation(store);
      assert.equal(store.beginGroupSend(invitation.id, '2026-08-02T20:00:01.000Z'), true);
      assert.equal(store.operationalStatus().uncertain_invitations.length, 1);
      assert.equal(store.resolveGroupDelivery(invitation.id, {
        resolution: 'not_sent', now: '2026-08-02T20:00:02.000Z',
      }), true);
      assert.equal(store.beginGroupSend(invitation.id, '2026-08-02T20:00:03.000Z'), true);
    } finally {
      store.close();
    }
  });

  test('claims an update before side effects and requires explicit replay after uncertainty', () => {
    const store = new GatekeeperStore(':memory:');
    try {
      const rawBody = '{"update_id":1}';
      const input = {
        updateId: 1,
        encryptedBody: encryptUpdateBody(rawBody, 'link-signing-secret-at-least-32-chars', Buffer.alloc(12, 1)),
        rawBodySha256: sha256(rawBody),
        now: '2026-08-02T20:00:00.000Z',
      };
      assert.equal(store.claimUpdate(input), 'claimed');
      assert.equal(store.claimUpdate(input), 'processing');
      store.finishUpdate(1, {
        state: 'inconclusive', error: 'timeout', now: '2026-08-02T20:00:01.000Z',
      });
      assert.equal(store.claimUpdate(input), 'inconclusive');
      assert.equal(store.resolveUpdateProcessed(1, '2026-08-02T20:00:02.000Z'), true);
      assert.equal(store.findUpdate(1).state, 'processed');
      store.finishUpdate(1, {
        state: 'inconclusive', error: 'second timeout', now: '2026-08-02T20:00:03.000Z',
      });
      assert.equal(store.markUpdateRetryable(1, '2026-08-02T20:00:02.000Z'), true);
      assert.equal(store.claimUpdate(input), 'claimed');
      assert.equal(store.claimUpdate(input), 'processing');
      assert.equal(store.findUpdate(1).attempts, 2);
    } finally {
      store.close();
    }
  });

  test('claims one encrypted site case and never auto-retries a Zapier delivery', () => {
    const store = new GatekeeperStore(':memory:');
    try {
      const secret = 'link-signing-secret-at-least-32-chars';
      const id = '22222222-2222-4222-8222-222222222222';
      const token = createSiteOnboardingToken(id, 1, secret);
      const email = 'student@example.org';
      const input = {
        id,
        registrationEventId: 'site-event-1',
        payloadFingerprint: privateValueFingerprint('canonical-site-payload', secret),
        email: encryptPrivateValue(email, secret, Buffer.alloc(12, 8)),
        emailFingerprint: privateValueFingerprint(email, secret),
        startTokenVersion: 1,
        startTokenSha256: sha256(token),
        expiresAt: '2026-08-10T00:00:00.000Z',
        now: '2026-08-03T00:00:00.000Z',
      };
      const inviteIntent = {
        deliveryKey: 'gatekeeper-site-invite-atomic',
        eventType: 'site_invite_requested',
        onboardingCaseId: id,
        now: '2026-08-03T00:00:00.000Z',
      };
      const first = store.claimSiteCase(input, { zapierIntent: inviteIntent });
      assert.equal(first.claim, 'claimed');
      assert.equal(first.siteCase.email_ciphertext.includes(email), false);
      assert.equal(first.siteCase.payload_fingerprint.includes(email), false);
      assert.equal(store.findZapierDelivery(inviteIntent.deliveryKey).state, 'intent');
      assert.equal(store.claimSiteCase(input).claim, 'duplicate');
      assert.equal(store.claimSiteCase({
        ...input,
        payloadFingerprint: privateValueFingerprint('different', secret),
      }).claim, 'conflict');

      const delivery = {
        deliveryKey: 'gatekeeper-delivery-1',
        eventType: 'site_invite_requested',
        onboardingCaseId: id,
        now: '2026-08-03T00:00:01.000Z',
      };
      assert.equal(store.beginZapierDelivery(delivery).claim, 'duplicate');
      store.finishZapierDelivery(inviteIntent.deliveryKey, {
        state: 'inconclusive', error: 'transport_unknown', now: '2026-08-03T00:00:02.000Z',
      });
      assert.equal(store.beginZapierDelivery(delivery).claim, 'duplicate');
      assert.equal(store.findZapierDelivery(inviteIntent.deliveryKey).attempts, 1);
      const completionIntent = {
        deliveryKey: 'gatekeeper-site-completion-atomic',
        eventType: 'onboarding_completed',
        onboardingCaseId: id,
        now: '2026-08-03T00:00:03.000Z',
      };
      assert.equal(store.markSiteCaseCompleted(id, '2026-08-03T00:00:03.000Z', {
        zapierIntent: completionIntent,
      }).changed, true);
      assert.equal(store.findZapierDelivery(completionIntent.deliveryKey).state, 'intent');
      assert.equal(store.markSiteCaseCompleted(id, '2026-08-03T00:00:04.000Z').changed, false);

      const secondId = '44444444-4444-4444-8444-444444444444';
      const secondToken = createSiteOnboardingToken(secondId, 1, secret);
      assert.throws(() => store.claimSiteCase({
        ...input,
        id: secondId,
        registrationEventId: 'site-event-rollback',
        payloadFingerprint: privateValueFingerprint('rollback-payload', secret),
        startTokenSha256: sha256(secondToken),
      }, {
        zapierIntent: {
          deliveryKey: 'invalid-atomic-intent',
          eventType: 'unsupported',
          onboardingCaseId: secondId,
          now: '2026-08-03T00:00:05.000Z',
        },
      }), /CHECK constraint failed/u);
      assert.equal(store.findSiteCaseByRegistrationEventId('site-event-rollback'), undefined);
    } finally {
      store.close();
    }
  });
});

describe('opaque start tokens', () => {
  test('are reconstructable from runtime secret without storing the capability', () => {
    const secret = 'link-signing-secret-at-least-32-chars';
    const first = createStartToken('11111111-1111-4111-8111-111111111111', 1, secret);
    const reconstructed = createStartToken('11111111-1111-4111-8111-111111111111', 1, secret);
    const rotated = createStartToken('11111111-1111-4111-8111-111111111111', 2, secret);
    assert.equal(first, reconstructed);
    assert.notEqual(first, rotated);
    assert.match(first, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(`gk_done:${first}`.length <= 64);
  });

  test('uses a distinct reconstructable capability for site onboarding', () => {
    const secret = 'link-signing-secret-at-least-32-chars';
    const id = '22222222-2222-4222-8222-222222222222';
    const siteToken = createSiteOnboardingToken(id, 1, secret);
    assert.equal(siteToken, createSiteOnboardingToken(id, 1, secret));
    assert.notEqual(siteToken, createStartToken(id, 1, secret));
    assert.match(siteToken, /^w1_[A-Za-z0-9_-]+$/u);
  });

  test('encrypts stored Telegram updates and detects tampering', () => {
    const secret = 'link-signing-secret-at-least-32-chars';
    const rawBody = '{"message":{"text":"/start private_capability"}}';
    const encrypted = encryptUpdateBody(rawBody, secret, Buffer.alloc(12, 2));
    assert.equal(encrypted.ciphertext.includes('private_capability'), false);
    assert.equal(decryptUpdateBody(encrypted, secret), rawBody);
    assert.throws(() => decryptUpdateBody({ ...encrypted, tag: Buffer.alloc(16, 3).toString('base64url') }, secret));
  });

  test('uses a separate encryption context for private onboarding values', () => {
    const secret = 'link-signing-secret-at-least-32-chars';
    const email = 'student@example.org';
    const encrypted = encryptPrivateValue(email, secret, Buffer.alloc(12, 4));
    assert.equal(encrypted.ciphertext.includes(email), false);
    assert.equal(decryptPrivateValue(encrypted, secret), email);
    assert.throws(() => decryptUpdateBody(encrypted, secret));
    assert.match(privateValueFingerprint(email, secret), /^[a-f0-9]{64}$/u);
    assert.notEqual(privateValueFingerprint(email, secret), sha256(email));
  });
});
