import { createHmac, timingSafeEqual } from 'node:crypto';

export const SITE_SIGNATURE_HEADER = 'x-gatekeeper-site-signature';

const REQUIRED_KEYS = new Set(['event_id', 'event_type', 'occurred_at', 'email']);
const ALLOWED_KEYS = new Set([
  ...REQUIRED_KEYS,
  'telegram_user_id',
  'telegram_username',
]);

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function exactString(value, field, { max, pattern }) {
  if (typeof value !== 'string') throw validationError(`${field} must be a string`);
  if (!value || value.length > max || value !== value.trim() || !pattern.test(value)) {
    throw validationError(`${field} is malformed`);
  }
  return value;
}

function isoTimestamp(value, field) {
  const source = exactString(value, field, {
    max: 64,
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u,
  });
  const milliseconds = Date.parse(source);
  if (!Number.isFinite(milliseconds)) throw validationError(`${field} must be an ISO date-time`);
  return new Date(milliseconds).toISOString();
}

function emailAddress(value) {
  if (typeof value !== 'string') throw validationError('email must be a string');
  const normalized = value.trim();
  if (!normalized || normalized.length > 254 || /[\u0000-\u0020\u007f]/u.test(normalized)) {
    throw validationError('email must be a valid address');
  }
  const separator = normalized.lastIndexOf('@');
  if (separator < 1 || separator !== normalized.indexOf('@')) {
    throw validationError('email must be a valid address');
  }
  const local = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1).toLowerCase();
  if (local.length > 64
    || local.startsWith('.')
    || local.endsWith('.')
    || local.includes('..')
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)
    || domain.length > 253
    || !domain.includes('.')) {
    throw validationError('email must be a valid address');
  }
  const labels = domain.split('.');
  if (labels.some((label) => !label
    || label.length > 63
    || label.startsWith('-')
    || label.endsWith('-')
    || !/^[a-z0-9-]+$/u.test(label))) {
    throw validationError('email must be a valid address');
  }
  return `${local}@${domain}`;
}

function telegramUserId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError('telegram_user_id must be a positive safe integer');
  }
  return value;
}

function telegramUsername(value) {
  const username = exactString(value, 'telegram_username', {
    max: 33,
    pattern: /^@?[A-Za-z0-9_]{5,32}$/u,
  }).replace(/^@/u, '');
  if (username.length > 32) throw validationError('telegram_username is malformed');
  return username;
}

export function signSiteWebhook(secret, rawBody) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function singleSiteSignatureFromRawHeaders(rawHeaders) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return null;
  const matches = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === SITE_SIGNATURE_HEADER) {
      matches.push(rawHeaders[index + 1]);
    }
  }
  return matches.length === 1 && typeof matches[0] === 'string' ? matches[0] : null;
}

export function verifySiteWebhook({ secret, rawBody, signature }) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/iu.test(signature)) return false;
  const expected = Buffer.from(signSiteWebhook(secret, rawBody), 'hex');
  const received = Buffer.from(signature, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function mapSiteRegistration(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw validationError('Site webhook body must be an object');
  }
  const keys = Object.keys(payload);
  const unknown = keys.find((key) => !ALLOWED_KEYS.has(key));
  if (unknown) throw validationError(`Site webhook body contains unknown key: ${unknown}`);
  const missing = [...REQUIRED_KEYS].find((key) => !Object.hasOwn(payload, key));
  if (missing) throw validationError(`Site webhook body is missing required key: ${missing}`);

  const externalEventId = exactString(payload.event_id, 'event_id', {
    max: 128,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u,
  });
  if (payload.event_type !== 'student_registered') {
    throw validationError('event_type must be student_registered');
  }
  const occurredAt = isoTimestamp(payload.occurred_at, 'occurred_at');
  const email = emailAddress(payload.email);
  const hasTelegramUserId = Object.hasOwn(payload, 'telegram_user_id');
  const hasTelegramUsername = Object.hasOwn(payload, 'telegram_username');
  const normalized = {
    event_id: externalEventId,
    event_type: 'student_registered',
    occurred_at: occurredAt,
    email,
    ...(hasTelegramUserId ? { telegram_user_id: telegramUserId(payload.telegram_user_id) } : {}),
    ...(hasTelegramUsername ? { telegram_username: telegramUsername(payload.telegram_username) } : {}),
  };
  const identity = {
    source: 'site',
    external_event_id: externalEventId,
  };
  const canonicalBody = JSON.stringify(normalized);
  return {
    identity,
    event: {
      event_id: externalEventId,
      event_type: 'student_registered',
      source: 'site',
      occurred_at: occurredAt,
      email,
      ...(hasTelegramUserId ? { telegram_user_id: normalized.telegram_user_id } : {}),
      ...(hasTelegramUsername ? { telegram_username: normalized.telegram_username } : {}),
    },
    canonicalBody,
  };
}
