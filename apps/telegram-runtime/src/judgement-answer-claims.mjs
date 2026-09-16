import { randomUUID } from 'node:crypto';
import { providerCallUsage } from './provider-adapter.mjs';

/** One visible answer sequence per native question. New revisions may replace
 * only wholly unsent preparation, never a crossed/unknown delivery boundary. */
export function createJudgementAnswerClaims(db, { now } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_assistant_answer_claims (
      chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
      event_id TEXT NOT NULL REFERENCES runtime_inbound_events(event_id),
      judgement_event_id TEXT NOT NULL REFERENCES runtime_judgement_envelopes(event_id),
      revision_identity TEXT NOT NULL, revision INTEGER NOT NULL,
      claim_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 1),
      purpose TEXT NOT NULL CHECK(purpose IN ('answer','fallback')),
      state TEXT NOT NULL CHECK(state IN ('preparing','calling','confirmed','uncertain')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(chat_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS runtime_assistant_answer_attempts (
      event_id TEXT PRIMARY KEY REFERENCES runtime_inbound_events(event_id),
      judgement_event_id TEXT NOT NULL, claim_id TEXT NOT NULL, generation INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('calling','returned','unknown')),
      model_id TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
      created_at INTEGER NOT NULL, completed_at INTEGER
    );
  `);
  const issued = new WeakMap();
  const native = db.prepare('SELECT * FROM runtime_assistant_answer_claims WHERE chat_id = ? AND message_id = ?');
  const legacy = db.prepare('SELECT * FROM runtime_assistant_question_claims WHERE chat_id = ? AND message_id = ?');
  const envelope = db.prepare(`SELECT envelopes.*, dispositions.status AS disposition_status,
    dispositions.moderation_event_id AS disposition_event_id,
    dispositions.moderation_message_id AS disposition_revision,
    heads.revision_identity AS current_revision FROM runtime_judgement_envelopes envelopes
    JOIN runtime_judgement_heads heads ON heads.chat_id = envelopes.chat_id AND heads.message_id = envelopes.message_id
    LEFT JOIN runtime_assistant_moderation_dispositions dispositions ON dispositions.chat_id = envelopes.chat_id
      AND dispositions.message_id = envelopes.message_id WHERE envelopes.event_id = ?`);
  const stream = db.prepare(`SELECT 1 FROM runtime_judgement_stream_receipts streams
    JOIN runtime_inbound_events events ON events.event_id = streams.receipt_id
    WHERE streams.receipt_id = ? AND streams.revision_identity = ? AND events.bot_role = 'assistant'`);
  const insertLegacy = db.prepare(`INSERT INTO runtime_assistant_question_claims
    (chat_id,message_id,status,claimed_at) VALUES (?,?,'processing',?) ON CONFLICT(chat_id,message_id) DO NOTHING`);
  const resetLegacy = db.prepare(`UPDATE runtime_assistant_question_claims SET status = 'processing', outcome = NULL,
    claimed_at = ?, completed_at = NULL WHERE chat_id = ? AND message_id = ?`);
  const finishLegacy = db.prepare(`UPDATE runtime_assistant_question_claims SET status = 'completed', outcome = ?,
    completed_at = ? WHERE chat_id = ? AND message_id = ?`);
  const putNative = db.prepare(`INSERT INTO runtime_assistant_answer_claims VALUES (?,?,?,?,?,?,?,?,?,'preparing',?,?)
    ON CONFLICT(chat_id,message_id) DO UPDATE SET event_id = excluded.event_id,
    judgement_event_id = excluded.judgement_event_id, revision_identity = excluded.revision_identity,
    revision = excluded.revision, claim_id = excluded.claim_id, generation = excluded.generation,
    purpose = excluded.purpose, state = 'preparing', updated_at = excluded.updated_at`);
  const writeState = db.prepare(`UPDATE runtime_assistant_answer_claims SET state = ?, updated_at = ?
    WHERE chat_id = ? AND message_id = ? AND claim_id = ? AND generation = ?`);
  const insertAttempt = db.prepare(`INSERT INTO runtime_assistant_answer_attempts
    (event_id,judgement_event_id,claim_id,generation,status,created_at) VALUES (?,?,?,?,'calling',?)
    ON CONFLICT(event_id) DO NOTHING`);
  const finishAttempt = db.prepare(`UPDATE runtime_assistant_answer_attempts SET status = ?, model_id = ?,
    input_tokens = ?, output_tokens = ?, total_tokens = ?, completed_at = ?
    WHERE event_id = ? AND claim_id = ? AND generation = ? AND status = 'calling'`);

  function authorized(binding) {
    const row = envelope.get(binding.judgementEventId);
    return row && row.state === 'active' && row.owner === 'assistant'
      && row.chat_id === binding.chatId && row.message_id === binding.messageId
      && row.current_revision === row.revision_identity && row.revision_identity === binding.revisionIdentity
      && row.disposition_event_id === binding.judgementEventId
      && row.disposition_revision === binding.revisionIdentity
      && (binding.purpose === 'fallback' ? ['error', 'pending'].includes(row.disposition_status)
        : row.disposition_status === 'allowed');
  }
  function own(claim) {
    const binding = claim && issued.get(claim);
    if (!binding) return null;
    const row = native.get(binding.chatId, binding.messageId);
    return row?.claim_id === binding.claimId && row.generation === binding.generation
      && row.event_id === binding.eventId && row.judgement_event_id === binding.judgementEventId
      ? { binding, row } : null;
  }
  return {
    claimAssistantQuestion({ chatId, messageId, eventId, judgementEventId, purpose = 'answer' }) {
      return db.transaction(() => {
        const chat = String(chatId); const message = String(messageId);
        const previous = native.get(chat, message);
        const priorLegacy = legacy.get(chat, message);
        const denied = () => ({ claimed: false, claim: null, existing: priorLegacy || previous || null });
        if (eventId == null && judgementEventId == null) {
          if (previous) return denied();
          const claimed = insertLegacy.run(chat, message, now()).changes === 1;
          return { claimed, existing: claimed ? null : priorLegacy };
        }
        if (eventId == null || judgementEventId == null || !['answer', 'fallback'].includes(purpose)) return denied();
        const current = envelope.get(String(judgementEventId));
        if (!current) return denied();
        const binding = { chatId: chat, messageId: message, eventId: String(eventId),
          judgementEventId: String(judgementEventId), revisionIdentity: current.revision_identity,
          revision: current.revision, purpose, claimId: randomUUID(), generation: (previous?.generation || 0) + 1 };
        if (!authorized(binding) || !stream.get(binding.eventId, binding.revisionIdentity)) return denied();
        if (priorLegacy && !previous) return denied(); // unknown historical delivery: never guess it was unsent
        if (previous && (!priorLegacy || previous.state !== 'preparing' || current.revision <= previous.revision)) return denied();
        if (previous) resetLegacy.run(now(), chat, message);
        else if (insertLegacy.run(chat, message, now()).changes !== 1) return denied();
        putNative.run(chat, message, binding.eventId, binding.judgementEventId, binding.revisionIdentity,
          binding.revision, binding.claimId, binding.generation, purpose, now(), now());
        const claim = Object.freeze({ ...binding });
        issued.set(claim, binding);
        return { claimed: true, claim, existing: null };
      })();
    },
    validateAssistantAnswerClaim(claim) {
      const owned = own(claim);
      return Boolean(owned && ['preparing', 'calling'].includes(owned.row.state) && authorized(owned.binding));
    },
    markAssistantAnswerCalling(claim) {
      return db.transaction(() => {
        const owned = own(claim);
        if (!owned || !authorized(owned.binding) || !['preparing', 'calling'].includes(owned.row.state)) return false;
        if (owned.row.state === 'calling') return true;
        return writeState.run('calling', now(), owned.binding.chatId, owned.binding.messageId,
          owned.binding.claimId, owned.binding.generation).changes === 1;
      })();
    },
    completeAssistantAnswerDelivery({ claim, state }) {
      return db.transaction(() => {
        const owned = own(claim);
        if (!owned || owned.row.state !== 'calling' || !['confirmed', 'uncertain'].includes(state)) return { completed: false };
        return { completed: writeState.run(state, now(), owned.binding.chatId, owned.binding.messageId,
          owned.binding.claimId, owned.binding.generation).changes === 1 };
      })();
    },
    completeAssistantQuestion({ chatId, messageId, outcome, claim }) {
      return db.transaction(() => {
        const row = native.get(String(chatId), String(messageId));
        if (row) {
          const owned = own(claim);
          if (!owned || owned.binding.chatId !== String(chatId) || owned.binding.messageId !== String(messageId)) return { completed: false };
        } else if (claim != null) return { completed: false };
        return { completed: finishLegacy.run(String(outcome), now(), String(chatId), String(messageId)).changes === 1 };
      })();
    },
    markAssistantAnswerProviderCalling(claim) {
      return db.transaction(() => {
        const owned = own(claim);
        if (!owned || owned.binding.purpose !== 'answer' || owned.row.state !== 'preparing'
          || !authorized(owned.binding)) return { marked: false };
        const binding = owned.binding;
        return { marked: insertAttempt.run(binding.eventId, binding.judgementEventId,
          binding.claimId, binding.generation, now()).changes === 1 };
      })();
    },
    completeAssistantAnswerProviderAttempt({ claim, status, usage }) {
      const binding = claim && issued.get(claim);
      if (!binding || !['returned', 'unknown'].includes(status)) return { completed: false };
      // Superseded paid attempts retain their own usage, but never touch the
      // current native answer reservation or another revision's attempt.
      const cost = providerCallUsage(usage);
      return { completed: finishAttempt.run(status, cost.modelId, cost.inputTokens, cost.outputTokens,
        cost.totalTokens, now(), binding.eventId, binding.claimId, binding.generation).changes === 1 };
    },
  };
}
