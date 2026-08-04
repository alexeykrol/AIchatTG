import Database from 'better-sqlite3';

const ACTIVE_STATES = new Set(['pending', 'contact_established', 'completed']);
const APPLICATION_ID = 'telegram-gatekeeper';
const SCHEMA_VERSION = 3;
const BASE_TABLE_DEFINITIONS = {
  gatekeeper_metadata: `(
    application_id TEXT PRIMARY KEY CHECK (application_id = 'telegram-gatekeeper'),
    schema_version INTEGER NOT NULL
  )`,
  gatekeeper_events: `(
    event_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  gatekeeper_invitations: `(
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    start_token_version INTEGER NOT NULL,
    start_token_sha256 TEXT NOT NULL UNIQUE,
    start_token_expires_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'contact_established', 'completed')),
    group_send_state TEXT NOT NULL CHECK (group_send_state IN ('none', 'intent', 'sent', 'failed', 'inconclusive')),
    group_send_attempts INTEGER NOT NULL DEFAULT 0,
    group_message_id TEXT,
    group_send_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    contact_established_at TEXT,
    completed_at TEXT,
    UNIQUE(chat_id, user_id)
  )`,
  gatekeeper_updates: `(
    update_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    raw_body_ciphertext TEXT NOT NULL,
    raw_body_iv TEXT NOT NULL,
    raw_body_tag TEXT NOT NULL,
    raw_body_sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('processing', 'processed', 'failed', 'inconclusive')),
    attempts INTEGER NOT NULL DEFAULT 1,
    outcome TEXT,
    last_error TEXT
  )`,
};

const PRIVATE_EMAIL_TABLE = `(
  invitation_id TEXT PRIMARY KEY REFERENCES gatekeeper_invitations(id) ON DELETE CASCADE,
  email_ciphertext TEXT NOT NULL,
  email_iv TEXT NOT NULL,
  email_tag TEXT NOT NULL,
  email_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const SITE_CASE_TABLE = `(
  id TEXT PRIMARY KEY,
  registration_event_id TEXT NOT NULL UNIQUE,
  payload_fingerprint TEXT NOT NULL,
  email_ciphertext TEXT NOT NULL,
  email_iv TEXT NOT NULL,
  email_tag TEXT NOT NULL,
  email_fingerprint TEXT NOT NULL,
  telegram_user_id TEXT,
  telegram_username TEXT,
  start_token_version INTEGER NOT NULL,
  start_token_sha256 TEXT NOT NULL UNIQUE,
  start_token_expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
)`;

const ZAPIER_DELIVERY_TABLE = `(
  delivery_key TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('site_invite_requested', 'onboarding_completed')),
  onboarding_case_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intent', 'sent', 'failed', 'inconclusive')),
  attempts INTEGER NOT NULL DEFAULT 1,
  provider_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_type, onboarding_case_id)
)`;

const metadataTable = (version) => `(
  application_id TEXT PRIMARY KEY CHECK (application_id = 'telegram-gatekeeper'),
  schema_version INTEGER NOT NULL CHECK (schema_version = ${version})
)`;

const TABLE_DEFINITIONS_BY_VERSION = {
  1: { ...BASE_TABLE_DEFINITIONS, gatekeeper_metadata: metadataTable(1) },
  2: {
    ...BASE_TABLE_DEFINITIONS,
    gatekeeper_metadata: metadataTable(2),
    gatekeeper_private_emails: PRIVATE_EMAIL_TABLE,
  },
  3: {
    ...BASE_TABLE_DEFINITIONS,
    gatekeeper_metadata: metadataTable(3),
    gatekeeper_private_emails: PRIVATE_EMAIL_TABLE,
    gatekeeper_site_cases: SITE_CASE_TABLE,
    gatekeeper_zapier_deliveries: ZAPIER_DELIVERY_TABLE,
  },
};

const TABLE_DEFINITIONS = TABLE_DEFINITIONS_BY_VERSION[SCHEMA_VERSION];

function createTableSql(name, { ifNotExists = false, definitions = TABLE_DEFINITIONS } = {}) {
  return `CREATE TABLE${ifNotExists ? ' IF NOT EXISTS' : ''} ${name} ${definitions[name]}`;
}

function normalizeSchemaSql(sql) {
  return String(sql || '')
    .toLowerCase()
    .replace(/create\s+table\s+if\s+not\s+exists/, 'create table')
    .replace(/\s+/g, '');
}

export class GatekeeperStore {
  constructor(filename) {
    this.db = new Database(filename);
    try {
      this.assertExclusiveSchema();
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.migrate();
      this.assertExclusiveSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  assertExclusiveSchema() {
    const version = this.db.pragma('user_version', { simple: true });
    if (version !== 0 && !TABLE_DEFINITIONS_BY_VERSION[version]) {
      throw new Error(`unsupported Gatekeeper database schema version: ${version}`);
    }
    const schemaObjects = this.db.prepare(`
      SELECT type, name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    if (version === 0 && schemaObjects.length) {
      throw new Error('unversioned Gatekeeper database is incompatible; refusing a non-empty or shared database');
    }
    if (version === 0) return;

    const unexpectedObjects = schemaObjects.filter((object) => object.type !== 'table');
    if (unexpectedObjects.length) {
      throw new Error(`Gatekeeper database contains unexpected schema objects: ${unexpectedObjects.map((object) => object.name).join(', ')}`);
    }
    const userTables = schemaObjects;
    const definitions = TABLE_DEFINITIONS_BY_VERSION[version];
    const expectedNames = Object.keys(definitions).sort();
    const actualNames = userTables.map((row) => row.name);
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new Error(`Gatekeeper database schema ownership check failed: expected ${expectedNames.join(', ')}`);
    }
    for (const table of userTables) {
      const expectedSql = createTableSql(table.name, { definitions });
      if (normalizeSchemaSql(table.sql) !== normalizeSchemaSql(expectedSql)) {
        throw new Error(`Gatekeeper database schema mismatch for ${table.name}`);
      }
    }
    const markers = this.db.prepare(`
      SELECT application_id, schema_version FROM gatekeeper_metadata
    `).all();
    if (markers.length !== 1
      || markers[0].application_id !== APPLICATION_ID
      || markers[0].schema_version !== version) {
      throw new Error('Gatekeeper database application marker is missing or invalid');
    }
  }

  migrate() {
    const version = this.db.pragma('user_version', { simple: true });
    if (version !== 0 && !TABLE_DEFINITIONS_BY_VERSION[version]) {
      throw new Error(`unsupported Gatekeeper database schema version: ${version}`);
    }
    if (version === 1) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ${createTableSql('gatekeeper_private_emails', { definitions: TABLE_DEFINITIONS_BY_VERSION[2] })};
        ALTER TABLE gatekeeper_metadata RENAME TO gatekeeper_metadata_v1;
        ${createTableSql('gatekeeper_metadata', { definitions: TABLE_DEFINITIONS_BY_VERSION[2] })};
        INSERT INTO gatekeeper_metadata (application_id, schema_version)
        VALUES ('${APPLICATION_ID}', 2);
        DROP TABLE gatekeeper_metadata_v1;
        PRAGMA user_version = 2;
        COMMIT;
      `);
      this.migrate();
      return;
    }
    if (version === 2) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ${createTableSql('gatekeeper_site_cases', { definitions: TABLE_DEFINITIONS_BY_VERSION[3] })};
        ${createTableSql('gatekeeper_zapier_deliveries', { definitions: TABLE_DEFINITIONS_BY_VERSION[3] })};
        ALTER TABLE gatekeeper_metadata RENAME TO gatekeeper_metadata_v2;
        ${createTableSql('gatekeeper_metadata', { definitions: TABLE_DEFINITIONS_BY_VERSION[3] })};
        INSERT INTO gatekeeper_metadata (application_id, schema_version)
        VALUES ('${APPLICATION_ID}', 3);
        DROP TABLE gatekeeper_metadata_v2;
        PRAGMA user_version = 3;
        COMMIT;
      `);
      return;
    }
    if (version !== 0) return;
    const createStatements = Object.keys(TABLE_DEFINITIONS)
      .map((name) => `${createTableSql(name, { ifNotExists: true })};`)
      .join('\n');
    this.db.exec(`
      ${createStatements}
      INSERT INTO gatekeeper_metadata (application_id, schema_version)
      VALUES ('${APPLICATION_ID}', ${SCHEMA_VERSION});
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  close() {
    this.db.close();
  }

  claimEvent({ eventKey, source, payloadSha256, userId, chatId, now }) {
    const findExisting = this.db.prepare(`
      SELECT source, payload_sha256, user_id, chat_id FROM gatekeeper_events WHERE event_key = ?
    `);
    const matches = (row) => row?.payload_sha256 === payloadSha256
      && row.user_id === String(userId)
      && row.chat_id === String(chatId);
    const promoteExactLegacyTribute = (row) => {
      if (source !== 'tribute' || row?.source !== 'external_webhook') return;
      this.db.prepare(`
        UPDATE gatekeeper_events
        SET source = 'tribute'
        WHERE event_key = ? AND source = 'external_webhook'
          AND payload_sha256 = ? AND user_id = ? AND chat_id = ?
      `).run(eventKey, payloadSha256, String(userId), String(chatId));
    };
    const existing = findExisting.get(eventKey);
    if (existing) {
      if (!matches(existing)) return 'conflict';
      promoteExactLegacyTribute(existing);
      return 'duplicate';
    }
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO gatekeeper_events
        (event_key, source, payload_sha256, user_id, chat_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(eventKey, source, payloadSha256, String(userId), String(chatId), now);
    if (result.changes === 1) return 'claimed';
    const concurrent = findExisting.get(eventKey);
    if (!matches(concurrent)) return 'conflict';
    promoteExactLegacyTribute(concurrent);
    return 'duplicate';
  }

  hasEventSource({ source, userId, chatId }) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM gatekeeper_events
      WHERE source = ? AND user_id = ? AND chat_id = ?
      LIMIT 1
    `).get(source, String(userId), String(chatId)));
  }

  claimUpdate({ updateId, encryptedBody, rawBodySha256, now }) {
    const existing = this.findUpdate(updateId);
    if (existing) {
      if (existing.raw_body_sha256 !== rawBodySha256) return 'conflict';
      if (existing.state !== 'failed') return existing.state;
      const result = this.db.prepare(`
        UPDATE gatekeeper_updates
        SET state = 'processing', attempts = attempts + 1, updated_at = ?, last_error = NULL
        WHERE update_id = ? AND state = 'failed'
      `).run(now, String(updateId));
      if (result.changes === 1) return 'claimed';
      const concurrent = this.findUpdate(updateId);
      if (concurrent?.raw_body_sha256 !== rawBodySha256) return 'conflict';
      return concurrent?.state || 'conflict';
    }
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO gatekeeper_updates
        (update_id, received_at, updated_at, raw_body_ciphertext, raw_body_iv,
         raw_body_tag, raw_body_sha256, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')
    `).run(
      String(updateId), now, now, encryptedBody.ciphertext,
      encryptedBody.iv, encryptedBody.tag, rawBodySha256,
    );
    if (result.changes === 1) return 'claimed';
    const concurrent = this.findUpdate(updateId);
    return concurrent?.raw_body_sha256 === rawBodySha256 ? concurrent.state : 'conflict';
  }

  findUpdate(updateId) {
    return this.db.prepare('SELECT * FROM gatekeeper_updates WHERE update_id = ?').get(String(updateId));
  }

  finishUpdate(updateId, { state, outcome = null, error = null, now }) {
    this.db.prepare(`
      UPDATE gatekeeper_updates
      SET state = ?, outcome = ?, last_error = ?, updated_at = ?
      WHERE update_id = ?
    `).run(state, outcome, error, now, String(updateId));
  }

  markUpdateRetryable(updateId, now) {
    const result = this.db.prepare(`
      UPDATE gatekeeper_updates
      SET state = 'failed', updated_at = ?, last_error = 'operator confirmed prior side effect absent'
      WHERE update_id = ? AND state IN ('processing', 'inconclusive', 'failed')
    `).run(now, String(updateId));
    return result.changes === 1;
  }

  resolveUpdateProcessed(updateId, now) {
    const result = this.db.prepare(`
      UPDATE gatekeeper_updates
      SET state = 'processed', updated_at = ?,
          outcome = 'operator confirmed prior side effect delivered', last_error = NULL
      WHERE update_id = ? AND state IN ('processing', 'inconclusive')
    `).run(now, String(updateId));
    return result.changes === 1;
  }

  findInvitationByUser(chatId, userId) {
    return this.db.prepare(`
      SELECT * FROM gatekeeper_invitations WHERE chat_id = ? AND user_id = ?
    `).get(String(chatId), String(userId));
  }

  findInvitationByTokenHash(tokenHash) {
    return this.db.prepare(`
      SELECT * FROM gatekeeper_invitations WHERE start_token_sha256 = ?
    `).get(tokenHash);
  }

  createInvitation(invitation) {
    this.db.prepare(`
      INSERT OR IGNORE INTO gatekeeper_invitations (
        id, chat_id, user_id, first_name, last_name, username,
        start_token_version, start_token_sha256, start_token_expires_at, status, group_send_state,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'none', ?, ?)
    `).run(
      invitation.id,
      String(invitation.chatId),
      String(invitation.user.id),
      invitation.user.first_name || null,
      invitation.user.last_name || null,
      invitation.user.username || null,
      invitation.startTokenVersion,
      invitation.startTokenSha256,
      invitation.expiresAt,
      invitation.now,
      invitation.now,
    );
    return this.findInvitationByUser(invitation.chatId, invitation.user.id);
  }

  rotateInvitationToken(invitationId, { expectedVersion, nextVersion, startTokenSha256, expiresAt, now }) {
    const result = this.db.prepare(`
      UPDATE gatekeeper_invitations
      SET start_token_version = ?, start_token_sha256 = ?, start_token_expires_at = ?,
          group_send_state = 'none', group_message_id = NULL, group_send_error = NULL,
          updated_at = ?
      WHERE id = ? AND status = 'pending' AND start_token_version = ?
    `).run(nextVersion, startTokenSha256, expiresAt, now, invitationId, expectedVersion);
    if (result.changes !== 1) return null;
    return this.db.prepare('SELECT * FROM gatekeeper_invitations WHERE id = ?').get(invitationId);
  }

  beginGroupSend(invitationId, now) {
    const result = this.db.prepare(`
      UPDATE gatekeeper_invitations
      SET group_send_state = 'intent', group_send_attempts = group_send_attempts + 1,
          group_send_error = NULL, updated_at = ?
      WHERE id = ? AND group_send_state IN ('none', 'failed')
    `).run(now, invitationId);
    return result.changes === 1;
  }

  finishGroupSend(invitationId, { state, messageId = null, error = null, now }) {
    this.db.prepare(`
      UPDATE gatekeeper_invitations
      SET group_send_state = ?, group_message_id = COALESCE(?, group_message_id),
          group_send_error = ?, updated_at = ?
      WHERE id = ?
    `).run(state, messageId == null ? null : String(messageId), error, now, invitationId);
  }

  resolveGroupDelivery(invitationId, { resolution, messageId = null, now }) {
    const state = resolution === 'sent' ? 'sent' : resolution === 'not_sent' ? 'failed' : null;
    if (!state) throw new Error('resolution must be sent or not_sent');
    const result = this.db.prepare(`
      UPDATE gatekeeper_invitations
      SET group_send_state = ?, group_message_id = CASE WHEN ? = 'sent' THEN ? ELSE NULL END,
          group_send_error = CASE WHEN ? = 'failed' THEN 'operator confirmed prior send absent' ELSE NULL END,
          updated_at = ?
      WHERE id = ? AND group_send_state IN ('intent', 'inconclusive')
    `).run(state, state, messageId == null ? null : String(messageId), state, now, invitationId);
    return result.changes === 1;
  }

  markContactEstablished(invitationId, now) {
    this.db.prepare(`
      UPDATE gatekeeper_invitations
      SET status = CASE WHEN status = 'pending' THEN 'contact_established' ELSE status END,
          contact_established_at = COALESCE(contact_established_at, ?), updated_at = ?
      WHERE id = ?
    `).run(now, now, invitationId);
    return this.db.prepare('SELECT * FROM gatekeeper_invitations WHERE id = ?').get(invitationId);
  }

  findPrivateEmail(invitationId) {
    return this.db.prepare(`
      SELECT * FROM gatekeeper_private_emails WHERE invitation_id = ?
    `).get(invitationId);
  }

  storePrivateEmail(invitationId, { ciphertext, iv, tag, emailFingerprint, now }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO gatekeeper_private_emails (
        invitation_id, email_ciphertext, email_iv, email_tag, email_fingerprint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(invitationId, ciphertext, iv, tag, emailFingerprint, now, now);
    return this.findPrivateEmail(invitationId);
  }

  markCompleted(invitationId, now) {
    this.db.prepare(`
      UPDATE gatekeeper_invitations
      SET status = 'completed', completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE id = ? AND status IN ('contact_established', 'completed')
    `).run(now, now, invitationId);
    return this.db.prepare('SELECT * FROM gatekeeper_invitations WHERE id = ?').get(invitationId);
  }

  findSiteCaseByRegistrationEventId(registrationEventId) {
    return this.db.prepare(`
      SELECT * FROM gatekeeper_site_cases WHERE registration_event_id = ?
    `).get(String(registrationEventId));
  }

  findSiteCaseById(id) {
    return this.db.prepare('SELECT * FROM gatekeeper_site_cases WHERE id = ?').get(String(id));
  }

  findSiteCaseByTokenHash(tokenHash) {
    return this.db.prepare(`
      SELECT * FROM gatekeeper_site_cases WHERE start_token_sha256 = ?
    `).get(tokenHash);
  }

  insertZapierIntent(delivery) {
    this.db.prepare(`
      INSERT INTO gatekeeper_zapier_deliveries (
        delivery_key, event_type, onboarding_case_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, 'intent', ?, ?)
    `).run(
      delivery.deliveryKey,
      delivery.eventType,
      String(delivery.onboardingCaseId),
      delivery.now,
      delivery.now,
    );
    return this.findZapierDelivery(delivery.deliveryKey);
  }

  claimSiteCase(siteCase, { zapierIntent = null } = {}) {
    const transaction = this.db.transaction(() => {
      const existing = this.findSiteCaseByRegistrationEventId(siteCase.registrationEventId);
      if (existing) {
        return {
          claim: existing.payload_fingerprint === siteCase.payloadFingerprint ? 'duplicate' : 'conflict',
          siteCase: existing,
        };
      }
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO gatekeeper_site_cases (
          id, registration_event_id, payload_fingerprint,
          email_ciphertext, email_iv, email_tag, email_fingerprint,
          telegram_user_id, telegram_username,
          start_token_version, start_token_sha256, start_token_expires_at,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        siteCase.id,
        String(siteCase.registrationEventId),
        siteCase.payloadFingerprint,
        siteCase.email.ciphertext,
        siteCase.email.iv,
        siteCase.email.tag,
        siteCase.emailFingerprint,
        siteCase.telegramUserId == null ? null : String(siteCase.telegramUserId),
        siteCase.telegramUsername || null,
        siteCase.startTokenVersion,
        siteCase.startTokenSha256,
        siteCase.expiresAt,
        siteCase.now,
        siteCase.now,
      );
      if (result.changes === 1) {
        if (zapierIntent) this.insertZapierIntent(zapierIntent);
        return { claim: 'claimed', siteCase: this.findSiteCaseById(siteCase.id) };
      }
      const concurrent = this.findSiteCaseByRegistrationEventId(siteCase.registrationEventId);
      return {
        claim: concurrent?.payload_fingerprint === siteCase.payloadFingerprint ? 'duplicate' : 'conflict',
        siteCase: concurrent,
      };
    });
    return transaction();
  }

  markSiteCaseCompleted(id, now, { zapierIntent = null } = {}) {
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE gatekeeper_site_cases
        SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(now, now, String(id));
      if (result.changes === 1 && zapierIntent) this.insertZapierIntent(zapierIntent);
      return {
        changed: result.changes === 1,
        siteCase: this.findSiteCaseById(id),
      };
    });
    return transaction();
  }

  markCompletedWithZapierIntent(invitationId, now, zapierIntent) {
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE gatekeeper_invitations
        SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'contact_established'
      `).run(now, now, invitationId);
      if (result.changes === 1) this.insertZapierIntent(zapierIntent);
      return {
        changed: result.changes === 1,
        invitation: this.db.prepare('SELECT * FROM gatekeeper_invitations WHERE id = ?').get(invitationId),
      };
    });
    return transaction();
  }

  beginZapierDelivery({ deliveryKey, eventType, onboardingCaseId, now }) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO gatekeeper_zapier_deliveries (
        delivery_key, event_type, onboarding_case_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, 'intent', ?, ?)
    `).run(deliveryKey, eventType, String(onboardingCaseId), now, now);
    if (result.changes === 1) {
      return { claim: 'claimed', delivery: this.findZapierDelivery(deliveryKey) };
    }
    return { claim: 'duplicate', delivery: this.findZapierDelivery(deliveryKey) };
  }

  findZapierDelivery(deliveryKey) {
    return this.db.prepare(`
      SELECT * FROM gatekeeper_zapier_deliveries WHERE delivery_key = ?
    `).get(String(deliveryKey));
  }

  finishZapierDelivery(deliveryKey, { state, providerStatus = null, error = null, now }) {
    if (!['sent', 'failed', 'inconclusive'].includes(state)) {
      throw new Error('Zapier delivery state must be sent, failed, or inconclusive');
    }
    const result = this.db.prepare(`
      UPDATE gatekeeper_zapier_deliveries
      SET state = ?, provider_status = ?, last_error = ?, updated_at = ?
      WHERE delivery_key = ? AND state = 'intent'
    `).run(state, providerStatus, error, now, String(deliveryKey));
    return result.changes === 1 ? this.findZapierDelivery(deliveryKey) : null;
  }

  summary() {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM gatekeeper_invitations GROUP BY status
    `).all();
    const counts = { pending: 0, contact_established: 0, completed: 0 };
    for (const row of rows) {
      if (ACTIVE_STATES.has(row.status)) counts[row.status] = row.count;
    }
    return counts;
  }

  siteSummary() {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM gatekeeper_site_cases GROUP BY status
    `).all();
    const counts = { pending: 0, completed: 0 };
    for (const row of rows) {
      if (Object.hasOwn(counts, row.status)) counts[row.status] = row.count;
    }
    return counts;
  }

  operationalStatus() {
    return {
      onboarding: this.summary(),
      delivery: this.db.prepare(`
        SELECT group_send_state AS state, COUNT(*) AS count
        FROM gatekeeper_invitations GROUP BY group_send_state
      `).all(),
      uncertain_invitations: this.db.prepare(`
        SELECT id, chat_id, user_id, group_send_state, group_send_attempts, updated_at
        FROM gatekeeper_invitations
        WHERE group_send_state IN ('intent', 'inconclusive')
        ORDER BY updated_at
      `).all(),
      uncertain_updates: this.db.prepare(`
        SELECT update_id, state, attempts, updated_at, last_error
        FROM gatekeeper_updates
        WHERE state IN ('processing', 'inconclusive')
        ORDER BY updated_at
      `).all(),
      site_onboarding: this.siteSummary(),
      uncertain_zapier_deliveries: this.db.prepare(`
        SELECT delivery_key, event_type, onboarding_case_id, state, attempts, updated_at, last_error
        FROM gatekeeper_zapier_deliveries
        WHERE state IN ('intent', 'inconclusive')
        ORDER BY updated_at
      `).all(),
    };
  }

  backup(destination) {
    return this.db.backup(destination);
  }
}
