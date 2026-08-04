import { relative, resolve, sep } from 'node:path';
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

function pathWithin(root, candidate, name) {
  const resolved = resolve(candidate);
  const pathRelative = relative(root, resolved);
  if (pathRelative === '..' || pathRelative.startsWith(`..${sep}`) || pathRelative === '') {
    throw new Error(`${name} must name a file below TELEGRAM_RUNTIME_KNOWLEDGE_ROOT`);
  }
  return resolved;
}

function knowledgeAdmission(env, cwd, root, { sourceId, pathName, digestName, defaultPath }) {
  return {
    manifestPath: pathWithin(root, resolve(cwd, String(env[pathName] || defaultPath)), pathName),
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

function providerTuple(env, name) {
  const prefix = `TELEGRAM_RUNTIME_PROVIDER_${name}`;
  return {
    model: String(env[`${prefix}_MODEL`] || ''),
    reasoningEffort: String(env[`${prefix}_REASONING_EFFORT`] || ''),
    maxOutputTokens: String(env[`${prefix}_MAX_OUTPUT_TOKENS`] || ''),
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
  const moderationMode = String(env.TELEGRAM_RUNTIME_MODERATION_MODE || 'shadow') === 'live' ? 'live' : 'shadow';
  const knowledgeRoot = resolve(cwd, String(env.TELEGRAM_RUNTIME_KNOWLEDGE_ROOT || 'data/knowledge'));
  const moderator = roleConfig(env, 'MODERATOR');
  const assistant = roleConfig(env, 'ASSISTANT');
  if (ingressEnabled) {
    for (const role of roleNames) {
      const config = role === 'MODERATOR' ? moderator : assistant;
      if (!config.webhookSecret) throw new Error(`TELEGRAM_RUNTIME_${role}_WEBHOOK_SECRET is required when ingress is enabled`);
      if (!config.botToken) throw new Error(`TELEGRAM_RUNTIME_${role}_BOT_TOKEN is required when ingress is enabled`);
      if (!config.chatIds.length) throw new Error(`TELEGRAM_RUNTIME_${role}_CHAT_IDS requires at least one chat when ingress is enabled`);
    }
    if (moderationMode === 'live') {
      const guardedChats = new Set(moderator.chatIds);
      const uncoveredAssistantChat = assistant.chatIds.find((chatId) => !guardedChats.has(chatId));
      if (uncoveredAssistantChat) {
        throw new Error('TELEGRAM_RUNTIME_ASSISTANT_CHAT_IDS must be covered by TELEGRAM_RUNTIME_MODERATOR_CHAT_IDS when live ingress is enabled');
      }
    }
  }
  const provider = {
    enabled: boolean(env, 'TELEGRAM_RUNTIME_PROVIDER_ENABLED', false),
    vendor: String(env.TELEGRAM_RUNTIME_PROVIDER_VENDOR || ''),
    endpoint: String(env.TELEGRAM_RUNTIME_PROVIDER_ENDPOINT || ''),
    apiKey: String(env.TELEGRAM_RUNTIME_PROVIDER_API_KEY || ''),
    modelTuples: {
      moderatorSafety: providerTuple(env, 'MODERATOR_SAFETY'),
      assistantRouter: providerTuple(env, 'ASSISTANT_ROUTER'),
      assistantAnswer: providerTuple(env, 'ASSISTANT_ANSWER'),
    },
  };
  const validatedProvider = validateProviderRuntimeConfig(provider);
  if (provider.enabled && !validatedProvider.valid) {
    throw new Error(`an enabled provider requires the explicit OpenAI-compatible configuration (${validatedProvider.code})`);
  }
  return {
    port: integer(env, 'TELEGRAM_RUNTIME_PORT', 8788),
    dataRoot: resolve(cwd, String(env.TELEGRAM_RUNTIME_DATA_ROOT || 'data/telegram-runtime')),
    databasePath: resolve(cwd, String(env.TELEGRAM_RUNTIME_DATABASE_PATH || 'data/telegram-runtime/telegram-runtime.db')),
    knowledge: {
      root: knowledgeRoot,
      admissions: {
        [ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT]: knowledgeAdmission(env, cwd, knowledgeRoot, {
          sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT,
          pathName: 'TELEGRAM_RUNTIME_KNOWLEDGE_CONTENT_MANIFEST_PATH',
          digestName: 'TELEGRAM_RUNTIME_KNOWLEDGE_CONTENT_MANIFEST_SHA256',
          defaultPath: 'data/knowledge/course-content.manifest.json',
        }),
        [ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS]: knowledgeAdmission(env, cwd, knowledgeRoot, {
          sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS,
          pathName: 'TELEGRAM_RUNTIME_KNOWLEDGE_OPERATIONS_MANIFEST_PATH',
          digestName: 'TELEGRAM_RUNTIME_KNOWLEDGE_OPERATIONS_MANIFEST_SHA256',
          defaultPath: 'data/knowledge/manifest.json',
        }),
      },
    },
    ingressEnabled,
    moderationMode,
    // The published Telegram safety policy treats real URLs as a hard spam
    // signal. @mentions are excluded by the core detector, so this default does
    // not turn normal conversation into a link violation.
    moderationBanLinks: boolean(env, 'TELEGRAM_RUNTIME_MODERATION_BAN_LINKS', true),
    assistantModerationWaitMs: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_MODERATION_WAIT_MS', 30_000),
    assistantModerationPollMs: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_MODERATION_POLL_MS', 50, 5_000),
    moderator,
    assistant,
    provider: provider.enabled ? validatedProvider.config : provider,
    notification: { enabled: boolean(env, 'TELEGRAM_RUNTIME_NOTIFICATIONS_ENABLED', false) },
    startupPlan: Object.freeze({ setCommands: false, registerWebhook: false, deleteWebhook: false, poll: false }),
  };
}
