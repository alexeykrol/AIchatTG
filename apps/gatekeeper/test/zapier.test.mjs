import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildZapierPayload, sendZapierEvent } from '../src/zapier.mjs';

const CONFIG = {
  zapierEnabled: true,
  zapierSiteInviteUrl: 'https://hooks.zapier.com/hooks/catch/site-invite',
  zapierCompletionUrl: 'https://hooks.zapier.com/hooks/catch/completion',
  zapierAuthToken: 'runtime-only-token',
  zapierTimeoutMs: 5_000,
};

function siteInvite(overrides = {}) {
  return {
    onboarding_case_id: 'case-0001',
    registration_event_id: 'registration-0001',
    email: 'Student@EXAMPLE.com',
    onboarding_url: 'https://gatekeeper.example/onboarding/case-0001?t=opaque',
    occurred_at: '2026-08-03T19:00:00.000Z',
    email_subject: 'Ваш доступ к закрытому сообществу',
    email_text: 'Откройте персональную страницу.\n\nВыполните шаги и подтвердите завершение.',
    button_text: 'Начать онбординг',
    ...overrides,
  };
}

function completion(overrides = {}) {
  return {
    onboarding_case_id: 'case-0001',
    completed_at: '2026-08-03T20:00:00.000Z',
    source: 'site',
    ...overrides,
  };
}

describe('Zapier webhook adapter', () => {
  test('builds a minimal allowlisted invite payload with a stable idempotency key', () => {
    const first = buildZapierPayload('site_invite_requested', siteInvite());
    const retry = buildZapierPayload('site_invite_requested', siteInvite({
      occurred_at: '2026-08-03T20:00:00.000Z',
    }));
    assert.deepEqual(Object.keys(first), [
      'event_type',
      'idempotency_key',
      'onboarding_case_id',
      'registration_event_id',
      'email',
      'onboarding_url',
      'occurred_at',
      'email_subject',
      'email_text',
      'button_text',
    ]);
    assert.match(first.idempotency_key, /^gatekeeper-[a-f0-9]{64}$/u);
    assert.equal(first.idempotency_key, retry.idempotency_key);
    assert.equal(first.email, 'Student@example.com');
    assert.equal(first.email_subject, siteInvite().email_subject);
    assert.equal(first.email_text, siteInvite().email_text);
    assert.equal(first.button_text, siteInvite().button_text);
    const missingCopy = siteInvite();
    delete missingCopy.email_text;
    assert.throws(
      () => buildZapierPayload('site_invite_requested', missingCopy),
      /missing required key: email_text/u,
    );
    assert.throws(
      () => buildZapierPayload('site_invite_requested', siteInvite({ raw_body: 'forbidden' })),
      /unknown key: raw_body/u,
    );
    assert.throws(
      () => buildZapierPayload('site_invite_requested', siteInvite({
        onboarding_url: 'http://localhost:8787/onboarding/case-0001',
      })),
      /public HTTPS URL/u,
    );
    assert.throws(
      () => buildZapierPayload('site_invite_requested', siteInvite({ email_subject: '' })),
      /email_subject is malformed/u,
    );
    assert.throws(
      () => buildZapierPayload('site_invite_requested', siteInvite({ email_text: 'x'.repeat(10_001) })),
      /email_text is malformed/u,
    );
    assert.throws(
      () => buildZapierPayload('site_invite_requested', siteInvite({ button_text: 'x'.repeat(81) })),
      /button_text is malformed/u,
    );
  });

  test('builds the completion payload with only optional allowlisted identities', () => {
    const payload = buildZapierPayload('onboarding_completed', completion({
      email: 'Student@example.com',
      telegram_user_id: 196267257,
    }));
    assert.deepEqual(Object.keys(payload), [
      'event_type',
      'idempotency_key',
      'onboarding_case_id',
      'completed_at',
      'source',
      'email',
      'telegram_user_id',
    ]);
    assert.equal(payload.source, 'site');
    assert.throws(
      () => buildZapierPayload('onboarding_completed', completion({ source: 'unknown' })),
      /source is not supported/u,
    );
    assert.throws(
      () => buildZapierPayload('unexpected_event', completion()),
      /event_type is not supported/u,
    );
  });

  test('sends one authenticated POST on a 2xx response without reading its body', async () => {
    const calls = [];
    const result = await sendZapierEvent({
      config: CONFIG,
      eventType: 'site_invite_requested',
      data: siteInvite(),
      transport: async (request) => {
        calls.push(request);
        return {
          status: 204,
          json() { throw new Error('response body must not be read'); },
          text() { throw new Error('response body must not be read'); },
        };
      },
    });
    assert.deepEqual(result, { state: 'sent', status: 204 });
    assert.equal(calls.length, 1);
    const request = calls[0];
    assert.equal(request.url, CONFIG.zapierSiteInviteUrl);
    assert.equal(request.headers.authorization, 'Bearer runtime-only-token');
    const body = JSON.parse(request.body);
    assert.equal(request.headers['idempotency-key'], body.idempotency_key);
    assert.equal(body.email, 'Student@example.com');
    assert.equal(request.timeoutMs, CONFIG.zapierTimeoutMs);
  });

  test('classifies a 4xx rejection as definite and never retries', async () => {
    let calls = 0;
    const result = await sendZapierEvent({
      config: CONFIG,
      eventType: 'onboarding_completed',
      data: completion(),
      transport: async () => {
        calls += 1;
        return { status: 422 };
      },
    });
    assert.deepEqual(result, { state: 'definite_failure', status: 422, code: 'rejected' });
    assert.equal(calls, 1);
  });

  test('classifies 5xx and transport timeout outcomes as inconclusive with zero retries', async () => {
    let remoteCalls = 0;
    const remote = await sendZapierEvent({
      config: CONFIG,
      eventType: 'onboarding_completed',
      data: completion(),
      transport: async () => {
        remoteCalls += 1;
        return { status: 503 };
      },
    });
    assert.deepEqual(remote, { state: 'inconclusive', status: 503, code: 'remote_unknown' });
    assert.equal(remoteCalls, 1);

    let timeoutCalls = 0;
    const timeout = await sendZapierEvent({
      config: CONFIG,
      eventType: 'onboarding_completed',
      data: completion(),
      transport: async () => {
        timeoutCalls += 1;
        throw new DOMException('timed out', 'TimeoutError');
      },
    });
    assert.deepEqual(timeout, { state: 'inconclusive', code: 'transport_unknown' });
    assert.equal(timeoutCalls, 1);
  });

  test('does not start transport when Zapier delivery is disabled or missing its endpoint', async () => {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      return { status: 204 };
    };
    assert.deepEqual(await sendZapierEvent({
      config: { ...CONFIG, zapierEnabled: false },
      eventType: 'site_invite_requested',
      data: siteInvite(),
      transport,
    }), { state: 'definite_failure', code: 'disabled' });
    assert.deepEqual(await sendZapierEvent({
      config: { ...CONFIG, zapierCompletionUrl: '' },
      eventType: 'onboarding_completed',
      data: completion(),
      transport,
    }), { state: 'definite_failure', code: 'missing_endpoint' });
    assert.equal(calls, 0);
  });

  test('rejects a bypassed non-Zapier endpoint before transport or payload delivery', async () => {
    let transportCalls = 0;
    const result = await sendZapierEvent({
      config: { ...CONFIG, zapierCompletionUrl: 'https://10.0.0.1/internal' },
      eventType: 'onboarding_completed',
      data: completion(),
      transport: async () => { transportCalls += 1; return { status: 307 }; },
    });
    assert.deepEqual(result, { state: 'definite_failure', code: 'destination_not_approved' });
    assert.equal(transportCalls, 0);
  });

  test('treats redirect status as inconclusive and never starts a second transport', async () => {
    let transportCalls = 0;
    const result = await sendZapierEvent({
      config: CONFIG,
      eventType: 'onboarding_completed',
      data: completion(),
      transport: async () => {
        transportCalls += 1;
        return { status: 307 };
      },
    });
    assert.deepEqual(result, { state: 'inconclusive', status: 307, code: 'remote_unknown' });
    assert.equal(transportCalls, 1);
  });
});
