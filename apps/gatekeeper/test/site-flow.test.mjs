import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { GatekeeperService } from '../src/gatekeeper.mjs';
import { createGatekeeperHttpServer } from '../src/http-server.mjs';
import { DEFAULT_SCENARIO_PATH, parseScenarioMarkdown } from '../src/scenario.mjs';
import { signSiteWebhook } from '../src/site.mjs';
import { GatekeeperStore } from '../src/store.mjs';

const SITE_SECRET = 'site-webhook-secret-with-more-than-32-characters';
const LINK_SECRET = 'link-signing-secret-at-least-32-chars';

function readyScenario() {
  const source = fs.readFileSync(DEFAULT_SCENARIO_PATH, 'utf8');
  const draft = parseScenarioMarkdown(source, { allowDraftScenario: true });
  const value = structuredClone(draft);
  value.status = 'ready';
  value.messages.site_email_instruction.subject = 'Ваш онбординг';
  value.messages.site_email_instruction.text = 'Откройте персональную ссылку и выполните шаги.';
  value.messages.site_instruction.text = 'Прочитайте материалы и подтвердите завершение.';
  value.messages.site_instruction.links = [
    { label: 'Правила', url: 'https://community.example/rules' },
    { label: 'Материал', url: 'https://community.example/start' },
  ];
  value.messages.site_invalid_link.text = 'Ссылка недействительна.';
  value.messages.site_completion_success.text = 'Онбординг завершён.';
  value.messages.site_completion_already_completed.text = 'Онбординг уже был завершён.';
  return value;
}

function configuration() {
  return {
    botToken: '1:token',
    botUsername: 'example_bot',
    targetChatId: '-1001',
    telegramWebhookSecret: 'telegram-secret',
    tributeApiKey: 'tribute-secret',
    tributeSubscriptionIds: ['1'],
    tributeChannelId: '',
    linkSigningSecret: LINK_SECRET,
    startTokenTtlSeconds: 604_800,
    siteEnabled: true,
    siteWebhookSecret: SITE_SECRET,
    siteTokenTtlSeconds: 604_800,
    zapierEnabled: true,
    zapierSiteInviteUrl: 'https://hooks.zapier.example/site',
    zapierCompletionUrl: 'https://hooks.zapier.example/completed',
    zapierAuthToken: '',
    zapierTimeoutMs: 10_000,
    adminSettingsToken: 'admin-settings-token-with-more-than-32-characters',
    publicBaseUrl: 'https://news.questtales.com',
    scenarioPath: DEFAULT_SCENARIO_PATH,
  };
}

function registrationPayload() {
  return {
    event_id: 'registration-001',
    event_type: 'student_registered',
    occurred_at: '2026-08-03T10:00:00.000Z',
    email: 'Student@Example.org',
  };
}

describe('site email-only onboarding flow', () => {
  let store;
  let server;
  let baseUrl;
  let deliveries;
  let service;
  let config;

  beforeEach(async () => {
    store = new GatekeeperStore(':memory:');
    deliveries = [];
    config = configuration();
    service = new GatekeeperService({
      config,
      store,
      telegram: { async sendMessage() { throw new Error('Telegram must not be called'); } },
      clock: () => Date.parse('2026-08-03T10:05:00.000Z'),
      randomId: () => '22222222-2222-4222-8222-222222222222',
      zapierSender: async ({ eventType, data }) => {
        deliveries.push({ eventType, data });
        return { state: 'sent', status: 200 };
      },
    });
    const scenario = readyScenario();
    server = createGatekeeperHttpServer({
      config,
      service,
      store,
      ingressScenarioProvider: { load: () => scenario },
      adminScenarioProvider: { load: () => scenario },
      logger: { error() {} },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    store?.close();
  });

  test('accepts one signed registration, emails one capability, and completes once', async () => {
    const rawBody = JSON.stringify(registrationPayload());
    const headers = {
      'content-type': 'application/json',
      'x-gatekeeper-site-signature': signSiteWebhook(SITE_SECRET, Buffer.from(rawBody)),
    };
    const first = await fetch(`${baseUrl}/webhooks/site-registration`, {
      method: 'POST', headers, body: rawBody,
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.deepEqual(firstBody, {
      status: 'ok',
      result: { state: 'pending', invitationDelivery: 'sent', duplicate: false },
    });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].eventType, 'site_invite_requested');
    assert.equal(deliveries[0].data.email, 'Student@example.org');
    assert.equal(deliveries[0].data.email_subject, 'Ваш онбординг');
    assert.equal(JSON.stringify(firstBody).includes('Student@example.org'), false);

    const duplicate = await fetch(`${baseUrl}/webhooks/site-registration`, {
      method: 'POST', headers, body: rawBody,
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).result.duplicate, true);
    assert.equal(deliveries.length, 1);

    const siteCase = store.findSiteCaseByRegistrationEventId('registration-001');
    assert.ok(siteCase);
    assert.equal(siteCase.email_ciphertext.includes('Student@example.org'), false);
    const token = service.siteTokenForCase(siteCase);
    const page = await fetch(`${baseUrl}/onboarding/site?token=${encodeURIComponent(token)}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const pageText = await page.text();
    assert.match(pageText, /Прочитайте материалы и подтвердите завершение/u);
    assert.equal(pageText.includes('Student@example.org'), false);

    const completed = await fetch(`${baseUrl}/onboarding/site/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    assert.equal(completed.status, 200);
    assert.match(await completed.text(), /Онбординг завершён/u);
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1].eventType, 'onboarding_completed');
    assert.equal(deliveries[1].data.source, 'site');

    const completedAgain = await fetch(`${baseUrl}/onboarding/site/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    assert.equal(completedAgain.status, 200);
    assert.match(await completedAgain.text(), /уже был завершён/u);
    assert.equal(deliveries.length, 2);
    assert.deepEqual(store.siteSummary(), { pending: 0, completed: 1 });
  });

  test('rejects a bad signature before scenario load, DB claim, or Zapier call', async () => {
    const scenario = readyScenario();
    let loads = 0;
    await new Promise((resolve) => server.close(resolve));
    server = createGatekeeperHttpServer({
      config: configuration(), service, store,
      ingressScenarioProvider: { load() { loads += 1; return scenario; } },
      adminScenarioProvider: { load: () => scenario },
      logger: { error() {} },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/webhooks/site-registration`, {
      method: 'POST',
      headers: { 'x-gatekeeper-site-signature': '0'.repeat(64) },
      body: JSON.stringify(registrationPayload()),
    });
    assert.equal(response.status, 401);
    assert.equal(loads, 0);
    assert.equal(store.siteSummary().pending, 0);
    assert.equal(deliveries.length, 0);
  });

  test('rejects HMAC-valid duplicate decoded JSON keys before parsing or claiming', async () => {
    const bodies = [
      '{"event_id":"registration-first","event_id":"registration-second","event_type":"student_registered","occurred_at":"2026-08-03T10:00:00.000Z","email":"student@example.org"}',
      '{"event_id":"registration-first","event_\\u0069d":"registration-second","event_type":"student_registered","occurred_at":"2026-08-03T10:00:00.000Z","email":"student@example.org"}',
    ];
    for (const rawBody of bodies) {
      const response = await fetch(`${baseUrl}/webhooks/site-registration`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gatekeeper-site-signature': signSiteWebhook(SITE_SECRET, Buffer.from(rawBody)),
        },
        body: rawBody,
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /duplicate JSON key at root\.event_id/u);
    }
    assert.equal(store.siteSummary().pending, 0);
    assert.equal(deliveries.length, 0);
  });

  test('keeps the settings page and snapshot behind runtime Basic auth', async () => {
    const unauthenticated = await fetch(`${baseUrl}/admin/gatekeeper`);
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get('www-authenticate'), /^Basic /u);

    const authorization = `Basic ${Buffer.from(`gatekeeper:${config.adminSettingsToken}`).toString('base64')}`;
    const page = await fetch(`${baseUrl}/admin/gatekeeper`, { headers: { authorization } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<h1>Привратник<\/h1>/u);
    const snapshot = await fetch(`${baseUrl}/admin/settings/snapshot`, {
      headers: { authorization },
    });
    assert.equal(snapshot.status, 200);
    const serialized = JSON.stringify(await snapshot.json());
    assert.equal(serialized.includes(config.adminSettingsToken), false);

    config.adminSettingsToken = '';
    assert.equal((await fetch(`${baseUrl}/admin/settings/snapshot`, {
      headers: { authorization },
    })).status, 404);
  });

  test('atomically preserves the site case and outbox intent across a sender crash', async () => {
    let attempts = 0;
    service.zapierSender = async () => {
      attempts += 1;
      throw new Error('simulated process boundary');
    };
    const rawBody = JSON.stringify(registrationPayload());
    const headers = {
      'content-type': 'application/json',
      'x-gatekeeper-site-signature': signSiteWebhook(SITE_SECRET, Buffer.from(rawBody)),
    };
    const first = await fetch(`${baseUrl}/webhooks/site-registration`, {
      method: 'POST', headers, body: rawBody,
    });
    assert.equal(first.status, 500);
    const siteCase = store.findSiteCaseByRegistrationEventId('registration-001');
    assert.equal(siteCase.status, 'pending');
    assert.match(siteCase.payload_fingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(Object.hasOwn(siteCase, 'payload_sha256'), false);
    const outbox = store.db.prepare(`
      SELECT * FROM gatekeeper_zapier_deliveries WHERE onboarding_case_id = ?
    `).get(siteCase.id);
    assert.equal(outbox.state, 'intent');

    const duplicate = await fetch(`${baseUrl}/webhooks/site-registration`, {
      method: 'POST', headers, body: rawBody,
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).result.invitationDelivery, 'intent');
    assert.equal(attempts, 1);
  });

  test('atomically preserves completion and its outbox intent before delivery', async () => {
    const rawBody = JSON.stringify(registrationPayload());
    const headers = {
      'content-type': 'application/json',
      'x-gatekeeper-site-signature': signSiteWebhook(SITE_SECRET, Buffer.from(rawBody)),
    };
    assert.equal((await fetch(`${baseUrl}/webhooks/site-registration`, {
      method: 'POST', headers, body: rawBody,
    })).status, 200);
    const siteCase = store.findSiteCaseByRegistrationEventId('registration-001');
    const token = service.siteTokenForCase(siteCase);
    let completionAttempts = 0;
    service.zapierSender = async () => {
      completionAttempts += 1;
      throw new Error('simulated completion boundary');
    };
    const first = await fetch(`${baseUrl}/onboarding/site/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    assert.equal(first.status, 500);
    assert.equal(store.findSiteCaseById(siteCase.id).status, 'completed');
    const completionOutbox = store.db.prepare(`
      SELECT * FROM gatekeeper_zapier_deliveries
      WHERE onboarding_case_id = ? AND event_type = 'onboarding_completed'
    `).get(siteCase.id);
    assert.equal(completionOutbox.state, 'intent');

    const duplicate = await fetch(`${baseUrl}/onboarding/site/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    assert.equal(duplicate.status, 200);
    assert.match(await duplicate.text(), /уже был завершён/u);
    assert.equal(completionAttempts, 1);
  });
});

test('Tribute completion emits one Zapier completion event and a repeated callback emits none', async () => {
  const store = new GatekeeperStore(':memory:');
  const calls = [];
  let messageId = 100;
  const config = {
    ...configuration(),
    targetChatId: '-1003840653970',
  };
  const service = new GatekeeperService({
    config,
    store,
    telegram: {
      async sendMessage() { messageId += 1; return { message_id: messageId }; },
      async answerCallbackQuery() { return true; },
    },
    clock: () => Date.parse('2026-08-03T10:05:00.000Z'),
    randomId: () => '33333333-3333-4333-8333-333333333333',
    zapierSender: async ({ eventType, data }) => {
      calls.push({ eventType, data });
      return { state: 'sent', status: 200 };
    },
  });
  const scenario = readyScenario();
  try {
    await service.handleExternalEvent({
      event_id: 'tribute-event-1',
      event_type: 'newcomer',
      chat_id: config.targetChatId,
      user: { id: 196267257, first_name: 'Новичок' },
    }, '{"tribute":true}', { scenario });
    const invitation = store.findInvitationByUser(config.targetChatId, 196267257);
    const token = service.startTokenForInvitation(invitation);
    await service.handleStart({
      chat: { id: 196267257, type: 'private' },
      from: { id: 196267257 },
      text: `/start ${token}`,
    }, scenario);
    await service.handleEmail({
      chat: { id: 196267257, type: 'private' },
      from: { id: 196267257 },
      text: 'student@example.org',
    }, scenario);
    const completed = await service.handleCompletion({
      id: 'callback-1', from: { id: 196267257 }, data: `gk_done:${token}`,
    }, scenario);
    assert.equal(completed.completionDelivery, 'sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].eventType, 'onboarding_completed');
    assert.equal(calls[0].data.source, 'tribute');
    assert.equal(calls[0].data.email, 'student@example.org');
    assert.equal(store.db.prepare(`
      SELECT state FROM gatekeeper_zapier_deliveries
      WHERE onboarding_case_id = ? AND event_type = 'onboarding_completed'
    `).get(invitation.id).state, 'sent');

    const duplicate = await service.handleCompletion({
      id: 'callback-2', from: { id: 196267257 }, data: `gk_done:${token}`,
    }, scenario);
    assert.equal(duplicate.duplicate, true);
    assert.equal(calls.length, 1);
  } finally {
    store.close();
  }
});
