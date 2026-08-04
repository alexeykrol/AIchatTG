import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorConsoleServer, validOperatorAuthorization } from '../src/server.mjs';

const config = {
  token: 'operator-test-token',
  runtimeFlags: { ingressEnabled: false, moderationMode: 'shadow', providerEnabled: false, notificationsEnabled: false },
  gatekeeperFlags: { scenarioReady: false, siteEnabled: false, zapierEnabled: false },
};

const overview = {
  schemaVersion: 1, product: 'AIchatTG', readOnly: true, generatedAt: '2026-08-04T00:00:00.000Z',
  bots: { moderator: { database: 'available', flags: {} }, assistant: { database: 'available', flags: {} }, gatekeeper: { database: 'available', flags: {} } },
  runtime: { state: 'available', reason: null, counts: {}, recovery: {} },
  gatekeeper: { state: 'available', reason: null, counts: {}, recovery: {} }, recentAudit: [],
};

function auth(value = 'operator:operator-test-token') { return `Basic ${Buffer.from(value).toString('base64')}`; }

async function withServer(run) {
  const server = createOperatorConsoleServer({ config, getOverview: () => overview, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('operator auth is explicit and has no default password', () => {
  assert.equal(validOperatorAuthorization(auth(), 'operator-test-token'), true);
  assert.equal(validOperatorAuthorization(auth('operator:wrong'), 'operator-test-token'), false);
  assert.equal(validOperatorAuthorization(auth(), ''), false);
});

test('operator routes require app-owned authentication while health stays public', async () => {
  await withServer(async (url) => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/`)).status, 401);
    assert.equal((await fetch(`${url}/`)).status, 401);
    const home = await fetch(`${url}/`, { headers: { authorization: auth() } });
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /AIchatTG Bot Console/);
    assert.equal(html.includes('News'), false);
    const script = await fetch(`${url}/operator.js`, { headers: { authorization: auth() } });
    assert.equal(script.status, 200);
    assert.equal((await script.text()).includes('News'), false);
    const api = await fetch(`${url}/api/v1/overview`, { headers: { authorization: auth() } });
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), overview);
    assert.equal((await fetch(`${url}/api/v1/overview`, { method: 'POST', headers: { authorization: auth() } })).status, 404);
  });
});

test('operator routes are hidden when the token is absent', async () => {
  const server = createOperatorConsoleServer({ config: { ...config, token: '' }, getOverview: () => overview, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/api/v1/overview`, { headers: { authorization: auth() } })).status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
