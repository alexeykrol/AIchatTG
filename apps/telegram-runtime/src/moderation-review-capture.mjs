import { projectModerationReviewUpdate } from '../../../packages/telegram-core/src/moderation-review-projection.mjs';

const OUTCOMES = ['acknowledged', 'not_attempted', 'rejected', 'uncertain'];
const RECEIPT_KEYS = 'bindingId,contract,epochId,intakeSeq,outcome';

/** Optional request-scoped side capture. Never awaits, queues or replays the
 * primary runtime. Counters are deliberately independent of the Review DB. */
export function createModerationReviewCapture({ policy = null, send = null,
  maxInflight = 4, timeoutMs = 1500, now = Date.now,
  project = projectModerationReviewUpdate } = {}) {
  if (!Number.isSafeInteger(maxInflight) || maxInflight < 1 || maxInflight > 32
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new TypeError('review_capture_limits_invalid');
  policy = policy ? JSON.parse(JSON.stringify(policy)) : null;
  const bootAt = new Date(now()).toISOString();
  const counts = Object.fromEntries(OUTCOMES.map((key) => [key, 0]));
  const reasons = new Map(), active = new Set();
  let telemetryKnown = true, closed = false;
  function record(outcome, code) {
    try {
      if (!OUTCOMES.includes(outcome) || !Number.isSafeInteger(counts[outcome] + 1)) { telemetryKnown = false; return; }
      counts[outcome]++;
      const safe = typeof code === 'string' && /^review_[a-z_]{1,60}$/u.test(code) ? code : 'review_unknown';
      const key = reasons.has(safe) || reasons.size < 32 ? safe : 'review_other';
      reasons.set(key, (reasons.get(key) || 0) + 1);
    } catch { telemetryKnown = false; }
  }
  return {
    start(role, update) {
      const noop = () => {};
      if (closed || policy?.enabled !== true || typeof send !== 'function') return noop;
      let result;
      try { result = project({ role, update, receivedAt: new Date(now()).toISOString(), policy }); }
      catch { record('not_attempted', 'review_projection_failed'); return noop; }
      finally { update = null; }
      if (result?.kind === 'skip') return noop;
      if (result?.kind !== 'candidate') { record('not_attempted', result?.code); return noop; }
      if (active.size >= maxInflight) { result = null; record('not_attempted', 'review_busy'); return noop; }
      const controller = new AbortController();
      let finished = false, issued = false, timer;
      const finish = (outcome, code) => {
        if (finished) return;
        finished = true; clearTimeout(timer); active.delete(cancel); record(outcome, code);
      };
      const cancel = () => {
        finish(issued ? 'uncertain' : 'not_attempted', 'review_primary_completed');
        controller.abort();
      };
      active.add(cancel);
      timer = setTimeout(() => { finish('uncertain', 'review_capture_timeout'); controller.abort(); }, timeoutMs);
      timer.unref?.();
      try {
        // send serializes immediately and must obey signal/deadline. No
        // retained envelope closure and no post-response application queue.
        issued = true;
        const pending = send(result.envelope, { signal: controller.signal, timeoutMs });
        result = null;
        Promise.resolve(pending).then((response) => {
          if (finished) return;
          const receipt = response?.body;
          const valid = response?.statusCode === 200 && receipt && typeof receipt === 'object'
            && Object.keys(receipt).sort().join(',') === RECEIPT_KEYS
            && receipt.contract === 'moderation-review-receipt/v1'
            && receipt.bindingId === policy.bindingId && receipt.epochId === policy.epochId
            && Number.isSafeInteger(receipt.intakeSeq) && receipt.intakeSeq > 0
            && ['accepted', 'duplicate', 'stale'].includes(receipt.outcome);
          if (valid) finish('acknowledged', 'review_receipt_verified');
          else if ([400, 403, 409, 422].includes(response?.statusCode)
            && receipt?.definiteNoCommit === true && /^review_[a-z_]+$/u.test(receipt.error || '')) {
            finish('rejected', receipt.error);
          } else finish('uncertain', 'review_receipt_unverified');
        }, () => finish('uncertain', 'review_transport_unavailable'));
      } catch { result = null; finish('uncertain', 'review_transport_unavailable'); controller.abort(); }
      return cancel;
    },
    snapshot() {
      return { contract: 'moderation-review-coverage/v1', status: 'unknown', sinceBoot: bootAt,
        priorCoverage: 'unknown', countersKnownSinceBoot: telemetryKnown,
        counts: telemetryKnown ? { ...counts } : null,
        reasons: telemetryKnown ? Object.fromEntries(reasons) : null, active: active.size,
        semantics: 'observed_attempts_not_unique_messages', backfillEnabled: false };
    },
    close() { closed = true; for (const cancel of [...active]) cancel(); },
  };
}
