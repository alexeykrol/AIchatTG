/**
 * A small, independent lifecycle wrapper for the 30-second bare-/ask timer.
 * It deliberately does not share the Moderator recovery loop: a provider call
 * may legitimately be slow or fenced, while UI expiry must remain bounded.
 */
export function createAssistantAskExpiryWorker({
  runtime,
  intervalMs = 1_000,
  batchSize = 10,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!runtime || typeof runtime.expireAssistantAskPrompts !== 'function') {
    throw new Error('Assistant ask expiry worker requires expiry support');
  }
  const interval = Math.max(250, Math.min(5_000, Number(intervalMs) || 1_000));
  const limit = Math.max(1, Math.min(50, Number(batchSize) || 10));
  let active = false;
  let timer = null;

  async function drain({ startup = false } = {}) {
    if (active) return { skipped: 'worker_already_active' };
    active = true;
    try {
      return await runtime.expireAssistantAskPrompts({ limit, startup });
    } catch (error) {
      logger.error?.('[telegram-runtime] Assistant ask expiry failed', error?.message || 'unknown_error');
      return { failed: 'ask_expiry_runtime_error' };
    } finally {
      active = false;
    }
  }

  return Object.freeze({
    drain,
    start() {
      if (timer != null) return false;
      timer = setIntervalFn(() => { void drain(); }, interval);
      void drain({ startup: true });
      return true;
    },
    stop() {
      if (timer == null) return false;
      clearIntervalFn(timer);
      timer = null;
      return true;
    },
    get active() { return active; },
  });
}
