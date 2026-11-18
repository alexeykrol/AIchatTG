// Personal one-time access tokens for paid students (contract v2 §1).
// The database stores only sha256(token); the CSV handed to the site is the
// only copy of the plaintext.
import crypto from 'node:crypto';
import fs from 'node:fs';

export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
export const SITE_RECORD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
export const INPUT_HEADER = 'site_record_id';
export const OUTPUT_HEADER = 'site_record_id,token,deep_link';

export function generateToken(randomBytes = crypto.randomBytes) {
  const token = randomBytes(24).toString('base64url');
  if (!TOKEN_RE.test(token)) throw new Error('generated token has an unexpected format');
  return token;
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function isTokenFormat(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

export function validateBotUsername(botUsername) {
  const value = String(botUsername ?? '').replace(/^@/, '');
  if (!value) throw new Error('--bot-username is required (the bot is not chosen yet: JOINGATE-1)');
  if (!BOT_USERNAME_RE.test(value)) throw new Error(`invalid bot username: ${botUsername}`);
  return value;
}

export function deepLink(botUsername, token) {
  return `https://t.me/${botUsername}?start=${token}`;
}

export function validateSiteRecordId(id, where = 'site_record_id') {
  if (typeof id !== 'string' || !SITE_RECORD_ID_RE.test(id)) {
    throw new Error(`${where} is invalid: must match ${SITE_RECORD_ID_RE}`);
  }
  return id;
}

// Input CSV: header `site_record_id`, one id per line; ids unique.
export function parseIdsCsv(text) {
  const content = String(text).replace(/^﻿/, '');
  const lines = content.split(/\r?\n/);
  while (lines.length && lines.at(-1) === '') lines.pop();
  if (lines[0] !== INPUT_HEADER) throw new Error(`input CSV header must be exactly "${INPUT_HEADER}"`);
  const ids = [];
  const seen = new Set();
  for (let i = 1; i < lines.length; i += 1) {
    const id = validateSiteRecordId(lines[i], `line ${i + 1}`);
    if (seen.has(id)) throw new Error(`line ${i + 1}: duplicate site_record_id ${id}`);
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) throw new Error('input CSV contains no site_record_id rows');
  return ids;
}

export function formatTokensCsv(rows) {
  return `${[OUTPUT_HEADER, ...rows.map((r) => `${r.siteRecordId},${r.token},${r.deepLink}`)].join('\n')}\n`;
}

export function parseTokensCsv(text) {
  const lines = String(text).split('\n');
  while (lines.length && lines.at(-1) === '') lines.pop();
  if (lines[0] !== OUTPUT_HEADER) throw new Error(`tokens CSV header must be exactly "${OUTPUT_HEADER}"`);
  return lines.slice(1).map((line) => {
    const [siteRecordId, token, link] = line.split(',');
    return { siteRecordId, token, deepLink: link };
  });
}

// Writes the secret CSV and records hashes in one step: the output file is
// created exclusively (never overwritten) with mode 0600 before any DB write;
// DB inserts run in a transaction that rolls back if the file write fails.
function writeSecretCsv(store, outputPath, rows, dbWork) {
  let fd;
  try {
    fd = fs.openSync(outputPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`refusing to overwrite existing file ${outputPath}`);
    throw error;
  }
  let written = false;
  try {
    fs.fchmodSync(fd, 0o600);
    store.transaction(() => {
      dbWork();
      fs.writeSync(fd, formatTokensCsv(rows));
      fs.fsyncSync(fd);
    });
    written = true;
  } finally {
    fs.closeSync(fd);
    if (!written) fs.rmSync(outputPath, { force: true });
  }
}

export function generateTokens({ store, ids, outputPath, botUsername, now = Date.now(), randomBytes }) {
  const bot = validateBotUsername(botUsername);
  for (const id of ids) {
    validateSiteRecordId(id);
    if (store.hasIssuedToken(id)) throw new Error(`site_record_id ${id} already holds an active token (use reissue)`);
  }
  if (new Set(ids).size !== ids.length) throw new Error('duplicate site_record_id');
  const rows = ids.map((siteRecordId) => {
    const token = generateToken(randomBytes);
    return { siteRecordId, token, deepLink: deepLink(bot, token) };
  });
  writeSecretCsv(store, outputPath, rows, () => {
    for (const row of rows) store.insertIssuedToken({ tokenSha256: hashToken(row.token), siteRecordId: row.siteRecordId, now });
  });
  return { count: rows.length, outputPath };
}

export function reissueToken({ store, siteRecordId, outputPath, botUsername, now = Date.now(), randomBytes }) {
  const bot = validateBotUsername(botUsername);
  validateSiteRecordId(siteRecordId);
  if (store.listTokensBySite(siteRecordId).length === 0) {
    throw new Error(`site_record_id ${siteRecordId} has no tokens (use generate)`);
  }
  const token = generateToken(randomBytes);
  const rows = [{ siteRecordId, token, deepLink: deepLink(bot, token) }];
  let revoked = 0;
  writeSecretCsv(store, outputPath, rows, () => {
    revoked = store.revokeIssuedTokens(siteRecordId, now);
    store.insertIssuedToken({ tokenSha256: hashToken(token), siteRecordId, now });
  });
  return { siteRecordId, revoked, outputPath };
}

// Never contains a token or a token hash.
export function tokenStatus({ store, siteRecordId }) {
  validateSiteRecordId(siteRecordId);
  const tokens = store.listTokensBySite(siteRecordId).map((row) => ({
    status: row.status,
    telegram_user_id: row.telegram_user_id,
    created_at: new Date(row.created_at).toISOString(),
    used_at: row.used_at == null ? null : new Date(row.used_at).toISOString(),
    revoked_at: row.revoked_at == null ? null : new Date(row.revoked_at).toISOString(),
  }));
  return {
    site_record_id: siteRecordId,
    active: tokens.some((t) => t.status === 'issued'),
    verified: store.isVerifiedSite(siteRecordId),
    tokens,
  };
}
