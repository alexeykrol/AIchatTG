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
export const PORN_SPAM_POLICY_VERSION = 'porn-spam-policy-v1';
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

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
}
function closedObject(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
function matchSchema(types) {
  return closedObject({
    match: { type: 'boolean' },
    types: { type: 'array', items: { type: 'string', enum: [...types] } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 240 } },
  });
}

// The wire schema and local validator share their field and enum definitions.
// Cross-field meaning and verbatim evidence remain code-validated, not delegated
// to Structured Outputs. These are the existing two stages, not extra calls.
export const SAFETY_ROUTER_RESPONSE_FORMAT = deepFreeze({
  type: 'json_schema',
  json_schema: {
    name: 'telegram_safety_router_v1', strict: true,
    schema: closedObject({
      threat: matchSchema(THREAT_TYPES), abuse: matchSchema(ABUSE_TYPES),
      target: { type: 'string', enum: [...SAFETY_TARGETS] }, context_used: { type: 'boolean' },
    }),
  },
});
export const SAFETY_ABUSE_RESPONSE_FORMAT = deepFreeze({
  type: 'json_schema',
  json_schema: {
    name: 'telegram_abuse_severity_v1', strict: true,
    schema: closedObject({
      severity: { type: 'string', enum: [...ABUSE_SEVERITIES] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      basis: { type: 'string', enum: [...ABUSE_BASES] },
    }),
  },
});

// Only these content-free categories may leave the validator. Never report a
// rejected key, enum value or evidence span received from the provider.
export const SAFETY_CONTRACT_REJECTION_REASONS = Object.freeze([
  'request_invalid', 'json_invalid', 'json_duplicate_keys', 'router_keys_invalid',
  ...['threat', 'abuse'].flatMap((domain) => [
    'keys_invalid', 'match_invalid', 'confidence_invalid', 'types_invalid', 'types_duplicate',
    'match_types_mismatch', 'evidence_invalid', 'evidence_not_verbatim', 'match_evidence_mismatch',
  ].map((reason) => `${domain}_${reason}`)),
  'target_invalid', 'context_used_invalid', 'target_match_mismatch', 'overlapping_evidence',
  'warning_context_mismatch', 'warning_context_unavailable', 'severity_keys_invalid',
  'severity_invalid', 'severity_confidence_invalid', 'severity_basis_invalid',
  'severity_basis_mismatch', 'severity_router_type_mismatch',
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
    '--- PORN-SPAM POLICY v1 ---', artifact(`${PORN_SPAM_POLICY_VERSION}.md`),
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

class VerdictValidationError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
function rejectVerdict(reason) { throw new VerdictValidationError(reason); }

function strictJsonObject(raw) {
  if (typeof raw !== 'string') rejectVerdict('json_invalid');
  const text = raw.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) rejectVerdict('json_invalid');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch { rejectVerdict('json_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) rejectVerdict('json_invalid');
  if (hasDuplicateJsonObjectKeys(text)) rejectVerdict('json_duplicate_keys');
  return parsed;
}

function confidence(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1; }

function evidence(value, message, domain) {
  if (!Array.isArray(value) || value.length > 3
    || value.some((span) => typeof span !== 'string' || !span.trim() || span.length > 240)) {
    rejectVerdict(`${domain}_evidence_invalid`);
  }
  if (value.some((span) => !message.includes(span))) rejectVerdict(`${domain}_evidence_not_verbatim`);
  return [...value];
}

function verdictMatch(value, typeOrder, message, domain) {
  const schema = SAFETY_ROUTER_RESPONSE_FORMAT.json_schema.schema.properties[domain];
  if (!exactKeys(value, schema.required)) rejectVerdict(`${domain}_keys_invalid`);
  if (typeof value.match !== 'boolean') rejectVerdict(`${domain}_match_invalid`);
  if (!confidence(value.confidence)) rejectVerdict(`${domain}_confidence_invalid`);
  const allowed = new Set(typeOrder);
  if (!Array.isArray(value.types) || value.types.some((item) => !allowed.has(item))) rejectVerdict(`${domain}_types_invalid`);
  if (new Set(value.types).size !== value.types.length) rejectVerdict(`${domain}_types_duplicate`);
  if (value.match !== (value.types.length > 0)) rejectVerdict(`${domain}_match_types_mismatch`);
  const spans = evidence(value.evidence, message, domain);
  if (value.match !== (spans.length > 0)) rejectVerdict(`${domain}_match_evidence_mismatch`);
  const selected = new Set(value.types);
  return { match: value.match, types: typeOrder.filter((item) => selected.has(item)), confidence: value.confidence, evidence: spans };
}

function validatedSafetyRouterVerdict(raw, message) {
  if (typeof message !== 'string') rejectVerdict('request_invalid');
  const parsed = strictJsonObject(raw);
  if (!exactKeys(parsed, SAFETY_ROUTER_RESPONSE_FORMAT.json_schema.schema.required)) rejectVerdict('router_keys_invalid');
  const threat = verdictMatch(parsed.threat, THREAT_TYPES, message, 'threat');
  const abuse = verdictMatch(parsed.abuse, ABUSE_TYPES, message, 'abuse');
  if (!TARGET_SET.has(parsed.target)) rejectVerdict('target_invalid');
  if (typeof parsed.context_used !== 'boolean') rejectVerdict('context_used_invalid');
  if ((threat.match || abuse.match) === (parsed.target === 'none')) rejectVerdict('target_match_mismatch');
  if (threat.match && abuse.match && threat.evidence.some((threatSpan) => abuse.evidence.some(
    (abuseSpan) => threatSpan.includes(abuseSpan) || abuseSpan.includes(threatSpan),
  ))) rejectVerdict('overlapping_evidence');
  return { threat, abuse, target: parsed.target, context_used: parsed.context_used };
}

function validatedAbuseSeverityVerdict(raw) {
  const parsed = strictJsonObject(raw);
  if (!exactKeys(parsed, SAFETY_ABUSE_RESPONSE_FORMAT.json_schema.schema.required)) rejectVerdict('severity_keys_invalid');
  if (!ABUSE_SEVERITY_SET.has(parsed.severity)) rejectVerdict('severity_invalid');
  if (!confidence(parsed.confidence)) rejectVerdict('severity_confidence_invalid');
  if (!ABUSE_BASIS_SET.has(parsed.basis)) rejectVerdict('severity_basis_invalid');
  if (parsed.severity === 'weak' && !WEAK_ABUSE_BASES.has(parsed.basis)
    || parsed.severity === 'strong' && !STRONG_ABUSE_BASES.has(parsed.basis)) rejectVerdict('severity_basis_mismatch');
  return { severity: parsed.severity, confidence: parsed.confidence, basis: parsed.basis };
}

// Preserve the public null-on-rejection parsers at the submission boundary.
export function parseSafetyRouterVerdict(raw, message) {
  try { return validatedSafetyRouterVerdict(raw, message); } catch (error) {
    if (error instanceof VerdictValidationError) return null;
    throw error;
  }
}
export function parseAbuseSeverityVerdict(raw) {
  try { return validatedAbuseSeverityVerdict(raw); } catch (error) {
    if (error instanceof VerdictValidationError) return null;
    throw error;
  }
}

function classifyVerdict(stage, results, parse) {
  try { return parse(); } catch (error) {
    if (error instanceof VerdictValidationError) throw new SafetyV3ContractError(stage, error.reason, results);
    throw error;
  }
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
    // Итог берётся из квитанций, а не выводится сложением входа с выходом:
    // общее число называет провайдер, и считать его самим значило бы завести
    // вторую линейку для той же величины.
    totalTokens: sum('totalTokens'),
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

/** Revalidate the provider-neutral result at the private submission boundary.
 * Platform actions, targets, counters and public warning copy are forbidden.
 * The required v3 trace's verbatim spans and severity basis are checked
 * against the persisted raw source and warning context a second time. */
export function validateJudgementSemantic(value, message, context = {}) {
  const allowed = new Set(['safetyRoute', 'abuseLevel', 'confidence', 'reason', 'quote',
    'modelId', 'policyVersion', 'safetyTrace', 'receipt']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.has(key))
    || !['clean', 'abuse', 'threat'].includes(value.safetyRoute)
    || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)
    || value.confidence < 0 || value.confidence > 1
    || (value.modelId != null && (typeof value.modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(value.modelId)))
    || (value.safetyRoute === 'abuse' ? !['weak', 'strong'].includes(value.abuseLevel) : value.abuseLevel != null)
    || (value.quote && (typeof value.quote !== 'string' || !message.includes(value.quote)))) return false;
  if (!value.safetyTrace) return false;
  const trace = value.safetyTrace;
  const router = parseSafetyRouterVerdict(JSON.stringify(trace.router), message);
  if (!router || router.context_used !== router.abuse.types.includes('warning_dispute')
    || (router.context_used && !warningContextAvailable(normalizeSafetyContext(context)))) return false;
  const route = safetyRoute(router);
  if (route !== value.safetyRoute) return false;
  if (route !== 'abuse') return trace.abuseClassifier == null && value.abuseLevel == null
    && value.confidence === (route === 'threat' ? router.threat.confidence
      : Math.min(router.threat.confidence, router.abuse.confidence));
  const abuse = parseAbuseSeverityVerdict(JSON.stringify(trace.abuseClassifier));
  return Boolean(abuse && abuse.severity === value.abuseLevel
    && value.confidence === Math.min(router.abuse.confidence, abuse.confidence)
    && ABUSE_BASIS_TYPES[abuse.basis]?.size
    && router.abuse.types.some((type) => ABUSE_BASIS_TYPES[abuse.basis].has(type))
    && (abuse.basis !== 'warning_dispute' || warningContextAvailable(normalizeSafetyContext(context))));
}

/**
 * Execute the two-stage deployed Moderator contract through one injected,
 * non-retrying transport. `invoke` receives prebuilt code-owned payloads and
 * returns `{ text, receipt, completion? }`; optional completion metadata is
 * content-free and transport-validated. There is no fallback opportunity.
 */
export async function classifySafetyV3({ message, context = {}, invoke }) {
  if (typeof message !== 'string' || !message.trim() || typeof invoke !== 'function') {
    throw new SafetyV3ContractError('router', 'request_invalid');
  }
  const safeContext = normalizeSafetyContext(context);
  const results = [];
  const routerResult = await invoke({
    stage: 'router', system: buildSafetyRouterSystem(), user: routerPayload(message, safeContext),
    maxOutputTokens: SAFETY_ROUTER_MAX_OUTPUT_TOKENS, responseFormat: SAFETY_ROUTER_RESPONSE_FORMAT,
  });
  results.push(routerResult);
  const router = classifyVerdict('router', results, () => validatedSafetyRouterVerdict(routerResult?.text, message));
  if (router.context_used !== router.abuse.types.includes('warning_dispute')) {
    throw new SafetyV3ContractError('router', 'warning_context_mismatch', results);
  }
  if (router.context_used && !warningContextAvailable(safeContext)) {
    throw new SafetyV3ContractError('router', 'warning_context_unavailable', results);
  }

  const route = safetyRoute(router);
  let abuse = null;
  if (route === 'abuse') {
    const abuseResult = await invoke({
      stage: 'abuse_classifier', system: buildAbuseClassifierSystem(),
      user: abusePayload(message, router, safeContext), maxOutputTokens: SAFETY_ABUSE_MAX_OUTPUT_TOKENS,
      responseFormat: SAFETY_ABUSE_RESPONSE_FORMAT,
    });
    results.push(abuseResult);
    abuse = classifyVerdict('abuse_classifier', results, () => validatedAbuseSeverityVerdict(abuseResult?.text));
    const allowedBasisTypes = ABUSE_BASIS_TYPES[abuse.basis];
    const basisMatchesRouter = Boolean(
      allowedBasisTypes && router.abuse.types.some((type) => allowedBasisTypes.has(type)),
    );
    if (abuse.basis === 'warning_dispute' && !warningContextAvailable(safeContext)) {
      throw new SafetyV3ContractError('abuse_classifier', 'warning_context_unavailable', results);
    }
    if (!basisMatchesRouter) throw new SafetyV3ContractError('abuse_classifier', 'severity_router_type_mismatch', results);
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
        pornSpamPolicy: sha256(artifact(`${PORN_SPAM_POLICY_VERSION}.md`)),
      },
      usage,
      receipts: results.map((result) => result?.receipt || null),
    },
  };
  return Object.freeze(output);
}
