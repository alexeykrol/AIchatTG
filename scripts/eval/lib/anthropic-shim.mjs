/**
 * A `fetchFn` for `createProviderAdapter` that answers its OpenAI Chat Completions request through
 * Anthropic's Messages API. Eval-only: production never imports this file.
 *
 * Why a shim and not Anthropic's OpenAI-compatible endpoint: the adapter sends `reasoning_effort` and
 * `max_completion_tokens`, and the compatibility layer's handling of those fields is not documented in the
 * reference we can check offline. The shim maps every field explicitly, so the paid run sends exactly what
 * this file says and nothing is left to an undocumented translation.
 *
 * What stays identical to production: the adapter itself (validation, system prompt, user input with the
 * retrieval context, output cap, receipt parsing). What the shim changes, and only here:
 *   - transport: POST {base}/messages with `x-api-key` + `anthropic-version` instead of Bearer chat/completions;
 *   - `messages[0]` (role system) -> top-level `system`; the user message is passed unchanged;
 *   - `max_completion_tokens` -> `max_tokens` (thinking tokens count against it, as reasoning tokens do on
 *     the OpenAI side);
 *   - `reasoning_effort` -> `output_config.effort` (`minimal` -> `low`; `none` -> thinking `between_tools`,
 *     which turns thinking off on models that refuse `disabled`);
 *   - the response is mapped back to the Chat Completions envelope the adapter parses.
 *
 * The key never travels through the adapter: the adapter gets a placeholder and the shim strips its
 * Authorization header, so the real key exists in one closure only and is never logged.
 */

export const ANTHROPIC_MESSAGES_BASE = 'https://api.anthropic.com/v1/';
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
export const ADAPTER_PLACEHOLDER_KEY = 'eval-shim-holds-the-real-key';

const STOP_TO_FINISH = Object.freeze({
  end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', refusal: 'content_filter',
  tool_use: 'tool_calls', pause_turn: 'unknown',
});

function effortFields(effort) {
  if (effort == null) return {};
  if (effort === 'none') return { thinking: { type: 'between_tools' } };
  const level = effort === 'minimal' ? 'low' : effort;
  return { output_config: { effort: level } };
}

/** Chat Completions request body (as built by provider-adapter `requestFor`) -> Messages request body. */
export function messagesRequestFromChat(chat) {
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) throw new Error('shim_request_invalid');
  const system = chat.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const messages = chat.messages.filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  if (chat.response_format) throw new Error('shim_structured_output_unsupported'); // the answer path never asks for it
  return {
    model: chat.model,
    max_tokens: chat.max_completion_tokens,
    ...(system ? { system } : {}),
    messages,
    ...effortFields(chat.reasoning_effort),
  };
}

/** Messages response -> the Chat Completions envelope `provider-adapter` parses. */
export function chatResponseFromMessages(msg) {
  const text = Array.isArray(msg?.content)
    ? msg.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
    : '';
  const u = msg?.usage || {};
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const output = u.output_tokens || 0;
  return {
    id: msg?.id ?? null,
    model: msg?.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: STOP_TO_FINISH[msg?.stop_reason] || 'unknown',
    }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
    anthropic_usage: u,
    stop_reason: msg?.stop_reason ?? null,
  };
}

function responseLike({ ok, status, body, requestId }) {
  return {
    ok, status,
    headers: { get: (name) => (String(name).toLowerCase() === 'x-request-id' ? requestId : null) },
    async json() { return body; },
  };
}

/**
 * @param {object} o
 * @param {string} o.apiKey       real Anthropic key (from the env var named on the command line)
 * @param {Function} [o.fetchFn]  transport; globalThis.fetch in a paid run, a fake in tests
 * @param {Function} [o.onCall]   observer: ({ request, response, raw }) for the run journal
 */
export function createAnthropicChatShim({
  apiKey, fetchFn = globalThis.fetch, base = ANTHROPIC_MESSAGES_BASE,
  anthropicVersion = DEFAULT_ANTHROPIC_VERSION, onCall = null,
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw new Error('shim_api_key_missing');
  return async function shimFetch(url, init = {}) {
    if (String(url) !== `${base}chat/completions`) throw new Error('shim_unexpected_url');
    const chat = JSON.parse(init.body);
    const request = messagesRequestFromChat(chat);
    const res = await fetchFn(`${base}messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': anthropicVersion },
      body: JSON.stringify(request),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    let raw = null;
    try { raw = await res.json(); } catch { raw = null; }
    const requestId = typeof res.headers?.get === 'function' ? res.headers.get('request-id') : null;
    const body = res.ok ? chatResponseFromMessages(raw) : raw;
    if (onCall) onCall({ request, status: res.status, ok: res.ok, raw, body });
    return responseLike({ ok: res.ok, status: res.status, body, requestId });
  };
}
