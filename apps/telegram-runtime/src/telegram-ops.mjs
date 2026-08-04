const OWNED_ROLES = Object.freeze(['moderator', 'assistant']);
const ROLE_PATHS = Object.freeze({
  moderator: '/webhooks/telegram/moderator',
  assistant: '/webhooks/telegram/assistant',
});
const ASSISTANT_COMMANDS = Object.freeze([
  { command: 'ask', description: 'Ask the assistant' },
  { command: 'help', description: 'Show assistant help' },
]);

function ownedRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (!OWNED_ROLES.includes(normalized)) throw new Error('role must be moderator or assistant');
  return normalized;
}

function safePublicOrigin(value) {
  let origin;
  try { origin = new URL(String(value || '')); } catch { origin = null; }
  if (!origin || origin.protocol !== 'https:' || !origin.hostname || origin.username || origin.password
    || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('AICHATTG_PUBLIC_ORIGIN must be an exact HTTPS origin without a path');
  }
  return origin.origin;
}

function roleConfig(runtimeConfig, role) {
  const config = role === 'moderator' ? runtimeConfig?.moderator : runtimeConfig?.assistant;
  const botToken = typeof config?.botToken === 'string' ? config.botToken.trim() : '';
  const webhookSecret = typeof config?.webhookSecret === 'string' ? config.webhookSecret.trim() : '';
  if (!botToken) throw new Error(`TELEGRAM_RUNTIME_${role.toUpperCase()}_BOT_TOKEN is required for Telegram operations`);
  return { botToken, webhookSecret };
}

function redactedRequest(method, body) {
  if (!body) return { method };
  const redacted = { ...body };
  if (Object.hasOwn(redacted, 'secret_token')) redacted.secret_token = '[configured]';
  return { method, body: redacted };
}

function operationFor({ action, role, runtimeConfig, publicOrigin }) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const owned = ownedRole(role);
  const { botToken, webhookSecret } = roleConfig(runtimeConfig, owned);
  if (!['status', 'set-webhook', 'delete-webhook', 'set-commands'].includes(normalizedAction)) {
    throw new Error('action must be status, set-webhook, delete-webhook or set-commands');
  }
  if (normalizedAction === 'status') {
    return { role: owned, method: 'getWebhookInfo', botToken, body: null };
  }
  if (normalizedAction === 'set-commands') {
    if (owned !== 'assistant') throw new Error('set-commands is owned by the assistant role only');
    return { role: owned, method: 'setMyCommands', botToken, body: { commands: ASSISTANT_COMMANDS } };
  }
  if (normalizedAction === 'delete-webhook') {
    return { role: owned, method: 'deleteWebhook', botToken, body: { drop_pending_updates: false } };
  }
  if (!webhookSecret) throw new Error(`TELEGRAM_RUNTIME_${owned.toUpperCase()}_WEBHOOK_SECRET is required to set its webhook`);
  const origin = safePublicOrigin(publicOrigin);
  return {
    role: owned,
    method: 'setWebhook',
    botToken,
    body: {
      url: `${origin}${ROLE_PATHS[owned]}`,
      secret_token: webhookSecret,
      allowed_updates: ['message', 'edited_message'],
      drop_pending_updates: false,
    },
  };
}

async function invokeTelegram(operation, fetchFn) {
  if (typeof fetchFn !== 'function') throw new Error('Telegram operations require fetch');
  const response = await fetchFn(`https://api.telegram.org/bot${operation.botToken}/${operation.method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: operation.body == null ? undefined : JSON.stringify(operation.body),
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* Telegram response is invalid and remains a visible failure. */ }
  if (!response?.ok || payload?.ok === false) {
    throw new Error(`telegram_${operation.method}_failed:${String(payload?.description || `http_${response?.status || 0}`).slice(0, 160)}`);
  }
  return payload?.result ?? true;
}

/**
 * Explicitly prepares or executes one owned Telegram control-plane request.
 * `apply: false` is the safe default and does not even invoke fetch. A caller
 * must choose one role, so a Moderator configuration cannot mutate Assistant
 * state (or the reverse) through an implicit loop.
 */
export async function runTelegramOperation({
  action,
  role,
  runtimeConfig,
  publicOrigin,
  apply = false,
  fetchFn = globalThis.fetch,
} = {}) {
  const operation = operationFor({ action, role, runtimeConfig, publicOrigin });
  const plan = {
    action: String(action).trim().toLowerCase(),
    role: operation.role,
    request: redactedRequest(operation.method, operation.body),
  };
  if (apply !== true) return { mode: 'dry_run', ...plan };
  const result = await invokeTelegram(operation, fetchFn);
  return { mode: 'applied', ...plan, result };
}

export const TELEGRAM_OPS = Object.freeze({ OWNED_ROLES, ROLE_PATHS, ASSISTANT_COMMANDS });
