import { dirname, relative, resolve, sep } from 'node:path';
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

const ANALYZER_MODES = new Set(['off', 'observe', 'dispatch']);

/**
 * Анализатор запроса. Умолчание — `off`: выкат не меняет ни одного боевого
 * чата, пока чат не назван явно.
 *
 * `observe` — вердикт считается и журналируется, поведение не меняется ни на
 * символ. `dispatch` (этап Ф4) — в чатах из списка домен и форму ответа задаёт
 * вердикт анализатора вместо отдельного вызова модельного роутера; чаты вне
 * списка идут прежним путём байт-в-байт. Пер-чатный гейт — ступень 1
 * инфраструктурной лестницы: поведение включается адресно, а не флагом на всех.
 *
 * Пустой список чатов при включённом режиме — ошибка старта, а не «включить
 * везде». Разница между «ведём тестовый чат» и «ведём все чаты клиентов»
 * слишком велика, чтобы возникать из забытой переменной.
 */
function analyzerConfig(env, cwd) {
  const mode = String(env.TELEGRAM_RUNTIME_ANALYZER_MODE || 'off').trim().toLowerCase();
  if (!ANALYZER_MODES.has(mode)) {
    throw new Error(`TELEGRAM_RUNTIME_ANALYZER_MODE must be one of ${[...ANALYZER_MODES].join(', ')}`);
  }
  const chatIds = csv(env, 'TELEGRAM_RUNTIME_ANALYZER_CHAT_IDS');
  if (mode !== 'off' && chatIds.length === 0) {
    throw new Error('TELEGRAM_RUNTIME_ANALYZER_CHAT_IDS requires at least one chat when the analyzer is enabled');
  }
  const specPath = String(env.TELEGRAM_RUNTIME_ANALYZER_SPEC_PATH || '').trim();
  return {
    mode,
    chatIds,
    specPath: specPath ? resolve(cwd, specPath) : resolve(dirname(new URL(import.meta.url).pathname), 'analyzer-spec.json'),
  };
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

/**
 * A v2 binary package is admitted by package digest, not manifest digest, and
 * its files resolve against the package directory. Both that directory and the
 * manifest itself must sit below the knowledge root, so a configured path can
 * never point the loader at an arbitrary database on the host.
 */
function knowledgePackageAdmission(env, cwd, root, { sourceId, pathName, digestName, defaultPath }) {
  const manifestPath = pathWithin(root, resolve(cwd, String(env[pathName] || defaultPath)), pathName);
  return {
    manifestPath,
    packageRoot: pathWithin(root, dirname(manifestPath), pathName),
    expectedIdentity: {
      sourceId,
      packageDigest: configuredDigest(env, digestName),
    },
  };
}

/**
 * Путь к срезу знания (операционному или value). Пустая/отсутствующая
 * переменная — законная конфигурация: срез просто не подключается, и сервер
 * работает на одном пакете уроков, как до врезки. А вот заданный путь обязан
 * лежать ПОД корнем знаний — тот же гард, что у манифестов: конфигурация не
 * должна уметь показать загрузчику произвольный файл на хосте.
 */
function knowledgeSlicePath(env, cwd, root, name) {
  const raw = String(env[name] || '').trim();
  if (!raw) return null;
  return pathWithin(root, resolve(cwd, raw), name);
}

/**
 * `syntheticBotIds` only survives when synthetic testing is explicitly enabled.
 * A list left behind in a production env file must not silently let a bot talk
 * to the Assistant, so the flag is checked here rather than at the call site.
 */
function roleConfig(env, role, { syntheticTestingEnabled = false } = {}) {
  const prefix = `TELEGRAM_RUNTIME_${role}`;
  const syntheticBotIds = csv(env, `${prefix}_SYNTHETIC_BOT_IDS`);
  if (syntheticBotIds.length && !syntheticTestingEnabled) {
    throw new Error(`${prefix}_SYNTHETIC_BOT_IDS requires TELEGRAM_RUNTIME_SYNTHETIC_TESTING_ENABLED=true`);
  }
  return {
    chatIds: csv(env, `${prefix}_CHAT_IDS`),
    botToken: String(env[`${prefix}_BOT_TOKEN`] || ''),
    botUsername: String(env[`${prefix}_BOT_USERNAME`] || '').replace(/^@/, ''),
    webhookSecret: optionalSecret(env, `${prefix}_WEBHOOK_SECRET`),
    exemptBotIds: csv(env, `${prefix}_EXEMPT_BOT_IDS`),
    syntheticBotIds,
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
  const syntheticTestingEnabled = boolean(env, 'TELEGRAM_RUNTIME_SYNTHETIC_TESTING_ENABLED', false);
  const moderator = roleConfig(env, 'MODERATOR', { syntheticTestingEnabled });
  const assistant = roleConfig(env, 'ASSISTANT', { syntheticTestingEnabled });
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
    throw new Error(`an enabled provider requires the explicit OpenAI safety configuration (${validatedProvider.code})`);
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
        [ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE]: knowledgePackageAdmission(env, cwd, knowledgeRoot, {
          sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE,
          pathName: 'TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGE_MANIFEST_PATH',
          digestName: 'TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGE_DIGEST_SHA256',
          defaultPath: 'data/knowledge/package/knowledge.manifest.json',
        }),
      },
      // Срезы подменяют ровно свой источник поверх пакета уроков: org —
      // операционный (оплата, запись, доступ), value — пользу для роли. У них
      // нет ни digest, ни манифеста: срез мал, читается целиком и проверяется
      // собственной схемой при допуске, поэтому здесь только путь.
      slices: {
        orgPath: knowledgeSlicePath(env, cwd, knowledgeRoot, 'TELEGRAM_RUNTIME_KNOWLEDGE_ORG_SLICE_PATH'),
        valuePath: knowledgeSlicePath(env, cwd, knowledgeRoot, 'TELEGRAM_RUNTIME_KNOWLEDGE_VALUE_SLICE_PATH'),
      },
    },
    ingressEnabled,
    moderationMode,
    // The published Telegram safety policy treats real URLs as a hard spam
    // signal. @mentions are excluded by the core detector, so this default does
    // not turn normal conversation into a link violation.
    moderationBanLinks: boolean(env, 'TELEGRAM_RUNTIME_MODERATION_BAN_LINKS', true),
    // Preserve the deployed Moderator's safe default: only Telegram's automatic
    // pin of an auto-forwarded channel post is removed; manual pins are never
    // touched. The action remains behind the Moderator guard-rights check.
    moderationAntichannelPin: boolean(env, 'TELEGRAM_RUNTIME_MODERATION_ANTICHANNELPIN', true),
    // Recovery owns only a private Moderator comment snapshot and may repeat a
    // judgement solely after a ProviderUnavailableError proves no request was
    // issued. Calling/manual-review rows are never eligible for this worker.
    moderatorRecoveryIntervalSec: integer(env, 'TELEGRAM_RUNTIME_MODERATOR_RECOVERY_INTERVAL_SEC', 60, { min: 5, max: 3_600 }),
    moderatorRecoveryBatchSize: integer(env, 'TELEGRAM_RUNTIME_MODERATOR_RECOVERY_BATCH_SIZE', 10, { min: 1, max: 50 }),
    moderatorRecoveryLeaseSec: integer(env, 'TELEGRAM_RUNTIME_MODERATOR_RECOVERY_LEASE_SEC', 90, { min: 5, max: 900 }),
    moderatorRecoveryMaxSafeRetries: integer(env, 'TELEGRAM_RUNTIME_MODERATOR_RECOVERY_MAX_SAFE_RETRIES', 3, { min: 1, max: 10 }),
    moderatorRecoveryBackoffSec: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_MODERATOR_RECOVERY_BACKOFF_SEC', 60, 3_600),
    moderatorRecoverySnapshotTtlSec: integer(env, 'TELEGRAM_RUNTIME_MODERATOR_RECOVERY_SNAPSHOT_TTL_SEC', 604_800, { min: 60, max: 2_592_000 }),
    assistantModerationWaitMs: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_MODERATION_WAIT_MS', 30_000),
    assistantModerationPollMs: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_MODERATION_POLL_MS', 50, 5_000),
    // No course snapshot is admitted during the project split. This explicit
    // opt-in prevents a configured provider from treating an absent/unreviewed
    // source as permission to answer from general knowledge.
    assistantKnowledgeEnabled: boolean(env, 'TELEGRAM_RUNTIME_ASSISTANT_KNOWLEDGE_ENABLED', false),
    // The retriever over the admitted v2 content package. Off by default like
    // every other knowledge switch: enabling it is a cutover decision, not a
    // deployment side effect.
    assistantRetrieval: {
      enabled: boolean(env, 'TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_ENABLED', false),
      maxContextTokens: integer(env, 'TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_MAX_CONTEXT_TOKENS', 6_000, { min: 500, max: 60_000 }),
      // The provider hard-caps at 128; this is the working default the gold set
      // was measured with, and it may be raised up to that ceiling.
      maxEntries: integer(env, 'TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_MAX_ENTRIES', 12, { min: 1, max: 128 }),
      // Input-layer step 5. Off by default: it is one extra model call per
      // ungrounded question, so switching it on is a cost decision.
      rewriteEnabled: boolean(env, 'TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_REWRITE_ENABLED', false),
      // Contract self-check, on by default; the switch exists so an operator can
      // drop it without a code change if it ever becomes a latency problem.
      validatePacks: boolean(env, 'TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_VALIDATE_PACKS', true),
      rewrite: {
        model: String(env.TELEGRAM_RUNTIME_REWRITE_MODEL || ''),
        reasoningEffort: String(env.TELEGRAM_RUNTIME_REWRITE_REASONING_EFFORT || 'minimal'),
      },
    },
    assistantCooldownSec: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_COOLDOWN_SEC', 20, 86_400),
    assistantDailyPerUser: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_DAILY_PER_USER', 20, 10_000),
    assistantDialogueTtlSec: nonNegativeInteger(env, 'TELEGRAM_RUNTIME_ASSISTANT_DIALOGUE_TTL_SEC', 604_800, 31_536_000),
    assistantDialogueTurnLimit: integer(env, 'TELEGRAM_RUNTIME_ASSISTANT_DIALOGUE_TURN_LIMIT', 3, { min: 1, max: 100 }),
    analyzer: analyzerConfig(env, cwd),
    syntheticTestingEnabled,
    moderator,
    assistant,
    provider: provider.enabled ? validatedProvider.config : provider,
    notification: { enabled: boolean(env, 'TELEGRAM_RUNTIME_NOTIFICATIONS_ENABLED', false) },
    startupPlan: Object.freeze({ setCommands: false, registerWebhook: false, deleteWebhook: false, poll: false }),
  };
}
