import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_MUTABLE_SETTINGS,
  buildAdminSettingsSnapshot,
  maskDestinationUrl,
  validateAdminSettingsPatch,
} from '../src/admin-settings.mjs';

const pagePath = fileURLToPath(new URL('../public/gatekeeper.html', import.meta.url));

function exampleInput() {
  return {
    config: {
      botToken: '123456:BOT_TOKEN_SENTINEL',
      botUsername: 'private_test_bot',
      targetChatId: '-1001234567890',
      telegramWebhookSecret: 'TELEGRAM_SECRET_SENTINEL',
      tributeApiKey: 'TRIBUTE_KEY_SENTINEL',
      tributeSubscriptionIds: ['987654'],
      siteEnabled: true,
      siteWebhookSecret: 'SITE_SECRET_SENTINEL',
      linkSigningSecret: 'LINK_SECRET_SENTINEL',
      adminSettingsToken: 'ADMIN_SETTINGS_TOKEN_SENTINEL',
      publicBaseUrl: 'https://gatekeeper.example.test',
      zapierEnabled: true,
      zapierSiteInviteUrl: 'https://user:pass@hooks.zapier.com/hooks/catch/123/EMAIL_HOOK_SECRET?email=person@example.com',
      zapierCompletionUrl: 'https://hooks.zapier.com/hooks/catch/456/COMPLETE_HOOK_SECRET?token=QUERY_SECRET',
    },
    scenario: {
      status: 'ready',
      messages: {
        group_invitation: { status: 'active', text: 'person@example.com' },
        completion_success: { status: 'active' },
        activation_escalation_admin: { status: 'planned' },
      },
    },
    storeSummary: {
      onboarding: { pending: 2, contact_established: 3, completed: 5 },
      delivery: [{ state: 'sent', count: 4 }, { state: 'inconclusive', count: 1 }],
      uncertain_invitations: [{ id: 'secret-id', chat_id: '-100123', user_id: '777' }],
      uncertain_updates: [{ update_id: '999', last_error: 'person@example.com' }],
      uncertain_zapier_deliveries: [{ delivery_key: 'secret-delivery-id' }],
    },
    env: {
      GATEKEEPER_START_TOKEN_TTL_SECONDS: '900',
      GATEKEEPER_SITE_TOKEN_TTL_SECONDS: '1800',
      GATEKEEPER_BOT_TOKEN: 'ENV_TOKEN_SENTINEL',
      PERSON_EMAIL: 'other@example.com',
    },
  };
}

test('admin snapshot has every required section and only aggregate store counts', () => {
  const snapshot = buildAdminSettingsSnapshot(exampleInput());

  assert.deepEqual(snapshot.sections, [
    'overview',
    'sources',
    'user_paths',
    'delivery',
    'rules',
    'events_test',
  ]);
  assert.deepEqual(snapshot.overview.onboarding, {
    pending: 2,
    contactEstablished: 3,
    completed: 5,
  });
  assert.equal(snapshot.overview.attentionRequired, 3);
  assert.equal(snapshot.eventsTest.uncertainZapierDeliveries, 1);
  assert.equal(snapshot.eventsTest.liveSendAvailable, false);
  assert.equal(snapshot.eventsTest.simulation, 'offline_only');
  assert.equal(snapshot.userPaths.length, 6);
});

test('admin snapshot excludes secret values, secret property names and PII', () => {
  const serialized = JSON.stringify(buildAdminSettingsSnapshot(exampleInput()));
  const forbidden = [
    'BOT_TOKEN_SENTINEL',
    'TELEGRAM_SECRET_SENTINEL',
    'TRIBUTE_KEY_SENTINEL',
    'SITE_SECRET_SENTINEL',
    'LINK_SECRET_SENTINEL',
    'ADMIN_SETTINGS_TOKEN_SENTINEL',
    'EMAIL_HOOK_SECRET',
    'COMPLETE_HOOK_SECRET',
    'QUERY_SECRET',
    'ENV_TOKEN_SENTINEL',
    'person@example.com',
    'other@example.com',
    '-1001234567890',
    '-100123',
    'secret-delivery-id',
    '"botToken"',
    '"telegramWebhookSecret"',
    '"tributeApiKey"',
    '"siteWebhookSecret"',
    '"linkSigningSecret"',
    '"adminSettingsToken"',
    '"zapierAuthToken"',
  ];
  for (const value of forbidden) assert.equal(serialized.includes(value), false, value);
});

test('destination masking removes credentials, query and identifying path segments', () => {
  assert.equal(
    maskDestinationUrl('https://hooks.zapier.com/hooks/catch/123/secret?token=query'),
    'hooks.zapier.com/hooks/…',
  );
  assert.equal(
    maskDestinationUrl('https://example.test/private-user-id/credential'),
    'example.test/…',
  );
  assert.equal(maskDestinationUrl('https://user:pass@example.test/hooks/secret'), null);
  assert.equal(maskDestinationUrl('not a URL'), null);
});

test('settings patch accepts only bounded non-secret integer variables', () => {
  const patch = validateAdminSettingsPatch({
    startTokenTtlSeconds: 900,
    siteTokenTtlSeconds: 1_800,
  });
  assert.deepEqual(patch, {
    startTokenTtlSeconds: 900,
    siteTokenTtlSeconds: 1_800,
  });
  assert.equal(Object.isFrozen(patch), true);
  assert.deepEqual(Object.keys(ADMIN_MUTABLE_SETTINGS), Object.keys(patch));

  assert.throws(() => validateAdminSettingsPatch({ botToken: 123 }), /runtime-only secret/);
  assert.throws(() => validateAdminSettingsPatch({ zapierWebhookUrl: 123 }), /not an editable/);
  assert.throws(() => validateAdminSettingsPatch({ retryMaxAttempts: 4 }), /not an editable/);
  assert.throws(() => validateAdminSettingsPatch({ correlationWindowSeconds: 3_600 }), /not an editable/);
  assert.throws(() => validateAdminSettingsPatch({ startTokenTtlSeconds: '900' }), /integer between/);
});

test('snapshot distinguishes active runtime setting from planned rules', () => {
  const { rules } = buildAdminSettingsSnapshot(exampleInput());
  assert.equal(rules.startTokenTtlSeconds.status, 'active');
  assert.equal(rules.startTokenTtlSeconds.mutable, true);
  assert.equal(rules.startTokenTtlSeconds.value, 900);
  assert.equal(rules.siteTokenTtlSeconds.status, 'active');
  assert.equal(rules.siteTokenTtlSeconds.mutable, true);
  assert.equal(rules.siteTokenTtlSeconds.value, 1_800);
  for (const key of [
    'correlationWindowSeconds',
    'retryMaxAttempts',
    'retryBaseSeconds',
    'escalationAfterSeconds',
  ]) {
    assert.equal(rules[key].status, 'planned');
    assert.equal(rules[key].mutable, false);
    assert.equal(rules[key].value, null);
  }
});

test('static admin page is complete, read-only and has no live-send control', () => {
  const html = fs.readFileSync(pagePath, 'utf8');
  assert.match(html, /<title>Привратник · News Digest<\/title>/u);
  assert.match(html, /data-snapshot-endpoint="\/admin\/settings\/snapshot"/u);
  for (const id of ['overview', 'sources', 'user-paths', 'delivery', 'rules', 'events-test']) {
    assert.match(html, new RegExp(`id="${id}"`, 'u'));
  }
  assert.match(html, /id="safe-simulation"[^>]*disabled/u);
  assert.match(html, /Управления реальной отправкой здесь нет/u);
  assert.doesNotMatch(html, /type="password"/u);
  assert.doesNotMatch(html, />\s*(Сохранить|Отправить сейчас)\s*</u);
});
