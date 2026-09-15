const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

function safeConsoleOrigin(consoleUrl) {
  if (typeof consoleUrl !== 'string') throw new TypeError('moderation_review_console_url_invalid');
  let url;
  try { url = new URL(consoleUrl); } catch {
    throw new TypeError('moderation_review_console_url_invalid');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash
    || !['/', '/moderation-v3.html'].includes(url.pathname)) {
    throw new TypeError('moderation_review_console_url_invalid');
  }
  return url.origin;
}

function safeReceipt(value) {
  const id = typeof value === 'string' ? value : value?.id;
  return typeof id === 'string' && UUID.test(id) ? { id: id.toLowerCase() } : null;
}

/**
 * Injection-only local delivery. The store persists calling before send and
 * fences orphaned calls on restart. Never read a case or pass private evidence
 * to the sender. There is deliberately no token, destination or network client.
 * Store failures propagate: a caller must not report completion without the
 * durable terminal receipt. The calling fence still prevents blind replay.
 */
export async function deliverNextModerationReviewAlert({ store, send, consoleUrl } = {}) {
  if (!store || typeof store.claimAlert !== 'function' || typeof store.finishAlert !== 'function'
    || typeof send !== 'function') throw new TypeError('moderation_review_delivery_config_invalid');
  const origin = safeConsoleOrigin(consoleUrl);
  const claim = await store.claimAlert();
  if (!claim) return { state: 'idle' };
  const { caseId, attemptId } = claim;
  if (typeof caseId !== 'string' || !UUID.test(caseId)
    || typeof attemptId !== 'string' || !UUID.test(attemptId)) {
    await store.finishAlert({ caseId, attemptId, state: 'failed', receipt: null });
    return { caseId, attemptId, state: 'failed' };
  }
  const link = new URL('/moderation-v3.html', origin);
  link.searchParams.set('case', caseId);
  const url = link.toString();
  let state = 'uncertain';
  let receipt = null;
  try {
    const result = await send({ text: `Новый случай для проверки в Admin.\n\n${url}`, url });
    if (result?.ok === true) {
      state = 'sent';
      receipt = safeReceipt(result.receipt);
    } else if (result?.ok === false && result.definite === true) {
      state = 'failed';
    }
  } catch {
    // Exception contents may include private provider response bodies or
    // credentials. Persist only the outcome, never stringify the exception.
  }
  await store.finishAlert({ caseId, attemptId, state, receipt });
  return { caseId, attemptId, state };
}
