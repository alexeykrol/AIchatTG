import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadOperatorConsoleConfig } from '../src/config.mjs';
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

test('Console release time accepts only a real UTC timestamp', () => {
  assert.equal(loadOperatorConsoleConfig({ OPERATOR_CONSOLE_RELEASED_AT: '2026-09-15T21:40:00Z' }).releasedAt,
    '2026-09-15T21:40:00Z');
  for (const value of ['2026-02-30T12:00:00Z', '2026-09-15T21:40:00-07:00', 'tomorrow']) {
    assert.throws(() => loadOperatorConsoleConfig({ OPERATOR_CONSOLE_RELEASED_AT: value }),
      /OPERATOR_CONSOLE_RELEASED_AT/u);
  }
  assert.throws(() => loadOperatorConsoleConfig({ NODE_ENV: 'production' }),
    /OPERATOR_CONSOLE_RELEASED_AT is required/u);
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
    for (const page of ['/settings-v3.html', '/domains-v3.html', '/analytics-v3.html']) {
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

test('operator routes share a concise Russian menu and exact release stamp', async () => {
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
    assert.match(html, /Настройки/u);
    assert.match(html, /Базы ответов/u);
    assert.match(html, /Аналитика/u);
    assert.match(html, /Помощь/u);
    const pages = ['/moderation-v3.html', '/assistant-v3.html', '/settings-v3.html',
      '/domains-v3.html', '/analytics-v3.html', '/tests-v3.html', '/help-v3.html'];
    const menus = [];
    for (const path of pages) {
      const response = await fetch(`${url}${path}`, { headers: { authorization: auth() } });
      assert.equal(response.status, 200);
      const page = await response.text();
      assert.match(page, /<html lang="ru">/u);
      assert.match(page, /\/console-v3\.css/u);
      assert.match(page, /Версия 3\.1\.0 · релиз 15\.09\.2026, 21:40:00 UTC/u);
      assert.doesNotMatch(page, /Панель управления AIchatTG|CONSOLE_RELEASE_STAMP|class="subhead"|class="badge"/iu);
      assert.doesNotMatch(page, /Количество вопросов и оценка затрат по сохранённым ответам|Редактирование доступно\. Сохранение создаёт новую версию/u);
      assert.doesNotMatch(page, /Legacy assistant view|Domain knowledge|Assistant settings|Operator pages/u);
      const navigation = page.match(/<nav class="nav"[^>]*>([\s\S]*?)<\/nav>/u)?.[1];
      assert.ok(navigation, 'navigation present in ' + path);
      menus.push([...navigation.matchAll(/<a [^>]*href="(\/[^"]+)"[^>]*>([^<]+)<\/a>/gu)]
        .map((match) => [match[1], match[2]]));
    }
    const expectedMenu = pages.map((path, index) => [path,
      ['Модерация', 'Ассистент', 'Настройки', 'Базы ответов', 'Аналитика', 'Тесты', 'Помощь'][index]]);
    for (const menu of menus) assert.deepEqual(menu, expectedMenu);
    const help = await (await fetch(url + '/help-v3.html', { headers: { authorization: auth() } })).text();
    assert.match(help, /Как подготовить настройки ассистента|Как подготовить базу ответов|Почему в аналитике стоит «—»/u);
    assert.equal((await fetch(url + '/api/operator/release')).status, 401);
    assert.deepEqual(await (await fetch(url + '/api/operator/release', {
      headers: { authorization: auth() },
    })).json(), { version: '3.1.0', releasedAt: '2026-09-15T21:40:00Z' });
    const aliases = new Map([
      ['/moderation.html', '/moderation-v3.html'], ['/assistant.html', '/assistant-v3.html'],
      ['/eval.html', '/tests-v3.html'], ['/settings-v2.html', '/settings-v3.html'],
      ['/domains.html', '/domains-v3.html'], ['/analytics.html', '/analytics-v3.html'],
    ]);
    for (const [oldPath, newPath] of aliases) {
      const response = await fetch(`${url}${oldPath}`, {
        headers: { authorization: auth() }, redirect: 'manual',
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), newPath);
    }
    for (const path of ['/legacy/v1/moderation.html', '/legacy/v1/assistant.html',
      '/legacy/v1/eval.html', '/legacy/v2/settings-v2.html', '/legacy/v2/domains.html',
      '/legacy/v2/analytics.html']) {
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
  }, { ...config, releasedAt: '2026-09-15T21:40:00Z' });
});

test('operator routes are hidden when the token is absent', async () => {
  const server = createOperatorConsoleServer({ config: { ...config, token: '' }, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/api/moderation/mode`, { headers: { authorization: auth() } })).status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
