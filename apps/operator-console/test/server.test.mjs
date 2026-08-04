import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorConsoleServer, validOperatorAuthorization } from '../src/server.mjs';

const config = {
  token: 'operator-test-token',
  runtimeDatabasePath: '/tmp/aichattg-operator-console-test-absent.sqlite',
  safetyPromptPath: '/tmp/aichattg-prompt-test-absent.md',
  runtimeFlags: { ingressEnabled: false, moderationMode: 'shadow', providerEnabled: false, notificationsEnabled: false },
  runtimeModels: {
    vendor: 'openai', moderator: 'gpt-5.6-terra', moderatorReasoning: 'medium',
    router: 'gpt-5.6-luna', answer: 'gpt-5.6-terra', routerReasoning: 'minimal',
    answerReasoning: 'low', answerMaxTokens: 2000,
  },
  assistantPolicy: { cooldownSec: 20, dailyPerUser: 20, knowledgeEnabled: false },
};

function auth(value = 'operator:operator-test-token') { return `Basic ${Buffer.from(value).toString('base64')}`; }

async function withServer(run) {
  const server = createOperatorConsoleServer({ config, logger: { error() {} } });
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
    assert.match(html, /<h1>Модерация<\/h1>/);
    assert.match(html, /Ассистент/);
    assert.match(html, /Тесты/);
    assert.equal(html.includes('Дайджесты'), false);
    assert.equal(html.includes('Публикация'), false);
    assert.equal(html.includes('Настройки'), false);
    for (const path of ['/moderation.html', '/assistant.html', '/eval.html']) {
      assert.equal((await fetch(`${url}${path}`, { headers: { authorization: auth() } })).status, 200);
    }
    const authStatus = await fetch(`${url}/api/auth/status`, { headers: { authorization: auth() } });
    assert.deepEqual(await authStatus.json(), { required: true, authenticated: true, readOnly: true });
    const mode = await fetch(`${url}/api/moderation/mode`, { headers: { authorization: auth() } });
    assert.equal((await mode.json()).mode, 'shadow');
    const events = await fetch(`${url}/api/moderation/events?limit=300`, { headers: { authorization: auth() } });
    assert.deepEqual(await events.json(), []);
    assert.equal((await fetch(`${url}/api/moderation/mode`, { method: 'POST', headers: { authorization: auth() } })).status, 409);
  });
});

test('operator routes are hidden when the token is absent', async () => {
  const server = createOperatorConsoleServer({ config: { ...config, token: '' }, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/api/moderation/mode`, { headers: { authorization: auth() } })).status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
