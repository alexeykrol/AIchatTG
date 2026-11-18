import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createJoinGatekeeperHttpServer, routePath, secretMatches } from '../src/http-server.mjs';
import { ALLOWED_UPDATES, registerWebhook } from '../src/register-webhook.mjs';
import { loadScenario, validateScenario } from '../src/scenario.mjs';
import { JoinStore } from '../src/store.mjs';
import {
  baseEnv,
  FakeTelegram,
  rawScenario,
  readyScenarioFile,
  SECRET,
  tempDir,
} from './helpers.mjs';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const dirs = [];
function dir() {
  const d = tempDir();
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('scenario', () => {
  test('bundled scenario is valid and draft', () => {
    const scenario = loadScenario();
    assert.equal(scenario.status, 'draft');
    assert.equal(scenario.questions.length, 3);
    assert.deepEqual(scenario.limits, {
      answerTimeoutSeconds: 1800, dmWindowSeconds: 300, maxApplicationsPerUserPerDay: 3, retentionDays: 30, probationDays: 7,
    });
  });

  test('scenario-cli check prints a summary', () => {
    const out = execFileSync(process.execPath, ['src/scenario-cli.mjs', 'check'], { cwd: APP_ROOT, encoding: 'utf8' });
    const summary = JSON.parse(out);
    assert.equal(summary.ok, true);
    assert.equal(summary.status, 'draft');
  });

  const broken = {
    'duplicate question id': (raw) => { raw.questions[1].id = raw.questions[0].id; },
    'missing referenced prompt': (raw) => { raw.questions[0].prompt = 'nope'; },
    'missing required message': (raw) => { delete raw.messages.timeout; },
    'accepted references unknown option': (raw) => { raw.questions[0].accepted.push('ghost'); },
    'bad free_text rule': (raw) => { raw.questions[1].rule.minWords = -1; },
    'bad regex': (raw) => { raw.screening.linkPatterns.push('(['); },
    'timeout out of range': (raw) => { raw.limits.answerTimeoutSeconds = 5; },
    'dm window above Telegram 5 minutes': (raw) => { raw.limits.dmWindowSeconds = 600; },
    'unknown status': (raw) => { raw.status = 'live'; },
    'unknown key': (raw) => { raw.extra = true; },
    'empty keywords': (raw) => { raw.screening.spamKeywords = []; },
  };
  for (const [name, edit] of Object.entries(broken)) {
    test(`rejects broken scenario: ${name}`, () => {
      const raw = rawScenario();
      edit(raw);
      assert.throws(() => validateScenario(raw), /invalid join scenario/);
    });
  }
});

describe('config', () => {
  test('defaults: shadow mode, loopback bind, port 8788, db inside data root', () => {
    const d = dir();
    const config = loadConfig(baseEnv(d));
    assert.equal(config.mode, 'shadow');
    assert.equal(config.bindHost, '127.0.0.1');
    assert.equal(config.port, 8788);
    assert.equal(config.databasePath, path.join(path.resolve(d), 'join-gatekeeper.sqlite'));
    assert.equal(loadConfig(baseEnv(d, { JOIN_GATEKEEPER_CONTAINER_BIND: 'true' })).bindHost, '0.0.0.0');
  });

  test('enforce mode with a draft scenario refuses to start', () => {
    assert.throws(() => loadConfig(baseEnv(dir(), { JOIN_GATEKEEPER_MODE: 'enforce' })), /requires a ready scenario/);
  });

  test('enforce mode with a ready scenario starts', () => {
    const d = dir();
    const config = loadConfig(baseEnv(d, { JOIN_GATEKEEPER_MODE: 'enforce', JOIN_GATEKEEPER_SCENARIO_PATH: readyScenarioFile(d) }));
    assert.equal(config.mode, 'enforce');
  });

  test('rejects bad chat ids, duplicates, token, secret, mode', () => {
    const d = dir();
    for (const ids of ['123', '-100x', '', '-1001,-1001']) {
      assert.throws(() => loadConfig(baseEnv(d, { JOIN_GATEKEEPER_TARGET_CHAT_IDS: ids })), /TARGET_CHAT_IDS/);
    }
    assert.deepEqual([...loadConfig(baseEnv(d, { JOIN_GATEKEEPER_TARGET_CHAT_IDS: '-1001, -1002' })).targetChatIds], ['-1001', '-1002']);
    assert.throws(() => loadConfig(baseEnv(d, { JOIN_GATEKEEPER_BOT_TOKEN: 'nope' })), /BOT_TOKEN/);
    assert.throws(() => loadConfig(baseEnv(d, { JOIN_GATEKEEPER_WEBHOOK_SECRET: 'short' })), /WEBHOOK_SECRET/);
    assert.throws(() => loadConfig(baseEnv(d, { JOIN_GATEKEEPER_MODE: 'live' })), /MODE/);
  });

  test('database path must stay inside the data root', () => {
    const d = dir();
    assert.throws(() => loadConfig(baseEnv(d, { JOIN_GATEKEEPER_DATABASE_PATH: '../escape.sqlite' })), /DATABASE_PATH/);
    assert.throws(() => loadConfig(baseEnv(d, { JOIN_GATEKEEPER_DATABASE_PATH: '/etc/escape.sqlite' })), /DATABASE_PATH/);
    assert.throws(() => loadConfig(baseEnv(d, { JOIN_GATEKEEPER_DATABASE_PATH: 'a/../../b.sqlite' })), /DATABASE_PATH/);
    const nested = loadConfig(baseEnv(d, { JOIN_GATEKEEPER_DATABASE_PATH: 'db/join.sqlite' }));
    assert.equal(nested.databasePath, path.join(path.resolve(d), 'db', 'join.sqlite'));
  });

  test('public base URL must be https', () => {
    const d = dir();
    assert.throws(() => loadConfig(baseEnv(d, { JOIN_GATEKEEPER_PUBLIC_BASE_URL: 'http://example.com' })), /https/);
    assert.equal(
      loadConfig(baseEnv(d, { JOIN_GATEKEEPER_PUBLIC_BASE_URL: 'https://example.com/join-gatekeeper/' })).publicBaseUrl,
      'https://example.com/join-gatekeeper',
    );
  });
});

describe('register-webhook', () => {
  test('registers chat_join_request, message and callback_query with the secret', async () => {
    const d = dir();
    const telegram = new FakeTelegram();
    const receipts = [];
    await registerWebhook({
      env: baseEnv(d, {
        JOIN_GATEKEEPER_SCENARIO_PATH: readyScenarioFile(d),
        JOIN_GATEKEEPER_PUBLIC_BASE_URL: 'https://example.com/join-gatekeeper',
      }),
      telegramFactory: () => telegram,
      writeReceipt: (r) => receipts.push(r),
    });
    const [call] = telegram.byMethod('setWebhook');
    assert.equal(call.payload.url, 'https://example.com/join-gatekeeper/webhooks/telegram');
    assert.equal(call.payload.secret_token, SECRET);
    assert.ok(call.payload.allowed_updates.includes('chat_join_request'));
    assert.deepEqual(call.payload.allowed_updates, [...ALLOWED_UPDATES]);
    assert.equal(receipts.length, 1);
  });

  test('refuses a draft scenario or missing public URL', async () => {
    const d = dir();
    const telegram = new FakeTelegram();
    await assert.rejects(() => registerWebhook({
      env: baseEnv(d, { JOIN_GATEKEEPER_PUBLIC_BASE_URL: 'https://example.com' }),
      telegramFactory: () => telegram,
      writeReceipt: () => {},
    }), /ready join scenario/);
    await assert.rejects(() => registerWebhook({
      env: baseEnv(d, { JOIN_GATEKEEPER_SCENARIO_PATH: readyScenarioFile(d) }),
      telegramFactory: () => telegram,
      writeReceipt: () => {},
    }), /PUBLIC_BASE_URL/);
    assert.deepEqual(telegram.calls, []);
  });
});

describe('http server', () => {
  async function withServer(fn) {
    const handled = [];
    const service = { handleUpdate: async (update) => { handled.push(update); return { action: 'ok' }; } };
    const server = createJoinGatekeeperHttpServer({
      config: { webhookSecret: SECRET, mode: 'shadow' },
      service,
      logger: { error() {} },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base, handled);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const post = (url, body, secret = SECRET) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
    body,
  });

  test('health, secret check, JSON errors, 404, prefix routing', async () => {
    await withServer(async (base, handled) => {
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/join-gatekeeper/health`)).status, 200);
      assert.equal((await post(`${base}/webhooks/telegram`, '{"update_id":1}', 'wrong_secret_value_123')).status, 401);
      assert.equal((await post(`${base}/webhooks/telegram`, '{"update_id":1}', null)).status, 401);
      assert.equal((await post(`${base}/webhooks/telegram`, '{bad json')).status, 400);
      assert.equal((await post(`${base}/webhooks/telegram`, '{"no_id":1}')).status, 400);
      assert.equal((await post(`${base}/webhooks/telegram`, JSON.stringify({ update_id: 1, pad: 'x'.repeat(40_000) }))).status, 413);
      assert.equal(handled.length, 0);
      assert.equal((await post(`${base}/webhooks/telegram`, '{"update_id":7}')).status, 200);
      assert.equal((await post(`${base}/join-gatekeeper/webhooks/telegram`, '{"update_id":8}')).status, 200);
      assert.deepEqual(handled.map((u) => u.update_id), [7, 8]);
      assert.equal((await fetch(`${base}/webhooks/telegram`)).status, 404);
      assert.equal((await fetch(`${base}/admin`)).status, 404);
      assert.equal((await post(`${base}/gatekeeper/webhooks/telegram`, '{"update_id":9}')).status, 404);
    });
  });

  test('helpers', () => {
    assert.equal(routePath('/join-gatekeeper/webhooks/telegram?x=1'), '/webhooks/telegram');
    assert.equal(routePath('/join-gatekeeperX/health'), '/join-gatekeeperX/health');
    assert.equal(secretMatches(SECRET, SECRET), true);
    assert.equal(secretMatches(`${SECRET}x`, SECRET), false);
    assert.equal(secretMatches(undefined, SECRET), false);
  });
});

describe('store', () => {
  test('one active application per chat+user; schema guards', () => {
    const d = dir();
    const store = new JoinStore(path.join(d, 'join.sqlite'));
    try {
      const base = { chatId: '-1001', userId: '5', now: 1 };
      assert.ok(store.createApplication({ ...base, state: 'asking' }));
      assert.equal(store.createApplication({ ...base, state: 'screening' }), null);
      assert.ok(store.createApplication({ ...base, state: 'declined_rate_limit' }), 'inactive states are not unique');
      assert.ok(store.createApplication({ ...base, chatId: '-1002', state: 'asking' }));
      assert.throws(() => store.createApplication({ ...base, userId: '6', state: 'bogus' }), /CHECK/);
      assert.throws(() => store.updateApplication('x', { user_id: '1' }), /not updatable/);
      assert.equal(store.claimUpdate(1, 1), true);
      assert.equal(store.claimUpdate(1, 2), false);
    } finally {
      store.close();
    }
  });

  test('source has no DROP TABLE / TRUNCATE / unconditional DELETE (INV-001)', () => {
    const source = fs.readFileSync(path.join(APP_ROOT, 'src', 'store.mjs'), 'utf8');
    assert.doesNotMatch(source, /DROP\s+TABLE/i);
    assert.doesNotMatch(source, /TRUNCATE\s+TABLE/i);
    for (const match of source.matchAll(/DELETE\s+FROM\s+\w+([^`']*)/gi)) {
      assert.match(match[1], /WHERE/i, `unconditional DELETE: ${match[0]}`);
    }
  });
});
