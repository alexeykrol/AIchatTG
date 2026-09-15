import { resolve } from 'node:path';

function boolean(env, name, fallback = false) {
  if (!Object.hasOwn(env, name) || env[name] === '') return fallback;
  const value = String(env[name]).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function port(env) {
  const value = Number.parseInt(String(env.OPERATOR_CONSOLE_PORT || '8790'), 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error('OPERATOR_CONSOLE_PORT must be an integer between 1 and 65535');
  }
  return value;
}

function optionalToken(env) {
  const token = String(env.AICHATTG_OPERATOR_TOKEN || '');
  if (!token) return '';
  if (token.length > 512 || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error('AICHATTG_OPERATOR_TOKEN must be at most 512 printable characters');
  }
  return token;
}

function nonNegativeInteger(env, name, fallback) {
  const raw = Object.hasOwn(env, name) && env[name] !== '' ? env[name] : fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function csv(env, name) {
  return String(env[name] || '').split(',').map((value) => value.trim()).filter(Boolean);
}

function releaseTimestamp(env) {
  const value = String(env.OPERATOR_CONSOLE_RELEASED_AT || '').trim();
  if (!value) {
    if (env.NODE_ENV === 'production') {
      throw new Error('OPERATOR_CONSOLE_RELEASED_AT is required in production');
    }
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString().replace('.000Z', 'Z') !== value) {
    throw new Error('OPERATOR_CONSOLE_RELEASED_AT must be an exact UTC timestamp');
  }
  return value;
}

export function loadOperatorConsoleConfig(env = process.env, { cwd = process.cwd() } = {}) {
  return Object.freeze({
    port: port(env),
    bindHost: boolean(env, 'OPERATOR_CONSOLE_CONTAINER_BIND', false) ? '0.0.0.0' : '127.0.0.1',
    token: optionalToken(env),
    releasedAt: releaseTimestamp(env),
    runtimeDatabasePath: resolve(cwd, String(
      env.OPERATOR_CONSOLE_RUNTIME_DATABASE_PATH || 'data/telegram-runtime/telegram-runtime.sqlite',
    )),
    domainIndexPath: resolve(cwd, String(
      env.OPERATOR_CONSOLE_DOMAIN_INDEX_PATH || 'apps/telegram-runtime/src/domains/INDEX.md',
    )),
    candidateRoot: String(env.OPERATOR_CONSOLE_CANDIDATE_ROOT || '').trim()
      ? resolve(cwd, String(env.OPERATOR_CONSOLE_CANDIDATE_ROOT).trim()) : null,
    safetyPromptPath: resolve(cwd, String(
      env.OPERATOR_CONSOLE_SAFETY_PROMPT_PATH
        || 'apps/telegram-runtime/src/safety-artifacts/moderation-tg-v3.md',
    )),
    runtimeFlags: Object.freeze({
      ingressEnabled: boolean(env, 'TELEGRAM_RUNTIME_INGRESS_ENABLED', false),
      moderationMode: String(env.TELEGRAM_RUNTIME_MODERATION_MODE || 'shadow') === 'live' ? 'live' : 'shadow',
      providerEnabled: boolean(env, 'TELEGRAM_RUNTIME_PROVIDER_ENABLED', false),
      notificationsEnabled: boolean(env, 'TELEGRAM_RUNTIME_NOTIFICATIONS_ENABLED', false),
    }),
    runtimeModels: Object.freeze({
      vendor: String(env.TELEGRAM_RUNTIME_PROVIDER_VENDOR || 'openai'),
      moderator: String(env.TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_MODEL || 'gpt-5.6-terra'),
      moderatorReasoning: String(env.TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_REASONING_EFFORT || 'medium'),
      router: String(env.TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MODEL || ''),
      answer: String(env.TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MODEL || ''),
      routerReasoning: String(env.TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_REASONING_EFFORT || ''),
      answerReasoning: String(env.TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_REASONING_EFFORT || ''),
      answerMaxTokens: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MAX_OUTPUT_TOKENS', 2000),
    }),
    assistantPolicy: Object.freeze({
      cooldownSec: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_COOLDOWN_SEC', 20),
      dailyPerUser: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_DAILY_PER_USER', 20),
      syntheticDailyPerUser: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_SYNTHETIC_DAILY_PER_USER', 200),
      dialogueTurnLimit: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_DIALOGUE_TURN_LIMIT', 3),
      chatIds: csv(env, 'TELEGRAM_RUNTIME_ASSISTANT_CHAT_IDS'),
      knowledgeEnabled: boolean(env, 'TELEGRAM_RUNTIME_ASSISTANT_KNOWLEDGE_ENABLED', false),
    }),
  });
}
