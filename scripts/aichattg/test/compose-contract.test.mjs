import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const composeUrl = new URL('../../../infra/aichattg/docker-compose.yml', import.meta.url);

test('Telegram runtime receives the documented recovery and assistant settings', async () => {
  const compose = await readFile(composeUrl, 'utf8');
  const required = [
    'TELEGRAM_RUNTIME_MODERATION_ANTICHANNELPIN',
    'TELEGRAM_RUNTIME_MODERATOR_RECOVERY_INTERVAL_SEC',
    'TELEGRAM_RUNTIME_MODERATOR_RECOVERY_BATCH_SIZE',
    'TELEGRAM_RUNTIME_MODERATOR_RECOVERY_LEASE_SEC',
    'TELEGRAM_RUNTIME_MODERATOR_RECOVERY_MAX_SAFE_RETRIES',
    'TELEGRAM_RUNTIME_MODERATOR_RECOVERY_BACKOFF_SEC',
    'TELEGRAM_RUNTIME_MODERATOR_RECOVERY_SNAPSHOT_TTL_SEC',
    'TELEGRAM_RUNTIME_ASSISTANT_COOLDOWN_SEC',
    'TELEGRAM_RUNTIME_ASSISTANT_DAILY_PER_USER',
    'TELEGRAM_RUNTIME_ASSISTANT_KNOWLEDGE_ENABLED',
    'TELEGRAM_RUNTIME_ASSISTANT_DIALOGUE_TURN_LIMIT',
    'TELEGRAM_RUNTIME_REWRITE_MODEL',
    'TELEGRAM_RUNTIME_REWRITE_REASONING_EFFORT',
    'TELEGRAM_RUNTIME_TELEGRAM_REQUEST_TIMEOUT_MS',
    'TELEGRAM_RUNTIME_PROVIDER_REQUEST_TIMEOUT_MS',
  ];

  for (const name of required) {
    assert.match(compose, new RegExp(`^\\s+${name}:`, 'm'), `${name} is not passed to runtime`);
  }
});

test('knowledge admission uses a separate read-only mount', async () => {
  const compose = await readFile(composeUrl, 'utf8');

  assert.match(compose, /source: "\$\{AICHATTG_KNOWLEDGE_ROOT:/);
  assert.match(compose, /target: \/var\/lib\/aichattg\/knowledge\n\s+read_only: true/);
  assert.match(compose, /TELEGRAM_RUNTIME_KNOWLEDGE_ROOT: \/var\/lib\/aichattg\/knowledge/);
  assert.doesNotMatch(compose, /\/srv\/news_agent_001|news-digest\.db/);
});

test('the UTC release timestamp reaches only the production Console', async () => {
  const compose = await readFile(composeUrl, 'utf8');
  const runtime = compose.split('  aichattg-telegram-runtime:')[1]?.split('  aichattg-operator-console:')[0];
  const consoleService = compose.split('  aichattg-operator-console:')[1]?.split('\nnetworks:')[0];
  assert.ok(runtime && consoleService);
  assert.match(consoleService, /OPERATOR_CONSOLE_RELEASED_AT: "\$\{OPERATOR_CONSOLE_RELEASED_AT:-\}"/u);
  assert.doesNotMatch(runtime, /OPERATOR_CONSOLE_RELEASED_AT/u);
  const dockerfile = await readFile(new URL('../../../infra/aichattg/Dockerfile.operator-console', import.meta.url), 'utf8');
  assert.match(dockerfile, /ENV NODE_ENV=production/u);
});
