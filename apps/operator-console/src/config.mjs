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

export function loadOperatorConsoleConfig(env = process.env, { cwd = process.cwd() } = {}) {
  return Object.freeze({
    port: port(env),
    bindHost: boolean(env, 'OPERATOR_CONSOLE_CONTAINER_BIND', false) ? '0.0.0.0' : '127.0.0.1',
    token: optionalToken(env),
    runtimeDatabasePath: resolve(cwd, String(
      env.OPERATOR_CONSOLE_RUNTIME_DATABASE_PATH || 'data/telegram-runtime/telegram-runtime.sqlite',
    )),
    gatekeeperDatabasePath: resolve(cwd, String(
      env.OPERATOR_CONSOLE_GATEKEEPER_DATABASE_PATH || 'data/gatekeeper/gatekeeper.sqlite',
    )),
    runtimeFlags: Object.freeze({
      ingressEnabled: boolean(env, 'TELEGRAM_RUNTIME_INGRESS_ENABLED', false),
      moderationMode: String(env.TELEGRAM_RUNTIME_MODERATION_MODE || 'shadow') === 'live' ? 'live' : 'shadow',
      providerEnabled: boolean(env, 'TELEGRAM_RUNTIME_PROVIDER_ENABLED', false),
      notificationsEnabled: boolean(env, 'TELEGRAM_RUNTIME_NOTIFICATIONS_ENABLED', false),
    }),
    gatekeeperFlags: Object.freeze({
      scenarioReady: boolean(env, 'GATEKEEPER_SCENARIO_READY', false),
      siteEnabled: boolean(env, 'GATEKEEPER_SITE_ENABLED', false),
      zapierEnabled: boolean(env, 'GATEKEEPER_ZAPIER_ENABLED', false),
    }),
  });
}
