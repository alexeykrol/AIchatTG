import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig } from '../src/config.mjs';

function env(overrides = {}) {
  return {
    GATEKEEPER_BOT_TOKEN: '123456:valid_token',
    GATEKEEPER_BOT_USERNAME: '@krolkeeper_bot',
    GATEKEEPER_TARGET_CHAT_ID: '-1003840653970',
    GATEKEEPER_TELEGRAM_WEBHOOK_SECRET: 'telegram_secret',
    GATEKEEPER_TRIBUTE_API_KEY: 'tribute-runtime-api-key',
    GATEKEEPER_TRIBUTE_SUBSCRIPTION_IDS: '1644,1645',
    GATEKEEPER_LINK_SIGNING_SECRET: 'link-signing-secret-at-least-32-chars',
    ...overrides,
  };
}

describe('loadConfig', () => {
  test('loads a valid runtime-only configuration', () => {
    const value = loadConfig(env());
    assert.equal(value.botUsername, 'krolkeeper_bot');
    assert.equal(value.targetChatId, '-1003840653970');
    assert.deepEqual(value.tributeSubscriptionIds, ['1644', '1645']);
    assert.equal(value.tributeChannelId, '');
    assert.equal(value.startTokenTtlSeconds, 604800);
    assert.equal(value.siteEnabled, false);
    assert.equal(value.siteWebhookSecret, '');
    assert.equal(value.siteTokenTtlSeconds, 604800);
    assert.equal(value.zapierEnabled, false);
    assert.equal(value.zapierSiteInviteUrl, '');
    assert.equal(value.zapierCompletionUrl, '');
    assert.equal(value.zapierAuthToken, '');
    assert.equal(value.adminSettingsToken, '');
    assert.equal(value.zapierTimeoutMs, 10000);
    assert.equal(value.bindHost, '127.0.0.1');
    assert.equal(value.publicOrigin, '');
    assert.equal(value.publicBaseUrl, '');
    assert.match(value.scenarioPath, /ONBOARDING_SCENARIO\.md$/u);
    assert.equal(Object.hasOwn(value, 'allowDraftScenario'), false);
  });

  test('rejects malformed credentials and non-channel chat ids', () => {
    assert.throws(() => loadConfig(env({ GATEKEEPER_BOT_TOKEN: 'bad' })), /BOT_TOKEN/);
    assert.throws(() => loadConfig(env({ GATEKEEPER_TARGET_CHAT_ID: '123' })), /TARGET_CHAT_ID/);
    assert.throws(() => loadConfig(env({ GATEKEEPER_TRIBUTE_API_KEY: '' })), /TRIBUTE_API_KEY/);
    assert.throws(() => loadConfig(env({ GATEKEEPER_TRIBUTE_SUBSCRIPTION_IDS: '1644,bad' })), /positive safe integers/);
    assert.throws(() => loadConfig(env({ GATEKEEPER_TRIBUTE_SUBSCRIPTION_IDS: '1644,1644' })), /duplicates/);
    assert.throws(() => loadConfig(env({ GATEKEEPER_TRIBUTE_CHANNEL_ID: '-1001' })), /positive safe integers/);
    assert.equal(loadConfig(env({ GATEKEEPER_TRIBUTE_CHANNEL_ID: '614' })).tributeChannelId, '614');
  });

  test('rejects the retired draft-server flag', () => {
    assert.throws(
      () => loadConfig(env({ GATEKEEPER_ALLOW_DRAFT_SCENARIO: 'true' })),
      /retired; draft scenarios are offline-simulator only/u,
    );
  });

  test('rejects retired instruction env so Markdown remains the only source of truth', () => {
    assert.throws(() => loadConfig(env({ GATEKEEPER_INSTRUCTION_TEXT: 'legacy' })), /retired/);
    assert.throws(() => loadConfig(env({ GATEKEEPER_INSTRUCTION_LINKS_JSON: '[]' })), /retired/);
    assert.throws(() => loadConfig(env({ GATEKEEPER_ALLOW_PLACEHOLDER_INSTRUCTION: 'true' })), /retired/);
  });

  test('rejects the retired custom newcomer webhook configuration', () => {
    assert.throws(
      () => loadConfig(env({ GATEKEEPER_EXTERNAL_WEBHOOK_SECRET: 'retired-secret' })),
      /retired; configure the Tribute webhook/u,
    );
    assert.throws(
      () => loadConfig(env({ GATEKEEPER_EXTERNAL_WEBHOOK_MAX_SKEW_SECONDS: '300' })),
      /retired; configure the Tribute webhook/u,
    );
  });

  test('enables the Site webhook only with a strong bounded secret', () => {
    const value = loadConfig(env({
      GATEKEEPER_SITE_ENABLED: 'true',
      GATEKEEPER_SITE_WEBHOOK_SECRET: 'site-secret-that-is-at-least-32-characters',
      GATEKEEPER_SITE_TOKEN_TTL_SECONDS: '86400',
      GATEKEEPER_PUBLIC_ORIGIN: 'https://gatekeeper.example.test/',
    }));
    assert.equal(value.siteEnabled, true);
    assert.equal(value.siteWebhookSecret, 'site-secret-that-is-at-least-32-characters');
    assert.equal(value.siteTokenTtlSeconds, 86400);
    assert.equal(value.publicOrigin, 'https://gatekeeper.example.test');
    assert.equal(value.publicBaseUrl, 'https://gatekeeper.example.test/gatekeeper');
    assert.throws(
      () => loadConfig(env({ GATEKEEPER_SITE_ENABLED: 'true' })),
      /SITE_WEBHOOK_SECRET is required/u,
    );
    assert.throws(
      () => loadConfig(env({
        GATEKEEPER_SITE_ENABLED: 'true',
        GATEKEEPER_SITE_WEBHOOK_SECRET: 'too-short',
      })),
      /32-256 printable ASCII/u,
    );
    assert.throws(
      () => loadConfig(env({ GATEKEEPER_SITE_ENABLED: 'yes' })),
      /must be true or false/u,
    );
    assert.throws(
      () => loadConfig(env({
        GATEKEEPER_SITE_ENABLED: 'true',
        GATEKEEPER_SITE_WEBHOOK_SECRET: 'site-secret-that-is-at-least-32-characters',
      })),
      /PUBLIC_ORIGIN is required/u,
    );
    assert.throws(
      () => loadConfig(env({
        GATEKEEPER_SITE_ENABLED: 'true',
        GATEKEEPER_SITE_WEBHOOK_SECRET: 'site-secret-that-is-at-least-32-characters',
        GATEKEEPER_PUBLIC_ORIGIN: 'http://localhost:8787',
      })),
      /PUBLIC_ORIGIN must be a canonical public HTTPS origin/u,
    );
    assert.throws(
      () => loadConfig(env({
        GATEKEEPER_SITE_ENABLED: 'true',
        GATEKEEPER_SITE_WEBHOOK_SECRET: 'site-secret-that-is-at-least-32-characters',
        GATEKEEPER_PUBLIC_ORIGIN: 'https://gatekeeper.example.test/prefix',
      })),
      /without a path or query/u,
    );
    assert.throws(
      () => loadConfig(env({ GATEKEEPER_PUBLIC_BASE_URL: 'https://legacy.example.test' })),
      /PUBLIC_BASE_URL is retired/u,
    );
    assert.throws(
      () => loadConfig(env({ GATEKEEPER_SITE_TOKEN_TTL_SECONDS: '2592001' })),
      /between 300 and 2592000/u,
    );
  });

  test('normalizes the Gatekeeper public base under the fixed route prefix', () => {
    const value = loadConfig(env({
      GATEKEEPER_SITE_ENABLED: 'true',
      GATEKEEPER_SITE_WEBHOOK_SECRET: 'site-secret-that-is-at-least-32-characters',
      GATEKEEPER_PUBLIC_ORIGIN: 'https://aikrol.questtales.com/',
    }));
    assert.equal(value.publicOrigin, 'https://aikrol.questtales.com');
    assert.equal(value.publicBaseUrl, 'https://aikrol.questtales.com/gatekeeper');
    assert.equal(
      new URL('onboarding/site', `${value.publicBaseUrl}/`).toString(),
      'https://aikrol.questtales.com/gatekeeper/onboarding/site',
    );
  });

  test('enables both Zapier hooks with HTTPS endpoints and bounded delivery settings', () => {
    const value = loadConfig(env({
      GATEKEEPER_ZAPIER_ENABLED: 'true',
      GATEKEEPER_ZAPIER_SITE_INVITE_URL: 'https://hooks.zapier.com/hooks/catch/site-invite',
      GATEKEEPER_ZAPIER_COMPLETION_URL: 'https://hooks.zapier.com/hooks/catch/completion',
      GATEKEEPER_ZAPIER_AUTH_TOKEN: 'runtime-token',
      GATEKEEPER_ZAPIER_TIMEOUT_MS: '12000',
    }));
    assert.equal(value.zapierEnabled, true);
    assert.equal(value.zapierSiteInviteUrl, 'https://hooks.zapier.com/hooks/catch/site-invite');
    assert.equal(value.zapierCompletionUrl, 'https://hooks.zapier.com/hooks/catch/completion');
    assert.equal(value.zapierAuthToken, 'runtime-token');
    assert.equal(value.zapierTimeoutMs, 12000);
    assert.throws(
      () => loadConfig(env({ GATEKEEPER_ZAPIER_ENABLED: 'true' })),
      /ZAPIER_SITE_INVITE_URL is required/u,
    );
    assert.throws(
      () => loadConfig(env({ GATEKEEPER_ZAPIER_TIMEOUT_MS: '999' })),
      /between 1000 and 30000/u,
    );
  });

  test('enables the admin settings surface only with a strong runtime token', () => {
    const token = 'admin-settings-token-with-more-than-32-characters';
    assert.equal(loadConfig(env({ GATEKEEPER_ADMIN_SETTINGS_TOKEN: token })).adminSettingsToken, token);
    assert.throws(
      () => loadConfig(env({ GATEKEEPER_ADMIN_SETTINGS_TOKEN: 'too-short' })),
      /ADMIN_SETTINGS_TOKEN must contain 32-256 printable ASCII/u,
    );
  });

  test('allows only the approved Zapier hostname with no test-mode bypass', () => {
    const enabled = {
      GATEKEEPER_ZAPIER_ENABLED: 'true',
      GATEKEEPER_ZAPIER_SITE_INVITE_URL: 'http://hooks.zapier.com/site',
      GATEKEEPER_ZAPIER_COMPLETION_URL: 'https://hooks.zapier.com/completion',
    };
    assert.throws(() => loadConfig(env(enabled)), /approved Zapier HTTPS URL/u);
    for (const destination of [
      'https://127.0.0.1/site',
      'https://10.0.0.1/site',
      'https://192.168.50.10/site',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/site',
      'https://198.18.0.1/site',
      'https://[::1]/site',
      'https://[fd00::1]/site',
      'https://[fe80::1]/site',
      'https://metadata.google.internal/site',
      'https://hooks.zapier.com.evil.example/site',
      'https://hooks.zapier.com:444/site',
    ]) {
      assert.throws(
        () => loadConfig(env({
          ...enabled,
          NODE_ENV: 'test',
          GATEKEEPER_ZAPIER_SITE_INVITE_URL: destination,
        })),
        /approved Zapier HTTPS URL/u,
        destination,
      );
    }
  });

  test('accepts a canonical configured public origin and rejects unsafe values', () => {
    const site = {
      GATEKEEPER_SITE_ENABLED: 'true',
      GATEKEEPER_SITE_WEBHOOK_SECRET: 'site-secret-that-is-at-least-32-characters',
    };
    for (const destination of [
      'https://10.0.0.1',
      'https://192.168.50.10',
      'https://169.254.169.254',
      'https://100.64.0.1',
      'https://[::1]',
      'https://[fd00::1]',
      'https://[fe80::1]',
      'https://localhost',
      'https://gatekeeper.example.test.evil.example/prefix',
      'https://gatekeeper.example.test:444',
    ]) {
      assert.throws(
        () => loadConfig(env({ ...site, GATEKEEPER_PUBLIC_ORIGIN: destination })),
        /canonical public HTTPS origin/u,
        destination,
      );
    }
  });

  test('allows only the Compose-reviewed container bind override', () => {
    assert.equal(loadConfig(env({ GATEKEEPER_CONTAINER_BIND: 'true' })).bindHost, '0.0.0.0');
    assert.throws(
      () => loadConfig(env({ GATEKEEPER_CONTAINER_BIND: 'yes' })),
      /GATEKEEPER_CONTAINER_BIND must be true or false/u,
    );
  });
});
