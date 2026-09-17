import { createReviewIpcServer, requestReviewIpc } from '../../../packages/telegram-core/src/moderation-review-ipc.mjs';
import { reviewCapturePolicy, reviewSocketPaths } from '../../../packages/telegram-core/src/moderation-review-config.mjs';
import { createModerationReviewStore } from './moderation-review-store.mjs';
import { deliverNextModerationReviewAlert } from './moderation-review-alerts.mjs';
import { DISABLED_REVIEW_STATUS } from './moderation-review-http.mjs';

const COVERAGE_CONTRACT = 'moderation-review-coverage/v1';
const COVERAGE_SEMANTICS = 'observed_attempts_not_unique_messages';
const COVERAGE_FIELDS = ['contract', 'status', 'sinceBoot', 'priorCoverage', 'countersKnownSinceBoot',
  'counts', 'reasons', 'active', 'semantics', 'backfillEnabled'];
const OUTCOMES = ['acknowledged', 'not_attempted', 'rejected', 'uncertain'];
// Code-owned labels only. A peer-controlled string must never become public
// telemetry, even when it happens to match the producer's review_* pattern.
const COVERAGE_REASONS = new Set([
  'review_busy', 'review_capture_timeout', 'review_primary_completed', 'review_projection_failed',
  'review_receipt_unverified', 'review_receipt_verified', 'review_transport_unavailable', 'review_unknown', 'review_other',
  'review_before_start', 'review_binding_invalid', 'review_chat_forbidden', 'review_clock_invalid',
  'review_context_invalid', 'review_contract_invalid', 'review_disabled', 'review_envelope_invalid',
  'review_exempt_bot', 'review_id_invalid', 'review_kind_invalid', 'review_message_invalid', 'review_policy_invalid',
  'review_sender_invalid', 'review_source_digest_invalid', 'review_source_time_invalid', 'review_text_invalid',
  'review_truncation_invalid', 'review_update_invalid', 'review_user_forbidden',
  'review_capacity_reached', 'review_capture_required', 'review_erasure_reserve_full', 'review_event_capacity_reached',
  'review_event_conflict', 'review_revision_conflict', 'review_revision_order_conflict', 'review_shape_invalid',
  'review_source_date_conflict',
]);
const plainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plainRecord(value) && Reflect.ownKeys(value).length === keys.length
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const unknownCoverage = () => ({ contract: COVERAGE_CONTRACT, status: 'unknown', sinceBoot: null,
  priorCoverage: 'unknown', countersKnownSinceBoot: false, counts: null, reasons: null, active: null,
  semantics: COVERAGE_SEMANTICS, backfillEnabled: false });
const unavailableStatus = () => ({ ...DISABLED_REVIEW_STATUS, mode: 'unavailable', coverage: unknownCoverage(),
  erasureReplayProtection: false, notificationRecall: false });

/** An attempted but failed bootstrap is unavailable, not a deliberately disabled
 * feature. No error text, binding identifiers or private configuration survive. */
export function createUnavailableConsoleReviewService() {
  return { store: null, async status() { return unavailableStatus(); },
    async step() { return { state: 'unavailable' }; }, async close() {} };
}

function projectCoverage(value, { maxInflight, now }) {
  try {
    if (!exact(value, COVERAGE_FIELDS) || value.contract !== COVERAGE_CONTRACT
      || value.status !== 'unknown' || value.priorCoverage !== 'unknown'
      || value.semantics !== COVERAGE_SEMANTICS || value.backfillEnabled !== false
      || typeof value.countersKnownSinceBoot !== 'boolean' || !count(value.active) || value.active > maxInflight
      || typeof value.sinceBoot !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.sinceBoot)) {
      return unknownCoverage();
    }
    const boot = Date.parse(value.sinceBoot), time = now();
    if (!count(boot) || !count(time) || boot > time || new Date(boot).toISOString() !== value.sinceBoot) return unknownCoverage();
    let counts = null, reasons = null;
    if (value.countersKnownSinceBoot) {
      if (!exact(value.counts, OUTCOMES) || !OUTCOMES.every((key) => count(value.counts[key]))
        || !plainRecord(value.reasons) || Reflect.ownKeys(value.reasons).length > 33
        || !exact(value.reasons, Object.keys(value.reasons))) return unknownCoverage();
      const reasonKeys = Object.keys(value.reasons);
      if (reasonKeys.some((key) => !COVERAGE_REASONS.has(key) || !count(value.reasons[key]) || value.reasons[key] === 0)) {
        return unknownCoverage();
      }
      const total = OUTCOMES.reduce((sum, key) => sum + BigInt(value.counts[key]), 0n);
      if (reasonKeys.reduce((sum, key) => sum + BigInt(value.reasons[key]), 0n) !== total) return unknownCoverage();
      counts = Object.fromEntries(OUTCOMES.map((key) => [key, value.counts[key]]));
      reasons = Object.fromEntries(reasonKeys.map((key) => [key, value.reasons[key]]));
    } else if (value.counts !== null || value.reasons !== null) return unknownCoverage();
    return { contract: COVERAGE_CONTRACT, status: 'unknown', sinceBoot: new Date(boot).toISOString(),
      priorCoverage: 'unknown', countersKnownSinceBoot: value.countersKnownSinceBoot,
      counts, reasons, active: value.active, semantics: COVERAGE_SEMANTICS, backfillEnabled: false };
  } catch { return unknownCoverage(); }
}

export async function createConsoleReviewService({ binding, now = Date.now, provision = false,
  request = requestReviewIpc, serverFactory = createReviewIpcServer } = {}) {
  if (!binding) return { store: null, status: async () => DISABLED_REVIEW_STATUS, async close() {} };
  const sockets = reviewSocketPaths(binding);
  const store = createModerationReviewStore({ root: binding.storeRoot, mode: 'live',
    limits: binding.limits, capturePolicy: reviewCapturePolicy(binding), maxEvents: binding.maxEvents,
    maxErasureReceipts: binding.maxErasureReceipts, maxAlertsPerHour: binding.maxAlertsPerHour, now, provision });
  let ipc, timer, work = null, workAbort = null, closed = false;
  const statusAborts = new Set();
  let deliveryAvailable = binding.deliveryEnabled;
  try {
    ipc = await serverFactory({ socketPath: sockets.console, timeoutMs: binding.ipcTimeoutMs,
      maxConcurrent: binding.maxInflight, handle: async ({ path, body, signal }) => {
        if (closed || signal.aborted) return { statusCode: 503, body: { error: 'review_unavailable' } };
        try {
          if (path === '/capture') return { statusCode: 200, body: store.capture(body) };
          if (path === '/authorize' && deliveryAvailable) return { statusCode: 200, body: store.authorizeAlert(body) };
          return { statusCode: 404, body: { error: 'review_route_not_found' } };
        } catch (error) {
          const safe = /^review_[a-z_]+$/u.test(error?.code || '');
          const statusCode = safe && [400, 403, 409, 422].includes(error.statusCode) ? error.statusCode : 503;
          return { statusCode, body: { error: safe ? error.code : 'review_unavailable',
            ...(statusCode !== 503 ? { definiteNoCommit: true } : {}) } };
        }
      } });
  } catch (error) { store.close(); throw error; }
  async function step() {
    if (closed || !deliveryAvailable || work) return { state: 'idle' };
    workAbort = new AbortController();
    work = deliverNextModerationReviewAlert({ store, consoleUrl: binding.consoleUrl,
      send: async (_payload, claim) => {
        const result = await request({ socketPath: sockets.runtime, path: '/notify', body: claim,
          timeoutMs: binding.notificationTimeoutMs + binding.ipcTimeoutMs + 500, signal: workAbort.signal });
        return result.statusCode === 200 ? result.body : { ok: false };
      } });
    try {
      const result = await work;
      // Stop this sender run on uncertain transport/commit. Do not repeatedly
      // start readers/calls against an unavailable peer or replay this alert.
      if (result.state === 'uncertain') deliveryAvailable = false;
      return result;
    } catch { deliveryAvailable = false; return { state: 'unavailable' }; }
    finally { work = null; workAbort = null; }
  }
  timer = setInterval(() => { void step(); }, binding.notificationIntervalMs);
  timer.unref?.();
  return {
    store, step,
    async status() {
      if (closed) return unavailableStatus();
      let status;
      try { status = store.status(); } catch { return unavailableStatus(); }
      let coverage = unknownCoverage();
      const controller = new AbortController();
      statusAborts.add(controller);
      try {
        const response = await request({ socketPath: sockets.runtime, path: '/coverage', body: {},
          timeoutMs: binding.ipcTimeoutMs, signal: controller.signal });
        if (response.statusCode === 200) coverage = projectCoverage(response.body, { maxInflight: binding.maxInflight, now });
      } catch { /* unknown, never zero missed */ }
      finally { statusAborts.delete(controller); }
      if (closed) return unavailableStatus();
      return { ...status, deliveryEnabled: deliveryAvailable, coverage,
        erasureReplayProtection: false, notificationRecall: false };
    },
    async close() {
      if (closed) return;
      closed = true; clearInterval(timer); workAbort?.abort();
      for (const controller of statusAborts) controller.abort();
      await work?.catch(() => {});
      await ipc.close(); store.close();
    },
  };
}
