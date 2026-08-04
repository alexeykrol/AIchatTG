import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_inbound_events (
  event_id TEXT PRIMARY KEY,
  bot_role TEXT NOT NULL CHECK(bot_role IN ('moderator', 'assistant')),
  update_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'skipped', 'error')),
  result_json TEXT,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
-- A receipt names one delivery from one bot stream. A claim is deliberately
-- separate from that receipt: stale workers may never finalize a row once its
-- claim generation has been fenced by controlled recovery.
CREATE TABLE IF NOT EXISTS runtime_inbound_update_receipts (
  receipt_id TEXT PRIMARY KEY,
  bot_role TEXT NOT NULL CHECK(bot_role IN ('moderator', 'assistant')),
  update_id INTEGER NOT NULL CHECK(update_id >= 0),
  revision_identity TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  claim_generation INTEGER NOT NULL CHECK(claim_generation >= 1),
  status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'skipped', 'uncertain')),
  result_json TEXT,
  error_code TEXT,
  recovery_id TEXT,
  received_at INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  completed_at INTEGER,
  recovered_at INTEGER,
  UNIQUE(bot_role, update_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_inbound_update_receipts_recovery
  ON runtime_inbound_update_receipts(status, received_at);
CREATE TABLE IF NOT EXISTS runtime_inbound_update_conflicts (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES runtime_inbound_update_receipts(receipt_id),
  revision_identity TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  UNIQUE(receipt_id, payload_fingerprint)
);
CREATE TABLE IF NOT EXISTS runtime_moderation_records (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES runtime_inbound_events(event_id),
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT,
  verdict TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  mode TEXT NOT NULL,
  action_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_assistant_dialogues (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_activity_at INTEGER NOT NULL,
  UNIQUE(chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS runtime_assistant_turns (
  id TEXT PRIMARY KEY,
  dialogue_id TEXT NOT NULL REFERENCES runtime_assistant_dialogues(id),
  event_id TEXT NOT NULL UNIQUE REFERENCES runtime_inbound_events(event_id),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  model_id TEXT,
  receipt_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_assistant_question_claims (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing', 'completed')),
  outcome TEXT,
  claimed_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (chat_id, message_id)
);
-- A reservation starts before model/delivery work and is released only for a
-- definitely-unsent reply. The uncertain state is intentionally retained: the inbound
-- delivery receipt will not blindly replay a Telegram action with an unknown
-- outcome.
CREATE TABLE IF NOT EXISTS runtime_assistant_request_reservations (
  event_id TEXT PRIMARY KEY REFERENCES runtime_inbound_events(event_id),
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved', 'completed', 'uncertain')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runtime_assistant_request_rate
  ON runtime_assistant_request_reservations(chat_id, user_id, status, created_at);
CREATE TABLE IF NOT EXISTS runtime_assistant_moderation_dispositions (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'allowed', 'blocked', 'error')),
  moderation_message_id TEXT,
  verdict TEXT,
  reason TEXT,
  moderation_event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_assistant_moderation_status
  ON runtime_assistant_moderation_dispositions(status, updated_at);
CREATE TABLE IF NOT EXISTS runtime_moderation_weak_strikes (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  weak_strikes INTEGER NOT NULL CHECK(weak_strikes >= 0),
  warning_stage TEXT NOT NULL DEFAULT 'none' CHECK(warning_stage IN ('none', 'first', 'final')),
  warning_delivered_at INTEGER,
  last_event_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
-- One native Telegram message may have several edit revisions. A weak-abuse
-- strike is claimed at most once across those revisions, matching the deployed
-- Guard policy and preventing edits from escalating a member repeatedly.
CREATE TABLE IF NOT EXISTS runtime_moderation_message_ledger (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT,
  latest_revision_identity TEXT NOT NULL,
  weak_strike_event_id TEXT,
  deletion_state TEXT,
  deletion_at INTEGER,
  PRIMARY KEY (chat_id, message_id)
);
-- External enforcement is a finite state machine. It deliberately contains no
-- source text, answer text, token, or raw Telegram payload. A step marked
-- calling or uncertain is never re-issued automatically because Telegram
-- action endpoints do not offer a caller-provided idempotency key.
CREATE TABLE IF NOT EXISTS runtime_moderation_enforcement_receipts (
  event_id TEXT PRIMARY KEY REFERENCES runtime_inbound_events(event_id),
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  policy_action TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  guard_proof_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('planned', 'calling', 'completed', 'skipped', 'uncertain')),
  receipt_json TEXT,
  error_code TEXT,
  claim_id TEXT NOT NULL,
  claim_generation INTEGER NOT NULL CHECK(claim_generation >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runtime_moderation_enforcement_recovery
  ON runtime_moderation_enforcement_receipts(status, updated_at);
-- Pin governance is separate from safety enforcement.  Telegram can surface
-- one channel auto-forward as both the post and a pinned-message service event;
-- this native-key claim makes the harmless unpin exactly-once across those
-- deliveries and keeps an unknown Telegram outcome fenced for operator review.
CREATE TABLE IF NOT EXISTS runtime_moderation_auto_unpins (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  first_event_id TEXT NOT NULL UNIQUE REFERENCES runtime_inbound_events(event_id),
  state TEXT NOT NULL CHECK(state IN ('planned', 'calling', 'completed', 'skipped', 'uncertain')),
  result_json TEXT,
  error_code TEXT,
  claimed_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_moderation_auto_unpins_recovery
  ON runtime_moderation_auto_unpins(state, claimed_at);
-- A manual/owner pin is never unpinned.  Retaining its native identity mirrors
-- the deployed Moderator's owner-pin state without storing message text.
CREATE TABLE IF NOT EXISTS runtime_moderation_owner_pins (
  chat_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES runtime_inbound_events(event_id),
  remembered_at INTEGER NOT NULL
);
`;

const MIGRATION_RECEIPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_migration_receipts (
  bundle_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL UNIQUE,
  source_commit TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  controller_lease_id TEXT NOT NULL,
  product_owner_approval_id TEXT NOT NULL,
  record_count INTEGER NOT NULL CHECK(record_count >= 0),
  record_summary_json TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

export function openRuntimeDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  ensureRuntimeDatabaseSchema(db);
  return db;
}

export function ensureRuntimeDatabaseSchema(db) {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  // The pre-Guard standalone runtime created this table without warning state.
  // Keep the expansion guarded and additive so an existing isolated runtime DB
  // opens safely without a destructive table rebuild.
  const columns = new Set(db.prepare('PRAGMA table_info(runtime_moderation_weak_strikes)').all().map((row) => row.name));
  if (!columns.has('warning_stage')) db.exec("ALTER TABLE runtime_moderation_weak_strikes ADD COLUMN warning_stage TEXT NOT NULL DEFAULT 'none'");
  if (!columns.has('warning_delivered_at')) db.exec('ALTER TABLE runtime_moderation_weak_strikes ADD COLUMN warning_delivered_at INTEGER');
  if (!columns.has('last_event_id')) db.exec('ALTER TABLE runtime_moderation_weak_strikes ADD COLUMN last_event_id TEXT');
  const messageColumns = new Set(db.prepare('PRAGMA table_info(runtime_moderation_message_ledger)').all().map((row) => row.name));
  if (!messageColumns.has('user_id')) db.exec('ALTER TABLE runtime_moderation_message_ledger ADD COLUMN user_id TEXT');
}

/**
 * Used only by the state importer. Existing files are opened without schema or
 * journal changes so the importer can prove they are the runtime database
 * before it mutates them.
 */
export function openRuntimeDatabaseForImport(databasePath) {
  return new Database(databasePath);
}

export function openReadOnlyRuntimeDatabase(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * The state importer calls this inside its transaction. The runtime itself does
 * not create migration receipts during normal webhook processing.
 */
export function ensureRuntimeMigrationReceiptSchema(db) {
  db.exec(MIGRATION_RECEIPT_SCHEMA);
}

export function createRuntimeStore(db, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  const claim = db.prepare(`INSERT INTO runtime_inbound_events
    (event_id, bot_role, update_id, status, created_at) VALUES (?, ?, ?, 'processing', ?)
    ON CONFLICT(event_id) DO NOTHING`);
  const event = db.prepare('SELECT * FROM runtime_inbound_events WHERE event_id = ?');
  const finish = db.prepare(`UPDATE runtime_inbound_events
    SET status = ?, result_json = ?, error_text = ?, completed_at = ? WHERE event_id = ?`);
  const inboundReceipt = db.prepare('SELECT * FROM runtime_inbound_update_receipts WHERE receipt_id = ?');
  const createInboundReceipt = db.prepare(`INSERT INTO runtime_inbound_update_receipts
    (receipt_id, bot_role, update_id, revision_identity, payload_fingerprint,
     claim_id, claim_generation, status, received_at, claimed_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'processing', ?, ?)
    ON CONFLICT(receipt_id) DO NOTHING`);
  const completeInboundReceipt = db.prepare(`UPDATE runtime_inbound_update_receipts
    SET status = ?, result_json = ?, error_code = NULL, completed_at = ?
    WHERE receipt_id = ? AND claim_id = ? AND claim_generation = ? AND status = 'processing'`);
  const markInboundReceiptUncertain = db.prepare(`UPDATE runtime_inbound_update_receipts
    SET status = 'uncertain', error_code = ?, completed_at = NULL
    WHERE receipt_id = ? AND claim_id = ? AND claim_generation = ? AND status = 'processing'`);
  const quarantineInboundReceipts = db.prepare(`UPDATE runtime_inbound_update_receipts
    SET status = 'uncertain', error_code = 'recovery_required', recovery_id = ?,
        recovered_at = ?, claim_generation = claim_generation + 1
    WHERE status = 'processing'`);
  const listInboundRecovery = db.prepare(`SELECT * FROM runtime_inbound_update_receipts
    WHERE status IN ('processing', 'uncertain') ORDER BY received_at ASC, receipt_id ASC LIMIT ?`);
  const recordInboundConflict = db.prepare(`INSERT INTO runtime_inbound_update_conflicts
    (id, receipt_id, revision_identity, payload_fingerprint, observed_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(receipt_id, payload_fingerprint) DO NOTHING`);
  const dialogue = db.prepare('SELECT * FROM runtime_assistant_dialogues WHERE chat_id = ? AND user_id = ?');
  const turns = db.prepare(`SELECT question, answer FROM runtime_assistant_turns
    WHERE dialogue_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`);
  const insertDialogue = db.prepare(`INSERT INTO runtime_assistant_dialogues
    (id, chat_id, user_id, last_activity_at) VALUES (?, ?, ?, ?)`);
  const touchDialogue = db.prepare('UPDATE runtime_assistant_dialogues SET last_activity_at = ? WHERE id = ?');
  const insertTurn = db.prepare(`INSERT INTO runtime_assistant_turns
    (id, dialogue_id, event_id, question, answer, model_id, receipt_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertModeration = db.prepare(`INSERT INTO runtime_moderation_records
    (id, event_id, chat_id, message_id, user_id, verdict, confidence, reason, mode, action_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const questionClaim = db.prepare(`INSERT INTO runtime_assistant_question_claims
    (chat_id, message_id, status, claimed_at) VALUES (?, ?, 'processing', ?)
    ON CONFLICT(chat_id, message_id) DO NOTHING`);
  const question = db.prepare('SELECT * FROM runtime_assistant_question_claims WHERE chat_id = ? AND message_id = ?');
  const completeQuestion = db.prepare(`UPDATE runtime_assistant_question_claims
    SET status = 'completed', outcome = ?, completed_at = ? WHERE chat_id = ? AND message_id = ?`);
  const assistantRequest = db.prepare('SELECT * FROM runtime_assistant_request_reservations WHERE event_id = ?');
  const countAssistantRequests = db.prepare(`SELECT COUNT(*) AS count FROM runtime_assistant_request_reservations
    WHERE chat_id = ? AND user_id = ? AND status IN ('reserved', 'completed', 'uncertain') AND created_at > ?`);
  const insertAssistantRequest = db.prepare(`INSERT INTO runtime_assistant_request_reservations
    (event_id, chat_id, user_id, status, created_at) VALUES (?, ?, ?, 'reserved', ?)`);
  const completeAssistantRequest = db.prepare(`UPDATE runtime_assistant_request_reservations
    SET status = 'completed', completed_at = ? WHERE event_id = ? AND status = 'reserved'`);
  const uncertainAssistantRequest = db.prepare(`UPDATE runtime_assistant_request_reservations
    SET status = 'uncertain', completed_at = ? WHERE event_id = ? AND status = 'reserved'`);
  const releaseAssistantRequest = db.prepare(`DELETE FROM runtime_assistant_request_reservations
    WHERE event_id = ? AND status = 'reserved'`);
  const deleteExpiredDialogueTurns = db.prepare(`DELETE FROM runtime_assistant_turns
    WHERE dialogue_id IN (SELECT id FROM runtime_assistant_dialogues WHERE last_activity_at <= ?)`);
  const deleteExpiredDialogues = db.prepare('DELETE FROM runtime_assistant_dialogues WHERE last_activity_at <= ?');
  const trimDialogueTurns = db.prepare(`DELETE FROM runtime_assistant_turns
    WHERE dialogue_id = ? AND id NOT IN (
      SELECT id FROM runtime_assistant_turns WHERE dialogue_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    )`);
  const disposition = db.prepare(`SELECT * FROM runtime_assistant_moderation_dispositions
    WHERE chat_id = ? AND message_id = ?`);
  const writeDisposition = db.prepare(`INSERT INTO runtime_assistant_moderation_dispositions
    (chat_id, message_id, status, moderation_message_id, verdict, reason, moderation_event_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET
      status = CASE
        WHEN runtime_assistant_moderation_dispositions.status IN ('allowed', 'blocked')
          AND runtime_assistant_moderation_dispositions.moderation_message_id IS excluded.moderation_message_id
          AND excluded.status = 'pending'
        THEN runtime_assistant_moderation_dispositions.status
        ELSE excluded.status
      END,
      verdict = CASE
        WHEN runtime_assistant_moderation_dispositions.status IN ('allowed', 'blocked')
          AND runtime_assistant_moderation_dispositions.moderation_message_id IS excluded.moderation_message_id
          AND excluded.status = 'pending'
        THEN runtime_assistant_moderation_dispositions.verdict
        ELSE excluded.verdict
      END,
      reason = CASE
        WHEN runtime_assistant_moderation_dispositions.status IN ('allowed', 'blocked')
          AND runtime_assistant_moderation_dispositions.moderation_message_id IS excluded.moderation_message_id
          AND excluded.status = 'pending'
        THEN runtime_assistant_moderation_dispositions.reason
        ELSE excluded.reason
      END,
      moderation_event_id = CASE
        WHEN runtime_assistant_moderation_dispositions.status IN ('allowed', 'blocked')
          AND runtime_assistant_moderation_dispositions.moderation_message_id IS excluded.moderation_message_id
          AND excluded.status = 'pending'
        THEN runtime_assistant_moderation_dispositions.moderation_event_id
        ELSE excluded.moderation_event_id
      END,
      moderation_message_id = excluded.moderation_message_id,
      updated_at = excluded.updated_at`);
  const currentWeakStrikes = db.prepare(`SELECT weak_strikes FROM runtime_moderation_weak_strikes
    WHERE chat_id = ? AND user_id = ?`);
  const incrementWeakStrike = db.prepare(`INSERT INTO runtime_moderation_weak_strikes
    (chat_id, user_id, weak_strikes, last_event_id, updated_at) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      weak_strikes = runtime_moderation_weak_strikes.weak_strikes + 1,
      last_event_id = excluded.last_event_id,
      updated_at = excluded.updated_at`);
  const observeModerationMessage = db.prepare(`INSERT INTO runtime_moderation_message_ledger
    (chat_id, message_id, user_id, latest_revision_identity) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET latest_revision_identity = excluded.latest_revision_identity`);
  const observeModerationMessageWithUser = db.prepare(`INSERT INTO runtime_moderation_message_ledger
    (chat_id, message_id, user_id, latest_revision_identity) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, runtime_moderation_message_ledger.user_id),
      latest_revision_identity = excluded.latest_revision_identity`);
  const weakMessageClaim = db.prepare(`UPDATE runtime_moderation_message_ledger
    SET weak_strike_event_id = ? WHERE chat_id = ? AND message_id = ? AND weak_strike_event_id IS NULL`);
  const moderationMessage = db.prepare(`SELECT * FROM runtime_moderation_message_ledger
    WHERE chat_id = ? AND message_id = ?`);
  const knownUndeletedMessagesForUser = db.prepare(`SELECT chat_id, message_id, user_id, deletion_state
    FROM runtime_moderation_message_ledger
    WHERE chat_id = ? AND user_id = ?
      AND COALESCE(deletion_state, '') NOT IN ('deleted', 'uncertain', 'calling')
    ORDER BY rowid ASC
    LIMIT ?`);
  const markWarningDelivered = db.prepare(`UPDATE runtime_moderation_weak_strikes
    SET warning_stage = CASE WHEN warning_stage = 'final' THEN 'final' ELSE ? END,
        warning_delivered_at = ?, last_event_id = ?, updated_at = ?
    WHERE chat_id = ? AND user_id = ?`);
  const recordMessageDeletion = db.prepare(`UPDATE runtime_moderation_message_ledger
    SET deletion_state = ?, deletion_at = ? WHERE chat_id = ? AND message_id = ?`);
  const enforcementReceipt = db.prepare('SELECT * FROM runtime_moderation_enforcement_receipts WHERE event_id = ?');
  const createEnforcementReceipt = db.prepare(`INSERT INTO runtime_moderation_enforcement_receipts
    (event_id, chat_id, message_id, policy_action, policy_json, guard_proof_json,
     status, claim_id, claim_generation, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, 1, ?, ?)
    ON CONFLICT(event_id) DO NOTHING`);
  const markEnforcementCalling = db.prepare(`UPDATE runtime_moderation_enforcement_receipts
    SET status = 'calling', receipt_json = ?, error_code = NULL, updated_at = ?
    WHERE event_id = ? AND claim_id = ? AND claim_generation = ? AND status IN ('planned', 'calling')`);
  const completeEnforcementReceipt = db.prepare(`UPDATE runtime_moderation_enforcement_receipts
    SET status = ?, receipt_json = ?, error_code = ?, updated_at = ?, completed_at = ?
    WHERE event_id = ? AND claim_id = ? AND claim_generation = ? AND status IN ('planned', 'calling')`);
  const autoUnpin = db.prepare(`SELECT * FROM runtime_moderation_auto_unpins
    WHERE chat_id = ? AND message_id = ?`);
  const createAutoUnpin = db.prepare(`INSERT INTO runtime_moderation_auto_unpins
    (chat_id, message_id, first_event_id, state, claimed_at)
    VALUES (?, ?, ?, 'planned', ?)
    ON CONFLICT(chat_id, message_id) DO NOTHING`);
  const markAutoUnpinCalling = db.prepare(`UPDATE runtime_moderation_auto_unpins
    SET state = 'calling', result_json = NULL, error_code = NULL
    WHERE chat_id = ? AND message_id = ? AND state = 'planned'`);
  const completeAutoUnpin = db.prepare(`UPDATE runtime_moderation_auto_unpins
    SET state = ?, result_json = ?, error_code = ?, completed_at = ?
    WHERE chat_id = ? AND message_id = ? AND state IN ('planned', 'calling')`);
  const rememberOwnerPin = db.prepare(`INSERT INTO runtime_moderation_owner_pins
    (chat_id, message_id, source_event_id, remembered_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      message_id = excluded.message_id,
      source_event_id = excluded.source_event_id,
      remembered_at = excluded.remembered_at`);
  const ownerPin = db.prepare('SELECT * FROM runtime_moderation_owner_pins WHERE chat_id = ?');
  const reserveWeakStrike = db.transaction((chatId, userId, messageId, revisionIdentity, eventId, at) => {
    observeModerationMessage.run(chatId, messageId, null, revisionIdentity);
    const before = currentWeakStrikes.get(chatId, userId)?.weak_strikes || 0;
    const claimed = weakMessageClaim.run(eventId, chatId, messageId).changes === 1;
    if (!claimed) return { claimed: false, before, after: before, row: moderationMessage.get(chatId, messageId) };
    incrementWeakStrike.run(chatId, userId, eventId, at);
    return { claimed: true, before, after: before + 1, row: moderationMessage.get(chatId, messageId) };
  });
  const claimModerationSafetyEnforcement = db.transaction(({
    eventId, chatId, messageId, revisionIdentity, userId = null, isWeak = false,
    guardProof = null, derivePolicy,
  }) => {
    const existing = enforcementReceipt.get(String(eventId));
    if (existing) return { claimed: false, existing, duplicateNative: false, policy: null };

    const normalizedChatId = String(chatId);
    const normalizedMessageId = String(messageId);
    const normalizedEventId = String(eventId);
    const normalizedUserId = userId == null || String(userId) === '' ? null : String(userId);
    const at = now();
    let strike = { claimed: false, before: 0, after: 0, row: null };
    if (isWeak && normalizedUserId) {
      observeModerationMessage.run(normalizedChatId, normalizedMessageId, null, String(revisionIdentity));
      const before = currentWeakStrikes.get(normalizedChatId, normalizedUserId)?.weak_strikes || 0;
      const claimed = weakMessageClaim.run(normalizedEventId, normalizedChatId, normalizedMessageId).changes === 1;
      if (claimed) incrementWeakStrike.run(normalizedChatId, normalizedUserId, normalizedEventId, at);
      strike = {
        claimed,
        before,
        after: claimed ? before + 1 : before,
        row: moderationMessage.get(normalizedChatId, normalizedMessageId),
      };
    } else {
      observeModerationMessage.run(normalizedChatId, normalizedMessageId, null, String(revisionIdentity));
    }
    const policy = derivePolicy(strike.before);
    const claimId = randomUUID();
    createEnforcementReceipt.run(
      normalizedEventId, normalizedChatId, normalizedMessageId, String(policy.action), JSON.stringify(policy),
      guardProof == null ? null : JSON.stringify(guardProof), claimId, at, at,
    );
    return {
      claimed: true,
      claim: { eventId: normalizedEventId, claimId, claimGeneration: 1 },
      existing: null,
      duplicateNative: isWeak && normalizedUserId != null && !strike.claimed,
      strike,
      policy,
    };
  });

  return {
    /**
     * Create the only executable claim for a Telegram delivery. The update
     * payload itself is deliberately not copied into the inbox; its stable
     * SHA-256 fingerprint and exact revision identity are enough to detect a
     * receipt collision while avoiding a second raw-message store.
     */
    claimInboundDelivery({ receiptId, role, updateId, revisionIdentity, payloadFingerprint }) {
      const normalizedReceiptId = String(receiptId);
      const claimId = randomUUID();
      const at = now();
      const claimed = createInboundReceipt.run(
        normalizedReceiptId, String(role), Number(updateId), String(revisionIdentity),
        String(payloadFingerprint), claimId, at, at,
      ).changes === 1;
      const existing = claimed ? null : inboundReceipt.get(normalizedReceiptId);
      const collision = !claimed && existing != null && (
        existing.bot_role !== String(role)
        || Number(existing.update_id) !== Number(updateId)
        || existing.revision_identity !== String(revisionIdentity)
        || existing.payload_fingerprint !== String(payloadFingerprint)
      );
      if (collision) {
        recordInboundConflict.run(
          randomUUID(), normalizedReceiptId, String(revisionIdentity), String(payloadFingerprint), at,
        );
      }
      return {
        claimed,
        claim: claimed ? { receiptId: normalizedReceiptId, claimId, claimGeneration: 1 } : null,
        existing,
        collision,
      };
    },
    completeInboundDelivery({ claim: inboundClaim, status, result }) {
      if (!inboundClaim || !['completed', 'skipped'].includes(status)) return { completed: false, row: null };
      const completed = completeInboundReceipt.run(
        status, JSON.stringify(result), now(), inboundClaim.receiptId,
        inboundClaim.claimId, inboundClaim.claimGeneration,
      ).changes === 1;
      return { completed, row: inboundReceipt.get(inboundClaim.receiptId) || null };
    },
    markInboundDeliveryUncertain({ claim: inboundClaim, errorCode = 'runtime_error' }) {
      if (!inboundClaim) return { marked: false, row: null };
      const marked = markInboundReceiptUncertain.run(
        String(errorCode).slice(0, 120), inboundClaim.receiptId,
        inboundClaim.claimId, inboundClaim.claimGeneration,
      ).changes === 1;
      return { marked, row: inboundReceipt.get(inboundClaim.receiptId) || null };
    },
    /**
     * This is an explicit operator/recovery action, not a retry mechanism. It
     * fences every in-flight claim and records an observable uncertain state;
     * it never invokes a provider or Telegram adapter.
     */
    quarantineProcessingInboundDeliveries({ recoveryId }) {
      const normalizedRecoveryId = String(recoveryId || '').trim();
      if (!normalizedRecoveryId) throw new Error('recoveryId is required to quarantine inbound deliveries');
      return { recoveryId: normalizedRecoveryId, quarantined: quarantineInboundReceipts.run(normalizedRecoveryId, now()).changes };
    },
    listInboundRecovery({ limit = 50 } = {}) {
      return listInboundRecovery.all(Math.max(1, Math.min(500, Number(limit) || 50)));
    },
    getInboundDelivery(receiptId) { return inboundReceipt.get(String(receiptId)) || null; },
    claimEvent({ eventId, role, updateId }) {
      const claimed = claim.run(eventId, role, updateId, now()).changes === 1;
      return { claimed, existing: claimed ? null : event.get(eventId) };
    },
    completeEvent(eventId, status, result = null, error = null) {
      finish.run(status, result == null ? null : JSON.stringify(result), error, now(), eventId);
    },
    recordModeration(record) {
      insertModeration.run(
        randomUUID(), record.eventId, record.chatId, record.messageId, record.userId,
        record.verdict, record.confidence, record.reason, record.mode,
        JSON.stringify(record.actions || []), now(),
      );
    },
    claimAssistantQuestion({ chatId, messageId }) {
      const claimed = questionClaim.run(String(chatId), String(messageId), now()).changes === 1;
      return { claimed, existing: claimed ? null : question.get(String(chatId), String(messageId)) };
    },
    completeAssistantQuestion({ chatId, messageId, outcome }) {
      const result = completeQuestion.run(String(outcome), now(), String(chatId), String(messageId));
      return { completed: result.changes === 1 };
    },
    getAssistantDisposition({ chatId, messageId }) {
      return disposition.get(String(chatId), String(messageId));
    },
    upsertAssistantDisposition({
      chatId, messageId, status, moderationMessageId = null, verdict = null,
      reason = null, moderationEventId = null,
    }) {
      const at = now();
      writeDisposition.run(
        String(chatId), String(messageId), String(status),
        moderationMessageId == null ? null : String(moderationMessageId),
        verdict == null ? null : String(verdict), reason == null ? null : String(reason),
        moderationEventId == null ? null : String(moderationEventId), at, at,
      );
      return disposition.get(String(chatId), String(messageId));
    },
    observeModerationMessage({ chatId, messageId, userId = null, revisionIdentity }) {
      observeModerationMessageWithUser.run(
        String(chatId), String(messageId), userId == null || String(userId) === '' ? null : String(userId), String(revisionIdentity),
      );
      return moderationMessage.get(String(chatId), String(messageId));
    },
    listKnownUndeletedModerationMessages({ chatId, userId, limit = 100 }) {
      if (userId == null || String(userId) === '') return [];
      const boundedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 100));
      return knownUndeletedMessagesForUser.all(String(chatId), String(userId), boundedLimit);
    },
    getWeakStrikeState({ chatId, userId }) {
      if (userId == null || String(userId) === '') return { weakStrikes: 0, warningStage: 'none' };
      const row = db.prepare(`SELECT weak_strikes, warning_stage, warning_delivered_at, last_event_id
        FROM runtime_moderation_weak_strikes WHERE chat_id = ? AND user_id = ?`).get(String(chatId), String(userId));
      return row
        ? { weakStrikes: row.weak_strikes, warningStage: row.warning_stage, warningDeliveredAt: row.warning_delivered_at, lastEventId: row.last_event_id }
        : { weakStrikes: 0, warningStage: 'none' };
    },
    reserveWeakStrikeForMessage({ chatId, userId, messageId, revisionIdentity, eventId }) {
      if (userId == null || String(userId) === '') return { claimed: false, before: 0, after: 0, reason: 'author_identity_missing' };
      return reserveWeakStrike(
        String(chatId), String(userId), String(messageId), String(revisionIdentity), String(eventId), now(),
      );
    },
    markWarningDelivered({ chatId, userId, eventId, stage }) {
      if (userId == null || !['first', 'final'].includes(String(stage))) return { marked: false };
      const at = now();
      const changed = markWarningDelivered.run(String(stage), at, String(eventId), at, String(chatId), String(userId)).changes;
      return { marked: changed === 1 };
    },
    recordModerationDeletion({ chatId, messageId, state }) {
      return { recorded: recordMessageDeletion.run(String(state), now(), String(chatId), String(messageId)).changes === 1 };
    },
    claimModerationEnforcement({ eventId, chatId, messageId, policy, guardProof = null }) {
      const claimId = randomUUID();
      const at = now();
      const claimed = createEnforcementReceipt.run(
        String(eventId), String(chatId), String(messageId), String(policy.action), JSON.stringify(policy),
        guardProof == null ? null : JSON.stringify(guardProof), claimId, at, at,
      ).changes === 1;
      const existing = claimed ? null : enforcementReceipt.get(String(eventId));
      return {
        claimed,
        claim: claimed ? { eventId: String(eventId), claimId, claimGeneration: 1 } : null,
        existing,
      };
    },
    claimModerationSafetyEnforcement({
      eventId, chatId, messageId, revisionIdentity, userId = null, isWeak = false,
      guardProof = null, derivePolicy,
    }) {
      if (typeof derivePolicy !== 'function') throw new Error('derivePolicy is required');
      return claimModerationSafetyEnforcement({
        eventId, chatId, messageId, revisionIdentity, userId, isWeak, guardProof, derivePolicy,
      });
    },
    markModerationEnforcementCalling({ claim: enforcementClaim, receipt }) {
      if (!enforcementClaim) return { marked: false };
      const marked = markEnforcementCalling.run(
        JSON.stringify(receipt), now(), enforcementClaim.eventId,
        enforcementClaim.claimId, enforcementClaim.claimGeneration,
      ).changes === 1;
      return { marked, row: enforcementReceipt.get(enforcementClaim.eventId) || null };
    },
    completeModerationEnforcement({ claim: enforcementClaim, status, receipt, errorCode = null }) {
      if (!enforcementClaim || !['completed', 'skipped', 'uncertain'].includes(String(status))) return { completed: false };
      const at = now();
      const completed = completeEnforcementReceipt.run(
        String(status), JSON.stringify(receipt), errorCode == null ? null : String(errorCode).slice(0, 120), at, at,
        enforcementClaim.eventId, enforcementClaim.claimId, enforcementClaim.claimGeneration,
      ).changes === 1;
      return { completed, row: enforcementReceipt.get(enforcementClaim.eventId) || null };
    },
    getModerationEnforcement(eventId) { return enforcementReceipt.get(String(eventId)) || null; },
    claimAutoUnpin({ chatId, messageId, eventId }) {
      const normalizedChatId = String(chatId);
      const normalizedMessageId = String(messageId);
      const claimed = createAutoUnpin.run(
        normalizedChatId, normalizedMessageId, String(eventId), now(),
      ).changes === 1;
      return {
        claimed,
        existing: claimed ? null : autoUnpin.get(normalizedChatId, normalizedMessageId),
      };
    },
    markAutoUnpinCalling({ chatId, messageId }) {
      const normalizedChatId = String(chatId);
      const normalizedMessageId = String(messageId);
      const marked = markAutoUnpinCalling.run(normalizedChatId, normalizedMessageId).changes === 1;
      return { marked, row: autoUnpin.get(normalizedChatId, normalizedMessageId) || null };
    },
    completeAutoUnpin({ chatId, messageId, state, result = null, errorCode = null }) {
      if (!['completed', 'skipped', 'uncertain'].includes(String(state))) return { completed: false, row: null };
      const normalizedChatId = String(chatId);
      const normalizedMessageId = String(messageId);
      const completed = completeAutoUnpin.run(
        String(state), JSON.stringify(result), errorCode == null ? null : String(errorCode).slice(0, 120), now(),
        normalizedChatId, normalizedMessageId,
      ).changes === 1;
      return { completed, row: autoUnpin.get(normalizedChatId, normalizedMessageId) || null };
    },
    rememberOwnerPin({ chatId, messageId, eventId }) {
      rememberOwnerPin.run(String(chatId), String(messageId), String(eventId), now());
      return ownerPin.get(String(chatId)) || null;
    },
    getOwnerPin({ chatId }) { return ownerPin.get(String(chatId)) || null; },
    reserveWeakStrike({ chatId, userId }) {
      // Compatibility helper for non-Guard callers. Guard enforcement must use
      // reserveWeakStrikeForMessage so edited revisions cannot create extra strikes.
      if (userId == null || String(userId) === '') return { claimed: false, before: 0, after: 0 };
      const syntheticMessageId = `compat:${randomUUID()}`;
      return reserveWeakStrike(String(chatId), String(userId), syntheticMessageId, syntheticMessageId, syntheticMessageId, now());
    },
    reserveAssistantRequest({ eventId, chatId, userId, cooldownSec = 0, dailyCap = 0 }) {
      if (!eventId || userId == null || String(userId) === '') return { allowed: false, reason: 'missing_user' };
      const at = now();
      const normalizedChatId = String(chatId);
      const normalizedUserId = String(userId);
      const existing = assistantRequest.get(String(eventId));
      if (existing) return { allowed: false, reason: 'already_reserved', existing };
      const cooldown = Math.max(0, Number.parseInt(cooldownSec, 10) || 0);
      const daily = Math.max(0, Number.parseInt(dailyCap, 10) || 0);
      if (cooldown > 0 && countAssistantRequests.get(normalizedChatId, normalizedUserId, at - cooldown).count > 0) {
        return { allowed: false, reason: 'cooldown' };
      }
      if (daily > 0 && countAssistantRequests.get(normalizedChatId, normalizedUserId, at - 86_400).count >= daily) {
        return { allowed: false, reason: 'daily_cap' };
      }
      insertAssistantRequest.run(String(eventId), normalizedChatId, normalizedUserId, at);
      return { allowed: true };
    },
    completeAssistantRequest(eventId) {
      return { completed: completeAssistantRequest.run(now(), String(eventId)).changes === 1 };
    },
    markAssistantRequestUncertain(eventId) {
      return { marked: uncertainAssistantRequest.run(now(), String(eventId)).changes === 1 };
    },
    releaseAssistantRequest(eventId) {
      return { released: releaseAssistantRequest.run(String(eventId)).changes === 1 };
    },
    recentDialogue(chatId, userId, { limit = 3, ttlSeconds = 604_800 } = {}) {
      const at = now();
      const ttl = Math.max(0, Number.parseInt(ttlSeconds, 10) || 0);
      if (ttl > 0) {
        deleteExpiredDialogueTurns.run(at - ttl);
        deleteExpiredDialogues.run(at - ttl);
      }
      const current = dialogue.get(String(chatId), String(userId));
      if (!current) return [];
      const boundedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 3));
      return turns.all(current.id, boundedLimit).reverse().map((row) => ({ question: row.question, answer: row.answer }));
    },
    recordBoundedAssistantTurn(turn, { maxTurns = 3, ttlSeconds = 604_800 } = {}) {
      const at = now();
      const ttl = Math.max(0, Number.parseInt(ttlSeconds, 10) || 0);
      if (ttl > 0) {
        deleteExpiredDialogueTurns.run(at - ttl);
        deleteExpiredDialogues.run(at - ttl);
      }
      let current = dialogue.get(String(turn.chatId), String(turn.userId));
      if (!current) {
        current = { id: randomUUID() };
        insertDialogue.run(current.id, String(turn.chatId), String(turn.userId), at);
      } else {
        touchDialogue.run(at, current.id);
      }
      insertTurn.run(
        randomUUID(), current.id, String(turn.eventId), String(turn.question), String(turn.answer),
        turn.modelId || null, JSON.stringify(turn.receipt || null), at,
      );
      const boundedLimit = Math.max(1, Math.min(100, Number.parseInt(maxTurns, 10) || 3));
      trimDialogueTurns.run(current.id, current.id, boundedLimit);
    },
    getEvent(eventId) { return event.get(eventId); },
  };
}
