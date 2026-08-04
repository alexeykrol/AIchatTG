import { resolve } from 'node:path';

const roleNames = ['MODERATOR', 'ASSISTANT'];

function boolean(env, name, fallback = false) {
  if (!Object.hasOwn(env, name) || env[name] === '') return fallback;
  const value = String(env[name]).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function integer(env, name, fallback, { min = 1, max = 65_535 } = {}) {
  const value = Number.parseInt(String(env[name] ?? fallback), 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function csv(env, name) {
  return String(env[name] || '').split(',').map((value) => value.trim()).filter(Boolean);
}

function optionalSecret(env, name) {
  const value = String(env[name] || '');
  if (value && (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value))) {
    throw new Error(`${name} must contain 1-256 URL-safe characters`);
  }
  return value;
}

function roleConfig(env, role) {
  const prefix = `TELEGRAM_RUNTIME_${role}`;
  return {
    chatIds: csv(env, `${prefix}_CHAT_IDS`),
    botToken: String(env[`${prefix}_BOT_TOKEN`] || ''),
    botUsername: String(env[`${prefix}_BOT_USERNAME`] || '').replace(/^@/, ''),
    webhookSecret: optionalSecret(env, `${prefix}_WEBHOOK_SECRET`),
    exemptBotIds: csv(env, `${prefix}_EXEMPT_BOT_IDS`),
  };
}

export function loadRuntimeConfig(env = process.env, { cwd = process.cwd() } = {}) {
  if (boolean(env, 'TELEGRAM_RUNTIME_POLLING_ENABLED', false)) {
    throw new Error('TELEGRAM_RUNTIME_POLLING_ENABLED is unsupported: polling is intentionally not implemented');
  }
  if (boolean(env, 'TELEGRAM_RUNTIME_REGISTER_WEBHOOK_ON_START', false)
    || boolean(env, 'TELEGRAM_RUNTIME_SET_COMMANDS_ON_START', false)) {
    throw new Error('webhook registration and command setup are separate cutover actions, never startup behavior');
  }
  const ingressEnabled = boolean(env, 'TELEGRAM_RUNTIME_INGRESS_ENABLED', false);
  const moderator = roleConfig(env, 'MODERATOR');
  const assistant = roleConfig(env, 'ASSISTANT');
  if (ingressEnabled) {
    for (const role of roleNames) {
      const config = role === 'MODERATOR' ? moderator : assistant;
      if (!config.webhookSecret) throw new Error(`TELEGRAM_RUNTIME_${role}_WEBHOOK_SECRET is required when ingress is enabled`);
    }
  }
  const llmEnabled = boolean(env, 'TELEGRAM_RUNTIME_LLM_ENABLED', false);
  const llmEndpoint = String(env.TELEGRAM_RUNTIME_LLM_ENDPOINT || '').replace(/\/$/u, '');
  const llmApiKey = String(env.TELEGRAM_RUNTIME_LLM_API_KEY || '');
  if (llmEnabled && (!llmEndpoint || !llmApiKey)) {
    throw new Error('TELEGRAM_RUNTIME_LLM_ENDPOINT and TELEGRAM_RUNTIME_LLM_API_KEY are required when LLM is enabled');
  }
  return {
    port: integer(env, 'TELEGRAM_RUNTIME_PORT', 8788),
    dataRoot: resolve(cwd, String(env.TELEGRAM_RUNTIME_DATA_ROOT || 'data/telegram-runtime')),
    databasePath: resolve(cwd, String(env.TELEGRAM_RUNTIME_DATABASE_PATH || 'data/telegram-runtime/telegram-runtime.db')),
    ingressEnabled,
    moderationMode: String(env.TELEGRAM_RUNTIME_MODERATION_MODE || 'shadow') === 'live' ? 'live' : 'shadow',
    moderator,
    assistant,
    llm: {
      enabled: llmEnabled,
      endpoint: llmEndpoint,
      apiKey: llmApiKey,
      model: String(env.TELEGRAM_RUNTIME_LLM_MODEL || ''),
    },
    notification: { enabled: boolean(env, 'TELEGRAM_RUNTIME_NOTIFICATIONS_ENABLED', false) },
    startupPlan: Object.freeze({ setCommands: false, registerWebhook: false, deleteWebhook: false, poll: false }),
  };
}
