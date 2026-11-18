// Batch triage of old join requests the bot never received (contract v2 §3).
// classify: pure, offline. execute: production action, dry run by default.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PRECHECK_REASONS } from './scenario.mjs';
import { precheckApplicant } from './screening.mjs';
import {
  isAmbiguousTelegramError, isAuthOrRateError, isNoRequestError, permissions,
} from './telegram-api.mjs';

export const EXPORT_SCHEMA = 'joingate-pending-export-v1';
export const TRIAGE_SCHEMA = 'joingate-triage-v1';
export const SUMMARY_SCHEMA = 'joingate-triage-summary-v1';
export const RECEIPT_SCHEMA = 'joingate-triage-receipt-v1';
export const ACTIONS = Object.freeze(['reject', 'accept_restricted']);
export const MIN_PACING_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const EXPORT_KEYS = new Set(['schema', 'chat_id', 'generated_at', 'requests']);
const STRING_FIELDS = ['first_name', 'last_name', 'username', 'bio', 'lang_code'];
// has_personal_chat and is_deleted (A0-bis) are optional: exports without them
// stay valid.
const BOOLEAN_FIELDS = ['is_bot', 'is_scam', 'is_fake', 'is_premium', 'has_photo', 'has_personal_chat', 'is_deleted'];
// Triage-only code (no DM is ever sent in triage): a deleted account. Highest
// precedence, before R_SCAM.
export const R_DELETED = 'R_DELETED';
const TRIAGE_REASONS = Object.freeze([R_DELETED, ...PRECHECK_REASONS]);
const REQUEST_KEYS = new Set(['user_id', 'requested_at', ...STRING_FIELDS, ...BOOLEAN_FIELDS]);

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function fail(message) {
  throw new Error(`invalid ${EXPORT_SCHEMA}: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIso(value) {
  return typeof value === 'string' && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

export function validateExport(raw) {
  if (!isPlainObject(raw)) fail('root must be an object');
  for (const key of Object.keys(raw)) if (!EXPORT_KEYS.has(key)) fail(`unknown key ${key}`);
  if (raw.schema !== EXPORT_SCHEMA) fail(`schema must be ${EXPORT_SCHEMA}`);
  if (!Number.isSafeInteger(raw.chat_id) || raw.chat_id >= 0) fail('chat_id must be a negative integer');
  if (!isIso(raw.generated_at)) fail('generated_at must be an ISO timestamp');
  if (!Array.isArray(raw.requests)) fail('requests must be an array');
  const seen = new Set();
  raw.requests.forEach((request, index) => {
    const where = `requests[${index}]`;
    if (!isPlainObject(request)) fail(`${where} must be an object`);
    for (const key of Object.keys(request)) if (!REQUEST_KEYS.has(key)) fail(`${where}.${key} is not allowed`);
    if (!Number.isSafeInteger(request.user_id) || request.user_id <= 0) fail(`${where}.user_id must be a positive integer`);
    if (seen.has(request.user_id)) fail(`${where}.user_id ${request.user_id} is duplicated`);
    seen.add(request.user_id);
    if (!isIso(request.requested_at)) fail(`${where}.requested_at must be an ISO timestamp`);
    for (const key of STRING_FIELDS) {
      if (request[key] !== undefined && request[key] !== null && typeof request[key] !== 'string') {
        fail(`${where}.${key} must be a string or null`);
      }
    }
    for (const key of BOOLEAN_FIELDS) {
      if (request[key] !== undefined && request[key] !== null && typeof request[key] !== 'boolean') {
        fail(`${where}.${key} must be a boolean or null`);
      }
    }
  });
  return raw;
}

// One request → { list, reasons, signals }. Same pre-check rules as the live
// flow (A0-bis), preceded by the triage-only R_DELETED:
// R_DELETED → R_SCAM → R_PROFILE_AD → R_STOPWORD → reject; anything else →
// accept_restricted (the questionnaire decides later). `reasons` holds the
// reason code (empty for accept_restricted); `signals` the matched signal
// codes. null/missing = unknown, never false.
export function classifyRequest(request, scenario) {
  if (request.is_deleted === true) return { list: 'reject', reasons: [R_DELETED], signals: ['is_deleted'] };
  const photoCount = request.has_photo === true ? 1 : (request.has_photo === false ? 0 : null);
  const result = precheckApplicant({
    from: {
      is_bot: request.is_bot === true,
      first_name: request.first_name ?? undefined,
      last_name: request.last_name ?? undefined,
      username: request.username ?? undefined,
    },
    bio: request.bio ?? null,
    personalChat: typeof request.has_personal_chat === 'boolean' ? request.has_personal_chat : null,
    photoCount,
    isScam: request.is_scam === true,
    isFake: request.is_fake === true,
  }, scenario);
  if (result.reason) return { list: 'reject', reasons: [result.reason], signals: result.signals };
  return { list: 'accept_restricted', reasons: [], signals: [] };
}

// Pure: export text → the three output documents.
export function classifyExport({ exportText, scenario, now = Date.now() }) {
  let raw;
  try {
    raw = JSON.parse(exportText);
  } catch (error) {
    fail(`not JSON: ${error.message}`);
  }
  const data = validateExport(raw);
  const sourceSha256 = sha256(exportText);
  const generatedAt = new Date(now).toISOString();
  const lists = { reject: [], accept_restricted: [] };
  const reasonCounts = { reject: {}, accept_restricted: {} };
  for (const request of data.requests) {
    const { list, reasons, signals } = classifyRequest(request, scenario);
    lists[list].push({ user_id: request.user_id, requested_at: request.requested_at, reasons, signals });
    const counts = reasonCounts[list];
    if (reasons.length === 0) counts.none = (counts.none || 0) + 1;
    for (const reason of reasons) counts[reason] = (counts[reason] || 0) + 1;
  }
  const doc = (list) => ({
    schema: TRIAGE_SCHEMA, list, chat_id: data.chat_id, generated_at: generatedAt, source_sha256: sourceSha256, items: lists[list],
  });
  const files = {
    'reject.json': `${JSON.stringify(doc('reject'), null, 2)}\n`,
    'accept_restricted.json': `${JSON.stringify(doc('accept_restricted'), null, 2)}\n`,
  };
  const summary = {
    schema: SUMMARY_SCHEMA,
    chat_id: data.chat_id,
    generated_at: generatedAt,
    source_sha256: sourceSha256,
    total: data.requests.length,
    counts: { reject: lists.reject.length, accept_restricted: lists.accept_restricted.length },
    reasons: reasonCounts,
    // The PO approves exact lists by these hashes (--expect-sha256).
    list_sha256: { reject: sha256(files['reject.json']), accept_restricted: sha256(files['accept_restricted.json']) },
  };
  files['summary.json'] = `${JSON.stringify(summary, null, 2)}\n`;
  return { files, summary };
}

export function writePrivateFiles(outDir, files) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  for (const name of Object.keys(files)) {
    if (fs.existsSync(path.join(outDir, name))) throw new Error(`refusing to overwrite existing file ${path.join(outDir, name)}`);
  }
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
}

export function classifyFile({ inputPath, outDir, scenario, now = Date.now() }) {
  const exportText = fs.readFileSync(inputPath, 'utf8');
  const result = classifyExport({ exportText, scenario, now });
  writePrivateFiles(outDir, result.files);
  return result.summary;
}

export function parseTriageList(listText, action) {
  let doc;
  try {
    doc = JSON.parse(listText);
  } catch (error) {
    throw new Error(`triage list is not JSON: ${error.message}`);
  }
  if (!isPlainObject(doc) || doc.schema !== TRIAGE_SCHEMA) throw new Error(`triage list schema must be ${TRIAGE_SCHEMA}`);
  if (doc.list !== action) throw new Error(`triage list is "${doc.list}", action is "${action}"`);
  if (!Number.isSafeInteger(doc.chat_id) || doc.chat_id >= 0) throw new Error('triage list chat_id must be a negative integer');
  if (!Array.isArray(doc.items)) throw new Error('triage list items must be an array');
  const seen = new Set();
  for (const item of doc.items) {
    if (!isPlainObject(item) || !Number.isSafeInteger(item.user_id) || item.user_id <= 0 || seen.has(item.user_id)) {
      throw new Error('triage list items must have unique positive integer user_id');
    }
    if (!Array.isArray(item.reasons)) throw new Error('triage list item reasons must be an array');
    if (item.signals !== undefined && (!Array.isArray(item.signals) || item.signals.some((v) => typeof v !== 'string'))) {
      throw new Error('triage list item signals must be an array of strings');
    }
    seen.add(item.user_id);
  }
  return doc;
}

// One Telegram call → { state: done|no_request|failed|inconclusive|auth, error }.
async function callTelegram(telegram, method, payload) {
  try {
    await telegram[method](payload);
    return { state: 'done' };
  } catch (error) {
    if (isAmbiguousTelegramError(error)) return { state: 'inconclusive', error: error.message };
    if (isAuthOrRateError(error)) return { state: 'auth', error: error.message };
    if (method === 'approveChatJoinRequest' || method === 'declineChatJoinRequest') {
      if (isNoRequestError(error)) return { state: 'no_request', error: error.message };
    }
    return { state: 'failed', error: error.message };
  }
}

const STOP_STATES = new Set(['inconclusive', 'auth']);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// triage execute. Dry run (default): plan only, no Telegram, no DB.
// Confirmed run: requires the exact list hash, an allowlisted chat, paces
// calls, stops at the first auth/transport/ambiguous error, skips users
// already processed for this list (journal), returns a receipt.
export async function executeTriage({
  listText, action, expectSha256, confirm = false, store = null, telegram = null, targetChatIds = [],
  probationDays = 7, now = () => Date.now(), sleep = defaultSleep, pacingMs = MIN_PACING_MS, logger = null,
}) {
  if (!ACTIONS.includes(action)) throw new Error(`--action must be one of ${ACTIONS.join(', ')}`);
  if (!/^[0-9a-f]{64}$/.test(String(expectSha256 ?? ''))) throw new Error('--expect-sha256 must be a sha256 hex digest');
  const listSha256 = sha256(listText);
  if (listSha256 !== expectSha256) {
    throw new Error(`list sha256 ${listSha256} does not match --expect-sha256 ${expectSha256}; refusing`);
  }
  const list = parseTriageList(listText, action);
  const userIds = list.items.map((item) => item.user_id);

  if (!confirm) {
    return {
      dry_run: true, action, chat_id: list.chat_id, list_sha256: listSha256, count: userIds.length, user_ids: userIds,
      plan: action === 'reject'
        ? 'declineChatJoinRequest for each user (verified members: approve without restriction)'
        : 'approveChatJoinRequest + restrictChatMember (no sending) + probation record per user (verified members: approve only)',
    };
  }

  if (!store || !telegram) throw new Error('confirmed triage requires a store and a Telegram client');
  if (!targetChatIds.map(String).includes(String(list.chat_id))) {
    throw new Error(`chat ${list.chat_id} is not in JOIN_GATEKEEPER_TARGET_CHAT_IDS; refusing`);
  }
  if (!(pacingMs >= MIN_PACING_MS)) throw new Error(`pacing must be at least ${MIN_PACING_MS} ms`);

  const chatId = list.chat_id;
  const receipt = {
    schema: RECEIPT_SCHEMA,
    action,
    chat_id: chatId,
    list_sha256: listSha256,
    started_at: new Date(now()).toISOString(),
    finished_at: null,
    completed: false,
    stopped: null,
    counts: {},
    results: [],
  };
  const record = (item, outcome, extra = {}) => {
    const t = now();
    store.addJournal({
      event: 'triage_item', userId: item.user_id, details: { list_sha256: listSha256, action, chat_id: chatId, outcome, ...extra }, now: t,
    });
    receipt.results.push({ user_id: item.user_id, outcome, ...extra });
    receipt.counts[outcome] = (receipt.counts[outcome] || 0) + 1;
  };
  const stop = (item, method, result) => {
    receipt.stopped = { user_id: item.user_id, method, state: result.state, error: result.error ?? null };
    logger?.error?.('triage_stopped', receipt.stopped);
  };

  let calls = 0;
  for (const item of list.items) {
    if (store.findTriageItem(listSha256, item.user_id)) {
      receipt.results.push({ user_id: item.user_id, outcome: 'skipped_already_processed' });
      receipt.counts.skipped_already_processed = (receipt.counts.skipped_already_processed || 0) + 1;
      continue;
    }
    if (store.findActiveApplication(chatId, item.user_id)) {
      record(item, 'skipped_active_application');
      continue;
    }
    if (calls > 0) await sleep(pacingMs);
    calls += 1;
    const payload = { chat_id: chatId, user_id: item.user_id };
    const t = now();
    const base = { chatId: String(chatId), userId: String(item.user_id), now: t, decidedAt: t, screeningReasons: [...item.reasons, ...(item.signals ?? [])] };

    const verified = store.getVerifiedMember(item.user_id);
    if (verified) {
      const result = await callTelegram(telegram, 'approveChatJoinRequest', payload);
      if (STOP_STATES.has(result.state)) { stop(item, 'approveChatJoinRequest', result); break; }
      if (result.state === 'done') {
        store.createApplication({ ...base, state: 'approved_token', decisionReason: 'token', extra: { telegram_action_state: 'done' } });
      }
      record(item, result.state === 'done' ? 'approved_verified' : result.state, { site_record_id: verified.site_record_id });
      continue;
    }

    if (action === 'reject') {
      const result = await callTelegram(telegram, 'declineChatJoinRequest', payload);
      if (STOP_STATES.has(result.state)) { stop(item, 'declineChatJoinRequest', result); break; }
      if (result.state === 'done') {
        const code = item.reasons.length === 1 && TRIAGE_REASONS.includes(item.reasons[0]) ? item.reasons[0] : 'triage_reject';
        store.createApplication({
          ...base, state: 'declined_screening', screeningVerdict: 'block', decisionReason: code,
          extra: { telegram_action_state: 'done' },
        });
      }
      record(item, result.state === 'done' ? 'declined' : result.state);
      continue;
    }

    const approve = await callTelegram(telegram, 'approveChatJoinRequest', payload);
    if (STOP_STATES.has(approve.state)) { stop(item, 'approveChatJoinRequest', approve); break; }
    if (approve.state !== 'done') { record(item, approve.state); continue; }
    const restrict = await callTelegram(telegram, 'restrictChatMember', {
      ...payload, permissions: permissions(false), use_independent_chat_permissions: true,
    });
    const restrictState = restrict.state === 'done' ? 'restricted' : (restrict.state === 'inconclusive' ? 'inconclusive' : 'failed');
    store.createApplication({
      ...base,
      state: 'probation',
      screeningVerdict: 'clean',
      decisionReason: 'triage_accept_restricted',
      extra: {
        telegram_action_state: restrict.state === 'done' ? 'done' : (restrict.state === 'inconclusive' ? 'inconclusive' : 'failed'),
        restrict_state: restrictState,
        probation_deadline_at: t + probationDays * DAY_MS,
      },
    });
    if (restrict.state !== 'done') logger?.error?.('triage_restrict_failed', { user_id: item.user_id, state: restrict.state });
    record(item, restrict.state === 'done' ? 'approved_restricted' : 'approved_restrict_failed', { restrict_state: restrictState });
    if (STOP_STATES.has(restrict.state)) { stop(item, 'restrictChatMember', restrict); break; }
  }

  receipt.completed = receipt.stopped === null;
  receipt.finished_at = new Date(now()).toISOString();
  store.addJournal({
    event: 'triage_receipt',
    details: { list_sha256: listSha256, action, chat_id: chatId, completed: receipt.completed, counts: receipt.counts, stopped: receipt.stopped },
    now: now(),
  });
  return receipt;
}

export function writeReceipt(receiptDir, receipt) {
  fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const stamp = receipt.finished_at.replace(/[:.]/g, '-');
  const file = path.join(receiptDir, `receipt-${receipt.action}-${receipt.list_sha256.slice(0, 12)}-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
