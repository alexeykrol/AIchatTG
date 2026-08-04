export function createNotificationAdapter({ enabled = false, send = null } = {}) {
  if (!enabled) return { async notify() { return { delivered: false, skipped: 'disabled' }; } };
  if (typeof send !== 'function') throw new Error('enabled notification adapter requires an explicit send function');
  return { notify: send };
}
