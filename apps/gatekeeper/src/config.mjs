import { resolveGatekeeperDataPaths } from './data-paths.mjs';
import {
  validateApprovedPublicBaseUrl,
  validateApprovedZapierUrl,
} from './network-policy.mjs';
import { DEFAULT_SCENARIO_PATH } from './scenario.mjs';

const LEGACY_INSTRUCTION_ENV = [
  'GATEKEEPER_INSTRUCTION_TEXT',
  'GATEKEEPER_INSTRUCTION_LINKS_JSON',
  'GATEKEEPER_ALLOW_PLACEHOLDER_INSTRUCTION',
];

const RETIRED_EXTERNAL_WEBHOOK_ENV = [
  'GATEKEEPER_EXTERNAL_WEBHOOK_SECRET',
  'GATEKEEPER_EXTERNAL_WEBHOOK_MAX_SKEW_SECONDS',
];

const RETIRED_DRAFT_SERVER_ENV = 'GATEKEEPER_ALLOW_DRAFT_SCENARIO';

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseInteger(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = String(env[name] || fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseBoolean(env, name, fallback = false) {
  if (!Object.hasOwn(env, name) || env[name] == null || env[name] === '') return fallback;
  const raw = String(env[name]).trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function optionalBoundedSecret(env, name, { min = 1, max = 512 } = {}) {
  if (!Object.hasOwn(env, name) || env[name] == null || env[name] === '') return '';
  const value = String(env[name]);
  if (value.length < min || value.length > max || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new Error(`${name} must contain ${min}-${max} printable ASCII characters without whitespace`);
  }
  return value;
}

function zapierUrl(env, name, { enabled }) {
  const raw = String(env[name] || '');
  if (!raw) {
    if (enabled) throw new Error(`${name} is required when GATEKEEPER_ZAPIER_ENABLED=true`);
    return '';
  }
  try {
    return validateApprovedZapierUrl(raw, name);
  } catch (error) {
    throw new Error(`${name} must be an approved Zapier HTTPS URL: ${error.message}`);
  }
}

function sitePublicBaseUrl(env, { enabled }) {
  const name = 'GATEKEEPER_PUBLIC_BASE_URL';
  const raw = String(env[name] || '').replace(/\/$/u, '');
  if (!raw) {
    if (enabled) throw new Error(`${name} is required when GATEKEEPER_SITE_ENABLED=true`);
    return '';
  }
  try {
    return validateApprovedPublicBaseUrl(raw, name);
  } catch (error) {
    throw new Error(`${name} must be the approved public HTTPS origin: ${error.message}`);
  }
}

function parsePositiveIntegerId(value, name) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must contain positive safe integers`);
  }
  return String(Number(value));
}

function parseTributeSubscriptionIds(env) {
  const raw = required(env, 'GATEKEEPER_TRIBUTE_SUBSCRIPTION_IDS');
  const ids = raw.split(',').map((value) => parsePositiveIntegerId(value.trim(), 'GATEKEEPER_TRIBUTE_SUBSCRIPTION_IDS'));
  if (new Set(ids).size !== ids.length) {
    throw new Error('GATEKEEPER_TRIBUTE_SUBSCRIPTION_IDS must not contain duplicates');
  }
  return ids;
}

export function loadConfig(env = process.env) {
  const legacy = LEGACY_INSTRUCTION_ENV.find((name) => Object.hasOwn(env, name));
  if (legacy) {
    throw new Error(`${legacy} is retired; edit SCENARIO_TEXTS.md and synchronize the scenario instead`);
  }
  const retiredWebhook = RETIRED_EXTERNAL_WEBHOOK_ENV.find((name) => Object.hasOwn(env, name));
  if (retiredWebhook) {
    throw new Error(`${retiredWebhook} is retired; configure the Tribute webhook instead`);
  }
  if (Object.hasOwn(env, RETIRED_DRAFT_SERVER_ENV)) {
    throw new Error(`${RETIRED_DRAFT_SERVER_ENV} is retired; draft scenarios are offline-simulator only`);
  }
  const { dataRoot, databasePath } = resolveGatekeeperDataPaths(env);
  const botUsername = required(env, 'GATEKEEPER_BOT_USERNAME').replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(botUsername) || !/bot$/i.test(botUsername)) {
    throw new Error('GATEKEEPER_BOT_USERNAME must be a valid Telegram bot username');
  }

  const botToken = required(env, 'GATEKEEPER_BOT_TOKEN');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error('GATEKEEPER_BOT_TOKEN has an invalid format');
  const targetChatId = required(env, 'GATEKEEPER_TARGET_CHAT_ID');
  if (!/^-\d+$/.test(targetChatId)) throw new Error('GATEKEEPER_TARGET_CHAT_ID must be a numeric group, supergroup, or channel id');
  const telegramWebhookSecret = required(env, 'GATEKEEPER_TELEGRAM_WEBHOOK_SECRET');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(telegramWebhookSecret)) {
    throw new Error('GATEKEEPER_TELEGRAM_WEBHOOK_SECRET contains unsupported characters');
  }
  const tributeApiKey = required(env, 'GATEKEEPER_TRIBUTE_API_KEY');
  const tributeSubscriptionIds = parseTributeSubscriptionIds(env);
  const tributeChannelId = String(env.GATEKEEPER_TRIBUTE_CHANNEL_ID || '').trim();
  const normalizedTributeChannelId = tributeChannelId
    ? parsePositiveIntegerId(tributeChannelId, 'GATEKEEPER_TRIBUTE_CHANNEL_ID')
    : '';
  const linkSigningSecret = required(env, 'GATEKEEPER_LINK_SIGNING_SECRET');
  if (linkSigningSecret.length < 32) throw new Error('GATEKEEPER_LINK_SIGNING_SECRET must be at least 32 characters');
  const siteEnabled = parseBoolean(env, 'GATEKEEPER_SITE_ENABLED');
  const siteWebhookSecret = optionalBoundedSecret(env, 'GATEKEEPER_SITE_WEBHOOK_SECRET', {
    min: siteEnabled ? 32 : 1,
    max: 256,
  });
  if (siteEnabled && !siteWebhookSecret) {
    throw new Error('GATEKEEPER_SITE_WEBHOOK_SECRET is required when GATEKEEPER_SITE_ENABLED=true');
  }
  const publicBaseUrl = sitePublicBaseUrl(env, { enabled: siteEnabled });
  const zapierEnabled = parseBoolean(env, 'GATEKEEPER_ZAPIER_ENABLED');
  const zapierSiteInviteUrl = zapierUrl(env, 'GATEKEEPER_ZAPIER_SITE_INVITE_URL', {
    enabled: zapierEnabled,
  });
  const zapierCompletionUrl = zapierUrl(env, 'GATEKEEPER_ZAPIER_COMPLETION_URL', {
    enabled: zapierEnabled,
  });
  const zapierAuthToken = optionalBoundedSecret(env, 'GATEKEEPER_ZAPIER_AUTH_TOKEN');
  const adminSettingsToken = optionalBoundedSecret(env, 'GATEKEEPER_ADMIN_SETTINGS_TOKEN', {
    min: 32,
    max: 256,
  });
  return {
    botToken,
    botUsername,
    targetChatId,
    telegramWebhookSecret,
    tributeApiKey,
    tributeSubscriptionIds,
    tributeChannelId: normalizedTributeChannelId,
    linkSigningSecret,
    port: parseInteger(env, 'GATEKEEPER_PORT', 8787, { max: 65_535 }),
    dataRoot,
    databasePath,
    scenarioPath: DEFAULT_SCENARIO_PATH,
    startTokenTtlSeconds: parseInteger(env, 'GATEKEEPER_START_TOKEN_TTL_SECONDS', 7 * 24 * 60 * 60),
    publicBaseUrl,
    siteEnabled,
    siteWebhookSecret,
    siteTokenTtlSeconds: parseInteger(env, 'GATEKEEPER_SITE_TOKEN_TTL_SECONDS', 7 * 24 * 60 * 60, {
      min: 5 * 60,
      max: 30 * 24 * 60 * 60,
    }),
    zapierEnabled,
    zapierSiteInviteUrl,
    zapierCompletionUrl,
    zapierAuthToken,
    adminSettingsToken,
    zapierTimeoutMs: parseInteger(env, 'GATEKEEPER_ZAPIER_TIMEOUT_MS', 10_000, {
      min: 1_000,
      max: 30_000,
    }),
  };
}
