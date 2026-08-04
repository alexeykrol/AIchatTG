import { resolve } from 'node:path';
import { ASSISTANT_SOURCE_PACKAGES } from '@aichattg/telegram-core';
import { validateProviderRuntimeConfig } from './provider-adapter.mjs';

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

function nonNegativeInteger(env, name, fallback, max = 30_000) {
  const value = Number.parseInt(String(env[name] ?? fallback), 10);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
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

function configuredDigest(env, name) {
  return String(env[name] || '').trim().toLowerCase();
}

function knowledgeAdmission(env, cwd, { sourceId, pathName, digestName, defaultPath }) {
  return {
    manifestPath: resolve(cwd, String(env[pathName] || defaultPath)),
    expectedIdentity: {
      sourceId,
      manifestDigest: configuredDigest(env, digestName),
    },
  };
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
  const provider = {
    enabled: boolean(env, 'TELEGRAM_RUNTIME_PROVIDER_ENABLED', false),
    endpoint: String(env.TELEGRAM_RUNTIME_PROVIDER_ENDPOINT || ''),
    apiKey: String(env.TELEGRAM_RUNTIME_PROVIDER_API_KEY || ''),
    model: String(env.TELEGRAM_RUNTIME_PROVIDER_MODEL || ''),
  };
  if (provider.enabled && !validateProviderRuntimeConfig(provider).valid) {
    throw new Error('an enabled provider requires a HTTPS endpoint, API key and model');
  }
  return {
    port: integer(env, 'TELEGRAM_RUNTIME_PORT', 8788),
    dataRoot: resolve(cwd, String(env.TELEGRAM_RUNTIME_DATA_ROOT || 'data/telegram-runtime')),
    databasePath: resolve(cwd, String(env.TELEGRAM_RUNTIME_DATABASE_PATH || 'data/telegram-runtime/telegram-runtime.db')),
    knowledge: {
      root: resolve(cwd, String(env.TELEGRAM_RUNTIME_KNOWLEDGE_ROOT || 'data/knowledge')),
      admissions: {
        [ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT]: knowledgeAdmission(env, cwd, {
          sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT,
          pathName: 'TELEGRAM_RUNTIME_KNOWLEDGE_CONTENT_MANIFEST_PATH',
          digestName: 'TELEGRAM_RUNTIME_KNOWLEDGE_CONTENT_MANIFEST_SHA256',
          defaultPath: 'data/knowledge/course-content.manifest.json',
        }),
        [ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS]: knowledgeAdmission(env, cwd, {
          sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS,
          pathName: 'TELEGRAM_RUNTIME_KNOWLEDGE_OPERATIONS_MANIFEST_PATH',
          digestName: 'TELEGRAM_RUNTIME_KNOWLEDGE_OPERATIONS_MANIFEST_SHA256',
          defaultPath: 'data/knowledge/manifest.json',
        }),
      },
    },
    ingressEnabled,
    moderationMode: String(env.TELEGRAM_RUNTIME_MODERATION_MODE || 'shadow') === 'live' ? 'live' : 'shadow',
    assistantModerationWaitMs: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_MODERATION_WAIT_MS', 30_000),
    assistantModerationPollMs: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_MODERATION_POLL_MS', 50, 5_000),
    moderator,
    assistant,
    provider,
    notification: { enabled: boolean(env, 'TELEGRAM_RUNTIME_NOTIFICATIONS_ENABLED', false) },
    startupPlan: Object.freeze({ setCommands: false, registerWebhook: false, deleteWebhook: false, poll: false }),
  };
}
