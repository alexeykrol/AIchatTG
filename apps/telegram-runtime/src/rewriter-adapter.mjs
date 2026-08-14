import { REWRITE_MAX_CHARS } from '@aichattg/telegram-core';

/**
 * The model port for input-layer step 5. It restates a question in the
 * vocabulary of the domain so the lexical retriever gets a second, better-aimed
 * pass. The call is deliberately tiny — one short question in, one short
 * question out — and it is issued exactly once per user question by the caller.
 *
 * This adapter is separate from the answer provider on purpose: a rewrite is a
 * cheap pre-retrieval step, not a retry of a failed answer call, so it must not
 * borrow the answer transport's billing semantics or its no-retry fencing.
 */

const REWRITE_SYSTEM_PROMPT = [
  'Перепиши вопрос пользователя терминами учебного курса, чтобы его нашёл',
  'лексический поиск по конспектам уроков. Верни ТОЛЬКО переписанный вопрос',
  'одной строкой, без пояснений, кавычек и разметки. Сохрани смысл и язык',
  'вопроса. Замени разговорные обороты на термины предметной области.',
  'Если вопрос уже сформулирован терминами курса, верни его ключевые термины',
  'через пробел. Максимум 20 слов.',
].join(' ');

const MAX_OUTPUT_TOKENS = 128;
const REQUEST_TIMEOUT_MS = 10_000;

export class RewriterUnavailableError extends Error {
  constructor(code) {
    super(`AIchatTG rewriter is unavailable: ${code}`);
    this.name = 'RewriterUnavailableError';
    this.code = code;
  }
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').map((part) => part.trim()).find(Boolean) || '';
  // A model that ignores "one line only" tends to answer `Вопрос: ...`; the
  // label is stripped rather than searched.
  return line.replace(/^["'«»]+|["'«»]+$/g, '')
    .replace(/^(?:вопрос|переписанный вопрос|rewrite|question)\s*:\s*/i, '')
    .slice(0, REWRITE_MAX_CHARS)
    .trim();
}

/**
 * A rewriter backed by an OpenAI-compatible chat endpoint. It performs a single
 * POST with no retry: a rewrite that fails is simply not used, and the caller
 * falls back to the first retrieval pass rather than paying twice.
 */
export function createRewriterAdapter(
  { enabled = false, endpoint = '', apiKey = '', model = '', reasoningEffort = 'minimal' } = {},
  { fetchFn = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  if (enabled !== true) return null;
  if (typeof fetchFn !== 'function') throw new RewriterUnavailableError('rewriter_transport_unavailable');
  if (!endpoint || !apiKey || !model) throw new RewriterUnavailableError('rewriter_configuration_invalid');

  return async function rewriteQuestion({ question, conceptMatches = [] } = {}) {
    const text = String(question ?? '').trim();
    if (!text) throw new RewriterUnavailableError('rewriter_request_invalid');
    // The concepts the first pass did match are supplied as orientation: they
    // tell the model which vocabulary this corpus actually uses.
    const hint = conceptMatches.length
      ? `\nТермины, уже найденные в базе: ${conceptMatches.slice(0, 8).join(', ')}` : '';

    const request = {
      model,
      messages: [
        { role: 'system', content: REWRITE_SYSTEM_PROMPT },
        { role: 'user', content: `${text}${hint}` },
      ],
      max_completion_tokens: MAX_OUTPUT_TOKENS,
    };
    if (reasoningEffort && reasoningEffort !== 'none') request.reasoning_effort = reasoningEffort;

    const response = await fetchFn(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) throw new RewriterUnavailableError('rewriter_http_error');
    const result = await response.json();
    return firstLine(result?.choices?.[0]?.message?.content);
  };
}

/**
 * A rewriter with no network: it replays a recorded question→rewrite table.
 * Measurement of step 5 must be reproducible and free, and a fixture run also
 * proves the wiring without a key.
 */
export function createRecordedRewriter(table = {}) {
  const byQuestion = new Map(Object.entries(table));
  return async function rewriteQuestion({ question } = {}) {
    return byQuestion.get(String(question ?? '').trim()) ?? null;
  };
}

export { REWRITE_SYSTEM_PROMPT };
