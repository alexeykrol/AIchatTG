import { randomUUID } from 'node:crypto';
import { normalizeSafetyClassification, planTelegramSafetyAction, assistantDispositionForSafety } from '@aichattg/telegram-core';
import { judgementDigest } from './judgement-envelope.mjs';
import { validateJudgementSemantic } from './safety-v3.mjs';
import { providerCallUsage } from './provider-adapter.mjs';

// Names of historical job tables stay compatible with the existing recovery
// and accounting code. This arbiter adds ownership before those jobs exist.
export function createJudgementStore(db, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_judgement_envelopes (
      revision_identity TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
      revision INTEGER NOT NULL, owner TEXT NOT NULL CHECK(owner IN ('assistant','moderator')),
      event_id TEXT NOT NULL UNIQUE REFERENCES runtime_inbound_events(event_id),
      receipt_id TEXT NOT NULL REFERENCES runtime_inbound_update_receipts(receipt_id),
      source_hash TEXT NOT NULL, context_hash TEXT NOT NULL, policy_hash TEXT NOT NULL,
      context_json TEXT NOT NULL, policy_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','conflict','stale')),
      verdict_fingerprint TEXT, accepted_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_judgement_heads (
      chat_id TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL,
      revision_identity TEXT NOT NULL, PRIMARY KEY(chat_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS runtime_judgement_stream_receipts (
      receipt_id TEXT PRIMARY KEY REFERENCES runtime_inbound_update_receipts(receipt_id),
      revision_identity TEXT NOT NULL REFERENCES runtime_judgement_envelopes(revision_identity)
    );
    CREATE TABLE IF NOT EXISTS runtime_judgement_legacy_natives (
      chat_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(chat_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS runtime_judgement_legacy_jobs (
      event_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_judgement_legacy_jobs_native
      ON runtime_judgement_legacy_jobs(chat_id,message_id);
  `);
  const byRevision = db.prepare('SELECT * FROM runtime_judgement_envelopes WHERE revision_identity = ?');
  const byEvent = db.prepare('SELECT * FROM runtime_judgement_envelopes WHERE event_id = ?');
  const head = db.prepare('SELECT * FROM runtime_judgement_heads WHERE chat_id = ? AND message_id = ?');
  const legacyNative = db.prepare('SELECT 1 FROM runtime_judgement_legacy_natives WHERE chat_id = ? AND message_id = ?');
  const legacyJob = db.prepare('SELECT * FROM runtime_judgement_legacy_jobs WHERE event_id = ?');
  const legacyPeers = db.prepare('SELECT event_id FROM runtime_judgement_legacy_jobs WHERE chat_id = ? AND message_id = ? LIMIT 2');
  const putLegacyNative = db.prepare('INSERT OR IGNORE INTO runtime_judgement_legacy_natives VALUES (?,?)');
  const putLegacyJob = db.prepare('INSERT OR IGNORE INTO runtime_judgement_legacy_jobs VALUES (?,?,?)');
  // One startup pass extracts only native identifiers from pre-protocol state.
  // Later admission/recovery use indexed keys, not scans over retained bodies.
  // Existing protocol heads are excluded on every restart; no live new job is
  // retrospectively labelled historical. This is not verdict/allow adoption.
  db.transaction(() => {
    for (const source of ['runtime_moderation_message_ledger', 'runtime_assistant_moderation_dispositions',
      'runtime_moderation_enforcement_receipts', 'runtime_moderation_records']) {
      db.exec(`INSERT OR IGNORE INTO runtime_judgement_legacy_natives
        SELECT source.chat_id, source.message_id FROM ${source} source WHERE NOT EXISTS
        (SELECT 1 FROM runtime_judgement_heads h WHERE h.chat_id = source.chat_id AND h.message_id = source.message_id)`);
    }
    const jobs = db.prepare(`SELECT jobs.event_id, jobs.snapshot_json, receipts.revision_identity
      FROM runtime_moderator_judgement_jobs jobs JOIN runtime_inbound_update_receipts receipts
      ON receipts.receipt_id = jobs.receipt_id WHERE NOT EXISTS
      (SELECT 1 FROM runtime_judgement_envelopes e WHERE e.event_id = jobs.event_id)
      AND jobs.event_id > ? ORDER BY jobs.event_id LIMIT 500`);
    let cursor = '';
    for (;;) {
      const batch = jobs.all(cursor);
      if (!batch.length) break;
      cursor = batch.at(-1).event_id;
      for (const job of batch) {
      let comment;
      try { comment = JSON.parse(job.snapshot_json)?.comment; } catch { /* identifiers may remain in the receipt */ }
      const coordinate = /^(-?\d+):(?:edit:(?:\d+|[a-f0-9]{16}):)?(\d+)$/.exec(job.revision_identity || '');
      const chatId = String(comment?.chatId ?? coordinate?.[1] ?? '');
      const messageId = String(comment?.messageId ?? coordinate?.[2] ?? '');
      if (!/^-?[1-9]\d*$/.test(chatId) || !/^[1-9]\d*$/.test(messageId)) continue;
      if (head.get(chatId, messageId)) continue;
      putLegacyNative.run(chatId, messageId);
      putLegacyJob.run(job.event_id, chatId, messageId);
      }
    }
  })();
  const issued = new WeakMap();
  function current(row) {
    return Boolean(row && row.state === 'active'
      && head.get(row.chat_id, row.message_id)?.revision_identity === row.revision_identity);
  }
  function failVerdict(row, reason) {
    db.prepare(`UPDATE runtime_moderator_judgement_jobs SET state = 'manual_review',
      error_code = ?, lease_id = NULL, lease_expires_at = NULL
      WHERE event_id = ?`).run(reason, row.event_id);
    db.prepare(`UPDATE runtime_assistant_moderation_dispositions SET status = 'error',
      reason = ? WHERE moderation_event_id = ?`).run(reason, row.event_id);
  }
  function conflict(row) {
    db.prepare("UPDATE runtime_judgement_envelopes SET state = 'conflict' WHERE revision_identity = ?").run(row.revision_identity);
    failVerdict(row, 'judgement_conflict');
  }
  return {
    observeJudgementEnvelope({ envelope, eventId, receiptId, snapshotTtlSec }) {
      return db.transaction(() => {
        if (legacyNative.get(envelope.chatId, envelope.messageId)) {
          return { row: null, current: false, created: false, reason: 'legacy_native_quarantined' };
        }
        let row = byRevision.get(envelope.revisionIdentity);
        if (row) {
          if (row.source_hash !== envelope.sourceHash || row.policy_hash !== envelope.policyHash
            || row.owner !== envelope.owner) { conflict(row); row = byRevision.get(envelope.revisionIdentity); }
        } else {
          const oldHead = head.get(envelope.chatId, envelope.messageId);
          const state = oldHead && oldHead.revision > envelope.revision ? 'stale' : 'active';
          const context = this.getWeakStrikeState({ chatId: envelope.chatId, userId: envelope.comment.userId });
          db.prepare(`INSERT INTO runtime_judgement_envelopes
            (revision_identity,chat_id,message_id,revision,owner,event_id,receipt_id,source_hash,context_hash,
             policy_hash,context_json,policy_json,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(envelope.revisionIdentity, envelope.chatId, envelope.messageId, envelope.revision,
              envelope.owner, eventId, receiptId, envelope.sourceHash, judgementDigest(context), envelope.policyHash,
              JSON.stringify(context), JSON.stringify(envelope.policy), state, now());
          if (state === 'active') {
            db.prepare(`INSERT INTO runtime_judgement_heads VALUES (?,?,?,?)
              ON CONFLICT(chat_id,message_id) DO UPDATE SET revision = excluded.revision,
              revision_identity = excluded.revision_identity`)
              .run(envelope.chatId, envelope.messageId, envelope.revision, envelope.revisionIdentity);
            this.observeModerationMessage({ ...envelope.comment, revisionIdentity: envelope.revisionIdentity });
            // This transaction reserves the only persisted judge job as well as
            // ownership. A process crash between the two cannot lose a schedule.
            if (envelope.judgeEligible !== false) {
              this.ensureModeratorJudgement({ eventId, receiptId, comment: envelope.comment, snapshotTtlSec });
            }
          }
          row = byRevision.get(envelope.revisionIdentity);
        }
        db.prepare('INSERT OR IGNORE INTO runtime_judgement_stream_receipts VALUES (?,?)')
          .run(receiptId, row.revision_identity);
        return { row, current: current(row), created: row.event_id === eventId };
      })();
    },
    getJudgementEnvelope(eventId) { return byEvent.get(String(eventId)) || null; },
    isCurrentJudgement(eventId) {
      const row = byEvent.get(String(eventId));
      // Pre-upgrade jobs are handled only when no newer owner exists for them.
      if (!row) {
        const legacy = legacyJob.get(String(eventId));
        if (legacy) return !head.get(legacy.chat_id, legacy.message_id)
          && legacyPeers.all(legacy.chat_id, legacy.message_id).length === 1;
        const job = this.getModeratorJudgement(eventId);
        let comment;
        try { comment = JSON.parse(job?.snapshot_json).comment; } catch { return false; }
        return Boolean(comment && !head.get(comment.chatId, comment.messageId));
      }
      return current(row);
    },
    judgementContext(eventId) {
      const row = byEvent.get(String(eventId));
      return row ? JSON.parse(row.context_json) : null;
    },
    resolveJudgementExemption({ claim, comment, reason }) {
      return db.transaction(() => {
        if (!this.isCurrentJudgement(claim.eventId)) return { resolved: false };
        const resolved = this.resolveModeratorJudgement({ claim,
          decision: { verdict: 'clean', reason, source: 'guard_preflight' },
          result: { verdict: 'clean', action: 'exempt' }, providerBoundary: 'not_started' });
        if (resolved.resolved) this.upsertAssistantDisposition({ chatId: comment.chatId,
          messageId: comment.messageId, status: 'allowed', verdict: 'exempt',
          moderationMessageId: comment.platformMessageId, reason, moderationEventId: claim.eventId });
        return resolved;
      })();
    },
    issueJudgementSubmissionClaim(providerClaim) {
      const row = byEvent.get(String(providerClaim?.eventId));
      const job = this.getModeratorJudgement(providerClaim?.eventId);
      if (!current(row) || job?.state !== 'calling' || job.lease_id !== providerClaim.leaseId
        || job.claim_generation !== providerClaim.claimGeneration) return null;
      const opaque = Object.freeze({ nonce: randomUUID() });
      issued.set(opaque, { providerClaim: { ...providerClaim }, sourceHash: row.source_hash,
        contextHash: row.context_hash, policyHash: row.policy_hash });
      return opaque;
    },
    submitJudgementVerdict(opaque, semantic) {
      return db.transaction(() => {
        const binding = issued.get(opaque);
        if (!binding) return { ready: false, reason: 'untrusted_judgement_claim' };
        const { providerClaim } = binding;
        const row = byEvent.get(providerClaim.eventId);
        if (!current(row) || binding.sourceHash !== row.source_hash || binding.contextHash !== row.context_hash
          || binding.policyHash !== row.policy_hash) return { ready: false, reason: 'stale_judgement_claim' };
        const job = this.getModeratorJudgement(row.event_id);
        // Reject revoked generations before any validation/conflict mutation.
        // An old callback cannot poison a newer accepted decision.
        if (!job || job.claim_generation !== providerClaim.claimGeneration
          || (!row.verdict_fingerprint && (job.state !== 'calling' || job.lease_id !== providerClaim.leaseId))) {
          return { ready: false, reason: 'provider_claim_fenced' };
        }
        let comment;
        try { comment = JSON.parse(job?.snapshot_json).comment; } catch { return { ready: false, reason: 'snapshot_invalid' }; }
        const context = JSON.parse(row.context_json);
        if (!comment || !validateJudgementSemantic(semantic, comment.text, {
          currentWeakStrikes: context.weakStrikes, warningStage: context.warningStage,
        })) {
          if (row.verdict_fingerprint) conflict(row);
          else failVerdict(row, 'invalid_judgement_submission');
          return { ready: false, reason: 'invalid_judgement_submission' };
        }
        const fingerprint = judgementDigest(semantic);
        if (row.verdict_fingerprint) {
          if (row.verdict_fingerprint !== fingerprint) { conflict(row); return { ready: false, reason: 'judgement_resubmission_conflict' }; }
          return { ...JSON.parse(row.accepted_json), duplicate: true };
        }
        if (job.state !== 'calling' || job.lease_id !== providerClaim.leaseId
          || job.claim_generation !== providerClaim.claimGeneration) return { ready: false, reason: 'provider_claim_fenced' };
        let decision = normalizeSafetyClassification(semantic);
        const policy = JSON.parse(row.policy_json);
        // Code signals are derived from the stored RAW message snapshot, never
        // from the stripped Assistant answer projection or model action fields.
        const signal = decision.safetyRoute !== 'threat' && (
          comment.isBot && !policy.exemptBots.includes(String(comment.userId)) ? 'is_bot'
            : comment.senderChatId ? 'sender_chat' : policy.banLinks && comment.hasLink ? 'link' : null);
        if (signal) decision = { ...decision, safetyRoute: 'threat', abuseLevel: null, confidence: 1 };
        const isWeak = policy.mode === 'live' && decision.safetyRoute === 'abuse' && decision.abuseLevel === 'weak';
        const usage = providerCallUsage(semantic.safetyTrace?.usage);
        const accepted = this.persistModeratorDecisionAndEnforcement({
          claim: providerClaim, chatId: comment.chatId, messageId: comment.messageId,
          userId: comment.userId, revisionIdentity: row.revision_identity, isWeak,
          decision: { safetyRoute: decision.safetyRoute, abuseLevel: decision.abuseLevel,
            confidence: decision.confidence, modelId: decision.modelId, usage },
          derivePolicy: (before) => planTelegramSafetyAction(decision, isWeak ? before : context.weakStrikes),
        });
        if (!accepted.ready) return accepted;
        this.upsertAssistantDisposition({ chatId: comment.chatId, messageId: comment.messageId,
          ...assistantDispositionForSafety(accepted.enforcement.policy),
          moderationMessageId: row.revision_identity, moderationEventId: row.event_id, reason: 'judgement_accepted' });
        // Never duplicate the retained raw snapshot or provider quote/rationale
        // into a receipt whose lifetime exceeds bounded source retention.
        const receipt = { ready: true, enforcement: accepted.enforcement,
          decision: { safetyRoute: decision.safetyRoute, abuseLevel: decision.abuseLevel,
            confidence: decision.confidence, modelId: decision.modelId } };
        db.prepare('UPDATE runtime_judgement_envelopes SET verdict_fingerprint = ?, accepted_json = ? WHERE event_id = ?')
          .run(fingerprint, JSON.stringify(receipt), row.event_id);
        return receipt;
      })();
    },
  };
}
