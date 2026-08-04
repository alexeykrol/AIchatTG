const OPENAI_COMPATIBLE_VENDOR = 'openai-compatible';
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high']);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MAX_OUTPUT_TOKENS = 4_096;
const MAX_INPUT_CHARS = 60_000;

const TUPLE_NAMES = Object.freeze({
  moderatorSafety: 'moderatorSafety',
  assistantRouter: 'assistantRouter',
  assistantAnswer: 'assistantAnswer',
});

const MODERATOR_SYSTEM_PROMPT = [
  'You are the AIchatTG Moderator safety classifier.',
  'Classify only the supplied message. Return exactly one JSON object with',
  'safetyRoute, abuseLevel, confidence, reason, and quote. safetyRoute must be',
  'clean, abuse, or threat. abuseLevel must be weak or strong only when',
  'safetyRoute is abuse, otherwise null. confidence must be a number from 0 to 1.',
  'Do not choose Telegram actions and do not add Markdown.',
].join(' ');

const ROUTER_SYSTEM_PROMPT = [
  'You route an AIchatTG Assistant question without granting access yourself.',
  'Return exactly one JSON object with action and sourceId. action is exactly one',
  'of teach, navigate, support, redirect. teach and navigate require sourceId',
  'course-content-v1. support requires sourceId course-operations-v1. redirect',
  'requires sourceId null. Respect courseOperationsHint: an operations question',
  'may only be support or redirect. Do not add Markdown.',
].join(' ');

const ANSWER_SYSTEM_PROMPT = [
  'You are the AIchatTG Assistant. Answer the supplied question in the user\'s',
  'language using only the supplied admitted knowledge snapshot and dialogue.',
  'Do not invent course facts, secrets, links, access, or actions. If the snapshot',
  'does not support an answer, say so briefly and ask for a more specific question.',
].join(' ');

export class ProviderUnavailableError extends Error {
  constructor(code) {
    super(`AIchatTG provider is unavailable: ${code}`);
    this.name = 'ProviderUnavailableError';
    this.code = code;
  }
}

/** A single attempted provider request failed; the adapter never retries it. */
export class ProviderRequestError extends Error {
  constructor(code, receipt = null) {
    super(`AIchatTG provider request failed: ${code}`);
    this.name = 'ProviderRequestError';
    this.code = code;
    this.receipt = receipt;
    this.retryable = false;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unavailable(code) {
  return Object.freeze({
    async moderate() { throw new ProviderUnavailableError(code); },
    async routeAssistant() { throw new ProviderUnavailableError(code); },
    async answer() { throw new ProviderUnavailableError(code); },
  });
}

function invalid(code) {
  return { valid: false, code };
}

function normalizeEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(String(value || '')); } catch { return null; }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password
    || endpoint.port && endpoint.port !== '443' || endpoint.search || endpoint.hash) return null;
  const hostname = endpoint.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    || hostname.includes(':') || endpoint.pathname !== '/v1' && endpoint.pathname !== '/v1/') return null;
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

/**
 * Validate the explicit AIchatTG OpenAI-compatible transport contract. It
 * neither reads process.env nor permits a generic provider/vendor fallback.
 */
export function validateProviderRuntimeConfig(config) {
  if (config == null || config.enabled === false) return invalid('provider_disabled');
  if (!plainObject(config) || config.enabled !== true) return invalid('provider_configuration_invalid');
  if (config.vendor !== OPENAI_COMPATIBLE_VENDOR) return invalid('provider_vendor_invalid');
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
  return {
    valid: true,
    config: Object.freeze({
      enabled: true,
      vendor: OPENAI_COMPATIBLE_VENDOR,
      endpoint,
      apiKey,
      modelTuples: Object.freeze(modelTuples),
    }),
  };
}

export function isProviderUnavailableError(error) {
  return error instanceof ProviderUnavailableError;
}

function responseHeader(response, name) {
  const value = typeof response?.headers?.get === 'function' ? response.headers.get(name) : null;
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : null;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

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
    vendor: OPENAI_COMPATIBLE_VENDOR,
    operation,
    modelId: responseModel,
    configuredModelId: tuple.model,
    reasoningEffort: tuple.reasoningEffort,
    httpStatus: Number.isSafeInteger(status) ? status : 0,
    requestId: responseHeader(response, 'x-request-id'),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    costUsd: null,
    retryCount: 0,
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

function userInput(operation, payload) {
  if (!plainObject(payload)) return null;
  if (operation === 'moderatorSafety') {
    const text = questionText(payload.text);
    return text ? boundedJson({ message: text }) : null;
  }
  if (operation === 'assistantRouter') {
    const text = questionText(payload.text);
    return text ? boundedJson({ question: text, courseOperationsHint: Boolean(payload.courseOperationsHint) }) : null;
  }
  const text = questionText(payload.text);
  if (!text || !plainObject(payload.route) || !Array.isArray(payload.dialogue) || !plainObject(payload.knowledge)) return null;
  const dialogue = payload.dialogue.map((turn) => ({
    question: questionText(turn?.question), answer: questionText(turn?.answer),
  }));
  if (dialogue.length > 3 || dialogue.some((turn) => !turn.question || !turn.answer)) return null;
  const route = { action: String(payload.route.action || ''), sourceId: payload.route.sourceId ?? null };
  const knowledge = {
    sourceId: typeof payload.knowledge.sourceId === 'string' ? payload.knowledge.sourceId : '',
    entries: Array.isArray(payload.knowledge.entries)
      ? payload.knowledge.entries.map((entry) => ({ id: String(entry?.id || ''), content: String(entry?.content || '') }))
      : null,
  };
  if (!knowledge.sourceId || !knowledge.entries || knowledge.entries.length === 0 || knowledge.entries.length > 128) return null;
  return boundedJson({ question: text, route, dialogue, knowledge });
}

function requestFor(operation, tuple, input) {
  const system = operation === 'moderatorSafety' ? MODERATOR_SYSTEM_PROMPT
    : operation === 'assistantRouter' ? ROUTER_SYSTEM_PROMPT : ANSWER_SYSTEM_PROMPT;
  const request = {
    model: tuple.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: input }],
    max_completion_tokens: tuple.maxOutputTokens,
  };
  if (tuple.reasoningEffort !== 'none') request.reasoning_effort = tuple.reasoningEffort;
  if (operation !== 'assistantAnswer') request.response_format = { type: 'json_object' };
  return request;
}

function parseStructuredResult(response, receipt) {
  const text = completionText(response);
  let result;
  try { result = JSON.parse(text || ''); } catch { throw new ProviderRequestError('provider_response_invalid', receipt); }
  if (!plainObject(result)) throw new ProviderRequestError('provider_response_invalid', receipt);
  return { ...result, modelId: receipt.modelId, receipt };
}

/**
 * Demand-only OpenAI Chat Completions transport. Construction and disabled or
 * invalid calls never fetch. Each enabled operation performs one POST only:
 * there are no automatic retries, field fallbacks, or secondary providers.
 */
export function createProviderAdapter(config, { fetchFn = globalThis.fetch } = {}) {
  const validated = validateProviderRuntimeConfig(config);
  if (!validated.valid) return unavailable(validated.code);
  if (typeof fetchFn !== 'function') return unavailable('provider_transport_unavailable');

  async function invoke(operation, payload) {
    const tuple = validated.config.modelTuples[operation];
    const input = userInput(operation, payload);
    if (!input) throw new ProviderRequestError('provider_request_invalid');
    let response;
    try {
      response = await fetchFn(`${validated.config.endpoint}chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${validated.config.apiKey}`,
        },
        body: JSON.stringify(requestFor(operation, tuple, input)),
      });
    } catch {
      throw new ProviderRequestError('provider_transport_failed');
    }
    const status = Number(response?.status) || 0;
    let result = null;
    try { result = typeof response?.json === 'function' ? await response.json() : null; } catch { result = null; }
    const receipt = receiptFor({ operation, tuple, result, response, status });
    if (!response?.ok) throw new ProviderRequestError('provider_http_error', receipt);
    if (!plainObject(result) || !receipt) throw new ProviderRequestError('provider_response_invalid', receipt);
    if (operation === 'assistantAnswer') {
      const text = completionText(result);
      if (text == null) throw new ProviderRequestError('provider_response_invalid', receipt);
      return { text, modelId: receipt.modelId, receipt };
    }
    return parseStructuredResult(result, receipt);
  }

  return Object.freeze({
    moderate: (payload) => invoke(TUPLE_NAMES.moderatorSafety, payload),
    routeAssistant: (payload) => invoke(TUPLE_NAMES.assistantRouter, payload),
    answer: (payload) => invoke(TUPLE_NAMES.assistantAnswer, payload),
  });
}
