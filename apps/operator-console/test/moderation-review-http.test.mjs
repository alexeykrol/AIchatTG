import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createModerationReviewHandler, MODERATION_REVIEW_PREFIX as PREFIX } from '../src/moderation-review-http.mjs';
import { validOperatorAuthorization } from '../src/server.mjs';

const CASE = '38dba5d4-838d-48cf-93fb-b00b5a39db17';
const AUTH = `Basic ${Buffer.from('operator:synthetic-review-token').toString('base64')}`;

async function fixture(t, options = {}) {
  let handler;
  const calls = [];
  const store = {
    status: () => ({ mode: 'synthetic', decisionsEnabled: true }),
    listCases: (query) => { calls.push(['list', query]); return { cases: [], total: 0 }; },
    listPatterns: () => ({ patterns: [], total: 0 }),
    listHistory: () => ({ history: [], total: 0 }),
    getCase: (id) => id === CASE ? { id, version: 1 } : null,
    decide: (body, principal) => { calls.push(['decide', body, principal]); return { decisionId: body.decisionId }; },
    eraseCase: (body, principal) => { calls.push(['erase', body, principal]); return { erased: true }; },
    ...options.store,
  };
  const server = createServer(async (req, res) => {
    if (!await handler(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createModerationReviewHandler({
    store: options.disabled ? null : store, origin,
    authenticate: (request) => validOperatorAuthorization(request.headers.authorization, 'synthetic-review-token') ? 'operator' : null,
  });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const get = (path, headers = {}) => fetch(`${origin}${PREFIX}${path}`, { headers: { authorization: AUTH, ...headers } });
  const post = (path, body, headers = {}) => fetch(`${origin}${PREFIX}${path}`, {
    method: 'POST', headers: {
      authorization: AUTH, origin, 'content-type': 'application/json',
      'x-operator-intent': 'moderation-review', 'sec-fetch-site': 'same-origin', ...headers,
    }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { calls, get, post, origin };
}

const decision = () => ({ expectedVersion: 1, decisionId: randomUUID(), label: 'legitimate', note: 'Synthetic owner note' });

test('review HTTP authenticates even reads; missing configuration is disabled, not empty', async (t) => {
  const f = await fixture(t, { disabled: true });
  const denied = await f.get('/status', { authorization: '' });
  assert.equal(denied.status, 401);
  const status = await f.get('/status');
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    mode: 'disabled', collectionEnabled: false, deliveryEnabled: false, decisionsEnabled: false,
    patternActivationEnabled: false, sanctionsEnabled: false, retentionMs: null, counts: null,
  });
  const absent = await f.get('/cases');
  assert.equal(absent.status, 503);
  assert.equal((await absent.json()).error, 'review_disabled');
  assert.equal((await f.post(`/cases/${CASE}/decisions`, decision())).status, 503);
  assert.deepEqual(f.calls, []);
});

test('authenticated read routes validate pagination, IDs, missing case and privacy headers', async (t) => {
  const f = await fixture(t);
  const cases = await f.get('/cases?status=all&offset=30&limit=20');
  assert.equal(cases.status, 200);
  assert.deepEqual(f.calls[0], ['list', { status: 'all', offset: 30, limit: 20 }]);
  assert.equal((await f.get('/cases?status=retained')).status, 200);
  assert.deepEqual(f.calls[1], ['list', { status: 'retained', offset: 0, limit: 30 }]);
  assert.equal(cases.headers.get('cache-control'), 'no-store');
  assert.equal(cases.headers.get('referrer-policy'), 'no-referrer');
  for (const path of ['/cases?limit=301', '/cases?limit=1&limit=2', '/cases?offset=-1', '/cases?status=active', '/patterns?arbitrary=x', '/cases/%2Ffoo']) {
    assert.equal((await f.get(path)).status, 400, path);
  }
  assert.deepEqual(await (await f.get(`/cases/${CASE}`)).json(), { id: CASE, version: 1 });
  assert.equal((await f.get(`/cases/${randomUUID()}`)).status, 404);
  assert.equal((await f.get('/ingest')).status, 404);
  assert.equal((await f.post('/ingest', {})).status, 404);
  assert.equal((await f.get(`/cases/${CASE}/erase`)).status, 405);
});

test('decisions and erase bind URL target and server principal; no client identity accepted', async (t) => {
  const f = await fixture(t);
  const body = decision();
  assert.equal((await f.post(`/cases/${CASE}/decisions`, body)).status, 200);
  assert.deepEqual(f.calls[0], ['decide', { ...body, caseId: CASE }, 'operator']);
  for (const addition of [{ principal: 'owner' }, { caseId: randomUUID() }, { action: 'ban' }]) {
    assert.equal((await f.post(`/cases/${CASE}/decisions`, { ...body, ...addition })).status, 400);
  }
  const erase = { expectedVersion: 2, requestId: randomUUID() };
  assert.equal((await f.post(`/cases/${CASE}/erase`, erase)).status, 200);
  assert.deepEqual(f.calls[1], ['erase', { ...erase, caseId: CASE }, 'operator']);
  assert.equal(f.calls.length, 2);
});

test('review writes reject cross-site, omitted origin, wrong intent, non-JSON and oversized bodies', async (t) => {
  const f = await fixture(t);
  const path = `/cases/${CASE}/decisions`;
  for (const headers of [
    { origin: 'https://attacker.invalid' }, { origin: '' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { 'x-operator-intent': 'candidate-draft' }, { 'content-type': 'text/plain' },
    { 'content-encoding': 'gzip' },
  ]) assert.equal((await f.post(path, decision(), headers)).status, 403);
  assert.equal((await f.post(path, '{bad json')).status, 400);
  assert.equal((await f.post(path, { ...decision(), note: 'x'.repeat(20_000) })).status, 413);
  for (const body of [[], null, { ...decision(), expectedVersion: 0 }, { ...decision(), label: 'ban' }, { ...decision(), decisionId: 'untrusted' }]) {
    assert.equal((await f.post(path, JSON.stringify(body))).status, 400);
  }
  assert.deepEqual(f.calls, []);
});

test('domain conflicts remain exact while internal filesystem/SQL errors are redacted', async (t) => {
  const f = await fixture(t, { store: {
    decide() { const error = new Error('raw private path'); error.code = 'review_case_stale'; error.statusCode = 409; throw error; },
    getCase() { throw new Error('/private/secret/user-text'); },
  } });
  const stale = await f.post(`/cases/${CASE}/decisions`, decision());
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'review_case_stale' });
  const broken = await f.get(`/cases/${CASE}`);
  assert.equal(broken.status, 503);
  assert.deepEqual(await broken.json(), { error: 'review_unavailable' });
});

test('handler without authenticator fails closed and never touches store', async () => {
  let touched = false;
  const handler = createModerationReviewHandler({ store: { status() { touched = true; } } });
  const result = {};
  const res = { writeHead: (status) => { result.status = status; }, end: (body) => { result.body = body; } };
  assert.equal(await handler({ url: `${PREFIX}/status`, method: 'GET', headers: {} }, res), true);
  assert.equal(result.status, 401);
  assert.equal(touched, false);
  assert.equal(await handler({ url: '/api/moderation/mode', method: 'GET' }, res), false);
});
