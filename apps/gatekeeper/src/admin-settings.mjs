const SECRET_KEY_PATTERN = /(secret|token|api.?key|password|credential|signature)/iu;
const SAFE_URL_PATH_SEGMENTS = new Set(['api', 'catch', 'hook', 'hooks', 'webhook', 'webhooks']);

const MUTABLE_SETTINGS = Object.freeze({
  startTokenTtlSeconds: Object.freeze({
    env: 'GATEKEEPER_START_TOKEN_TTL_SECONDS',
    min: 300,
    max: 2_592_000,
    fallback: 604_800,
  }),
  siteTokenTtlSeconds: Object.freeze({
    env: 'GATEKEEPER_SITE_TOKEN_TTL_SECONDS',
    min: 300,
    max: 2_592_000,
    fallback: 604_800,
  }),
});

const PLANNED_RULES = Object.freeze({
  correlationWindowSeconds: Object.freeze({
    env: 'GATEKEEPER_CORRELATION_WINDOW_SECONDS',
    min: 60,
    max: 604_800,
  }),
  retryMaxAttempts: Object.freeze({
    env: 'GATEKEEPER_RETRY_MAX_ATTEMPTS',
    min: 1,
    max: 10,
  }),
  retryBaseSeconds: Object.freeze({
    env: 'GATEKEEPER_RETRY_BASE_SECONDS',
    min: 1,
    max: 3_600,
  }),
  escalationAfterSeconds: Object.freeze({
    env: 'GATEKEEPER_ESCALATION_AFTER_SECONDS',
    min: 300,
    max: 604_800,
  }),
});

const USER_PATHS = Object.freeze([
  Object.freeze({
    id: 'common',
    title: 'Общие',
    messageIds: Object.freeze([
      'start_missing_token',
      'start_invalid_token',
      'start_expired_token',
      'email_invalid',
    ]),
  }),
  Object.freeze({
    id: 'tribute_telegram',
    title: 'Tribute + Telegram',
    messageIds: Object.freeze([
      'group_invitation',
      'start_payment_not_confirmed',
      'start_already_completed',
      'private_instruction',
      'email_accepted',
      'tribute_confirmation_retry',
    ]),
  }),
  Object.freeze({
    id: 'site_email',
    title: 'Сайт + email',
    messageIds: Object.freeze([
      'site_email_instruction',
      'site_instruction',
      'site_invalid_link',
    ]),
  }),
  Object.freeze({
    id: 'site_telegram',
    title: 'Сайт + Telegram',
    messageIds: Object.freeze([
      'non_tribute_private_instruction',
    ]),
  }),
  Object.freeze({
    id: 'completion_zapier',
    title: 'Завершение / Zapier',
    messageIds: Object.freeze([
      'completion_invalid_user',
      'completion_before_start',
      'completion_before_email',
      'completion_already_completed',
      'completion_success',
      'site_completion_success',
      'site_completion_already_completed',
      'post_confirmation_check',
    ]),
  }),
  Object.freeze({
    id: 'errors_admin',
    title: 'Ошибки / администратор',
    messageIds: Object.freeze([
      'activation_escalation_admin',
      'confirmation_escalation_admin',
      'support_handoff',
      'question_router_clarification',
      'local_dialog_boundary',
    ]),
  }),
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isConfigured(...values) {
  return values.every((value) => {
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === 'number' ? Number.isFinite(value) : Boolean(String(value || '').trim());
  });
}

function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function firstValue(source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return undefined;
}

function readRuleValue(config, env, key) {
  const definition = MUTABLE_SETTINGS[key];
  const candidate = firstValue(config, [key]) ?? env[definition.env] ?? definition.fallback;
  const parsed = typeof candidate === 'number' ? candidate : Number.parseInt(String(candidate), 10);
  return Number.isSafeInteger(parsed) && parsed >= definition.min && parsed <= definition.max
    ? parsed
    : definition.fallback;
}

function configuredState(configured, detail = null) {
  return detail
    ? { configured: Boolean(configured), detail }
    : { configured: Boolean(configured) };
}

function collectMessageCoverage(scenario, messageIds) {
  const messages = scenario?.messages && typeof scenario.messages === 'object'
    ? scenario.messages
    : {};
  let active = 0;
  let planned = 0;
  for (const id of messageIds) {
    if (messages[id]?.status === 'active') active += 1;
    if (messages[id]?.status === 'planned') planned += 1;
  }
  return { active, planned, total: active + planned };
}

function summarizedDelivery(delivery) {
  const allowedStates = ['none', 'intent', 'sent', 'failed', 'inconclusive'];
  const totals = Object.fromEntries(allowedStates.map((state) => [state, 0]));
  if (!Array.isArray(delivery)) return totals;
  for (const row of delivery) {
    if (allowedStates.includes(row?.state)) totals[row.state] += safeCount(row.count);
  }
  return totals;
}

/**
 * Return only a destination summary. Credentials, query parameters and webhook
 * identifiers are deliberately never preserved in the returned string.
 */
export function maskDestinationUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const url = new URL(rawUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    const firstSegment = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    const path = SAFE_URL_PATH_SEGMENTS.has(firstSegment) ? `/${firstSegment}/…` : '/…';
    return `${host}${path}`;
  } catch {
    return null;
  }
}

/**
 * Builds the complete admin-page contract without copying config or store rows.
 * This function must remain the only boundary between runtime state and the UI.
 */
export function buildAdminSettingsSnapshot({
  config = {},
  scenario = {},
  storeSummary = {},
  env = {},
} = {}) {
  const onboarding = storeSummary?.onboarding || {};
  const uncertainInvitationCount = Array.isArray(storeSummary?.uncertain_invitations)
    ? storeSummary.uncertain_invitations.length
    : safeCount(storeSummary?.uncertainInvitationCount);
  const uncertainUpdateCount = Array.isArray(storeSummary?.uncertain_updates)
    ? storeSummary.uncertain_updates.length
    : safeCount(storeSummary?.uncertainUpdateCount);
  const uncertainZapierCount = Array.isArray(storeSummary?.uncertain_zapier_deliveries)
    ? storeSummary.uncertain_zapier_deliveries.length
    : safeCount(storeSummary?.uncertainZapierCount);

  const siteSecret = config.siteWebhookSecret;
  const zapierEmailUrl = config.zapierSiteInviteUrl;
  const zapierCompletionUrl = config.zapierCompletionUrl;

  const snapshot = {
    schemaVersion: 1,
    readOnly: true,
    title: 'Привратник',
    sections: ['overview', 'sources', 'user_paths', 'delivery', 'rules', 'events_test'],
    overview: {
      scenarioStatus: ['draft', 'ready'].includes(scenario?.status) ? scenario.status : 'unknown',
      onboarding: {
        pending: safeCount(onboarding.pending),
        contactEstablished: safeCount(onboarding.contact_established),
        completed: safeCount(onboarding.completed),
      },
      siteOnboarding: {
        pending: safeCount(storeSummary?.site_onboarding?.pending),
        completed: safeCount(storeSummary?.site_onboarding?.completed),
      },
      attentionRequired: uncertainInvitationCount + uncertainUpdateCount + uncertainZapierCount,
    },
    sources: {
      tribute: configuredState(isConfigured(config.tributeApiKey, config.tributeSubscriptionIds)),
      site: configuredState(config.siteEnabled === true && isConfigured(siteSecret)),
      telegram: configuredState(isConfigured(
        config.botToken,
        config.telegramWebhookSecret,
        config.targetChatId,
      )),
      coinbase: { configured: false, planned: true },
    },
    userPaths: USER_PATHS.map((path) => ({
      id: path.id,
      title: path.title,
      ...collectMessageCoverage(scenario, path.messageIds),
    })),
    delivery: {
      telegram: configuredState(isConfigured(config.botToken, config.targetChatId)),
      zapierEmail: configuredState(
        config.zapierEnabled === true && isConfigured(zapierEmailUrl),
        maskDestinationUrl(zapierEmailUrl),
      ),
      zapierCompletion: configuredState(
        config.zapierEnabled === true && isConfigured(zapierCompletionUrl),
        maskDestinationUrl(zapierCompletionUrl),
      ),
      states: summarizedDelivery(storeSummary?.delivery),
    },
    rules: {
      ...Object.fromEntries(Object.entries(MUTABLE_SETTINGS).map(([key, definition]) => [key, {
        status: 'active',
        mutable: true,
        value: readRuleValue(config, env, key),
        env: definition.env,
        min: definition.min,
        max: definition.max,
      }])),
      ...Object.fromEntries(Object.entries(PLANNED_RULES).map(([key, definition]) => [key, {
        status: 'planned',
        mutable: false,
        value: null,
        env: definition.env,
        min: definition.min,
        max: definition.max,
      }])),
    },
    eventsTest: {
      uncertainInvitations: uncertainInvitationCount,
      uncertainUpdates: uncertainUpdateCount,
      uncertainZapierDeliveries: uncertainZapierCount,
      simulation: 'offline_only',
      liveSendAvailable: false,
    },
  };
  return deepFreeze(snapshot);
}

/**
 * Validate future non-secret writes. The current admin page is read-only; a
 * caller must still persist accepted values through a separate runtime path.
 */
export function validateAdminSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('settings patch must be an object');
  }
  const prototype = Object.getPrototypeOf(patch);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('settings patch must be a plain object');
  }

  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    const definition = MUTABLE_SETTINGS[key];
    if (!definition && SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`${key} is a runtime-only secret and cannot be changed here`);
    }
    if (!definition) throw new Error(`${key} is not an editable Gatekeeper setting`);
    if (!Number.isSafeInteger(value) || value < definition.min || value > definition.max) {
      throw new Error(`${key} must be an integer between ${definition.min} and ${definition.max}`);
    }
    result[key] = value;
  }
  return deepFreeze(result);
}

export const ADMIN_MUTABLE_SETTINGS = MUTABLE_SETTINGS;
