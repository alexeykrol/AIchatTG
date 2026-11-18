import path from 'node:path';
import { DEFAULT_SCENARIO_PATH, loadScenario } from './scenario.mjs';

const PREFIX = 'JOIN_GATEKEEPER_';

function required(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(env, name) {
  return String(env[name] ?? '').trim();
}

function parseInteger(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = optional(env, name) || String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseBoolean(env, name, fallback = false) {
  const raw = optional(env, name).toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export function parseBotToken(env) {
  const botToken = required(env, `${PREFIX}BOT_TOKEN`);
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error(`${PREFIX}BOT_TOKEN has an invalid format`);
  return botToken;
}

// Optional public group link appended to the token welcome DM (contract v2 §1).
export function parseGroupLink(env) {
  const name = `${PREFIX}GROUP_LINK`;
  const raw = optional(env, name);
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an https://t.me/... URL`);
  }
  if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.username || url.password || url.hash
    || url.pathname.length < 2) {
    throw new Error(`${name} must be an https://t.me/... URL`);
  }
  return url.href;
}

export function parseTargetChatIds(env) {
  const name = `${PREFIX}TARGET_CHAT_IDS`;
  const raw = required(env, name);
  const ids = raw.split(',').map((value) => value.trim());
  for (const id of ids) {
    if (!/^-\d{1,20}$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new Error(`${name} must be a comma-separated list of negative numeric chat ids`);
    }
  }
  if (new Set(ids).size !== ids.length) throw new Error(`${name} must not contain duplicates`);
  return Object.freeze(ids);
}

export function resolveDataPaths(env) {
  const rootRaw = required(env, `${PREFIX}DATA_ROOT`);
  const dataRoot = path.resolve(rootRaw);
  const dbRaw = optional(env, `${PREFIX}DATABASE_PATH`) || 'join-gatekeeper.sqlite';
  if (dbRaw.split(/[\\/]+/).includes('..')) {
    throw new Error(`${PREFIX}DATABASE_PATH must not contain '..' segments`);
  }
  const databasePath = path.resolve(dataRoot, dbRaw);
  const relative = path.relative(dataRoot, databasePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${PREFIX}DATABASE_PATH must resolve to a file inside ${PREFIX}DATA_ROOT`);
  }
  return { dataRoot, databasePath };
}

function parsePublicBaseUrl(env) {
  const name = `${PREFIX}PUBLIC_BASE_URL`;
  const raw = optional(env, name);
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid https URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an https URL without credentials, query or fragment`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function loadConfig(env = process.env, { loadScenarioImpl = loadScenario } = {}) {
  const botToken = parseBotToken(env);
  const targetChatIds = parseTargetChatIds(env);
  const webhookSecret = required(env, `${PREFIX}WEBHOOK_SECRET`);
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
    throw new Error(`${PREFIX}WEBHOOK_SECRET must be 16-256 characters of [A-Za-z0-9_-]`);
  }
  const mode = optional(env, `${PREFIX}MODE`) || 'shadow';
  if (!['shadow', 'enforce'].includes(mode)) throw new Error(`${PREFIX}MODE must be shadow or enforce`);
  const { dataRoot, databasePath } = resolveDataPaths(env);
  const scenarioPath = optional(env, `${PREFIX}SCENARIO_PATH`) || DEFAULT_SCENARIO_PATH;
  const scenario = loadScenarioImpl(scenarioPath);
  if (mode === 'enforce' && scenario.status !== 'ready') {
    throw new Error(`${PREFIX}MODE=enforce requires a ready scenario (current status: ${scenario.status})`);
  }
  return Object.freeze({
    botToken,
    targetChatIds,
    webhookSecret,
    mode,
    port: parseInteger(env, `${PREFIX}PORT`, 8788, { max: 65_535 }),
    bindHost: parseBoolean(env, `${PREFIX}CONTAINER_BIND`) ? '0.0.0.0' : '127.0.0.1',
    dataRoot,
    databasePath,
    publicBaseUrl: parsePublicBaseUrl(env),
    groupLink: parseGroupLink(env),
    scenarioPath,
    scenario,
  });
}

// Operator CLIs (tokens, triage) need only the database path: no bot token,
// no webhook secret (contract v2 §1).
export function loadDataConfig(env = process.env) {
  return resolveDataPaths(env);
}

// triage execute --confirm: bot token + allowlist + data paths + scenario
// (probationDays). Does not require the webhook secret or an enforce-mode
// scenario: triage sends no DMs, and each run is gated by --confirm and the
// list hash approved by the Product Owner.
export function loadTriageConfig(env = process.env, { loadScenarioImpl = loadScenario } = {}) {
  const scenarioPath = optional(env, `${PREFIX}SCENARIO_PATH`) || DEFAULT_SCENARIO_PATH;
  return Object.freeze({
    botToken: parseBotToken(env),
    targetChatIds: parseTargetChatIds(env),
    ...resolveDataPaths(env),
    scenario: loadScenarioImpl(scenarioPath),
  });
}
