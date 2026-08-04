import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildOperatorOverview } from '../src/read-model.mjs';

function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

function fixtureDatabases() {
  const directory = mkdtempSync(join(tmpdir(), 'aichattg-operator-'));
  const runtimePath = join(directory, 'runtime.sqlite');
  const gatekeeperPath = join(directory, 'gatekeeper.sqlite');
  const runtime = new Database(runtimePath);
  runtime.exec(`
    CREATE TABLE runtime_inbound_events (event_id TEXT, status TEXT);
    CREATE TABLE runtime_assistant_question_claims (chat_id TEXT, message_id TEXT, status TEXT);
    CREATE TABLE runtime_inbound_update_receipts (receipt_id TEXT, status TEXT, received_at INTEGER, completed_at INTEGER, recovered_at INTEGER);
    CREATE TABLE runtime_inbound_update_conflicts (id TEXT);
    CREATE TABLE runtime_moderation_records (id TEXT, verdict TEXT, created_at INTEGER);
    CREATE TABLE runtime_assistant_moderation_dispositions (status TEXT);
    CREATE TABLE runtime_moderation_weak_strikes (user_id TEXT);
    INSERT INTO runtime_inbound_events VALUES ('event-1', 'completed');
    INSERT INTO runtime_assistant_question_claims VALUES ('-100secretchat', '42', 'completed');
    INSERT INTO runtime_inbound_update_receipts VALUES ('receipt-secret', 'uncertain', 10, NULL, NULL);
    INSERT INTO runtime_moderation_records VALUES ('moderation-secret', 'blocked', 11);
    INSERT INTO runtime_assistant_moderation_dispositions VALUES ('allowed');
    INSERT INTO runtime_moderation_weak_strikes VALUES ('196267257');
  `);
  runtime.close();
  const gatekeeper = new Database(gatekeeperPath);
  gatekeeper.exec(`
    CREATE TABLE gatekeeper_invitations (id TEXT, status TEXT, group_send_state TEXT, updated_at TEXT, first_name TEXT, username TEXT);
    CREATE TABLE gatekeeper_updates (update_id TEXT, state TEXT, updated_at TEXT, raw_body_ciphertext TEXT, last_error TEXT);
    CREATE TABLE gatekeeper_site_cases (id TEXT, status TEXT);
    CREATE TABLE gatekeeper_zapier_deliveries (delivery_key TEXT, state TEXT, updated_at TEXT, last_error TEXT);
    INSERT INTO gatekeeper_invitations VALUES ('invite-secret', 'pending', 'inconclusive', '2026-08-04T00:00:00Z', 'Private Name', '@private_username');
    INSERT INTO gatekeeper_updates VALUES ('update-secret', 'processed', '2026-08-04T00:00:01Z', 'ciphertext-with-email@example.com', 'private failure');
    INSERT INTO gatekeeper_site_cases VALUES ('site-secret', 'completed');
    INSERT INTO gatekeeper_zapier_deliveries VALUES ('delivery-secret', 'sent', '2026-08-04T00:00:02Z', 'private url');
  `);
  gatekeeper.close();
  return { runtimePath, gatekeeperPath };
}

test('buildOperatorOverview reads only aggregates and redacted audit data', () => {
  const { runtimePath, gatekeeperPath } = fixtureDatabases();
  const beforeRuntime = sha256(runtimePath);
  const beforeGatekeeper = sha256(gatekeeperPath);
  const overview = buildOperatorOverview({
    config: {
      runtimeDatabasePath: runtimePath,
      gatekeeperDatabasePath: gatekeeperPath,
      runtimeFlags: { ingressEnabled: false, moderationMode: 'shadow', providerEnabled: false, notificationsEnabled: false },
      gatekeeperFlags: { scenarioReady: false, siteEnabled: false, zapierEnabled: false },
    },
    now: () => '2026-08-04T00:00:03.000Z',
  });
  assert.equal(overview.product, 'AIchatTG');
  assert.equal(overview.readOnly, true);
  assert.equal(overview.runtime.state, 'available');
  assert.equal(overview.gatekeeper.state, 'available');
  assert.equal(overview.runtime.counts.inboundReceipts.uncertain, 1);
  assert.equal(overview.gatekeeper.recovery.invitationDelivery, 1);
  assert.equal(beforeRuntime, sha256(runtimePath));
  assert.equal(beforeGatekeeper, sha256(gatekeeperPath));
  const serialized = JSON.stringify(overview);
  for (const privateValue of ['Private Name', '@private_username', 'email@example.com', 'private failure', '-100secretchat', '196267257', 'receipt-secret']) {
    assert.equal(serialized.includes(privateValue), false, `must not expose ${privateValue}`);
  }
  assert.match(serialized, /[a-f0-9]{16}/);
});

test('buildOperatorOverview reports absent databases without creating them', () => {
  const absent = join(mkdtempSync(join(tmpdir(), 'aichattg-operator-')), 'absent.sqlite');
  const overview = buildOperatorOverview({
    config: {
      runtimeDatabasePath: absent,
      gatekeeperDatabasePath: absent,
      runtimeFlags: {}, gatekeeperFlags: {},
    },
  });
  assert.equal(overview.runtime.state, 'unavailable');
  assert.equal(overview.gatekeeper.state, 'unavailable');
  assert.equal(existsSync(absent), false);
});
