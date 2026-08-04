import { sha256 } from './security.mjs';
import {
  postApprovedJson,
  validateApprovedZapierUrl,
} from './network-policy.mjs';

const EVENT_TYPES = new Set(['site_invite_requested', 'onboarding_completed']);
const COMPLETION_SOURCES = new Set(['site', 'tribute', 'telegram', 'admin']);

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function exactObject(value, allowedKeys, requiredKeys, field = 'Zapier event data') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError(`${field} must be an object`);
  }
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw validationError(`${field} contains unknown key: ${unknown}`);
  const missing = requiredKeys.find((key) => !Object.hasOwn(value, key));
  if (missing) throw validationError(`${field} is missing required key: ${missing}`);
}

function boundedString(value, field, max = 256) {
  if (typeof value !== 'string'
    || !value
    || value.length > max
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw validationError(`${field} is malformed`);
  }
  return value;
}

function boundedMultilineText(value, field, max = 10_000) {
  if (typeof value !== 'string'
    || !value.trim()
    || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw validationError(`${field} is malformed`);
  }
  return value;
}

function timestamp(value, field) {
  const source = boundedString(value, field, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(source)) {
    throw validationError(`${field} must be an ISO date-time`);
  }
  const milliseconds = Date.parse(source);
  if (!Number.isFinite(milliseconds)) throw validationError(`${field} must be an ISO date-time`);
  return new Date(milliseconds).toISOString();
}

function emailAddress(value) {
  const source = boundedString(value, 'email', 254);
  const separator = source.lastIndexOf('@');
  if (separator < 1 || separator !== source.indexOf('@')) {
    throw validationError('email must be a valid address');
  }
  const local = source.slice(0, separator);
  const domain = source.slice(separator + 1).toLowerCase();
  if (local.length > 64
    || local.startsWith('.')
    || local.endsWith('.')
    || local.includes('..')
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)
    || !domain.includes('.')
    || domain.split('.').some((label) => !label
      || label.length > 63
      || label.startsWith('-')
      || label.endsWith('-')
      || !/^[a-z0-9-]+$/u.test(label))) {
    throw validationError('email must be a valid address');
  }
  return `${local}@${domain}`;
}

function publicHttpsUrl(value, field) {
  const source = boundedString(value, field, 2_048);
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw validationError(`${field} must be a public HTTPS URL`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const loopback = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '::1'
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  if (parsed.protocol !== 'https:'
    || loopback
    || parsed.username
    || parsed.password
    || parsed.hash) {
    throw validationError(`${field} must be a public HTTPS URL`);
  }
  return parsed.toString();
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError(`${field} must be a positive safe integer`);
  }
  return value;
}

function idempotencyKey(eventType, onboardingCaseId) {
  const stableIdentity = JSON.stringify({ event_type: eventType, onboarding_case_id: onboardingCaseId });
  return `gatekeeper-${sha256(stableIdentity)}`;
}

export function buildZapierPayload(eventType, data) {
  if (!EVENT_TYPES.has(eventType)) throw validationError('Zapier event_type is not supported');
  if (eventType === 'site_invite_requested') {
    exactObject(
      data,
      new Set([
        'onboarding_case_id',
        'registration_event_id',
        'email',
        'onboarding_url',
        'occurred_at',
        'email_subject',
        'email_text',
        'button_text',
      ]),
      [
        'onboarding_case_id',
        'registration_event_id',
        'email',
        'onboarding_url',
        'occurred_at',
        'email_subject',
        'email_text',
        'button_text',
      ],
    );
    const onboardingCaseId = boundedString(data.onboarding_case_id, 'onboarding_case_id', 128);
    return {
      event_type: eventType,
      idempotency_key: idempotencyKey(eventType, onboardingCaseId),
      onboarding_case_id: onboardingCaseId,
      registration_event_id: boundedString(data.registration_event_id, 'registration_event_id', 128),
      email: emailAddress(data.email),
      onboarding_url: publicHttpsUrl(data.onboarding_url, 'onboarding_url'),
      occurred_at: timestamp(data.occurred_at, 'occurred_at'),
      email_subject: boundedString(data.email_subject, 'email_subject', 200),
      email_text: boundedMultilineText(data.email_text, 'email_text'),
      button_text: boundedString(data.button_text, 'button_text', 80),
    };
  }

  exactObject(
    data,
    new Set(['onboarding_case_id', 'completed_at', 'source', 'email', 'telegram_user_id']),
    ['onboarding_case_id', 'completed_at', 'source'],
  );
  const onboardingCaseId = boundedString(data.onboarding_case_id, 'onboarding_case_id', 128);
  const source = boundedString(data.source, 'source', 16);
  if (!COMPLETION_SOURCES.has(source)) throw validationError('source is not supported');
  return {
    event_type: eventType,
    idempotency_key: idempotencyKey(eventType, onboardingCaseId),
    onboarding_case_id: onboardingCaseId,
    completed_at: timestamp(data.completed_at, 'completed_at'),
    source,
    ...(Object.hasOwn(data, 'email') ? { email: emailAddress(data.email) } : {}),
    ...(Object.hasOwn(data, 'telegram_user_id')
      ? { telegram_user_id: positiveSafeInteger(data.telegram_user_id, 'telegram_user_id') }
      : {}),
  };
}

export async function sendZapierEvent({
  config,
  eventType,
  data,
  transport = postApprovedJson,
}) {
  if (!config?.zapierEnabled) return { state: 'definite_failure', code: 'disabled' };
  const payload = buildZapierPayload(eventType, data);
  const endpoint = eventType === 'site_invite_requested'
    ? config.zapierSiteInviteUrl
    : config.zapierCompletionUrl;
  if (typeof endpoint !== 'string' || !endpoint) {
    return { state: 'definite_failure', code: 'missing_endpoint' };
  }
  let approvedEndpoint;
  try {
    approvedEndpoint = validateApprovedZapierUrl(endpoint);
  } catch {
    return { state: 'definite_failure', code: 'destination_not_approved' };
  }
  const headers = {
    'content-type': 'application/json',
    'idempotency-key': payload.idempotency_key,
  };
  if (config.zapierAuthToken) headers.authorization = `Bearer ${config.zapierAuthToken}`;

  let response;
  try {
    response = await transport({
      url: approvedEndpoint,
      headers,
      body: JSON.stringify(payload),
      timeoutMs: config.zapierTimeoutMs,
    });
  } catch (error) {
    if (error?.code === 'destination_not_approved') {
      return { state: 'definite_failure', code: 'destination_not_approved' };
    }
    return { state: 'inconclusive', code: 'transport_unknown' };
  }
  if (!response || !Number.isInteger(response.status)) {
    return { state: 'inconclusive', code: 'invalid_response' };
  }
  if (response.status >= 200 && response.status < 300) {
    return { state: 'sent', status: response.status };
  }
  if (response.status >= 400 && response.status < 500) {
    return { state: 'definite_failure', status: response.status, code: 'rejected' };
  }
  return { state: 'inconclusive', status: response.status, code: 'remote_unknown' };
}
