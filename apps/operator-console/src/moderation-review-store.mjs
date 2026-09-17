import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { detectPromotionReview } from './moderation-review-detector.mjs';
import { acquireModerationReviewOwner } from './moderation-review-owner.mjs';
import { validateModerationReviewEnvelope } from '../../../packages/telegram-core/src/moderation-review-projection.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const LABELS = new Set(['hidden_advertising', 'legitimate', 'insufficient_evidence']);
const APPLICATION_ID = 0x4d525631;
const LIMIT_KEYS = ['retentionMs', 'maxTextChars', 'maxContextChars', 'maxNoteChars', 'maxObservations'];
const LIVE_TABLES = ['review_cases', 'review_observations', 'review_decisions', 'review_decision_evidence',
  'review_patterns', 'review_alerts', 'review_erasure_receipts', 'review_intake_binding', 'review_native_sources',
  'review_intake_events', 'review_dispatch_authorizations', 'review_alert_budget', 'review_source_revisions'].sort();
// This local synthetic slice has one process owner; it is not a shared production DB.
const OPEN_STORES = new Set();

export class ModerationReviewError extends Error {
  constructor(code, statusCode = 409) { super(code); this.code = code; this.statusCode = statusCode; }
}
const fail = (code, status = 400) => { throw new ModerationReviewError(code, status); };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value) => JSON.stringify(value);
const parse = (value) => JSON.parse(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function shape(value, required, optional = []) {
  if (!record(value) || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => ![...required, ...optional].includes(key))) fail('review_shape_invalid');
}
function identifier(value, name, maximum = 128) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`review_${name}_invalid`);
  }
  return value;
}
function uuid(value, name) { if (typeof value !== 'string' || !UUID.test(value)) fail(`review_${name}_invalid`); return value.toLowerCase(); }
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`review_${name}_invalid`);
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value.replace(/Z$/u, value.includes('.') ? 'Z' : '.000Z')) {
    fail('review_observedAt_invalid');
  }
  return value;
}
function plainText(value, name) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > 1_000_000) fail(`review_${name}_invalid`);
  return value;
}
function paging(input, allowed = []) {
  shape(input, [], ['limit', 'offset', ...allowed]);
  const limit = input.limit ?? 30, offset = input.offset ?? 0;
  integer(limit, 'limit', 1); integer(offset, 'offset');
  if (limit > 100) fail('review_limit_invalid');
  return { limit, offset };
}
function privatePath(path, kind) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
    || (kind === 'file' && stat.nlink !== 1)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('review_storage_invalid', 503);
  return stat;
}
const pathExists = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
function receiptIdentifier(value) {
  if (value === undefined || value === null) return null;
  // Only an opaque transport identifier is persisted, never an error/provider body.
  if (typeof value === 'string' && UUID.test(value)) return value.toLowerCase();
  if (record(value) && Object.keys(value).length === 1 && typeof value.id === 'string'
    && UUID.test(value.id)) return value.id.toLowerCase();
  fail('review_alert_receipt_invalid');
}

/** Console-only Review state. Never opens or modifies the runtime DB. Live
 * construction requires explicit policy and preprovisioned private storage. */
export function createModerationReviewStore({ root, mode, limits, now = Date.now,
  capturePolicy = null, maxEvents = null, maxErasureReceipts = null, maxAlertsPerHour = null, provision = false } = {}) {
  const live = mode === 'live' && record(capturePolicy) && capturePolicy.enabled === true;
  if (mode !== 'synthetic' && !live) fail('review_mode_invalid');
  if (typeof root !== 'string' || !isAbsolute(root)
    || ['/', resolve(homedir()), resolve(tmpdir())].includes(resolve(root))) fail('review_root_invalid');
  shape(limits, LIMIT_KEYS);
  if (limits.retentionMs !== null) integer(limits.retentionMs, 'retentionMs', 1);
  for (const key of LIMIT_KEYS.slice(1)) integer(limits[key], key, 1);
  if (typeof now !== 'function') fail('review_clock_invalid');
  // Capture validated values; a caller cannot change retention or caps after construction.
  limits = Object.freeze({ ...limits });
  if (live) {
    if (limits.retentionMs !== null) fail('review_live_retention_invalid');
    integer(maxEvents, 'maxEvents', 1); integer(maxErasureReceipts, 'maxErasureReceipts', 1);
    integer(maxAlertsPerHour, 'maxAlertsPerHour', 1);
    capturePolicy = JSON.parse(JSON.stringify(capturePolicy));
  }
  const clock = () => {
    const value = now(); integer(value, 'clock');
    if (!Number.isFinite(new Date(value).getTime())) fail('review_clock_invalid');
    return value;
  };
  clock();
  const requestedRoot = resolve(root);
  if (live) {
    let ancestor = requestedRoot;
    while (!pathExists(ancestor)) ancestor = dirname(ancestor);
    if (realpathSync(ancestor) !== ancestor) fail('review_storage_invalid', 503);
  }
  if (pathExists(requestedRoot)) {
    const stat = privatePath(requestedRoot, 'directory');
    if (live && (stat.mode & 0o777) !== 0o700) fail('review_storage_invalid', 503);
  } else if (live && !provision) fail('review_storage_not_provisioned', 503);
  mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  privatePath(requestedRoot, 'directory');
  if (!live) chmodSync(requestedRoot, 0o700);
  root = realpathSync(requestedRoot);
  const path = join(root, 'moderation-review.sqlite');
  if (OPEN_STORES.has(path)) fail('review_store_already_open', 409);
  if (live && !existsSync(path) && provision !== true) fail('review_storage_not_provisioned', 503);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (pathExists(path + suffix)) privatePath(path + suffix, 'file');
  }
  const owner = live ? acquireModerationReviewOwner(root) : null;
  let rootStat, databaseStat;
  try {
    if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
    privatePath(path, 'file'); chmodSync(path, 0o600);
    rootStat = privatePath(root, 'directory'); databaseStat = privatePath(path, 'file');
  } catch (error) { owner?.release(); throw error; }
  OPEN_STORES.add(path);
  let db;
  try {
    db = new Database(path);
    db.pragma('busy_timeout = 1000');
    const applicationId = db.pragma('application_id', { simple: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const schemaDigest = () => hash(db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all());
    if ((applicationId !== APPLICATION_ID && tables.length) || (applicationId && applicationId !== APPLICATION_ID)) {
      fail('review_storage_schema_invalid', 503);
    }
    if (applicationId === APPLICATION_ID && ![1, 2].includes(db.pragma('user_version', { simple: true }))) {
      fail('review_storage_schema_invalid', 503);
    }
    if (!live && db.pragma('user_version', { simple: true }) === 2) fail('review_mode_invalid');
    if (live && db.pragma('user_version', { simple: true }) === 2) {
      // Validate existing state BEFORE CREATE IF NOT EXISTS or orphan recovery:
      // missing fences must never become an apparently fresh empty ledger.
      if (tables.map((row) => row.name).sort().join(',') !== LIVE_TABLES.join(',')) fail('review_storage_schema_invalid', 503);
      const binding = db.prepare('SELECT schema_digest FROM review_intake_binding WHERE singleton=1').get();
      if (!binding || binding.schema_digest !== schemaDigest()) fail('review_storage_schema_invalid', 503);
    } else if (live && (!provision || tables.length)) fail('review_storage_not_provisioned', 503);
    db.pragma('journal_mode = DELETE');
    db.pragma('secure_delete = ON');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_cases (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL,
        chat_id TEXT NOT NULL, fingerprint TEXT NOT NULL, pattern_ids TEXT NOT NULL,
        reasons TEXT NOT NULL, detector_version TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, expires_at INTEGER, label TEXT
      );
      CREATE TABLE IF NOT EXISTS review_observations (
        id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
        revision INTEGER NOT NULL, fingerprint TEXT NOT NULL, text TEXT NOT NULL,
        user_id TEXT, observed_at TEXT NOT NULL, context_json TEXT, truncated_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER,
        case_id TEXT REFERENCES review_cases(id) ON DELETE CASCADE,
        UNIQUE(chat_id, message_id, revision)
      );
      CREATE INDEX IF NOT EXISTS review_native ON review_observations(chat_id, message_id, revision DESC);
      CREATE INDEX IF NOT EXISTS review_case_evidence ON review_observations(case_id, id);
      CREATE TABLE IF NOT EXISTS review_decisions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        case_id TEXT NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
        evidence_version INTEGER NOT NULL, resulting_version INTEGER NOT NULL,
        request_fingerprint TEXT NOT NULL, label TEXT NOT NULL, note TEXT NOT NULL,
        principal TEXT NOT NULL, created_at INTEGER NOT NULL, pattern_draft_id TEXT
      );
      CREATE TABLE IF NOT EXISTS review_decision_evidence (
        decision_id TEXT NOT NULL REFERENCES review_decisions(id) ON DELETE CASCADE,
        observation_id INTEGER NOT NULL REFERENCES review_observations(id) ON DELETE CASCADE,
        PRIMARY KEY(decision_id, observation_id)
      );
      CREATE TABLE IF NOT EXISTS review_patterns (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        case_id TEXT NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
        decision_id TEXT NOT NULL REFERENCES review_decisions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, pattern_ids TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_alerts (
        case_id TEXT PRIMARY KEY REFERENCES review_cases(id) ON DELETE CASCADE,
        state TEXT NOT NULL, attempt_id TEXT UNIQUE, receipt_id TEXT
      );
      CREATE TABLE IF NOT EXISTS review_erasure_receipts (
        request_id TEXT PRIMARY KEY, case_id TEXT UNIQUE NOT NULL, principal TEXT NOT NULL,
        expected_version INTEGER NOT NULL, deleted_at INTEGER NOT NULL
      );
    `);
    db.pragma(`application_id = ${APPLICATION_ID}`);
    if (live) {
      const policyHash = hash({ capturePolicy, limits, maxEvents, maxErasureReceipts, maxAlertsPerHour });
      const hasBinding = db.prepare("SELECT name FROM sqlite_master WHERE name='review_intake_binding'").get();
      if (!hasBinding && (!provision || db.prepare('SELECT count(*) AS n FROM review_cases').get().n
        || db.prepare('SELECT count(*) AS n FROM review_erasure_receipts').get().n)) fail('review_storage_not_provisioned', 503);
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS review_intake_binding (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), binding_id TEXT NOT NULL,
            epoch_id TEXT NOT NULL, policy_hash TEXT NOT NULL, intake_seq INTEGER NOT NULL,
            schema_digest TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS review_native_sources (
            chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
            case_id TEXT NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
            source_date INTEGER NOT NULL, revision_time INTEGER NOT NULL,
            source_digest TEXT NOT NULL, revision INTEGER NOT NULL,
            PRIMARY KEY(chat_id,message_id)
          );
          CREATE TABLE IF NOT EXISTS review_intake_events (
            event_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
            source_digest TEXT NOT NULL, intake_seq INTEGER UNIQUE NOT NULL, outcome TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS review_source_revisions (
            chat_id TEXT NOT NULL, message_id TEXT NOT NULL, revision_time INTEGER NOT NULL,
            source_digest TEXT NOT NULL, case_id TEXT NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
            PRIMARY KEY(chat_id,message_id,revision_time)
          );
          CREATE TABLE IF NOT EXISTS review_dispatch_authorizations (
            case_id TEXT PRIMARY KEY REFERENCES review_cases(id) ON DELETE CASCADE,
            attempt_id TEXT UNIQUE NOT NULL
          );
          CREATE TABLE IF NOT EXISTS review_alert_budget (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), hour INTEGER NOT NULL, used INTEGER NOT NULL
          );
        `);
        const binding = db.prepare('SELECT * FROM review_intake_binding WHERE singleton=1').get();
        if (!binding) {
          if (!provision || hasBinding) fail('review_checkpoint_unknown', 503);
          db.prepare('INSERT INTO review_intake_binding VALUES (1,?,?,?,0,?)')
            .run(capturePolicy.bindingId, capturePolicy.epochId, policyHash, schemaDigest());
          db.prepare('INSERT INTO review_alert_budget VALUES (1,0,0)').run();
        } else if (binding.binding_id !== capturePolicy.bindingId || binding.epoch_id !== capturePolicy.epochId
          || binding.policy_hash !== policyHash || !Number.isSafeInteger(binding.intake_seq) || binding.intake_seq < 0
          || db.prepare('SELECT count(*) AS n FROM review_intake_events WHERE intake_seq>?').get(binding.intake_seq).n) {
          fail('review_checkpoint_unknown', 503);
        }
        db.pragma('user_version = 2');
      }).immediate();
      if (db.pragma('quick_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) {
        fail('review_storage_schema_invalid', 503);
      }
      if (db.prepare(`SELECT count(*) AS n FROM review_observations o
        LEFT JOIN review_native_sources n ON n.chat_id=o.chat_id AND n.message_id=o.message_id
        WHERE o.case_id IS NULL OR n.case_id IS NULL OR n.case_id<>o.case_id`).get().n
        || db.prepare(`SELECT count(*) AS n FROM review_native_sources n
          LEFT JOIN review_observations o ON o.chat_id=n.chat_id AND o.message_id=n.message_id AND o.revision=n.revision
          WHERE o.id IS NULL OR n.case_id<>o.case_id OR n.source_digest<>o.fingerprint OR n.revision<>
          (SELECT max(revision) FROM review_observations z WHERE z.chat_id=n.chat_id AND z.message_id=n.message_id)`).get().n
        || db.prepare(`SELECT count(*) AS n FROM review_native_sources n LEFT JOIN review_source_revisions r
          ON r.chat_id=n.chat_id AND r.message_id=n.message_id AND r.revision_time=n.revision_time
          WHERE r.chat_id IS NULL OR r.source_digest<>n.source_digest OR r.case_id<>n.case_id`).get().n
        || db.prepare(`SELECT count(*) AS n FROM review_intake_events e LEFT JOIN review_source_revisions r
          ON r.case_id=e.case_id AND r.source_digest=e.source_digest WHERE r.chat_id IS NULL`).get().n
        || db.prepare(`SELECT count(*) AS n FROM review_observations o LEFT JOIN review_source_revisions r
          ON r.case_id=o.case_id AND r.chat_id=o.chat_id AND r.message_id=o.message_id AND r.source_digest=o.fingerprint
          WHERE r.chat_id IS NULL`).get().n
        || db.prepare(`SELECT count(*) AS n FROM review_source_revisions r LEFT JOIN review_intake_events e
          ON e.case_id=r.case_id AND e.source_digest=r.source_digest WHERE e.event_id IS NULL`).get().n) fail('review_checkpoint_unknown', 503);
      const budget = db.prepare('SELECT * FROM review_alert_budget WHERE singleton=1').get();
      if (!budget || !Number.isSafeInteger(budget.hour) || budget.hour < 0 || !Number.isSafeInteger(budget.used)
        || budget.used < 0 || budget.used > maxAlertsPerHour) fail('review_checkpoint_unknown', 503);
    } else db.pragma('user_version = 1');
    // A send whose process ended has an unknown external outcome. Never requeue it.
    db.prepare("UPDATE review_alerts SET state='uncertain' WHERE state='calling'").run();
  } catch (error) {
    db?.close();
    OPEN_STORES.delete(path);
    owner?.release();
    if (error instanceof ModerationReviewError) throw error;
    throw new ModerationReviewError('review_storage_unavailable', 503);
  }
  let closed = false;
  function ready() {
    if (closed) fail('review_store_closed', 503);
    owner?.verify();
    try {
      privatePath(requestedRoot, 'directory');
      const directory = privatePath(root, 'directory'), file = privatePath(path, 'file');
      if (directory.ino !== rootStat.ino || directory.dev !== rootStat.dev
        || file.ino !== databaseStat.ino || file.dev !== databaseStat.dev
        || (directory.mode & 0o777) !== 0o700 || (file.mode & 0o777) !== 0o600) {
        fail('review_storage_invalid', 503);
      }
    } catch { fail('review_storage_invalid', 503); }
  }
  const expiry = (time) => {
    if (limits.retentionMs === null) return null;
    const value = time + limits.retentionMs;
    if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) fail('review_retentionMs_invalid');
    return value;
  };
  const iso = (value) => value === null ? null : new Date(value).toISOString();
  function purge() {
    if (limits.retentionMs === null) return { cases: 0, observations: 0 };
    const time = clock();
    const before = db.prepare('SELECT count(*) AS n FROM review_observations').get().n;
    const cases = db.prepare('DELETE FROM review_cases WHERE expires_at IS NOT NULL AND expires_at <= ?').run(time).changes;
    // Case evidence is retained together until its case expires, not partially removed.
    db.prepare('DELETE FROM review_observations WHERE case_id IS NULL AND expires_at IS NOT NULL AND expires_at <= ?').run(time);
    return { cases, observations: before - db.prepare('SELECT count(*) AS n FROM review_observations').get().n };
  }
  function atomic(work) { ready(); return db.transaction(() => { purge(); return work(); }).immediate(); }
  function observation(row) {
    return { messageId: row.message_id, revision: row.revision, text: row.text,
      userId: row.user_id, observedAt: row.observed_at, context: parse(row.context_json),
      truncated: parse(row.truncated_json) };
  }
  function summary(row) {
    const latest = db.prepare('SELECT text FROM review_observations WHERE case_id=? ORDER BY id DESC LIMIT 1').get(row.id);
    const count = db.prepare('SELECT count(DISTINCT message_id) AS n FROM review_observations WHERE case_id=?').get(row.id).n;
    return { id: row.id, version: row.version, status: row.status, chatId: row.chat_id,
      updatedAt: iso(row.updated_at), preview: latest?.text.slice(0, 160) || '',
      patternIds: parse(row.pattern_ids), messageCount: count, label: row.label };
  }
  function decision(row) {
    return { decisionId: row.id, caseId: row.case_id, evidenceVersion: row.evidence_version,
      label: row.label, note: row.note, createdAt: iso(row.created_at), principal: row.principal,
      patternDraftId: row.pattern_draft_id,
      evidence: db.prepare(`SELECT o.message_id, o.revision FROM review_decision_evidence d
        JOIN review_observations o ON o.id=d.observation_id WHERE d.decision_id=? ORDER BY o.id`).all(row.id)
        .map((row) => ({ messageId: row.message_id, revision: row.revision })) };
  }
  function erasure(row) {
    return { caseId: row.case_id, requestId: row.request_id, principal: row.principal,
      expectedVersion: row.expected_version, deletedAt: iso(row.deleted_at), erased: true };
  }
  function normalize(input, admission = {}) {
    shape(input, ['chatId', 'messageId', 'revision', 'text', 'observedAt'], ['userId', 'context']);
    const value = { chatId: identifier(input.chatId, 'chatId'), messageId: identifier(input.messageId, 'messageId'),
      revision: integer(input.revision, 'revision'), text: plainText(input.text, 'text'),
      observedAt: timestamp(input.observedAt), userId: input.userId === undefined ? null : identifier(input.userId, 'userId'), context: null };
    if (input.context !== undefined && input.context !== null) {
      shape(input.context, ['text', 'messageId']);
      value.context = { text: plainText(input.context.text, 'context'), messageId: identifier(input.context.messageId, 'contextMessageId') };
    }
    // Retry arrival time is not a content revision; keep the first observedAt.
    const { observedAt, ...sourceIdentity } = value;
    const fingerprint = admission.sourceDigest || hash(sourceIdentity);
    const truncated = { text: value.text.length > limits.maxTextChars || admission.truncated?.text === true,
      context: Boolean(value.context && value.context.text.length > limits.maxContextChars) || admission.truncated?.context === true,
      ...(admission.contextUnavailable ? { contextUnavailable: true } : {}) };
    value.text = value.text.slice(0, limits.maxTextChars);
    if (value.context) value.context.text = value.context.text.slice(0, limits.maxContextChars);
    const detectorObservation = { ...value, context: value.context && { ...value.context } };
    return { value, fingerprint, truncated, detectorObservation };
  }
  // Earlier synthetic v1 stores admitted ordinary observations without a case.
  // Make those retained revisions reachable for manual erasure on reopen, but
  // do not retrospectively classify them or enqueue an alert.
  try {
    db.transaction(() => {
      const natives = db.prepare(`SELECT chat_id,message_id,count(*) AS revisions,
        min(created_at) AS created_at,max(created_at) AS updated_at,max(expires_at) AS expires_at
        FROM review_observations WHERE case_id IS NULL GROUP BY chat_id,message_id`).all();
      for (const native of natives) {
        const id = randomUUID();
        db.prepare(`INSERT INTO review_cases VALUES (?,?,'retained',?,?,'[]','[]','retained-legacy-v1',?,?,?,NULL)`)
          .run(id, native.revisions, native.chat_id, `unclassified:${id}`, native.created_at, native.updated_at,
            limits.retentionMs === null ? null : native.expires_at);
        db.prepare("INSERT INTO review_alerts(case_id,state) VALUES (?,'disabled')").run(id);
        db.prepare('UPDATE review_observations SET case_id=? WHERE chat_id=? AND message_id=? AND case_id IS NULL')
          .run(id, native.chat_id, native.message_id);
      }
    }).immediate();
  } catch {
    db.close(); OPEN_STORES.delete(path); owner?.release();
    fail('review_storage_unavailable', 503);
  }
  const reviewCaseId = (id) => id && db.prepare('SELECT status FROM review_cases WHERE id=?').get(id)?.status !== 'retained'
    ? id : null;
  const captureAdmission = Symbol('capture-admission');
  const api = {
    ingest(input, admission = {}) {
      if (live && admission[captureAdmission] !== true) fail('review_capture_required', 403);
      const { value, fingerprint, truncated, detectorObservation } = normalize(input, admission);
      return atomic(() => {
        const prior = db.prepare('SELECT * FROM review_observations WHERE chat_id=? AND message_id=? ORDER BY revision DESC LIMIT 1')
          .get(value.chatId, value.messageId);
        const exact = db.prepare('SELECT * FROM review_observations WHERE chat_id=? AND message_id=? AND revision=?')
          .get(value.chatId, value.messageId, value.revision);
        if (exact && exact.fingerprint !== fingerprint) fail('review_revision_conflict', 409);
        if (exact) return { caseId: reviewCaseId(exact.case_id), duplicate: true, stale: Boolean(prior.revision > value.revision) };
        if (prior && prior.revision > value.revision) return { caseId: reviewCaseId(prior.case_id), duplicate: false, stale: true };
        if (db.prepare('SELECT count(*) AS n FROM review_observations').get().n >= limits.maxObservations) {
          fail('review_capacity_reached', 409);
        }
        const historyRows = db.prepare(`SELECT o.* FROM review_observations o WHERE chat_id=? AND message_id<>?
          AND revision=(SELECT max(revision) FROM review_observations n WHERE n.chat_id=o.chat_id AND n.message_id=o.message_id)
          ORDER BY id DESC LIMIT ?`).all(value.chatId, value.messageId, limits.maxObservations)
          .filter((row) => !Object.values(parse(row.truncated_json)).some(Boolean));
        const detect = (rows) => {
          // Do not mistake a retained prefix for exact repeated product/URL evidence.
          const result = detectPromotionReview(detectorObservation, {
            history: rows.map((row) => ({ chatId: row.chat_id, ...observation(row) })),
          });
          if (!record(result) || result.reviewOnly !== true || typeof result.version !== 'string'
            || !/^[a-f0-9]{64}$/u.test(result.fingerprint || '')
            || !['patternIds', 'reasons', 'relatedMessageIds'].every((key) => Array.isArray(result[key])
              && result[key].every((item) => typeof item === 'string' && item.length <= 256))) {
            fail('review_detector_invalid', 503);
          }
          // A clipped source/context may omit a claim or its qualification.
          // Retain it visibly for manual inspection, but introduce no detector
          // claim, repeat grouping or alert from incomplete evidence.
          if (Object.values(truncated).some(Boolean)) {
            return { ...result, patternIds: [], reasons: [], relatedMessageIds: [] };
          }
          return result;
        };
        let detected = detect(historyRows);
        const time = clock(), expires = expiry(time);
        // A retained source may be coalesced only before human review or any
        // delivery attempt. Pending/reviewed cases are never source donors.
        const coalescible = new Set(db.prepare(`SELECT c.id FROM review_cases c
          JOIN review_alerts a ON a.case_id=c.id WHERE c.chat_id=? AND c.status='retained'
          AND a.state='disabled' AND a.attempt_id IS NULL AND a.receipt_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM review_decisions d WHERE d.case_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM review_patterns p WHERE p.case_id=c.id)`).all(value.chatId).map((row) => row.id));
        let existing = prior?.case_id ? db.prepare('SELECT * FROM review_cases WHERE id=?').get(prior.case_id) : null;
        if (!existing && detected.patternIds.length) {
          for (const messageId of detected.relatedMessageIds) {
            existing = db.prepare(`SELECT c.* FROM review_cases c JOIN review_observations o ON o.case_id=c.id
              WHERE o.chat_id=? AND o.message_id=? ORDER BY c.created_at, c.id LIMIT 1`).get(value.chatId, messageId);
            if (existing) break;
          }
          // Only qualified related messages may locate a shared case. A stored
          // fingerprint can outlive an edit, clipped context or an exercise
          // exclusion, so it is never independent grouping evidence.
        }
        // Same-chat history can locate a candidate case, but only evidence that
        // is already visible there or can join it may support persisted claims.
        // In particular, an edit or a new message may match several immutable
        // cases. Never borrow another case's proof while refusing to merge it.
        detected = detect(historyRows.filter((row) => row.case_id === null || row.case_id === existing?.id
          || coalescible.has(row.case_id)));
        const caseId = existing?.id || randomUUID();
        const suspicious = detected.patternIds.length > 0;
        const status = suspicious || (existing && existing.status !== 'retained') ? 'pending' : 'retained';
        const patternIds = [...new Set([...(existing ? parse(existing.pattern_ids) : []), ...detected.patternIds])];
        const reasons = [...new Set([...(existing ? parse(existing.reasons) : []), ...detected.reasons])];
        if (existing) {
          db.prepare(`UPDATE review_cases SET version=version+1,status=?,updated_at=?,expires_at=?,
            pattern_ids=?,reasons=?,detector_version=?,label=NULL WHERE id=?`)
            .run(status, time, expires, json(patternIds), json(reasons), detected.version, caseId);
          if (suspicious) db.prepare("UPDATE review_alerts SET state='pending' WHERE case_id=? AND state='disabled'").run(caseId);
        } else {
          db.prepare(`INSERT INTO review_cases VALUES (?,1,?,?,?,?,?,?,?,?,?,NULL)`)
            .run(caseId, status, value.chatId, detected.fingerprint, json(patternIds), json(reasons), detected.version, time, time, expires);
          db.prepare('INSERT INTO review_alerts(case_id,state) VALUES (?,?)').run(caseId, suspicious ? 'pending' : 'disabled');
        }
        if (suspicious) {
          const related = new Set(detected.relatedMessageIds);
          const donors = new Set(historyRows.filter((row) => related.has(row.message_id)
            && row.case_id !== caseId && coalescible.has(row.case_id)).map((row) => row.case_id));
          for (const donor of donors) {
            // Move all immutable revisions before retiring the never-reviewed
            // source case. Its old opaque ID intentionally becomes missing.
            db.prepare('UPDATE review_observations SET case_id=? WHERE case_id=?').run(caseId, donor);
            if (live) {
              db.prepare('UPDATE review_native_sources SET case_id=? WHERE case_id=?').run(caseId, donor);
              db.prepare('UPDATE review_intake_events SET case_id=? WHERE case_id=?').run(caseId, donor);
              db.prepare('UPDATE review_source_revisions SET case_id=? WHERE case_id=?').run(caseId, donor);
            }
            db.prepare('DELETE FROM review_cases WHERE id=?').run(donor);
          }
        }
        db.prepare(`INSERT INTO review_observations(chat_id,message_id,revision,fingerprint,text,user_id,observed_at,
          context_json,truncated_json,created_at,expires_at,case_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(value.chatId, value.messageId, value.revision, fingerprint, value.text, value.userId, value.observedAt,
            json(value.context), json(truncated), time, expires, caseId);
        return { caseId: status === 'retained' ? null : caseId, duplicate: false, stale: false };
      });
    },
    capture(input) {
      if (!live) fail('review_capture_disabled', 503);
      const envelope = validateModerationReviewEnvelope(input, capturePolicy, { now: new Date(clock()).toISOString() });
      const receipt = (row) => ({ contract: 'moderation-review-receipt/v1', bindingId: capturePolicy.bindingId,
        epochId: capturePolicy.epochId, intakeSeq: row.intake_seq, outcome: row.outcome });
      return atomic(() => {
        const priorEvent = db.prepare('SELECT * FROM review_intake_events WHERE event_id=?').get(envelope.updateId);
        if (priorEvent) {
          if (priorEvent.source_digest !== envelope.sourceDigest) fail('review_event_conflict', 409);
          return receipt(priorEvent);
        }
        if (db.prepare('SELECT count(*) AS n FROM review_intake_events').get().n >= maxEvents) fail('review_event_capacity_reached', 409);
        let native = db.prepare('SELECT * FROM review_native_sources WHERE chat_id=? AND message_id=?')
          .get(envelope.chatId, envelope.messageId);
        const revisionTime = envelope.kind === 'edit' ? envelope.editDateSec : -1;
        if (native && native.source_date !== envelope.sourceDateSec) fail('review_source_date_conflict', 409);
        const knownRevision = db.prepare('SELECT * FROM review_source_revisions WHERE chat_id=? AND message_id=? AND revision_time=?')
          .get(envelope.chatId, envelope.messageId, revisionTime);
        if (knownRevision && knownRevision.source_digest !== envelope.sourceDigest) fail('review_revision_order_conflict', 409);
        let outcome = 'accepted', caseId = native?.case_id;
        if (native && revisionTime < native.revision_time) outcome = 'stale';
        else if (native && revisionTime === native.revision_time) {
          if (native.source_digest !== envelope.sourceDigest) fail('review_revision_order_conflict', 409);
          outcome = 'duplicate';
        } else {
          // Reserve eventual minimal erase-receipt capacity before admitting a
          // new native/case. Erasure itself has no additional logical quota gate.
          if (!native && db.prepare(`SELECT (SELECT count(*) FROM review_cases)
            +(SELECT count(*) FROM review_erasure_receipts) AS n`).get().n >= maxErasureReceipts) {
            fail('review_erasure_reserve_full', 409);
          }
          const revision = (native?.revision || 0) + 1;
          api.ingest({ chatId: envelope.chatId, messageId: envelope.messageId, revision,
            text: envelope.text, observedAt: envelope.observedAt,
            ...(envelope.userId === null ? {} : { userId: envelope.userId }),
            ...(envelope.context === null ? {} : { context: {
              messageId: envelope.context.messageId, text: envelope.context.text,
            } }) }, { [captureAdmission]: true, sourceDigest: envelope.sourceDigest,
            truncated: envelope.truncated, contextUnavailable: envelope.contextStatus === 'unavailable' });
          caseId = db.prepare('SELECT case_id FROM review_observations WHERE chat_id=? AND message_id=? AND revision=?')
            .get(envelope.chatId, envelope.messageId, revision).case_id;
          db.prepare(`INSERT INTO review_native_sources VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(chat_id,message_id) DO UPDATE SET case_id=excluded.case_id,
            revision_time=excluded.revision_time,source_digest=excluded.source_digest,revision=excluded.revision`)
            .run(envelope.chatId, envelope.messageId, caseId, envelope.sourceDateSec, revisionTime, envelope.sourceDigest, revision);
        }
        const binding = db.prepare('SELECT intake_seq FROM review_intake_binding WHERE singleton=1').get();
        if (!binding || !Number.isSafeInteger(binding.intake_seq + 1)) fail('review_checkpoint_unknown', 503);
        const sequence = binding.intake_seq + 1;
        if (!knownRevision) db.prepare('INSERT INTO review_source_revisions VALUES (?,?,?,?,?)')
          .run(envelope.chatId, envelope.messageId, revisionTime, envelope.sourceDigest, caseId);
        db.prepare('INSERT INTO review_intake_events VALUES (?,?,?,?,?)')
          .run(envelope.updateId, caseId, envelope.sourceDigest, sequence, outcome);
        db.prepare('UPDATE review_intake_binding SET intake_seq=? WHERE singleton=1').run(sequence);
        return receipt({ intake_seq: sequence, outcome });
      });
    },
    status() {
      return atomic(() => ({ mode: live ? 'live' : 'synthetic', collectionEnabled: live, deliveryEnabled: false,
        decisionsEnabled: true, patternActivationEnabled: false, sanctionsEnabled: false,
        retentionMs: limits.retentionMs, counts: {
          retained: db.prepare("SELECT count(*) AS n FROM review_cases WHERE status='retained'").get().n,
          pending: db.prepare("SELECT count(*) AS n FROM review_cases WHERE status='pending'").get().n,
          reviewed: db.prepare("SELECT count(*) AS n FROM review_cases WHERE status='reviewed'").get().n,
          patterns: db.prepare('SELECT count(*) AS n FROM review_patterns').get().n,
        } }));
    },
    listCases(input = {}) {
      const { limit, offset } = paging(input, ['status']);
      const status = input.status ?? 'pending';
      if (!['pending', 'reviewed', 'retained', 'all'].includes(status)) fail('review_status_invalid');
      return atomic(() => {
        const where = status === 'all' ? '' : ' WHERE status=?', args = status === 'all' ? [] : [status];
        return { cases: db.prepare(`SELECT * FROM review_cases${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`)
          .all(...args, limit, offset).map(summary), total: db.prepare(`SELECT count(*) AS n FROM review_cases${where}`).get(...args).n };
      });
    },
    getCase(id) {
      id = uuid(id, 'caseId');
      return atomic(() => {
        const row = db.prepare('SELECT * FROM review_cases WHERE id=?').get(id);
        if (!row) return null;
        return { ...summary(row), messages: db.prepare('SELECT * FROM review_observations WHERE case_id=? ORDER BY id').all(id).map(observation),
          reasons: parse(row.reasons), detectorVersion: row.detector_version,
          alert: { state: db.prepare('SELECT state FROM review_alerts WHERE case_id=?').get(id).state },
          decisions: db.prepare('SELECT * FROM review_decisions WHERE case_id=? ORDER BY sequence').all(id).map(decision),
          expiresAt: iso(row.expires_at) };
      });
    },
    decide(input, principal) {
      shape(input, ['caseId', 'expectedVersion', 'decisionId', 'label', 'note']);
      principal = identifier(principal, 'principal', 128);
      const caseId = uuid(input.caseId, 'caseId'), decisionId = uuid(input.decisionId, 'decisionId');
      const expectedVersion = integer(input.expectedVersion, 'expectedVersion', 1);
      if (!LABELS.has(input.label)) fail('review_label_invalid');
      const note = plainText(input.note, 'note');
      if (note.length > limits.maxNoteChars) fail('review_note_too_large');
      const fingerprint = hash({ caseId, expectedVersion, decisionId, label: input.label, note, principal });
      return atomic(() => {
        const previous = db.prepare('SELECT * FROM review_decisions WHERE id=?').get(decisionId);
        if (previous) {
          if (previous.request_fingerprint !== fingerprint) fail('review_decision_conflict', 409);
          return { caseId, version: previous.resulting_version, decisionId, label: previous.label,
            patternDraftId: previous.pattern_draft_id, replayed: true };
        }
        const row = db.prepare('SELECT * FROM review_cases WHERE id=?').get(caseId);
        if (!row) fail('review_case_not_found', 404);
        if (row.version !== expectedVersion) fail('review_case_stale', 409);
        const time = clock(), version = row.version + 1;
        const patternDraftId = input.label === 'insufficient_evidence' ? null : randomUUID();
        db.prepare(`INSERT INTO review_decisions(id,case_id,evidence_version,resulting_version,request_fingerprint,
          label,note,principal,created_at,pattern_draft_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(decisionId, caseId, expectedVersion, version, fingerprint, input.label, note, principal, time, patternDraftId);
        db.prepare('INSERT INTO review_decision_evidence SELECT ?,id FROM review_observations WHERE case_id=?').run(decisionId, caseId);
        if (patternDraftId) {
          const revision = db.prepare('SELECT count(*) AS n FROM review_patterns WHERE case_id=?').get(caseId).n + 1;
          db.prepare('INSERT INTO review_patterns(id,case_id,decision_id,revision,pattern_ids) VALUES (?,?,?,?,?)')
            .run(patternDraftId, caseId, decisionId, revision, row.pattern_ids);
        }
        db.prepare("UPDATE review_cases SET version=?,status='reviewed',label=?,updated_at=? WHERE id=?")
          .run(version, input.label, time, caseId);
        return { caseId, version, decisionId, label: input.label, patternDraftId, replayed: false };
      });
    },
    listPatterns(input = {}) {
      const { limit, offset } = paging(input);
      return atomic(() => ({ patterns: db.prepare(`SELECT p.*,d.label,d.note,d.created_at,d.principal
        FROM review_patterns p JOIN review_decisions d ON d.id=p.decision_id ORDER BY p.sequence DESC LIMIT ? OFFSET ?`)
        .all(limit, offset).map((row) => ({ id: row.id, caseId: row.case_id, revision: row.revision,
          label: row.label, note: row.note, createdAt: iso(row.created_at), principal: row.principal,
          patternIds: parse(row.pattern_ids), state: 'draft' })),
      total: db.prepare('SELECT count(*) AS n FROM review_patterns').get().n }));
    },
    listHistory(input = {}) {
      const { limit, offset } = paging(input);
      return atomic(() => ({ history: db.prepare('SELECT * FROM review_decisions ORDER BY sequence DESC LIMIT ? OFFSET ?')
        .all(limit, offset).map(decision), total: db.prepare('SELECT count(*) AS n FROM review_decisions').get().n }));
    },
    eraseCase(input, principal) {
      shape(input, ['caseId', 'expectedVersion', 'requestId']);
      principal = identifier(principal, 'principal');
      const caseId = uuid(input.caseId, 'caseId'), requestId = uuid(input.requestId, 'requestId');
      const expectedVersion = integer(input.expectedVersion, 'expectedVersion', 1);
      return atomic(() => {
        const previous = db.prepare('SELECT * FROM review_erasure_receipts WHERE request_id=? OR case_id=?').all(requestId, caseId);
        if (previous.length) {
          const match = previous.length === 1 && previous[0];
          if (!match || match.request_id !== requestId || match.case_id !== caseId
            || match.principal !== principal || match.expected_version !== expectedVersion) fail('review_erasure_conflict', 409);
          return erasure(match);
        }
        const row = db.prepare('SELECT * FROM review_cases WHERE id=?').get(caseId);
        if (!row) fail('review_case_not_found', 404);
        if (row.version !== expectedVersion) fail('review_case_stale', 409);
        db.prepare('DELETE FROM review_cases WHERE id=?').run(caseId);
        db.prepare('INSERT INTO review_erasure_receipts VALUES (?,?,?,?,?)').run(requestId, caseId, principal, expectedVersion, clock());
        return erasure(db.prepare('SELECT * FROM review_erasure_receipts WHERE request_id=?').get(requestId));
      });
    },
    claimAlert() {
      return atomic(() => {
        if (live) {
          const budget = db.prepare('SELECT * FROM review_alert_budget WHERE singleton=1').get();
          if (!budget) fail('review_checkpoint_unknown', 503);
          if (budget.hour >= Math.floor(clock() / 3_600_000) && budget.used >= maxAlertsPerHour) return null;
        }
        const pending = db.prepare(`SELECT a.case_id FROM review_alerts a JOIN review_cases c ON c.id=a.case_id
          WHERE a.state='pending' ORDER BY c.created_at,c.id LIMIT 1`).get();
        if (!pending) return null;
        const attemptId = randomUUID();
        db.prepare("UPDATE review_alerts SET state='calling',attempt_id=? WHERE case_id=? AND state='pending'")
          .run(attemptId, pending.case_id);
        return { caseId: pending.case_id, attemptId };
      });
    },
    authorizeAlert(input) {
      if (!live) fail('review_delivery_disabled', 503);
      shape(input, ['caseId', 'attemptId']);
      const caseId = uuid(input.caseId, 'caseId'), attemptId = uuid(input.attemptId, 'attemptId');
      return atomic(() => {
        const row = db.prepare('SELECT * FROM review_alerts WHERE case_id=?').get(caseId);
        if (!row || row.state !== 'calling' || row.attempt_id !== attemptId) return { authorized: false };
        if (db.prepare('SELECT 1 FROM review_dispatch_authorizations WHERE case_id=? OR attempt_id=?').get(caseId, attemptId)) {
          return { authorized: false };
        }
        const budget = db.prepare('SELECT * FROM review_alert_budget WHERE singleton=1').get();
        const hour = Math.floor(clock() / 3_600_000);
        if (!budget || budget.hour > hour || (budget.hour === hour && budget.used >= maxAlertsPerHour)) return { authorized: false };
        db.prepare('UPDATE review_alert_budget SET hour=?,used=? WHERE singleton=1')
          .run(hour, budget.hour === hour ? budget.used + 1 : 1);
        db.prepare('INSERT INTO review_dispatch_authorizations VALUES (?,?)').run(caseId, attemptId);
        return { authorized: true };
      });
    },
    finishAlert(input) {
      shape(input, ['caseId', 'attemptId', 'state'], ['receipt']);
      const caseId = uuid(input.caseId, 'caseId'), attemptId = uuid(input.attemptId, 'attemptId');
      if (!['sent', 'failed', 'uncertain'].includes(input.state)) fail('review_alert_state_invalid');
      const receipt = receiptIdentifier(input.receipt);
      return atomic(() => {
        const row = db.prepare('SELECT * FROM review_alerts WHERE case_id=?').get(caseId);
        if (!row) {
          if (db.prepare('SELECT 1 FROM review_erasure_receipts WHERE case_id=?').get(caseId)) return { caseId, state: 'erased' };
          fail('review_case_not_found', 404);
        }
        if (row.attempt_id !== attemptId) fail('review_alert_attempt_conflict', 409);
        if (row.state !== 'calling') {
          if (row.state === input.state && row.receipt_id === receipt) return { caseId, state: row.state };
          fail('review_alert_terminal', 409);
        }
        db.prepare('UPDATE review_alerts SET state=?,receipt_id=? WHERE case_id=?').run(input.state, receipt, caseId);
        return { caseId, state: input.state };
      });
    },
    purgeExpired() { ready(); return db.transaction(purge).immediate(); },
    close() { if (!closed) { db.close(); OPEN_STORES.delete(path); closed = true; owner?.release(); } },
  };
  return api;
}
