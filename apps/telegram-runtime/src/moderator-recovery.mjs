/**
 * A deliberately small lifecycle wrapper around the runtime's fenced recovery
 * operation. It contains no provider or Telegram transport itself, which makes
 * the allowed automatic behaviour easy to audit and test.
 */
export function createModeratorRecoveryWorker({
  runtime,
  intervalSec = 60,
  batchSize = 10,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!runtime || typeof runtime.recoverModeratorJudgements !== 'function') {
    throw new Error('Moderator recovery worker requires runtime recovery support');
  }
  const intervalMs = Math.max(5, Math.min(3_600, Number(intervalSec) || 60)) * 1_000;
  const limit = Math.max(1, Math.min(50, Number(batchSize) || 10));
  let active = false;
  let timer = null;

  async function drain({ startup = false } = {}) {
    if (active) return { skipped: 'worker_already_active' };
    active = true;
    try {
      return await runtime.recoverModeratorJudgements({ limit, startup });
    } catch (error) {
      logger.error?.('[telegram-runtime] Moderator recovery failed', error?.message || 'unknown_error');
      return { failed: 'recovery_runtime_error' };
    } finally {
      active = false;
    }
  }

  return Object.freeze({
    drain,
    start() {
      if (timer != null) return false;
      timer = setIntervalFn(() => { void drain(); }, intervalMs);
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
