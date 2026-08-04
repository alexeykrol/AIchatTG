import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  mapTributeNewSubscription,
  signTributeWebhook,
  verifyTributeWebhook,
} from '../src/tribute.mjs';

const CONFIG = {
  tributeSubscriptionIds: ['1644', '2000'],
  tributeChannelId: '614',
  targetChatId: '-1003840653970',
};

function event(overrides = {}, payloadOverrides = {}) {
  return {
    name: 'new_subscription',
    created_at: '2026-08-02T19:59:00.000Z',
    sent_at: '2026-08-02T20:00:00.000Z',
    payload: {
      subscription_name: 'Paid community',
      subscription_id: 1644,
      period_id: 1547,
      period: 'monthly',
      type: 'regular',
      price: 1000,
      amount: 700,
      currency: 'rub',
      user_id: 31326,
      trb_user_id: 'T-31326',
      telegram_user_id: 196267257,
      telegram_username: 'alexeykrol',
      channel_id: 614,
      channel_name: 'Private community',
      expires_at: '2026-09-02T19:59:00.000Z',
      ...payloadOverrides,
    },
    ...overrides,
  };
}

describe('Tribute webhook adapter', () => {
  test('verifies the HMAC-SHA256 over the exact raw body with timing-safe bytes', () => {
    const apiKey = 'runtime-only-tribute-key';
    const body = Buffer.from('{"name":"new_subscription","note":"рубли"}', 'utf8');
    const signature = signTributeWebhook(apiKey, body);
    assert.match(signature, /^[a-f0-9]{64}$/u);
    assert.equal(verifyTributeWebhook({ apiKey, rawBody: body, signature }), true);
    assert.equal(verifyTributeWebhook({ apiKey, rawBody: body, signature: `sha256=${signature}` }), true);
    assert.equal(verifyTributeWebhook({ apiKey, rawBody: Buffer.concat([body, Buffer.from(' ')]), signature }), false);
    assert.equal(verifyTributeWebhook({ apiKey, rawBody: body, signature: 'wrong' }), false);
  });

  test('maps an allowlisted positive RUB payment to the existing invite flow', () => {
    const mapped = mapTributeNewSubscription(event(), CONFIG);
    assert.equal(mapped.event.event_type, 'newcomer');
    assert.equal(mapped.event.chat_id, CONFIG.targetChatId);
    assert.equal(mapped.event.user.id, 196267257);
    assert.equal(mapped.event.user.username, 'alexeykrol');
    assert.match(mapped.event.event_id, /^tribute-[a-f0-9]{64}$/u);
    assert.equal(mapped.canonicalBody.includes('telegram_username'), false);
  });

  test('uses stable identity across Tribute retries and excludes sent_at', () => {
    const first = mapTributeNewSubscription(event(), CONFIG);
    const retry = mapTributeNewSubscription(
      event({ sent_at: '2026-08-03T04:00:00.000Z' }),
      CONFIG,
    );
    assert.equal(retry.event.event_id, first.event.event_id);
    assert.equal(retry.canonicalBody, first.canonicalBody);
    assert.equal(first.canonicalBody.includes('sent_at'), false);
  });

  test('normalizes equivalent timestamps before deriving the stable identity', () => {
    const first = mapTributeNewSubscription(event(), CONFIG);
    const equivalent = mapTributeNewSubscription(event({
      created_at: '2026-08-02T12:59:00-07:00',
    }, {
      expires_at: '2026-09-02T12:59:00-07:00',
    }), CONFIG);
    assert.equal(equivalent.event.event_id, first.event.event_id);
    assert.equal(equivalent.canonicalBody, first.canonicalBody);
  });

  test('accepts official paid periods and an absent optional subscription type', () => {
    for (const period of ['onetime', 'weekly', 'monthly', 'quarterly', 'halfyearly', 'yearly']) {
      const payload = { period };
      if (period === 'onetime') payload.type = undefined;
      const mapped = mapTributeNewSubscription(event({}, payload), CONFIG);
      assert.equal(mapped.event.user.id, 196267257);
    }
  });

  test('returns ignored for authentic but irrelevant provider events', () => {
    assert.equal(mapTributeNewSubscription(event({ name: 'renewed_subscription' }), CONFIG).ignored, 'unsupported_event');
    assert.equal(mapTributeNewSubscription(event({}, { subscription_id: 9999 }), CONFIG).ignored, 'subscription_not_allowlisted');
    assert.equal(mapTributeNewSubscription(event({}, { channel_id: 999 }), CONFIG).ignored, 'channel_not_allowlisted');
    assert.equal(mapTributeNewSubscription(event({}, { currency: 'EUR' }), CONFIG).ignored, 'non_rub_currency');
    assert.equal(mapTributeNewSubscription(event({}, { type: 'trial' }), CONFIG).ignored, 'trial_subscription');
    assert.equal(mapTributeNewSubscription(event({}, { type: undefined, period: 'trial' }), CONFIG).ignored, 'trial_subscription');
    assert.equal(mapTributeNewSubscription(event({}, { price: 0 }), CONFIG).ignored, 'non_positive_price');
  });

  test('uses the subscription allowlist without requiring a Tribute channel id', () => {
    const mapped = mapTributeNewSubscription(
      event({}, { subscription_id: 2000, channel_id: 777 }),
      { ...CONFIG, tributeChannelId: '' },
    );
    assert.equal(mapped.event.user.id, 196267257);
    assert.match(mapped.event.event_id, /^tribute-[a-f0-9]{64}$/u);
  });

  test('rejects malformed eligible paid events', () => {
    assert.throws(
      () => mapTributeNewSubscription(event({}, { telegram_user_id: '196267257' }), CONFIG),
      /telegram_user_id must be a safe integer/u,
    );
    assert.throws(
      () => mapTributeNewSubscription(event({}, { period: 'daily' }), CONFIG),
      /period is not supported/u,
    );
    assert.throws(
      () => mapTributeNewSubscription(event({}, { telegram_username: 'bad name' }), CONFIG),
      /valid Telegram username/u,
    );
  });
});
