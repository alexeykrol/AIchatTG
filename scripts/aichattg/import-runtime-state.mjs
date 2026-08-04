#!/usr/bin/env node
/**
 * Candidate-only importer for an approved, normalized migration bundle.
 *
 * It deliberately accepts no News path, database, or free-form payload. The
 * JSONL record allowlist below contains only operational state, never message,
 * question, answer, username, display name, quote, or provider content.
 */
import { createReadStream, existsSync, lstatSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ensureRuntimeMigrationReceiptSchema,
  openReadOnlyRuntimeDatabase,
  ensureRuntimeDatabaseSchema,
  openRuntimeDatabaseForImport,
} from '../../apps/telegram-runtime/src/database.mjs';
import { verifyMigrationBundle } from './verify-migration-bundle.mjs';

const SHA1 = /^[0-9a-f]{40}$/u;
const RECORD_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const TELEGRAM_ID = /^-?[1-9][0-9]{0,19}$/u;
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_RECORDS = 100_000;
const ACTIONS = Object.freeze({
  clean: new Set(['none']),
  suspect: new Set(['delete_warn_1', 'delete_warn_2']),
  ban: new Set(['ban_purge']),
});
const RECORD_SUMMARY_KEYS = Object.freeze(['moderation.v1', 'assistant_question_claim.v1', 'weak_strike.v1']);
const RUNTIME_TABLES = Object.freeze([
  'runtime_inbound_events',
  'runtime_moderation_records',
  'runtime_assistant_question_claims',
  'runtime_assistant_moderation_dispositions',
  'runtime_moderation_weak_strikes',
]);

function fail(message) {
  throw new Error(`runtime state import rejected: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has an unsupported or missing field`);
  }
}

function string(value, label, matcher = null) {
  if (typeof value !== 'string' || value.length === 0 || (matcher && !matcher.test(value))) fail(`${label} is invalid`);
  return value;
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} is invalid`);
  return value;
}

function probability(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(`${label} is invalid`);
  return value;
}

function optionalTelegramId(value, label) {
  if (value === null) return null;
  return string(value, label, TELEGRAM_ID);
}

function platformMessageId(value, { chatId, messageId, updateId }) {
  const identifier = string(value, 'platformMessageId', RECORD_ID);
  const unedited = `${chatId}:${messageId}`;
  const edited = `${chatId}:edit:${updateId}:${messageId}`;
  if (identifier !== unedited && identifier !== edited) fail('platformMessageId does not match the Telegram revision identity');
  return identifier;
}

function actionJson(action) {
  return JSON.stringify({ action, source: 'migration-v1' });
}

function dispositionForVerdict(verdict) {
  return verdict === 'clean'
    ? { status: 'allowed', verdict: 'clean' }
    : { status: 'blocked', verdict };
}

function validateModeration(record, line) {
  exactKeys(record, [
    'type', 'recordId', 'eventId', 'updateId', 'chatId', 'messageId', 'platformMessageId', 'userId',
    'verdict', 'confidence', 'reasonCode', 'mode', 'action', 'createdAt',
  ], `record ${line}`);
  if (record.type !== 'moderation.v1') fail(`record ${line} has an unsupported type`);
  const recordId = string(record.recordId, `record ${line}.recordId`, RECORD_ID);
  const updateId = safeInteger(record.updateId, `record ${line}.updateId`);
  const eventId = string(record.eventId, `record ${line}.eventId`, RECORD_ID);
  if (eventId !== `moderator:${updateId}`) fail(`record ${line}.eventId must match moderator updateId`);
  const chatId = string(record.chatId, `record ${line}.chatId`, TELEGRAM_ID);
  const messageId = string(record.messageId, `record ${line}.messageId`, TELEGRAM_ID);
  const verdict = string(record.verdict, `record ${line}.verdict`);
  if (!Object.hasOwn(ACTIONS, verdict)) fail(`record ${line}.verdict is unsupported`);
  const action = string(record.action, `record ${line}.action`);
  if (!ACTIONS[verdict].has(action)) fail(`record ${line}.action is incompatible with verdict`);
  const mode = string(record.mode, `record ${line}.mode`);
  if (!['shadow', 'live'].includes(mode)) fail(`record ${line}.mode is unsupported`);
  return {
    type: record.type,
    recordId,
    eventId,
    updateId,
    chatId,
    messageId,
    platformMessageId: platformMessageId(record.platformMessageId, { chatId, messageId, updateId }),
    userId: optionalTelegramId(record.userId, `record ${line}.userId`),
    verdict,
    confidence: probability(record.confidence, `record ${line}.confidence`),
    reasonCode: string(record.reasonCode, `record ${line}.reasonCode`, REASON_CODE),
    mode,
    action,
    createdAt: safeInteger(record.createdAt, `record ${line}.createdAt`),
  };
}

function validateAssistantQuestionClaim(record, line) {
  exactKeys(record, ['type', 'recordId', 'chatId', 'messageId', 'outcome', 'claimedAt', 'completedAt'], `record ${line}`);
  if (record.type !== 'assistant_question_claim.v1') fail(`record ${line} has an unsupported type`);
  const claimedAt = safeInteger(record.claimedAt, `record ${line}.claimedAt`);
  const completedAt = safeInteger(record.completedAt, `record ${line}.completedAt`);
  if (completedAt < claimedAt) fail(`record ${line}.completedAt precedes claimedAt`);
  const outcome = string(record.outcome, `record ${line}.outcome`);
  if (!['answered', 'skipped'].includes(outcome)) fail(`record ${line}.outcome is unsupported`);
  return {
    type: record.type,
    recordId: string(record.recordId, `record ${line}.recordId`, RECORD_ID),
    chatId: string(record.chatId, `record ${line}.chatId`, TELEGRAM_ID),
    messageId: string(record.messageId, `record ${line}.messageId`, TELEGRAM_ID),
    outcome,
    claimedAt,
    completedAt,
  };
}

function validateWeakStrike(record, line) {
  exactKeys(record, ['type', 'recordId', 'chatId', 'userId', 'weakStrikes', 'updatedAt'], `record ${line}`);
  if (record.type !== 'weak_strike.v1') fail(`record ${line} has an unsupported type`);
  return {
    type: record.type,
    recordId: string(record.recordId, `record ${line}.recordId`, RECORD_ID),
    chatId: string(record.chatId, `record ${line}.chatId`, TELEGRAM_ID),
    userId: string(record.userId, `record ${line}.userId`, TELEGRAM_ID),
    weakStrikes: safeInteger(record.weakStrikes, `record ${line}.weakStrikes`, { max: 1_000_000 }),
    updatedAt: safeInteger(record.updatedAt, `record ${line}.updatedAt`),
  };
}

function validateRecord(value, line) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') {
    fail(`record ${line} must contain an allowed typed object`);
  }
  if (value.type === 'moderation.v1') return validateModeration(value, line);
  if (value.type === 'assistant_question_claim.v1') return validateAssistantQuestionClaim(value, line);
  if (value.type === 'weak_strike.v1') return validateWeakStrike(value, line);
  fail(`record ${line} has an unsupported type`);
}

async function parseRecords(payloadPath, expectedCount) {
  const records = [];
  const recordIds = new Set();
  const logicalIds = new Set();
  const stream = createReadStream(payloadPath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  for await (const raw of reader) {
    line += 1;
    if (!raw || Buffer.byteLength(raw, 'utf8') > 65_536) fail(`record ${line} is empty or exceeds the size limit`);
    let decoded;
    try {
      decoded = JSON.parse(raw);
    } catch {
      fail(`record ${line} is not valid JSON`);
    }
    const record = validateRecord(decoded, line);
    if (recordIds.has(record.recordId)) fail(`record ${line} duplicates a recordId`);
    recordIds.add(record.recordId);
    const logicalId = record.type === 'moderation.v1'
      ? `${record.type}:${record.eventId}`
      : record.type === 'assistant_question_claim.v1'
        ? `${record.type}:${record.chatId}:${record.messageId}`
        : `${record.type}:${record.chatId}:${record.userId}`;
    if (logicalIds.has(logicalId)) fail(`record ${line} duplicates a target state identity`);
    logicalIds.add(logicalId);
    records.push(record);
    if (records.length > MAX_RECORDS) fail(`record count exceeds the ${MAX_RECORDS} record limit`);
  }
  if (records.length !== expectedCount) fail('verified record count differs while parsing JSONL');
  return records;
}

function recordSummary(records) {
  const summary = Object.fromEntries(RECORD_SUMMARY_KEYS.map((key) => [key, 0]));
  for (const record of records) summary[record.type] += 1;
  return summary;
}

function parseArguments(argv) {
  const options = { mode: 'dry-run', explicitMode: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      if (options.explicitMode) fail('choose only one of --dry-run or --apply');
      options.mode = 'dry-run';
      options.explicitMode = true;
    } else if (argument === '--apply') {
      if (options.explicitMode) fail('choose only one of --dry-run or --apply');
      options.mode = 'apply';
      options.explicitMode = true;
    } else if (['--manifest', '--database', '--expected-candidate-sha'].includes(argument)) {
      if (index + 1 >= argv.length) fail(`${argument} requires a value`);
      options[argument.slice(2).replaceAll('-', '_')] = argv[++index];
    } else {
      fail(`unsupported argument ${argument}`);
    }
  }
  if (!options.manifest || !options.database || !options.expected_candidate_sha) {
    throw new Error('usage: import-runtime-state.mjs --manifest <bundle-manifest.json> --database <runtime.db> --expected-candidate-sha <40-hex SHA> [--dry-run|--apply]');
  }
  return {
    ...options,
    manifest: resolve(options.manifest),
    database: resolve(options.database),
    expectedCandidateSha: string(options.expected_candidate_sha, 'expected candidate SHA', SHA1),
  };
}

function currentCandidateSha() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  } catch {
    fail('current AIchatTG candidate SHA cannot be determined from Git');
  }
}

function assertCandidateAdmission(verified, expectedCandidateSha) {
  if (verified.candidateSha !== expectedCandidateSha) fail('manifest candidate SHA does not match the explicit expected candidate SHA');
  if (currentCandidateSha() !== expectedCandidateSha) fail('current AIchatTG Git HEAD does not match the expected candidate SHA');
}

function assertTargetPath(databasePath, { mustExist = false } = {}) {
  const resolved = resolve(databasePath);
  const pieces = resolved.toLowerCase().split('/');
  if (basename(resolved).toLowerCase() === 'news-digest.db'
    || pieces.includes('news') || pieces.includes('news-digest-pipeline')) {
    fail('target database path must not reference a News database or runtime');
  }
  const parent = dirname(resolved);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) {
    fail('target database parent must be an existing real directory');
  }
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('target database must be a regular non-symlink file');
  } else if (mustExist) {
    fail('target database does not exist for dry-run');
  }
  return resolved;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function assertRuntimeSchema(db) {
  for (const table of RUNTIME_TABLES) if (!tableExists(db, table)) fail('target is not an initialized AIchatTG telegram-runtime SQLite database');
}

function prepareStatements(db, { withReceipt = false } = {}) {
  const statements = {
    event: db.prepare('SELECT event_id, bot_role, update_id, status, result_json, error_text, created_at, completed_at FROM runtime_inbound_events WHERE event_id = ?'),
    insertEvent: db.prepare(`INSERT INTO runtime_inbound_events
      (event_id, bot_role, update_id, status, result_json, error_text, created_at, completed_at)
      VALUES (?, 'moderator', ?, 'completed', NULL, NULL, ?, ?)`),
    moderation: db.prepare(`SELECT event_id, chat_id, message_id, user_id, verdict, confidence, reason, mode, action_json, created_at
      FROM runtime_moderation_records WHERE event_id = ?`),
    insertModeration: db.prepare(`INSERT INTO runtime_moderation_records
      (id, event_id, chat_id, message_id, user_id, verdict, confidence, reason, mode, action_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    disposition: db.prepare(`SELECT chat_id, message_id, status, moderation_message_id, verdict, reason, moderation_event_id
      FROM runtime_assistant_moderation_dispositions WHERE chat_id = ? AND message_id = ?`),
    insertDisposition: db.prepare(`INSERT INTO runtime_assistant_moderation_dispositions
      (chat_id, message_id, status, moderation_message_id, verdict, reason, moderation_event_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    claim: db.prepare(`SELECT chat_id, message_id, status, outcome, claimed_at, completed_at
      FROM runtime_assistant_question_claims WHERE chat_id = ? AND message_id = ?`),
    insertClaim: db.prepare(`INSERT INTO runtime_assistant_question_claims
      (chat_id, message_id, status, outcome, claimed_at, completed_at)
      VALUES (?, ?, 'completed', ?, ?, ?)`),
    strike: db.prepare('SELECT chat_id, user_id, weak_strikes, updated_at FROM runtime_moderation_weak_strikes WHERE chat_id = ? AND user_id = ?'),
    insertStrike: db.prepare(`INSERT INTO runtime_moderation_weak_strikes
      (chat_id, user_id, weak_strikes, updated_at) VALUES (?, ?, ?, ?)`),
  };
  if (withReceipt) {
    statements.receiptByBundle = db.prepare(`SELECT bundle_id, payload_sha256, source_commit, candidate_sha,
      controller_lease_id, product_owner_approval_id, record_count FROM runtime_migration_receipts WHERE bundle_id = ?`);
    statements.receiptByPayload = db.prepare('SELECT bundle_id FROM runtime_migration_receipts WHERE payload_sha256 = ?');
    statements.insertReceipt = db.prepare(`INSERT INTO runtime_migration_receipts
      (bundle_id, payload_sha256, source_commit, candidate_sha, controller_lease_id, product_owner_approval_id,
       record_count, record_summary_json, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  }
  return statements;
}

function equalFields(actual, expected, fields) {
  return actual && fields.every((field) => actual[field] === expected[field]);
}

function migrationRecordId(bundleId, recordId) {
  return `migration:${bundleId}:${recordId}`;
}

function expectedModeration(record) {
  const disposition = dispositionForVerdict(record.verdict);
  return {
    event: {
      event_id: record.eventId, bot_role: 'moderator', update_id: record.updateId, status: 'completed',
      result_json: null, error_text: null, created_at: record.createdAt, completed_at: record.createdAt,
    },
    moderation: {
      event_id: record.eventId, chat_id: record.chatId, message_id: record.messageId, user_id: record.userId,
      verdict: record.verdict, confidence: record.confidence, reason: record.reasonCode, mode: record.mode,
      action_json: actionJson(record.action), created_at: record.createdAt,
    },
    disposition: {
      chat_id: record.chatId, message_id: record.messageId, status: disposition.status,
      moderation_message_id: record.platformMessageId, verdict: disposition.verdict, reason: record.reasonCode,
      moderation_event_id: record.eventId,
    },
  };
}

function assertRecordCompatible(statements, record) {
  if (record.type === 'moderation.v1') {
    const expected = expectedModeration(record);
    const event = statements.event.get(record.eventId);
    if (event && !equalFields(event, expected.event, Object.keys(expected.event))) fail('target conflict for a moderation event');
    const moderation = statements.moderation.get(record.eventId);
    if (moderation && !equalFields(moderation, expected.moderation, Object.keys(expected.moderation))) fail('target conflict for a moderation record');
    const disposition = statements.disposition.get(record.chatId, record.messageId);
    if (disposition && !equalFields(disposition, expected.disposition, Object.keys(expected.disposition))) fail('target conflict for an Assistant disposition');
    return;
  }
  if (record.type === 'assistant_question_claim.v1') {
    const claim = statements.claim.get(record.chatId, record.messageId);
    const expected = {
      chat_id: record.chatId, message_id: record.messageId, status: 'completed', outcome: record.outcome,
      claimed_at: record.claimedAt, completed_at: record.completedAt,
    };
    if (claim && !equalFields(claim, expected, Object.keys(expected))) fail('target conflict for an Assistant question claim');
    return;
  }
  const strike = statements.strike.get(record.chatId, record.userId);
  const expected = {
    chat_id: record.chatId, user_id: record.userId, weak_strikes: record.weakStrikes, updated_at: record.updatedAt,
  };
  if (strike && !equalFields(strike, expected, Object.keys(expected))) fail('target conflict for a weak-strike counter');
}

function importRecord(statements, bundleId, record, changes) {
  assertRecordCompatible(statements, record);
  if (record.type === 'moderation.v1') {
    const expected = expectedModeration(record);
    if (!statements.event.get(record.eventId)) {
      statements.insertEvent.run(record.eventId, record.updateId, record.createdAt, record.createdAt);
      changes.inboundEvents += 1;
    }
    if (!statements.moderation.get(record.eventId)) {
      statements.insertModeration.run(
        migrationRecordId(bundleId, record.recordId), record.eventId, record.chatId, record.messageId, record.userId,
        record.verdict, record.confidence, record.reasonCode, record.mode, expected.moderation.action_json, record.createdAt,
      );
      changes.moderationRecords += 1;
    }
    if (!statements.disposition.get(record.chatId, record.messageId)) {
      statements.insertDisposition.run(
        record.chatId, record.messageId, expected.disposition.status, record.platformMessageId, expected.disposition.verdict,
        record.reasonCode, record.eventId, record.createdAt, record.createdAt,
      );
      changes.dispositions += 1;
    }
    return;
  }
  if (record.type === 'assistant_question_claim.v1') {
    if (!statements.claim.get(record.chatId, record.messageId)) {
      statements.insertClaim.run(record.chatId, record.messageId, record.outcome, record.claimedAt, record.completedAt);
      changes.assistantQuestionClaims += 1;
    }
    return;
  }
  if (!statements.strike.get(record.chatId, record.userId)) {
    statements.insertStrike.run(record.chatId, record.userId, record.weakStrikes, record.updatedAt);
    changes.weakStrikeCounters += 1;
  }
}

function emptyChanges() {
  return { inboundEvents: 0, moderationRecords: 0, dispositions: 0, assistantQuestionClaims: 0, weakStrikeCounters: 0 };
}

function receiptMatches(receipt, verified) {
  const authorization = verified.manifest.authorization;
  return receipt.payload_sha256 === verified.payloadSha256
    && receipt.source_commit === verified.sourceCommit
    && receipt.candidate_sha === verified.candidateSha
    && receipt.controller_lease_id === authorization.controllerLeaseId
    && receipt.product_owner_approval_id === authorization.productOwnerApprovalId
    && receipt.record_count === verified.recordCount;
}

function inspectReceipt(statements, verified) {
  if (!statements.receiptByBundle) return { alreadyApplied: false };
  const existing = statements.receiptByBundle.get(verified.bundleId);
  if (existing) {
    if (!receiptMatches(existing, verified)) fail('bundleId is already bound to a different migration receipt');
    return { alreadyApplied: true };
  }
  if (statements.receiptByPayload.get(verified.payloadSha256)) fail('payload digest is already bound to another migration receipt');
  return { alreadyApplied: false };
}

function dryRunAgainstExistingDatabase(databasePath, verified, records, summary) {
  const db = openReadOnlyRuntimeDatabase(databasePath);
  try {
    assertRuntimeSchema(db);
    const statements = prepareStatements(db, { withReceipt: tableExists(db, 'runtime_migration_receipts') });
    const receipt = inspectReceipt(statements, verified);
    if (receipt.alreadyApplied) return { status: 'already_applied', changes: emptyChanges(), targetState: 'existing' };
    const changes = emptyChanges();
    for (const record of records) {
      assertRecordCompatible(statements, record);
      if (record.type === 'moderation.v1') {
        if (!statements.event.get(record.eventId)) changes.inboundEvents += 1;
        if (!statements.moderation.get(record.eventId)) changes.moderationRecords += 1;
        if (!statements.disposition.get(record.chatId, record.messageId)) changes.dispositions += 1;
      } else if (record.type === 'assistant_question_claim.v1') {
        if (!statements.claim.get(record.chatId, record.messageId)) changes.assistantQuestionClaims += 1;
      } else if (!statements.strike.get(record.chatId, record.userId)) changes.weakStrikeCounters += 1;
    }
    return { status: 'dry_run', changes, targetState: 'existing', summary };
  } finally {
    db.close();
  }
}

function applyToDatabase(databasePath, verified, records, summary, now) {
  const existingTarget = existsSync(databasePath);
  const db = openRuntimeDatabaseForImport(databasePath);
  try {
    if (existingTarget) {
      assertRuntimeSchema(db);
    }
    ensureRuntimeDatabaseSchema(db);
    return db.transaction(() => {
      ensureRuntimeMigrationReceiptSchema(db);
      const statements = prepareStatements(db, { withReceipt: true });
      const receipt = inspectReceipt(statements, verified);
      if (receipt.alreadyApplied) return { status: 'already_applied', changes: emptyChanges(), targetState: 'existing' };
      const changes = emptyChanges();
      for (const record of records) importRecord(statements, verified.bundleId, record, changes);
      const authorization = verified.manifest.authorization;
      statements.insertReceipt.run(
        verified.bundleId, verified.payloadSha256, verified.sourceCommit, verified.candidateSha,
        authorization.controllerLeaseId, authorization.productOwnerApprovalId,
        verified.recordCount, JSON.stringify(summary), now(),
      );
      return { status: 'applied', changes, targetState: 'existing' };
    })();
  } finally {
    db.close();
  }
}

/** Exported for focused local tests. This function never contacts Telegram, a provider, or News. */
export async function importRuntimeState({ manifestPath, databasePath, expectedCandidateSha, mode = 'dry-run', now = () => Math.floor(Date.now() / 1000) }) {
  if (!['dry-run', 'apply'].includes(mode)) fail('mode must be dry-run or apply');
  const verified = await verifyMigrationBundle(manifestPath);
  assertCandidateAdmission(verified, string(expectedCandidateSha, 'expected candidate SHA', SHA1));
  const target = assertTargetPath(databasePath);
  const records = await parseRecords(verified.payloadPath, verified.recordCount);
  const summary = recordSummary(records);
  const result = mode === 'dry-run'
    ? existsSync(target)
      ? dryRunAgainstExistingDatabase(target, verified, records, summary)
      : { status: 'dry_run', changes: {
        inboundEvents: summary['moderation.v1'], moderationRecords: summary['moderation.v1'],
        dispositions: summary['moderation.v1'], assistantQuestionClaims: summary['assistant_question_claim.v1'],
        weakStrikeCounters: summary['weak_strike.v1'],
      }, targetState: 'absent' }
    : applyToDatabase(target, verified, records, summary, now);
  return {
    ...result,
    bundleId: verified.bundleId,
    sourceCommit: verified.sourceCommit,
    candidateSha: verified.candidateSha,
    payloadSha256: verified.payloadSha256,
    recordCount: verified.recordCount,
    records: summary,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await importRuntimeState({
    manifestPath: options.manifest,
    databasePath: options.database,
    expectedCandidateSha: options.expectedCandidateSha,
    mode: options.mode,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
