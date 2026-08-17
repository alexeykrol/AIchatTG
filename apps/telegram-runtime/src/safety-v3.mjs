import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// These are code-owned safety invariants inherited from the deployed Moderator
// policy. Environment configuration can enable the provider transport, but it
// cannot select a different judge model, vendor, effort, or stage token budget.
export const SAFETY_MODEL = 'gpt-5.6-terra';
export const SAFETY_VENDOR = 'openai';
export const SAFETY_REASONING_EFFORT = 'medium';
export const SAFETY_POLICY_VERSION = 'telegram-safety-v1';
export const SAFETY_ROUTER_MAX_OUTPUT_TOKENS = 1024;
export const SAFETY_ABUSE_MAX_OUTPUT_TOKENS = 768;

export const THREAT_TYPES = Object.freeze([
  'prompt_extraction', 'role_reprogramming', 'runtime_access', 'payment_data',
  'credentials', 'user_data', 'authorization_pretext', 'technical_injection',
  'resource_exhaustion', 'spam_or_scam', 'interpersonal_threat', 'incitement',
]);
export const ABUSE_TYPES = Object.freeze([
  'targeted_insult', 'harassment', 'hate_or_dehumanization', 'sexual_harassment',
  'targeted_malicious_accusation', 'targeted_provocation', 'warning_dispute',
]);
export const SAFETY_TARGETS = Object.freeze([
  'assistant', 'author', 'participant', 'group', 'protected_group', 'public', 'none',
]);
export const ABUSE_SEVERITIES = Object.freeze(['weak', 'strong']);
export const ABUSE_BASES = Object.freeze([
  'isolated_disrespect', 'isolated_harassment', 'targeted_provocation',
  'warning_dispute', 'repeated_harassment', 'dehumanizing_attack',
  'sexual_harassment', 'malicious_accusation', 'severe_personal_degradation',
]);

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET_SET = new Set(SAFETY_TARGETS);
const ABUSE_SEVERITY_SET = new Set(ABUSE_SEVERITIES);
const ABUSE_BASIS_SET = new Set(ABUSE_BASES);
const WEAK_ABUSE_BASES = new Set([
  'isolated_disrespect', 'isolated_harassment', 'targeted_provocation',
  'warning_dispute', 'sexual_harassment',
]);
const STRONG_ABUSE_BASES = new Set([
  'repeated_harassment', 'dehumanizing_attack', 'sexual_harassment',
  'malicious_accusation', 'severe_personal_degradation',
]);
const ABUSE_BASIS_TYPES = Object.freeze({
  isolated_disrespect: new Set(['targeted_insult']),
  isolated_harassment: new Set(['harassment']),
  targeted_provocation: new Set(['targeted_provocation']),
  warning_dispute: new Set(['warning_dispute']),
  repeated_harassment: new Set(['harassment']),
  dehumanizing_attack: new Set(['hate_or_dehumanization']),
  sexual_harassment: new Set(['sexual_harassment']),
  malicious_accusation: new Set(['targeted_malicious_accusation']),
  severe_personal_degradation: new Set([
    'targeted_insult', 'harassment', 'hate_or_dehumanization', 'sexual_harassment',
  ]),
});

const artifactCache = new Map();
function artifact(name) {
  if (!artifactCache.has(name)) {
    artifactCache.set(name, readFileSync(join(MODULE_DIR, 'safety-artifacts', name), 'utf8').trim());
  }
  return artifactCache.get(name);
}

export function buildSafetyRouterSystem() {
  return [
    artifact('moderation-tg-v3.md'),
    '--- THREAT LIBRARY v1 ---', artifact('threat-library-v1.md'),
    '--- ABUSE LIBRARY v1 ---', artifact('abuse-library-v1.md'),
  ].join('\n\n');
}

export function buildAbuseClassifierSystem() {
  return [
    artifact('abuse-classifier-tg-v1.md'),
    '--- ABUSE LIBRARY v1 ---', artifact('abuse-library-v1.md'),
  ].join('\n\n');
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Reject duplicate decoded object keys before JSON.parse silently collapses them. */
export function hasDuplicateJsonObjectKeys(text) {
  if (typeof text !== 'string') return true;
  const stack = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) { index++; continue; }
    if (char === '"') {
      const start = index++;
      let escaped = false;
      while (index < text.length) {
        const next = text[index++];
        if (escaped) escaped = false;
        else if (next === '\\') escaped = true;
        else if (next === '"') break;
      }
      const frame = stack.at(-1);
      if (frame?.type === 'object' && frame.expectingKey) {
        let key;
        try { key = JSON.parse(text.slice(start, index)); } catch { return true; }
        if (frame.keys.has(key)) return true;
        frame.keys.add(key);
        frame.expectingKey = false;
      }
      continue;
    }
    if (char === '{') stack.push({ type: 'object', keys: new Set(), expectingKey: true });
    else if (char === '[') stack.push({ type: 'array' });
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',') {
      const frame = stack.at(-1);
      if (frame?.type === 'object') frame.expectingKey = true;
    }
    index++;
  }
  return false;
}

function strictJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text.startsWith('{') || !text.endsWith('}') || hasDuplicateJsonObjectKeys(text)) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function confidence(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1; }

function evidence(value, message) {
  if (!Array.isArray(value) || value.length > 3) return null;
  if (value.some((span) => typeof span !== 'string' || !span.trim() || span.length > 240)) return null;
  if (value.some((span) => !message.includes(span))) return null;
  return [...value];
}

function verdictMatch(value, typeOrder, message) {
  if (!exactKeys(value, ['match', 'types', 'confidence', 'evidence'])) return null;
  if (typeof value.match !== 'boolean' || !confidence(value.confidence)) return null;
  const allowed = new Set(typeOrder);
  if (!Array.isArray(value.types) || value.types.some((item) => !allowed.has(item))) return null;
  if (new Set(value.types).size !== value.types.length || value.match !== (value.types.length > 0)) return null;
  const spans = evidence(value.evidence, message);
  if (!spans || value.match !== (spans.length > 0)) return null;
  const selected = new Set(value.types);
  return { match: value.match, types: typeOrder.filter((item) => selected.has(item)), confidence: value.confidence, evidence: spans };
}

export function parseSafetyRouterVerdict(raw, message) {
  if (typeof message !== 'string') return null;
  const parsed = strictJsonObject(raw);
  if (!exactKeys(parsed, ['threat', 'abuse', 'target', 'context_used'])) return null;
  const threat = verdictMatch(parsed.threat, THREAT_TYPES, message);
  const abuse = verdictMatch(parsed.abuse, ABUSE_TYPES, message);
  if (!threat || !abuse || !TARGET_SET.has(parsed.target) || typeof parsed.context_used !== 'boolean') return null;
  if ((threat.match || abuse.match) === (parsed.target === 'none')) return null;
  if (threat.match && abuse.match && threat.evidence.some((threatSpan) => abuse.evidence.some(
    (abuseSpan) => threatSpan.includes(abuseSpan) || abuseSpan.includes(threatSpan),
  ))) return null;
  return { threat, abuse, target: parsed.target, context_used: parsed.context_used };
}

export function parseAbuseSeverityVerdict(raw) {
  const parsed = strictJsonObject(raw);
  if (!exactKeys(parsed, ['severity', 'confidence', 'basis']) || !ABUSE_SEVERITY_SET.has(parsed.severity)
    || !confidence(parsed.confidence) || !ABUSE_BASIS_SET.has(parsed.basis)) return null;
  if (parsed.severity === 'weak' && !WEAK_ABUSE_BASES.has(parsed.basis)) return null;
  if (parsed.severity === 'strong' && !STRONG_ABUSE_BASES.has(parsed.basis)) return null;
  return { severity: parsed.severity, confidence: parsed.confidence, basis: parsed.basis };
}

function boundedInteger(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0;
}

/** Only code-owned warning state is supplied to a model; raw history is never admitted. */
export function normalizeSafetyContext(context = {}) {
  const weakStrikes = boundedInteger(context.currentWeakStrikes ?? context.weakStrikes ?? context.weak_strikes);
  const stage = context.warningStage ?? context.warning_stage;
  const warningStage = ['none', 'first', 'final'].includes(stage)
    ? stage : weakStrikes >= 2 ? 'final' : weakStrikes === 1 ? 'first' : 'none';
  return { weak_strikes: weakStrikes, warning_stage: warningStage };
}

function warningContextAvailable(context) { return context.weak_strikes > 0 && context.warning_stage !== 'none'; }
function safetyRoute(router) { return router.threat.match ? 'threat' : router.abuse.match ? 'abuse' : 'clean'; }
function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }

/**
 * Расход двухступенчатой модерации. Суммируются ТОЛЬКО названные провайдером
 * счётчики; если их не назвал никто, поле остаётся `null`, а не превращается в
 * ноль. Ноль здесь читался бы как «модерация ничего не стоила» — недостача
 * учёта выглядела бы экономией (тот же контракт, что `providerCallUsage`).
 */
function aggregateUsage(results) {
  const sum = (field) => {
    const measured = results
      .map((result) => result?.receipt?.[field])
      .filter((value) => Number.isSafeInteger(value) && value >= 0);
    return measured.length ? measured.reduce((total, value) => total + value, 0) : null;
  };
  return {
    calls: results.length,
    failed: 0,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    costUsd: null,
    modelId: SAFETY_MODEL,
    vendor: SAFETY_VENDOR,
    reasoningEffort: SAFETY_REASONING_EFFORT,
  };
}

export class SafetyV3ContractError extends Error {
  constructor(stage, reason, receipts = []) {
    super(`safety v3 contract rejected (${stage}/${reason})`);
    this.name = 'SafetyV3ContractError';
    this.stage = stage;
    this.reason = reason;
    this.receipts = receipts;
  }
}

function routerPayload(message, context) { return JSON.stringify({ message, context }); }
function abusePayload(message, router, context) {
  return JSON.stringify({
    message,
    router_abuse: {
      types: router.abuse.types, confidence: router.abuse.confidence, target: router.target,
      evidence: router.abuse.evidence, context_used: router.context_used,
    },
    context,
  });
}

function reasonFor(route, router, abuse) {
  if (route === 'threat') return `safety:threat:${router.threat.types.join(',')}`;
  if (route === 'abuse') return `safety:abuse:${abuse.severity}:${router.abuse.types.join(',')}`;
  return 'safety:clean';
}

/**
 * Execute the two-stage deployed Moderator contract through one injected,
 * non-retrying transport. `invoke` receives prebuilt code-owned payloads and
 * must return only `{ text, receipt }`; it does not get a fallback opportunity.
 */
export async function classifySafetyV3({ message, context = {}, invoke }) {
  if (typeof message !== 'string' || !message.trim() || typeof invoke !== 'function') {
    throw new SafetyV3ContractError('router', 'request_invalid');
  }
  const safeContext = normalizeSafetyContext(context);
  const results = [];
  const routerResult = await invoke({
    stage: 'router', system: buildSafetyRouterSystem(), user: routerPayload(message, safeContext),
    maxOutputTokens: SAFETY_ROUTER_MAX_OUTPUT_TOKENS,
  });
  results.push(routerResult);
  const router = parseSafetyRouterVerdict(routerResult?.text, message);
  if (!router) throw new SafetyV3ContractError('router', 'invalid_router_json', results);
  if (router.context_used !== router.abuse.types.includes('warning_dispute')
    || (router.context_used && !warningContextAvailable(safeContext))) {
    throw new SafetyV3ContractError('router', 'invalid_warning_context', results);
  }

  const route = safetyRoute(router);
  let abuse = null;
  if (route === 'abuse') {
    const abuseResult = await invoke({
      stage: 'abuse_classifier', system: buildAbuseClassifierSystem(),
      user: abusePayload(message, router, safeContext), maxOutputTokens: SAFETY_ABUSE_MAX_OUTPUT_TOKENS,
    });
    results.push(abuseResult);
    abuse = parseAbuseSeverityVerdict(abuseResult?.text);
    const allowedBasisTypes = abuse ? ABUSE_BASIS_TYPES[abuse.basis] : null;
    const basisMatchesRouter = Boolean(
      allowedBasisTypes && router.abuse.types.some((type) => allowedBasisTypes.has(type)),
    );
    if (!abuse || (abuse.basis === 'warning_dispute' && !warningContextAvailable(safeContext))
      || !basisMatchesRouter) {
      throw new SafetyV3ContractError('abuse_classifier', 'invalid_abuse_json', results);
    }
  }
  const routerSystem = buildSafetyRouterSystem();
  const abuseSystem = buildAbuseClassifierSystem();
  const usage = aggregateUsage(results);
  const output = {
    safetyRoute: route,
    abuseLevel: abuse?.severity ?? null,
    confidence: route === 'threat' ? router.threat.confidence
      : route === 'abuse' ? Math.min(router.abuse.confidence, abuse.confidence)
        : Math.min(router.threat.confidence, router.abuse.confidence),
    reason: reasonFor(route, router, abuse),
    quote: router.threat.evidence[0] || router.abuse.evidence[0] || '',
    modelId: SAFETY_MODEL,
    policyVersion: SAFETY_POLICY_VERSION,
    safetyTrace: {
      routePriority: ['threat', 'abuse', 'clean'], router, abuseClassifier: abuse,
      artifactSha256: {
        routerSystem: sha256(routerSystem), abuseSystem: sha256(abuseSystem),
        threatLibrary: sha256(artifact('threat-library-v1.md')), abuseLibrary: sha256(artifact('abuse-library-v1.md')),
      },
      usage,
      receipts: results.map((result) => result?.receipt || null),
    },
  };
  return Object.freeze(output);
}
