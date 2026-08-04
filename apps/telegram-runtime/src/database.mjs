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
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
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
    (chat_id, user_id, weak_strikes, updated_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      weak_strikes = runtime_moderation_weak_strikes.weak_strikes + 1,
      updated_at = excluded.updated_at`);
  const reserveWeakStrike = db.transaction((chatId, userId, at) => {
    const before = currentWeakStrikes.get(chatId, userId)?.weak_strikes || 0;
    incrementWeakStrike.run(chatId, userId, at);
    return { before, after: before + 1 };
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
    reserveWeakStrike({ chatId, userId }) {
      if (userId == null || String(userId) === '') return { before: 0, after: 0 };
      return reserveWeakStrike(String(chatId), String(userId), now());
    },
    recentDialogue(chatId, userId, limit = 3) {
      const current = dialogue.get(chatId, userId);
      if (!current) return [];
      return turns.all(current.id, limit).reverse().map((row) => ({ question: row.question, answer: row.answer }));
    },
    recordAssistantTurn(turn) {
      const at = now();
      let current = dialogue.get(turn.chatId, turn.userId);
      if (!current) {
        current = { id: randomUUID() };
        insertDialogue.run(current.id, turn.chatId, turn.userId, at);
      } else {
        touchDialogue.run(at, current.id);
      }
      insertTurn.run(
        randomUUID(), current.id, turn.eventId, turn.question, turn.answer,
        turn.modelId || null, JSON.stringify(turn.receipt || null), at,
      );
    },
    getEvent(eventId) { return event.get(eventId); },
  };
}
