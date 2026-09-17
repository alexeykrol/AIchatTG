import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const error = () => Object.assign(new Error('review_binding_invalid'), { code: 'review_binding_invalid', statusCode: 503 });
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const id = (value, negative = false) => typeof value === 'string'
  && (negative ? /^-[1-9]\d*$/u : /^[1-9]\d*$/u).test(value) && Number.isSafeInteger(Number(value));
const stamp = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && Date.parse(value) >= 0 && new Date(value).toISOString() === value;

export function validateModerationReviewBinding(value) {
  if (!exact(value, ['contract', 'enabled', 'bindingId', 'epochId', 'chatIds', 'startAt', 'allowUserId',
    'exemptBotIds', 'limits', 'maxEvents', 'maxErasureReceipts', 'maxInflight', 'captureTimeoutMs',
    'ipcTimeoutMs', 'notificationTimeoutMs', 'notificationIntervalMs', 'maxAlertsPerHour',
    'recipientChatId', 'reviewerPrincipal', 'consoleUrl', 'ipcRoot', 'storeRoot', 'deliveryEnabled'])
    || value.contract !== 'moderation-review-binding/v1' || value.enabled !== true
    || typeof value.deliveryEnabled !== 'boolean' || typeof value.allowUserId !== 'boolean'
    || ![value.bindingId, value.epochId].every((item) => typeof item === 'string' && /^[a-zA-Z0-9_-]{8,80}$/u.test(item))
    || !Array.isArray(value.chatIds) || !value.chatIds.length || value.chatIds.length > 20
    || value.chatIds.some((item) => !id(item, true)) || new Set(value.chatIds).size !== value.chatIds.length
    || !Array.isArray(value.exemptBotIds) || value.exemptBotIds.length > 100
    || value.exemptBotIds.some((item) => !id(item)) || new Set(value.exemptBotIds).size !== value.exemptBotIds.length || !stamp(value.startAt)
    || !id(value.recipientChatId) || typeof value.reviewerPrincipal !== 'string'
    || !/^[\p{L}\p{N}._:@-]{1,128}$/u.test(value.reviewerPrincipal)
    || !exact(value.limits, ['retentionMs', 'maxTextChars', 'maxContextChars', 'maxNoteChars', 'maxObservations'])
    || value.limits.retentionMs !== null || !integer(value.limits.maxTextChars, 1, 8192)
    || !integer(value.limits.maxContextChars, 1, 4096) || !integer(value.limits.maxNoteChars, 1, 4096)
    || !integer(value.limits.maxObservations, 1, 1_000_000) || !integer(value.maxEvents, 1, 5_000_000)
    || !integer(value.maxErasureReceipts, 1, 2_000_000) || !integer(value.maxInflight, 1, 32)
    || !integer(value.captureTimeoutMs, 50, 5000) || !integer(value.ipcTimeoutMs, 50, 5000)
    || !integer(value.notificationTimeoutMs, 100, 10_000) || !integer(value.notificationIntervalMs, 1000, 60_000)
    || !integer(value.maxAlertsPerHour, 1, 60)) throw error();
  for (const path of [value.ipcRoot, value.storeRoot]) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.length < 8 || path.endsWith('/')
      || /[\u0000-\u001f\u007f]/u.test(path) || resolve(path) !== path) throw error();
  }
  if (value.ipcRoot === value.storeRoot || value.storeRoot.startsWith(value.ipcRoot + '/')
    || value.ipcRoot.startsWith(value.storeRoot + '/')) throw error();
  let origin;
  try { origin = new URL(value.consoleUrl); } catch { throw error(); }
  if (origin.protocol !== 'https:' || origin.origin !== value.consoleUrl || origin.username || origin.password) throw error();
  const copy = JSON.parse(JSON.stringify(value));
  Object.freeze(copy.chatIds); Object.freeze(copy.exemptBotIds); Object.freeze(copy.limits);
  return Object.freeze(copy);
}

/** Never discovers a destination or credential. Missing/invalid config disables
 * only this optional feature; callers expose unavailable coverage explicitly. */
export function loadModerationReviewBinding(path) {
  if (!path) return { binding: null, code: 'review_disabled' };
  try {
    if (typeof path !== 'string' || !isAbsolute(path)) throw error();
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
      || stat.size > 16_384 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || realpathSync(path) !== path) throw error();
    return { binding: validateModerationReviewBinding(JSON.parse(readFileSync(path, 'utf8'))), code: null };
  } catch { return { binding: null, code: 'review_binding_unavailable' }; }
}

export function reviewCapturePolicy(binding) {
  return { enabled: binding.enabled, bindingId: binding.bindingId, epochId: binding.epochId,
    chatIds: [...binding.chatIds], startAt: binding.startAt, allowUserId: binding.allowUserId,
    exemptBotIds: [...binding.exemptBotIds], maxTextChars: binding.limits.maxTextChars,
    maxContextChars: binding.limits.maxContextChars };
}

export function reviewSocketPaths(binding) {
  return { console: join(binding.ipcRoot, 'console-review.sock'), runtime: join(binding.ipcRoot, 'runtime-review.sock') };
}
