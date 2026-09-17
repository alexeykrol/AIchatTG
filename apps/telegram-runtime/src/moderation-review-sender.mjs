import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const RESPONSE_LIMIT = 16 * 1024;
const failure = (code, definite) => ({ ok: false, definite, code });

function privateRecipient(value) {
  const id = typeof value === 'number' ? String(value) : value;
  return typeof id === 'string' && /^[1-9][0-9]{0,15}$/u.test(id)
    && Number.isSafeInteger(Number(id)) ? id : null;
}

function consoleOrigin(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
      || url.username || url.password || url.search || url.hash
      || !['/', '/moderation-v3.html'].includes(url.pathname)) return null;
    return url.origin;
  } catch { return null; }
}

/**
 * The Console owns the durable invocation fence. This helper has no ledger,
 * retry, fallback, footer or source-content input. Each authorized invocation
 * can perform exactly one bounded Telegram call.
 */
export function createModerationReviewTelegramSender({ enabled = false, botToken, recipientChatId,
  consoleUrl, authorize, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const recipient = privateRecipient(recipientChatId);
  const origin = consoleOrigin(consoleUrl);
  const configured = typeof botToken === 'string' && /^[0-9]{1,20}:[A-Za-z0-9_-]{20,100}$/u.test(botToken)
    && recipient && origin && typeof authorize === 'function' && typeof fetchImpl === 'function'
    && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000;
  return async function send(input, { signal } = {}) {
    if (enabled !== true) return failure('review_sender_disabled', true);
    if (!configured) return failure('review_sender_config_invalid', true);
    if (signal !== undefined && !(signal instanceof AbortSignal)) return failure('review_sender_request_invalid', true);
    if (signal?.aborted) return failure('review_sender_cancelled', true);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      || Reflect.ownKeys(input).length !== 2 || Object.keys(input).sort().join(',') !== 'attemptId,caseId'
      || ['caseId', 'attemptId'].some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) {
      return failure('review_sender_request_invalid', true);
    }
    const { caseId, attemptId } = input ?? {};
    if (typeof caseId !== 'string' || !UUID.test(caseId)
      || typeof attemptId !== 'string' || !UUID.test(attemptId)) {
      return failure('review_sender_request_invalid', true);
    }
    const url = new URL('/moderation-v3.html', origin);
    url.searchParams.set('case', caseId);
    const text = `Новый случай для проверки в Admin.\n\n${url.toString()}`;
    const controller = new AbortController();
    let invoked = false;
    let finished = false;
    let reader;
    let chunks = [];
    let response;
    let timer;
    let onAbort;
    const dispose = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
      chunks.length = 0;
      chunks = [];
      if (reader) {
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Safe discard. */ }
        reader = null;
      } else if (response?.body) {
        try { Promise.resolve(response.body.cancel()).catch(() => {}); } catch { /* Safe discard. */ }
      }
      response = null;
    };
    return new Promise((resolve) => {
      const finish = (value) => {
        if (finished) return;
        finished = true;
        dispose();
        resolve(value);
      };
      onAbort = () => finish(failure('review_sender_cancelled', !invoked));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      timer = setTimeout(() => finish(failure('review_sender_timeout', !invoked)), timeoutMs);
      (async () => {
        try {
          const authorization = await authorize({ caseId, attemptId }, { signal: controller.signal });
          if (finished || controller.signal.aborted) return;
          if (authorization?.authorized !== true) { finish(failure('review_sender_not_authorized', true)); return; }
          // No asynchronous boundary between final authorization and invocation.
          invoked = true;
          const incoming = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: recipient, text, link_preview_options: { is_disabled: true } }),
          });
          if (finished) {
            try { Promise.resolve(incoming?.body?.cancel()).catch(() => {}); } catch { /* Safe discard. */ }
            return;
          }
          response = incoming;
          const length = response?.headers?.get('content-length');
          if (response?.status !== 200 || response.ok !== true
            || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(response.headers?.get('content-type') ?? '')
            || (length !== null && length !== undefined && (!/^\d+$/u.test(length) || Number(length) > RESPONSE_LIMIT))
            || !response.body || typeof response.body.getReader !== 'function') {
            finish(failure('review_sender_response_invalid', false));
            return;
          }
          reader = response.body.getReader();
          let size = 0;
          while (!finished) {
            const part = await reader.read();
            if (finished) return;
            if (part.done) break;
            if (!(part.value instanceof Uint8Array)) throw 0;
            size += part.value.byteLength;
            if (size > RESPONSE_LIMIT) { finish(failure('review_sender_response_too_large', false)); return; }
            chunks.push(Buffer.from(part.value));
          }
          if (length !== null && length !== undefined && Number(length) !== size) {
            finish(failure('review_sender_response_incomplete', false));
            return;
          }
          const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          const result = decoded?.result;
          if (decoded?.ok !== true || !result || !Number.isSafeInteger(result.message_id) || result.message_id <= 0
            || !Number.isSafeInteger(result.chat?.id) || result.chat.id <= 0
            || String(result.chat.id) !== recipient || result.chat.type !== 'private' || result.text !== text) {
            finish(failure('review_sender_response_invalid', false));
            return;
          }
          finish({ ok: true, receipt: { id: randomUUID() } });
        } catch {
          finish(failure(invoked ? 'review_sender_transport_uncertain' : 'review_sender_authorization_failed', !invoked));
        }
      })();
    });
  };
}
