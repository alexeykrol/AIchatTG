import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOperatorConsoleServer, validOperatorAuthorization } from '../src/server.mjs';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'aichattg-operator-server-'));
const safetyPromptPath = join(fixtureRoot, 'moderation-tg-v3.md');
writeFileSync(safetyPromptPath, 'Telegram safety prompt v3', { mode: 0o600 });

const config = {
  token: 'operator-test-token',
  runtimeDatabasePath: '/tmp/aichattg-operator-console-test-absent.sqlite',
  safetyPromptPath,
  runtimeFlags: { ingressEnabled: false, moderationMode: 'shadow', providerEnabled: false, notificationsEnabled: false },
  runtimeModels: {
    vendor: 'openai', moderator: 'gpt-5.6-terra', moderatorReasoning: 'medium',
    router: 'gpt-5.6-luna', answer: 'gpt-5.6-terra', routerReasoning: 'minimal',
    answerReasoning: 'low', answerMaxTokens: 2000,
  },
  assistantPolicy: { cooldownSec: 20, dailyPerUser: 20, knowledgeEnabled: false },
};

function auth(value = 'operator:operator-test-token') { return `Basic ${Buffer.from(value).toString('base64')}`; }

async function withServer(run, serverConfig = config) {
  const server = createOperatorConsoleServer({ config: serverConfig, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('operator auth is explicit and has no default password', () => {
  assert.equal(validOperatorAuthorization(auth(), 'operator-test-token'), true);
  assert.equal(validOperatorAuthorization(auth('operator:wrong'), 'operator-test-token'), false);
  assert.equal(validOperatorAuthorization(auth(), ''), false);
});

test('new pages require operator auth and domain edits save only a versioned candidate', async () => {
  const candidateRoot = mkdtempSync(join(tmpdir(), 'aichattg-operator-candidate-http-'));
  const serverConfig = {
    ...config, candidateRoot,
    assistantPolicy: {
      ...config.assistantPolicy, syntheticDailyPerUser: 200, dialogueTurnLimit: 3,
      chatIds: ['-1001'],
    },
  };
  await withServer(async (url) => {
    for (const page of ['/settings-v2.html', '/domains.html', '/analytics.html']) {
      assert.equal((await fetch(url + page)).status, 401);
      assert.equal((await fetch(url + page, { headers: { authorization: auth() } })).status, 200);
    }
    const domainList = await fetch(url + '/api/operator/domains', { headers: { authorization: auth() } });
    const listed = await domainList.json();
    assert.deepEqual(listed.domains.filter((domain) => domain.editable).map((domain) => domain.id),
      ['assistant-self', 'abuse']);
    const settingsBefore = await (await fetch(url + '/api/operator/settings', {
      headers: { authorization: auth() },
    })).json();
    const settingsBody = JSON.stringify({
      values: { ...settingsBefore.released, dailyPerUser: 25 },
      baseDigest: settingsBefore.baseDigest,
    });
    const settingsSaved = await fetch(url + '/api/operator/settings/candidates', {
      method: 'POST', headers: {
        authorization: auth(), 'content-type': 'application/json',
        'x-operator-intent': 'candidate-draft', origin: url,
      }, body: settingsBody,
    });
    assert.equal(settingsSaved.status, 201);
    assert.equal((await settingsSaved.json()).runtimeApplied, false);
    const settingsAfter = await (await fetch(url + '/api/operator/settings', {
      headers: { authorization: auth() },
    })).json();
    assert.equal(settingsAfter.released.dailyPerUser, 20);
    assert.equal(settingsAfter.candidate.dailyPerUser, 25);
    assert.equal((await fetch(url + '/api/operator/settings/candidates', {
      method: 'POST', headers: {
        authorization: auth(), 'content-type': 'application/json',
        'x-operator-intent': 'candidate-draft', origin: url,
      }, body: settingsBody,
    })).status, 409, 'a second save with a stale base revision is rejected');
    const analytics = await (await fetch(url + '/api/operator/analytics', {
      headers: { authorization: auth() },
    })).json();
    assert.equal(analytics.status, 'unavailable');
    assert.equal(analytics.total, null);
    const read = await fetch(url + '/api/operator/domains/assistant-self', { headers: { authorization: auth() } });
    const before = await read.json();
    const endpoint = url + '/api/operator/domains/assistant-self/candidates';
    const body = JSON.stringify({ text: before.releasedText + '\nLocal HTTP candidate.\n',
      baseDigest: before.baseDigest });
    assert.equal((await fetch(endpoint, { method: 'POST', headers: {
      authorization: auth(), 'content-type': 'application/json',
    }, body })).status, 403, 'candidate intent header is required');
    assert.equal((await fetch(endpoint, { method: 'POST', headers: {
      authorization: auth(), 'content-type': 'application/json', 'x-operator-intent': 'candidate-draft',
      origin: 'https://unrelated.example',
    }, body })).status, 403, 'cross-origin candidate write is rejected');
    const saved = await fetch(endpoint, { method: 'POST', headers: {
      authorization: auth(), 'content-type': 'application/json', 'x-operator-intent': 'candidate-draft',
      origin: url,
    }, body });
    assert.equal(saved.status, 201);
    assert.equal((await saved.json()).runtimeApplied, false);
    const after = await (await fetch(url + '/api/operator/domains/assistant-self', {
      headers: { authorization: auth() },
    })).json();
    assert.equal(after.releasedText, before.releasedText);
    assert.match(after.candidateText, /Local HTTP candidate/u);
  }, serverConfig);
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
    const stats = await fetch(`${url}/api/moderation/stats`, { headers: { authorization: auth() } });
    assert.deepEqual((await stats.json()).pending, []);
    const prompt = await fetch(`${url}/api/moderation/prompts/tg-v3?platform=telegram`, { headers: { authorization: auth() } });
    assert.deepEqual(await prompt.json(), {
      version: 'tg-v3', text: 'Telegram safety prompt v3', active: true, readOnly: true,
    });
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
