import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  mapSiteRegistration,
  signSiteWebhook,
  singleSiteSignatureFromRawHeaders,
  verifySiteWebhook,
} from '../src/site.mjs';

function registration(overrides = {}) {
  return {
    event_id: 'registration-2026-0001',
    event_type: 'student_registered',
    occurred_at: '2026-08-03T12:00:00-07:00',
    email: 'Student@EXAMPLE.com',
    ...overrides,
  };
}

describe('Site registration webhook adapter', () => {
  test('verifies only a bare HMAC-SHA256 signature over the exact raw bytes', () => {
    const secret = 'site-secret-that-is-at-least-32-characters';
    const rawBody = Buffer.from(JSON.stringify(registration()), 'utf8');
    const signature = signSiteWebhook(secret, rawBody);
    assert.match(signature, /^[a-f0-9]{64}$/u);
    assert.equal(verifySiteWebhook({ secret, rawBody, signature }), true);
    assert.equal(verifySiteWebhook({ secret, rawBody, signature: signature.toUpperCase() }), true);
    assert.equal(verifySiteWebhook({ secret, rawBody, signature: `sha256=${signature}` }), false);
    assert.equal(verifySiteWebhook({ secret, rawBody, signature: ` ${signature}` }), false);
    assert.equal(verifySiteWebhook({
      secret,
      rawBody: Buffer.concat([rawBody, Buffer.from(' ')]),
      signature,
    }), false);
  });

  test('extracts exactly one signature header and rejects duplicate occurrences', () => {
    const signature = 'a'.repeat(64);
    assert.equal(singleSiteSignatureFromRawHeaders([
      'content-type', 'application/json',
      'X-Gatekeeper-Site-Signature', signature,
    ]), signature);
    assert.equal(singleSiteSignatureFromRawHeaders([
      'x-gatekeeper-site-signature', signature,
      'X-GATEKEEPER-SITE-SIGNATURE', signature,
    ]), null);
    assert.equal(singleSiteSignatureFromRawHeaders(['content-type', 'application/json']), null);
    assert.equal(singleSiteSignatureFromRawHeaders(['broken']), null);
  });

  test('maps an email-only registration to a canonical Site event', () => {
    const mapped = mapSiteRegistration(registration());
    assert.deepEqual(mapped.identity, {
      source: 'site',
      external_event_id: 'registration-2026-0001',
    });
    assert.deepEqual(mapped.event, {
      event_id: 'registration-2026-0001',
      event_type: 'student_registered',
      source: 'site',
      occurred_at: '2026-08-03T19:00:00.000Z',
      email: 'Student@example.com',
    });
    assert.deepEqual(JSON.parse(mapped.canonicalBody), {
      event_id: 'registration-2026-0001',
      event_type: 'student_registered',
      occurred_at: '2026-08-03T19:00:00.000Z',
      email: 'Student@example.com',
    });
  });

  test('accepts optional validated Telegram identifiers', () => {
    const mapped = mapSiteRegistration(registration({
      telegram_user_id: 196267257,
      telegram_username: '@alexeykrol',
    }));
    assert.equal(mapped.event.telegram_user_id, 196267257);
    assert.equal(mapped.event.telegram_username, 'alexeykrol');
    assert.equal(JSON.parse(mapped.canonicalBody).telegram_user_id, 196267257);
  });

  test('keeps the internal identity stable across equivalent timestamps and email domains', () => {
    const first = mapSiteRegistration(registration());
    const retry = mapSiteRegistration(registration({
      occurred_at: '2026-08-03T19:00:00.000Z',
      email: 'Student@example.com',
    }));
    assert.equal(retry.event.event_id, 'registration-2026-0001');
    assert.equal(retry.event.event_id, first.event.event_id);
    assert.equal(retry.canonicalBody, first.canonicalBody);
  });

  test('rejects unknown keys, missing fields, and unsupported event types', () => {
    assert.throws(
      () => mapSiteRegistration(registration({ raw_body: 'must not pass' })),
      /unknown key: raw_body/u,
    );
    const missingEmail = registration();
    delete missingEmail.email;
    assert.throws(() => mapSiteRegistration(missingEmail), /missing required key: email/u);
    assert.throws(
      () => mapSiteRegistration(registration({ event_type: 'payment_received' })),
      /must be student_registered/u,
    );
  });

  test('rejects malformed or oversized strings and Telegram fields', () => {
    assert.throws(
      () => mapSiteRegistration(registration({ event_id: `e${'x'.repeat(128)}` })),
      /event_id is malformed/u,
    );
    assert.throws(
      () => mapSiteRegistration(registration({ occurred_at: 'August 3, 2026' })),
      /occurred_at is malformed/u,
    );
    assert.throws(
      () => mapSiteRegistration(registration({ email: 'student @example.com' })),
      /valid address/u,
    );
    assert.throws(
      () => mapSiteRegistration(registration({ telegram_user_id: '196267257' })),
      /positive safe integer/u,
    );
    assert.throws(
      () => mapSiteRegistration(registration({ telegram_username: 'bad name' })),
      /telegram_username is malformed/u,
    );
  });
});
