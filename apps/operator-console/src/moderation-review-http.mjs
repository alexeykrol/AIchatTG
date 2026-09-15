/** Isolated v1 adapter. The root must inject its authenticated principal and
 * exact public origin. No collector, runtime database, transport or token. */
export const MODERATION_REVIEW_PREFIX = '/api/operator/moderation-review/v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const LABELS = new Set(['hidden_advertising', 'legitimate', 'insufficient_evidence']);
const MAX_BODY_BYTES = 16_384;

class RequestError extends Error {
  constructor(code, statusCode) { super(code); this.code = code; this.statusCode = statusCode; }
}

function reply(response, statusCode, body) {
  const text = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  response.end(text);
}

function exactFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}

function paging(params, allowStatus = false) {
  const allowed = new Set(['limit', 'offset', ...(allowStatus ? ['status'] : [])]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new RequestError('review_query_invalid', 400);
  }
  const integer = (name, fallback, min, max) => {
    const value = params.get(name);
    if (value === null) return fallback;
    if (!/^(0|[1-9]\d*)$/u.test(value)) throw new RequestError('review_query_invalid', 400);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new RequestError('review_query_invalid', 400);
    return number;
  };
  const result = { limit: integer('limit', 30, 1, 100), offset: integer('offset', 0, 0, 1_000_000) };
  if (allowStatus) {
    result.status = params.get('status') || 'pending';
    if (!['pending', 'retained', 'reviewed', 'all'].includes(result.status)) throw new RequestError('review_query_invalid', 400);
  }
  return result;
}

async function readBody(request, expectedOrigin) {
  if (!expectedOrigin
    || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] || '')
    || request.headers['x-operator-intent'] !== 'moderation-review'
    || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')
    || request.headers.origin !== expectedOrigin
    || request.headers.host !== new URL(expectedOrigin).host
    || request.headers['content-encoding']) {
    throw new RequestError('review_request_forbidden', 403);
  }
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    throw new RequestError('review_body_too_large', 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestError('review_body_too_large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError('review_json_invalid', 400); }
}

export const DISABLED_REVIEW_STATUS = Object.freeze({
  mode: 'disabled', collectionEnabled: false, deliveryEnabled: false,
  decisionsEnabled: false, patternActivationEnabled: false, sanctionsEnabled: false,
  retentionMs: null, counts: null,
});

/** authenticate(request) returns a trusted principal string or null, never a
 * client-supplied JSON identity. Unconfigured authentication fails closed. */
export function createModerationReviewHandler({ store = null, authenticate = () => null, origin = null } = {}) {
  if (typeof authenticate !== 'function') throw new TypeError('review authenticate must be a function');
  if (origin !== null) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin
      || parsed.username || parsed.password) throw new TypeError('review origin must be an exact HTTP(S) origin');
  }
  return async function handle(request, response) {
    let url;
    try { url = new URL(request.url, 'http://review.invalid'); }
    catch { return false; }
    if (url.pathname !== MODERATION_REVIEW_PREFIX && !url.pathname.startsWith(`${MODERATION_REVIEW_PREFIX}/`)) return false;
    try {
      const principal = await authenticate(request);
      if (typeof principal !== 'string' || !/^[\p{L}\p{N}._:@-]{1,128}$/u.test(principal)) {
        throw new RequestError('review_unauthorized', 401);
      }
      const suffix = url.pathname.slice(MODERATION_REVIEW_PREFIX.length);
      if (request.method === 'GET' && suffix === '/status') {
        if (url.search) throw new RequestError('review_query_invalid', 400);
        reply(response, 200, store ? store.status() : DISABLED_REVIEW_STATUS);
        return true;
      }
      const match = /^\/cases\/([^/]+)(?:\/(decisions|erase))?$/u.exec(suffix);
      const known = ['/cases', '/patterns', '/history'].includes(suffix) || Boolean(match);
      if (!known) throw new RequestError('review_route_not_found', 404);
      if (!store) throw new RequestError('review_disabled', 503);
      if (match && !UUID.test(match[1])) throw new RequestError('review_case_id_invalid', 400);
      if (request.method === 'GET' && !match?.[2]) {
        if (suffix === '/cases') reply(response, 200, store.listCases(paging(url.searchParams, true)));
        else if (suffix === '/patterns') reply(response, 200, store.listPatterns(paging(url.searchParams)));
        else if (suffix === '/history') reply(response, 200, store.listHistory(paging(url.searchParams)));
        else if (match) {
          if (url.search) throw new RequestError('review_query_invalid', 400);
          const found = store.getCase(match[1]);
          if (!found) throw new RequestError('review_case_not_found', 404);
          reply(response, 200, found);
        }
        return true;
      }
      if (request.method !== 'POST' || !match?.[2]) throw new RequestError('review_method_not_allowed', 405);
      if (url.search) throw new RequestError('review_query_invalid', 400);
      const body = await readBody(request, origin);
      const erase = match[2] === 'erase';
      const fields = erase ? ['expectedVersion', 'requestId'] : ['expectedVersion', 'decisionId', 'label', 'note'];
      if (!exactFields(body, fields) || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1
        || !UUID.test(body[erase ? 'requestId' : 'decisionId'] || '')
        || (!erase && (!LABELS.has(body.label) || typeof body.note !== 'string' || body.note.length > 4_096))) {
        throw new RequestError('review_body_invalid', 400);
      }
      const command = { ...body, caseId: match[1] };
      const result = erase ? store.eraseCase(command, principal) : store.decide(command, principal);
      reply(response, 200, result);
    } catch (error) {
      const safe = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600
        && /^review_[a-z0-9_]+$/u.test(error?.code || '');
      reply(response, safe ? error.statusCode : 503, { error: safe ? error.code : 'review_unavailable' });
    }
    return true;
  };
}
