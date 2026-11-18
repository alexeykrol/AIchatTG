import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const APPLICATION_ID = 'join-gatekeeper';
// v2 (contract v2): tokens, verified members, journal, probation. Nothing was
// ever deployed with v1, so v1 files are refused rather than migrated.
const SCHEMA_VERSION = 2;
export const ACTIVE_STATES = Object.freeze(['screening', 'asking']);
export const STATES = Object.freeze([
  'screening',
  'asking',
  'manual_review',
  'approved',
  'declined_screening',
  'declined_answers',
  'declined_rate_limit',
  'timed_out',
  'shadow_logged',
  'probation',
  'probation_passed',
  'probation_removed',
  'approved_token',
]);
export const TOKEN_STATUSES = Object.freeze(['issued', 'used', 'revoked']);
// DM-failure reasons: an undecided manual_review with one of these may run the
// questionnaire after the user starts the bot (contract v2 §2).
export const DM_FAILURE_REASONS = Object.freeze(['dm_failed', 'dm_inconclusive', 'missing_user_chat_id']);
const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS join_metadata (
  application_id TEXT PRIMARY KEY CHECK (application_id = '${APPLICATION_ID}'),
  schema_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS join_processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS join_applications (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  state TEXT NOT NULL CHECK (state IN (${STATES.map((s) => `'${s}'`).join(', ')})),
  screening_verdict TEXT CHECK (screening_verdict IS NULL OR screening_verdict IN ('block', 'review', 'clean')),
  screening_reasons TEXT NOT NULL DEFAULT '[]',
  question_index INTEGER NOT NULL DEFAULT 0,
  retries_used INTEGER NOT NULL DEFAULT 0,
  dm_state TEXT NOT NULL DEFAULT 'none' CHECK (dm_state IN ('none', 'sent', 'failed')),
  conversation_open INTEGER NOT NULL DEFAULT 0 CHECK (conversation_open IN (0, 1)),
  user_chat_id TEXT,
  created_at INTEGER NOT NULL,
  deadline_at INTEGER,
  decided_at INTEGER,
  decision_reason TEXT,
  telegram_action_state TEXT NOT NULL DEFAULT 'none' CHECK (telegram_action_state IN ('none', 'done', 'failed', 'inconclusive')),
  questionnaire_state TEXT NOT NULL DEFAULT 'none' CHECK (questionnaire_state IN ('none', 'active')),
  probation_deadline_at INTEGER,
  restrict_state TEXT NOT NULL DEFAULT 'none' CHECK (restrict_state IN ('none', 'restricted', 'failed', 'inconclusive', 'lifted', 'lift_failed', 'lift_inconclusive'))
);
CREATE UNIQUE INDEX IF NOT EXISTS join_applications_one_active
  ON join_applications(chat_id, user_id) WHERE state IN ('screening', 'asking');
CREATE INDEX IF NOT EXISTS join_applications_user_created
  ON join_applications(user_id, created_at);
CREATE INDEX IF NOT EXISTS join_applications_state_deadline
  ON join_applications(state, deadline_at);
CREATE TABLE IF NOT EXISTS join_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL REFERENCES join_applications(id),
  question_id TEXT NOT NULL,
  text TEXT,
  pass INTEGER NOT NULL CHECK (pass IN (0, 1)),
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS join_answers_application ON join_answers(application_id, id);
CREATE INDEX IF NOT EXISTS join_applications_probation_deadline
  ON join_applications(state, probation_deadline_at);
CREATE TABLE IF NOT EXISTS join_access_tokens (
  token_sha256 TEXT PRIMARY KEY CHECK (length(token_sha256) = 64),
  site_record_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued', 'used', 'revoked')),
  telegram_user_id TEXT,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS join_access_tokens_one_issued
  ON join_access_tokens(site_record_id) WHERE status = 'issued';
CREATE INDEX IF NOT EXISTS join_access_tokens_site ON join_access_tokens(site_record_id, created_at);
CREATE TABLE IF NOT EXISTS join_verified_members (
  user_id TEXT PRIMARY KEY,
  site_record_id TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  verified_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS join_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  user_id TEXT,
  site_record_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS join_journal_event_user ON join_journal(event, user_id);
`;

const UPDATABLE = new Set([
  'state',
  'screening_verdict',
  'screening_reasons',
  'question_index',
  'retries_used',
  'dm_state',
  'conversation_open',
  'deadline_at',
  'decided_at',
  'decision_reason',
  'telegram_action_state',
  'user_chat_id',
  'questionnaire_state',
  'probation_deadline_at',
  'restrict_state',
]);

function rowToApplication(row) {
  if (!row) return null;
  return { ...row, screening_reasons: JSON.parse(row.screening_reasons || '[]') };
}

export class JoinStore {
  constructor(databasePath) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    const meta = this.db.prepare('SELECT schema_version FROM join_metadata WHERE application_id = ?').get(APPLICATION_ID);
    if (!meta) {
      this.db.prepare('INSERT INTO join_metadata (application_id, schema_version) VALUES (?, ?)').run(APPLICATION_ID, SCHEMA_VERSION);
    } else if (meta.schema_version !== SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`join-gatekeeper database schema_version ${meta.schema_version} is not supported (expected ${SCHEMA_VERSION})`);
    }
  }

  close() {
    this.db.close();
  }

  // Returns true when the update is new (claimed), false when already seen.
  claimUpdate(updateId, now) {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO join_processed_updates (update_id, processed_at) VALUES (?, ?)')
      .run(updateId, now);
    return result.changes === 1;
  }

  countApplicationsSince(userId, sinceMs) {
    return this.db
      .prepare('SELECT COUNT(*) AS n FROM join_applications WHERE user_id = ? AND created_at >= ?')
      .get(String(userId), sinceMs).n;
  }

  countApplicationsLastDay(userId, now) {
    return this.countApplicationsSince(userId, now - DAY_MS);
  }

  findActiveApplication(chatId, userId) {
    return rowToApplication(this.db.prepare(
      `SELECT * FROM join_applications WHERE chat_id = ? AND user_id = ? AND state IN ('screening', 'asking')`,
    ).get(String(chatId), String(userId)));
  }

  // The application whose questionnaire is in progress: v1 'asking', or a
  // probation / DM-failure manual_review started via /start (contract v2 §2).
  findAskingByUser(userId) {
    return rowToApplication(this.db.prepare(
      `SELECT * FROM join_applications WHERE user_id = ?
         AND (state = 'asking' OR (state IN ('probation', 'manual_review') AND questionnaire_state = 'active'))
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(String(userId)));
  }

  listByUserAndStates(userId, states) {
    const placeholders = states.map(() => '?').join(', ');
    return this.db.prepare(
      `SELECT * FROM join_applications WHERE user_id = ? AND state IN (${placeholders}) ORDER BY created_at, rowid`,
    ).all(String(userId), ...states).map(rowToApplication);
  }

  // Most recent probation, else most recent undecided DM-failure manual_review.
  findQuestionnaireTarget(userId) {
    const probation = this.db.prepare(
      `SELECT * FROM join_applications WHERE user_id = ? AND state = 'probation' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(String(userId));
    if (probation) return rowToApplication(probation);
    const placeholders = DM_FAILURE_REASONS.map(() => '?').join(', ');
    return rowToApplication(this.db.prepare(
      `SELECT * FROM join_applications WHERE user_id = ? AND state = 'manual_review' AND decision_reason IN (${placeholders})
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(String(userId), ...DM_FAILURE_REASONS));
  }

  listExpiredProbation(now) {
    return this.db.prepare(
      `SELECT * FROM join_applications WHERE state = 'probation' AND probation_deadline_at IS NOT NULL
         AND probation_deadline_at <= ? ORDER BY probation_deadline_at`,
    ).all(now).map(rowToApplication);
  }

  // ------------------------------------------------------------ tokens

  getToken(tokenSha256) {
    return this.db.prepare('SELECT * FROM join_access_tokens WHERE token_sha256 = ?').get(tokenSha256) || null;
  }

  listTokensBySite(siteRecordId) {
    return this.db.prepare(
      'SELECT * FROM join_access_tokens WHERE site_record_id = ? ORDER BY created_at, rowid',
    ).all(String(siteRecordId));
  }

  hasIssuedToken(siteRecordId) {
    return Boolean(this.db.prepare(
      `SELECT 1 FROM join_access_tokens WHERE site_record_id = ? AND status = 'issued'`,
    ).get(String(siteRecordId)));
  }

  insertIssuedToken({ tokenSha256, siteRecordId, now }) {
    this.db.prepare(`INSERT INTO join_access_tokens (token_sha256, site_record_id, status, created_at)
      VALUES (?, ?, 'issued', ?)`).run(tokenSha256, String(siteRecordId), now);
  }

  revokeIssuedTokens(siteRecordId, now) {
    return this.db.prepare(`UPDATE join_access_tokens SET status = 'revoked', revoked_at = ?
      WHERE site_record_id = ? AND status = 'issued'`).run(now, String(siteRecordId)).changes;
  }

  // Atomically binds an issued token to a Telegram account. Returns false if
  // the token was not 'issued' any more (lost race).
  useToken({ tokenSha256, userId, now }) {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE join_access_tokens SET status = 'used', telegram_user_id = ?, used_at = ?
        WHERE token_sha256 = ? AND status = 'issued'`).run(String(userId), now, tokenSha256).changes;
      if (changed !== 1) return false;
      const token = this.getToken(tokenSha256);
      this.db.prepare(`INSERT OR IGNORE INTO join_verified_members (user_id, site_record_id, token_sha256, verified_at)
        VALUES (?, ?, ?, ?)`).run(String(userId), token.site_record_id, tokenSha256, now);
      return true;
    })();
  }

  getVerifiedMember(userId) {
    return this.db.prepare('SELECT * FROM join_verified_members WHERE user_id = ?').get(String(userId)) || null;
  }

  isVerifiedSite(siteRecordId) {
    return Boolean(this.db.prepare('SELECT 1 FROM join_verified_members WHERE site_record_id = ?').get(String(siteRecordId)));
  }

  transaction(fn) {
    return this.db.transaction(fn)();
  }

  // ------------------------------------------------------------ journal

  addJournal({ event, userId = null, siteRecordId = null, details = {}, now }) {
    this.db.prepare(`INSERT INTO join_journal (event, user_id, site_record_id, details, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(event, userId == null ? null : String(userId), siteRecordId, JSON.stringify(details), now);
  }

  listJournal(event = null) {
    const rows = event
      ? this.db.prepare('SELECT * FROM join_journal WHERE event = ? ORDER BY id').all(event)
      : this.db.prepare('SELECT * FROM join_journal ORDER BY id').all();
    return rows.map((row) => ({ ...row, details: JSON.parse(row.details) }));
  }

  // Triage idempotency: has this user already been processed for this list?
  findTriageItem(listSha256, userId) {
    const row = this.db.prepare(
      `SELECT * FROM join_journal WHERE event = 'triage_item' AND user_id = ?
         AND json_extract(details, '$.list_sha256') = ? ORDER BY id DESC LIMIT 1`,
    ).get(String(userId), listSha256);
    return row ? { ...row, details: JSON.parse(row.details) } : null;
  }

  // Returns the created application, or null if an active application for the
  // same chat+user already exists (partial unique index).
  createApplication({
    chatId, userId, username = null, firstName = null, lastName = null, state, screeningVerdict = null,
    screeningReasons = [], userChatId = null, now, decidedAt = null, decisionReason = null, extra = {},
  }) {
    const id = crypto.randomUUID();
    try {
      this.db.prepare(`INSERT INTO join_applications
        (id, chat_id, user_id, username, first_name, last_name, state, screening_verdict, screening_reasons,
         user_chat_id, created_at, decided_at, decision_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, String(chatId), String(userId), username, firstName, lastName, state, screeningVerdict,
        JSON.stringify(screeningReasons), userChatId == null ? null : String(userChatId), now, decidedAt, decisionReason,
      );
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
      throw error;
    }
    if (Object.keys(extra).length) return this.updateApplication(id, extra);
    return this.getApplication(id);
  }

  getApplication(id) {
    return rowToApplication(this.db.prepare('SELECT * FROM join_applications WHERE id = ?').get(id));
  }

  updateApplication(id, fields) {
    const entries = Object.entries(fields);
    if (entries.length === 0) return this.getApplication(id);
    for (const [key] of entries) {
      if (!UPDATABLE.has(key)) throw new Error(`join_applications.${key} is not updatable`);
    }
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    const params = Object.fromEntries(entries.map(([key, value]) => [
      key,
      key === 'screening_reasons' ? JSON.stringify(value) : value,
    ]));
    this.db.prepare(`UPDATE join_applications SET ${assignments} WHERE id = @id`).run({ ...params, id });
    return this.getApplication(id);
  }

  addAnswer({ applicationId, questionId, text, pass, reason = null, now }) {
    this.db.prepare(`INSERT INTO join_answers (application_id, question_id, text, pass, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(applicationId, questionId, text ?? null, pass ? 1 : 0, reason, now);
  }

  listAnswers(applicationId) {
    return this.db.prepare('SELECT * FROM join_answers WHERE application_id = ? ORDER BY id').all(applicationId);
  }

  listExpiredAsking(now) {
    return this.db.prepare(
      `SELECT * FROM join_applications WHERE state = 'asking' AND deadline_at IS NOT NULL AND deadline_at <= ? ORDER BY deadline_at`,
    ).all(now).map(rowToApplication);
  }

  countByState() {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS n FROM join_applications GROUP BY state').all();
    return Object.fromEntries(rows.map((row) => [row.state, row.n]));
  }

  // Retention: personal data of decided applications older than retentionDays
  // is removed with conditional DELETE/UPDATE (INV-001: no DROP/TRUNCATE, no
  // unconditional DELETE). Open probation is not "decided" (it still governs
  // a restriction). Tokens, verified members and the journal are never purged.
  purgeExpired(now, retentionDays) {
    const cutoff = now - retentionDays * DAY_MS;
    const decided = `state NOT IN ('screening', 'asking', 'probation') AND COALESCE(decided_at, created_at) < @cutoff`;
    return this.db.transaction(() => {
      const answers = this.db.prepare(
        `DELETE FROM join_answers WHERE application_id IN (SELECT id FROM join_applications WHERE ${decided})`,
      ).run({ cutoff }).changes;
      const applications = this.db.prepare(
        `UPDATE join_applications SET username = NULL, first_name = NULL, last_name = NULL
         WHERE ${decided} AND (username IS NOT NULL OR first_name IS NOT NULL OR last_name IS NOT NULL)`,
      ).run({ cutoff }).changes;
      const updates = this.db.prepare('DELETE FROM join_processed_updates WHERE processed_at < @cutoff').run({ cutoff }).changes;
      return { answers, applications, updates };
    })();
  }
}
