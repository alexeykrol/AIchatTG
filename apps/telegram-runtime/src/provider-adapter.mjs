import {
  SAFETY_ABUSE_MAX_OUTPUT_TOKENS,
  SAFETY_MODEL,
  SAFETY_REASONING_EFFORT,
  SAFETY_ROUTER_MAX_OUTPUT_TOKENS,
  SAFETY_VENDOR,
  SafetyV3ContractError,
  classifySafetyV3,
} from './safety-v3.mjs';

const OPENAI_VENDOR = 'openai';
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high']);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MAX_OUTPUT_TOKENS = 4_096;
const MAX_INPUT_CHARS = 60_000;
const MAX_TITLE_CHARS = 200;
const MAX_URL_CHARS = 2_048;

const TUPLE_NAMES = Object.freeze({
  moderatorSafety: 'moderatorSafety',
  assistantRouter: 'assistantRouter',
  assistantAnswer: 'assistantAnswer',
});

const ROUTER_SYSTEM_PROMPT = [
  'You route an AIchatTG Assistant question without granting access yourself.',
  'Return exactly one JSON object with action and sourceId. action is exactly one',
  'of teach, navigate, support, advise, redirect. teach and navigate require',
  'sourceId course-content-v1. support requires sourceId course-operations-v1.',
  'advise requires sourceId course-value-v1 and covers personal fit, benefit and',
  'course choice questions ("is this for me", "why do I need it", "which course',
  'to pick"). redirect requires sourceId null. Respect courseOperationsHint: an',
  'operations question may only be support or redirect. Respect courseValueHint:',
  'a value question may only be advise or redirect. Do not add Markdown.',
].join(' ');

const ANSWER_SYSTEM_PROMPT = [
  'You are the AIchatTG Assistant. Answer the supplied question in the user\'s',
  'language using only the supplied admitted knowledge snapshot and dialogue.',
  'Do not invent course facts, secrets, links, access, or actions. When an entry',
  'you used carries title and canonicalUrl, cite that lesson by its title and its',
  'exact canonicalUrl so the reader can open it; never alter such a URL and never',
  'state a link for an entry that has none. If the snapshot',
  'does not support an answer, say so briefly and ask for a more specific question.',
].join(' ');

// Тот же идентификатор, что в контракте источников telegram-core. Он объявлен
// здесь строкой, потому что адаптер провайдера намеренно не зависит от ядра.
const OPERATIONS_SOURCE_ID = 'course-operations-v1';

/**
 * Операционный ответ отличается от содержательного одним запретом: условия
 * (цены, тарифы, размеры скидок, сроки возврата) формулирует сайт, а не бот — у
 * сайта есть Terms, у бота нет. Поэтому промпт требует отдать ссылку и прямо
 * запрещает называть цифру, даже если модель считает, что знает её.
 */
const OPERATIONS_ANSWER_SYSTEM_PROMPT = [
  'You are the AIchatTG Assistant answering a course operations question',
  '(payment, access, account, subscription, documents, platform faults, support).',
  'Answer in the user\'s language using only the supplied admitted knowledge',
  'snapshot and dialogue. Follow a supplied procedure text step by step.',
  'You must never state, quote, estimate, recalculate or infer any price, tariff,',
  'amount, discount size, percentage, refund window or other contractual term,',
  'even if you believe you know it: the website states the terms, you do not.',
  'For any such question give the referral exactly as the entry words it and cite',
  'its canonicalUrl so the reader opens the page; never alter such a URL and never',
  'state a link for an entry that has none. If the snapshot does not support an',
  'answer, say so briefly and point to the support contact page.',
].join(' ');

// Тот же идентификатор, что в контракте источников telegram-core (см. выше про
// намеренную независимость адаптера от ядра).
const VALUE_SOURCE_ID = 'course-value-v1';

/**
 * Решение владельца: клиент, который «хочет понимать, но учиться некогда»,
 * верит в волшебную пилюлю. Ответ обязан НЕ подтверждать посылку «учиться не
 * надо», честно назвать цену в усилиях и предложить минимальный трек из среза —
 * иначе бот продаёт иллюзию контроля вместо пользы.
 */
const VALUE_ANSWER_SYSTEM_PROMPT = [
  'You are the AIchatTG Assistant answering a question about personal fit,',
  'benefit or course choice ("is this for me", "why do I need it as a manager",',
  '"I have no time to study but want to understand"). Answer in the user\'s',
  'language using only the supplied admitted knowledge snapshot and dialogue.',
  'Never validate the premise that learning is unnecessary: phrases like "you do',
  'not need a course", "you will figure it out without studying" or "just',
  'understanding is enough" are forbidden. State honestly that the ability to',
  'tell real work from nonsense does not exist without a minimal immersion in',
  'the subject. Offer the honest minimal track with its real cost in effort',
  '(which modules, how much time) using only what the snapshot states, never an',
  'invented estimate. Point the reader to course pages: when an entry carries a',
  'canonicalUrl, cite it exactly and never alter it; name lessons by their title',
  'without inventing links, and never state a link for an entry that has none.',
  'Do not invent prices, dates, discounts or promises of results. If the',
  'snapshot does not support an answer, say so briefly.',
].join(' ');

export class ProviderUnavailableError extends Error {
  constructor(code) {
    super(`AIchatTG provider is unavailable: ${code}`);
    this.name = 'ProviderUnavailableError';
    this.code = code;
  }
}

/** One attempted provider request failed. It is never retried automatically. */
export class ProviderRequestError extends Error {
  constructor(code, receipt = null, details = {}) {
    super(`AIchatTG provider request failed: ${code}`);
    this.name = 'ProviderRequestError';
    this.code = code;
    this.receipt = receipt;
    this.retryable = false;
    Object.assign(this, details);
  }
}

function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function invalid(code) { return { valid: false, code }; }

function unavailable(code) {
  return Object.freeze({
    async moderate() { throw new ProviderUnavailableError(code); },
    async routeAssistant() { throw new ProviderUnavailableError(code); },
    async answer() { throw new ProviderUnavailableError(code); },
  });
}

function normalizeEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(String(value || '')); } catch { return null; }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password
    || endpoint.port && endpoint.port !== '443' || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/v1' && endpoint.pathname !== '/v1/') return null;
  const hostname = endpoint.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return null;
  endpoint.pathname = '/v1/';
  return endpoint.toString();
}

function normalizeTuple(value) {
  if (!plainObject(value)) return null;
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const reasoningEffort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim().toLowerCase() : '';
  const maxOutputTokens = Number(value.maxOutputTokens);
  if (!MODEL_PATTERN.test(model) || !REASONING_EFFORTS.has(reasoningEffort)
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS) return null;
  return Object.freeze({ model, reasoningEffort, maxOutputTokens });
}

function isSafetyTuple(tuple) {
  return tuple?.model === SAFETY_MODEL && tuple.reasoningEffort === SAFETY_REASONING_EFFORT
    && tuple.maxOutputTokens === SAFETY_ROUTER_MAX_OUTPUT_TOKENS;
}

/**
 * The Moderator is intentionally not a configurable arbitrary model route.
 * OpenAI/Terra/medium and the router 1024 output limit are policy invariants;
 * the second abuse stage has the code-owned 768-token limit below.
 */
export function validateProviderRuntimeConfig(config) {
  if (config == null || config.enabled === false) return invalid('provider_disabled');
  if (!plainObject(config) || config.enabled !== true) return invalid('provider_configuration_invalid');
  if (config.vendor !== OPENAI_VENDOR) return invalid('provider_vendor_invalid');
  const endpoint = normalizeEndpoint(config.endpoint);
  if (!endpoint) return invalid('provider_endpoint_invalid');
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (!apiKey || apiKey.length > 4_096 || /[\r\n]/.test(apiKey)) return invalid('provider_api_key_invalid');
  if (!plainObject(config.modelTuples)) return invalid('provider_model_tuples_invalid');
  const modelTuples = {};
  for (const tupleName of Object.values(TUPLE_NAMES)) {
    const tuple = normalizeTuple(config.modelTuples[tupleName]);
    if (!tuple) return invalid('provider_model_tuples_invalid');
    modelTuples[tupleName] = tuple;
  }
  if (!isSafetyTuple(modelTuples.moderatorSafety)) return invalid('provider_safety_tuple_invalid');
  return {
    valid: true,
    config: Object.freeze({
      enabled: true, vendor: OPENAI_VENDOR, endpoint, apiKey, modelTuples: Object.freeze(modelTuples),
    }),
  };
}

export function isProviderUnavailableError(error) { return error instanceof ProviderUnavailableError; }

function responseHeader(response, name) {
  const value = typeof response?.headers?.get === 'function' ? response.headers.get(name) : null;
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : null;
}

function tokenCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function usageFrom(response) {
  if (response?.usage == null) return { inputTokens: null, outputTokens: null, totalTokens: null };
  if (!plainObject(response.usage)) return null;
  const inputTokens = tokenCount(response.usage.prompt_tokens);
  const outputTokens = tokenCount(response.usage.completion_tokens);
  const totalTokens = tokenCount(response.usage.total_tokens);
  if (inputTokens == null || outputTokens == null || totalTokens == null) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function receiptFor({ operation, tuple, result, response, status }) {
  const usage = usageFrom(result);
  if (!usage) return null;
  const responseModel = typeof result?.model === 'string' && MODEL_PATTERN.test(result.model)
    ? result.model : tuple.model;
  return Object.freeze({
    vendor: OPENAI_VENDOR, operation, modelId: responseModel, configuredModelId: tuple.model,
    reasoningEffort: tuple.reasoningEffort, httpStatus: Number.isSafeInteger(status) ? status : 0,
    requestId: responseHeader(response, 'x-request-id'), ...usage, costUsd: null, retryCount: 0,
  });
}

function completionText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.filter((part) => plainObject(part) && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text).join('');
    return text || null;
  }
  return null;
}

function boundedJson(value) {
  let json;
  try { json = JSON.stringify(value); } catch { return null; }
  return typeof json === 'string' && json.length <= MAX_INPUT_CHARS ? json : null;
}
function questionText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= 8_192 ? text : null;
}

function entryTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  return title ? title.slice(0, MAX_TITLE_CHARS) : null;
}

/**
 * Only an absolute https URL may reach the answer model as a citation. A
 * relative path, another scheme or an overlong string would let the model
 * publish a link the snapshot never admitted.
 */
function entryCanonicalUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_CHARS) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  return url.protocol === 'https:' ? url.toString() : null;
}

/**
 * Entries keep the citation fields the admitted snapshot already carries. The
 * answer is a funnel: without title and canonical URL the model cannot point a
 * reader at the lesson it just summarised.
 */
function knowledgeEntry(entry) {
  const title = entryTitle(entry?.title);
  const canonicalUrl = entryCanonicalUrl(entry?.canonicalUrl);
  return {
    id: String(entry?.id || ''),
    content: String(entry?.content || ''),
    ...(title == null ? {} : { title }),
    ...(canonicalUrl == null ? {} : { canonicalUrl }),
  };
}

function userInput(operation, payload) {
  if (!plainObject(payload)) return null;
  if (operation === 'assistantRouter') {
    const text = questionText(payload.text);
    return text ? boundedJson({
      question: text,
      courseOperationsHint: Boolean(payload.courseOperationsHint),
      courseValueHint: Boolean(payload.courseValueHint),
    }) : null;
  }
  const text = questionText(payload.text);
  if (!text || !plainObject(payload.route) || !Array.isArray(payload.dialogue) || !plainObject(payload.knowledge)) return null;
  const dialogue = payload.dialogue.map((turn) => ({ question: questionText(turn?.question), answer: questionText(turn?.answer) }));
  if (dialogue.length > 3 || dialogue.some((turn) => !turn.question || !turn.answer)) return null;
  const route = { action: String(payload.route.action || ''), sourceId: payload.route.sourceId ?? null };
  const knowledge = {
    sourceId: typeof payload.knowledge.sourceId === 'string' ? payload.knowledge.sourceId : '',
    entries: Array.isArray(payload.knowledge.entries)
      ? payload.knowledge.entries.map((entry) => knowledgeEntry(entry)) : null,
  };
  if (!knowledge.sourceId || !knowledge.entries || knowledge.entries.length === 0 || knowledge.entries.length > 128) return null;
  return boundedJson({ question: text, route, dialogue, knowledge });
}

/**
 * Промпт выбирается по источнику знания, а не по догадке о тексте вопроса:
 * операционный снимок — единственное, что даёт право на операционный ответ.
 */
export function answerSystemPrompt(payload) {
  const sourceId = plainObject(payload) && plainObject(payload.knowledge)
    ? payload.knowledge.sourceId : null;
  if (sourceId === OPERATIONS_SOURCE_ID) return OPERATIONS_ANSWER_SYSTEM_PROMPT;
  return sourceId === VALUE_SOURCE_ID ? VALUE_ANSWER_SYSTEM_PROMPT : ANSWER_SYSTEM_PROMPT;
}

function requestFor({ tuple, system, input, maxOutputTokens, responseFormat }) {
  const request = {
    model: tuple.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: input }],
    max_completion_tokens: maxOutputTokens,
  };
  if (tuple.reasoningEffort !== 'none') request.reasoning_effort = tuple.reasoningEffort;
  if (responseFormat) request.response_format = { type: 'json_object' };
  return request;
}

function parseStructuredResult(text, receipt) {
  let result;
  try { result = JSON.parse(text || ''); } catch { throw new ProviderRequestError('provider_response_invalid', receipt); }
  if (!plainObject(result)) throw new ProviderRequestError('provider_response_invalid', receipt);
  return { ...result, modelId: receipt.modelId, receipt };
}

/** A single POST with no retry/fallback. Its receipt contains no prompt or answer. */
async function callOnce({ config, fetchFn, operation, tuple, system, input, maxOutputTokens, responseFormat }) {
  let response;
  try {
    response = await fetchFn(`${config.endpoint}chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(requestFor({ tuple, system, input, maxOutputTokens, responseFormat })),
    });
  } catch { throw new ProviderRequestError('provider_transport_failed'); }
  const status = Number(response?.status) || 0;
  let result = null;
  try { result = typeof response?.json === 'function' ? await response.json() : null; } catch { result = null; }
  const receipt = receiptFor({ operation, tuple, result, response, status });
  if (!response?.ok) throw new ProviderRequestError('provider_http_error', receipt);
  if (!plainObject(result) || !receipt) throw new ProviderRequestError('provider_response_invalid', receipt);
  const text = completionText(result);
  if (text == null) throw new ProviderRequestError('provider_response_invalid', receipt);
  return { text, receipt };
}

/**
 * Explicit OpenAI Chat Completions transport. Safety requests are exactly one
 * router call plus, only for abuse, one severity call. No automatic retry can
 * produce a second bill or repeat an ambiguous action boundary.
 */
export function createProviderAdapter(config, { fetchFn = globalThis.fetch } = {}) {
  const validated = validateProviderRuntimeConfig(config);
  if (!validated.valid) return unavailable(validated.code);
  if (typeof fetchFn !== 'function') return unavailable('provider_transport_unavailable');

  async function moderate(payload) {
    const text = questionText(payload?.text);
    if (!text) throw new ProviderRequestError('provider_request_invalid');
    try {
      const result = await classifySafetyV3({
        message: text,
        context: {
          currentWeakStrikes: payload?.currentWeakStrikes,
          warningStage: payload?.warningStage,
        },
        invoke: ({ stage, system, user, maxOutputTokens }) => callOnce({
          config: validated.config, fetchFn, operation: `moderatorSafety.${stage}`,
          tuple: validated.config.modelTuples.moderatorSafety, system, input: user,
          maxOutputTokens, responseFormat: true,
        }),
      });
      return { ...result, receipt: result.safetyTrace.receipts.at(-1) || null };
    } catch (error) {
      if (error instanceof SafetyV3ContractError) {
        const receipt = error.receipts.at(-1)?.receipt || null;
        throw new ProviderRequestError(`provider_safety_${error.stage}_invalid`, receipt, {
          safetyStage: error.stage, safetyReason: error.reason,
          safetyReceipts: error.receipts.map((item) => item?.receipt || null),
        });
      }
      throw error;
    }
  }

  async function invokeAssistant(operation, payload) {
    const input = userInput(operation, payload);
    if (!input) throw new ProviderRequestError('provider_request_invalid');
    const tuple = validated.config.modelTuples[operation];
    const system = operation === 'assistantRouter'
      ? ROUTER_SYSTEM_PROMPT
      : answerSystemPrompt(payload);
    const raw = await callOnce({
      config: validated.config, fetchFn, operation, tuple, system, input,
      maxOutputTokens: tuple.maxOutputTokens, responseFormat: operation === 'assistantRouter',
    });
    if (operation === 'assistantAnswer') return { text: raw.text, modelId: raw.receipt.modelId, receipt: raw.receipt };
    return parseStructuredResult(raw.text, raw.receipt);
  }

  return Object.freeze({
    moderate,
    routeAssistant: (payload) => invokeAssistant(TUPLE_NAMES.assistantRouter, payload),
    answer: (payload) => invokeAssistant(TUPLE_NAMES.assistantAnswer, payload),
  });
}

export const SAFETY_PROVIDER_TUPLE = Object.freeze({
  vendor: SAFETY_VENDOR, model: SAFETY_MODEL, reasoningEffort: SAFETY_REASONING_EFFORT,
  routerMaxOutputTokens: SAFETY_ROUTER_MAX_OUTPUT_TOKENS,
  abuseMaxOutputTokens: SAFETY_ABUSE_MAX_OUTPUT_TOKENS,
});
