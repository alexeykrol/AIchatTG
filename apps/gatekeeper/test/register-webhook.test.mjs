import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { registerWebhook } from '../src/register-webhook.mjs';

function env(overrides = {}) {
  return {
    GATEKEEPER_BOT_TOKEN: '123456:valid_token',
    GATEKEEPER_BOT_USERNAME: '@krolkeeper_bot',
    GATEKEEPER_TARGET_CHAT_ID: '-1003840653970',
    GATEKEEPER_TELEGRAM_WEBHOOK_SECRET: 'telegram_secret',
    GATEKEEPER_TRIBUTE_API_KEY: 'tribute-runtime-api-key',
    GATEKEEPER_TRIBUTE_SUBSCRIPTION_IDS: '1644',
    GATEKEEPER_LINK_SIGNING_SECRET: 'link-signing-secret-at-least-32-chars',
    GATEKEEPER_PUBLIC_BASE_URL: 'https://news.questtales.com',
    ...overrides,
  };
}

describe('webhook registration preflight', () => {
  test('rejects the checked-in draft before constructing a Telegram client', async () => {
    let factoryCalls = 0;
    await assert.rejects(registerWebhook({
      env: env(),
      telegramFactory() {
        factoryCalls += 1;
        throw new Error('must not construct Telegram client');
      },
      writeReceipt() {},
    }), /draft status is allowed only/u);
    assert.equal(factoryCalls, 0);
  });

  test('does not let the local draft flag authorize external registration', async () => {
    let factoryCalls = 0;
    await assert.rejects(registerWebhook({
      env: env({ GATEKEEPER_ALLOW_DRAFT_SCENARIO: 'true' }),
      telegramFactory() {
        factoryCalls += 1;
        throw new Error('must not construct Telegram client');
      },
      writeReceipt() {},
    }), /retired; draft scenarios are offline-simulator only/u);
    assert.equal(factoryCalls, 0);
  });

  test('registers only after the scenario preflight returns ready', async () => {
    const calls = [];
    const receipts = [];
    let providerOptions;
    const result = await registerWebhook({
      env: env(),
      scenarioProviderFactory(options) {
        providerOptions = options;
        return { load() { return { status: 'ready' }; } };
      },
      telegramFactory({ botToken }) {
        assert.equal(botToken, '123456:valid_token');
        return {
          async setWebhook(payload) {
            calls.push(payload);
            return true;
          },
        };
      },
      writeReceipt(receipt) {
        receipts.push(receipt);
      },
    });

    assert.equal(providerOptions.allowDraftScenario, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      url: 'https://news.questtales.com/webhooks/telegram',
      secret_token: 'telegram_secret',
      allowed_updates: ['message', 'chat_member', 'callback_query'],
      drop_pending_updates: false,
    });
    assert.deepEqual(result, receipts[0]);
  });
});
