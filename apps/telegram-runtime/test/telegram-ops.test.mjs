import assert from 'node:assert/strict';
import test from 'node:test';
import { runTelegramOperation } from '../src/telegram-ops.mjs';

const runtimeConfig = {
  moderator: { botToken: 'moderator-token', webhookSecret: 'moderator-secret' },
  assistant: { botToken: 'assistant-token', webhookSecret: 'assistant-secret' },
};

test('Telegram operations default to a redacted dry run and never call fetch', async () => {
  let calls = 0;
  const plan = await runTelegramOperation({
    action: 'set-webhook', role: 'moderator', runtimeConfig,
    publicOrigin: 'https://telegram.example.test', fetchFn: async () => { calls++; throw new Error('must not call'); },
  });
  assert.equal(calls, 0);
  assert.deepEqual(plan, {
    mode: 'dry_run', action: 'set-webhook', role: 'moderator',
    request: { method: 'setWebhook', body: {
      url: 'https://telegram.example.test/webhooks/telegram/moderator', secret_token: '[configured]',
      allowed_updates: ['message', 'edited_message'], drop_pending_updates: false,
    } },
  });
});

test('explicit operations use only the selected role token and preserve the cutover payload contract', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, async json() { return { ok: true, result: { fixture: true } }; } };
  };
  await runTelegramOperation({ action: 'set-webhook', role: 'assistant', runtimeConfig, publicOrigin: 'https://telegram.example.test', apply: true, fetchFn });
  await runTelegramOperation({ action: 'delete-webhook', role: 'moderator', runtimeConfig, apply: true, fetchFn });
  await runTelegramOperation({ action: 'set-commands', role: 'assistant', runtimeConfig, apply: true, fetchFn });
  await runTelegramOperation({ action: 'status', role: 'moderator', runtimeConfig, apply: true, fetchFn });
  assert.deepEqual(calls.map(({ url, init }) => ({ url, body: init.body == null ? null : JSON.parse(init.body) })), [
    { url: 'https://api.telegram.org/botassistant-token/setWebhook', body: {
      url: 'https://telegram.example.test/webhooks/telegram/assistant', secret_token: 'assistant-secret',
      allowed_updates: ['message', 'edited_message'], drop_pending_updates: false,
    } },
    { url: 'https://api.telegram.org/botmoderator-token/deleteWebhook', body: { drop_pending_updates: false } },
    { url: 'https://api.telegram.org/botassistant-token/setMyCommands', body: { commands: [
      { command: 'ask', description: 'Ask the assistant' }, { command: 'help', description: 'Show assistant help' },
    ] } },
    { url: 'https://api.telegram.org/botmoderator-token/getWebhookInfo', body: null },
  ]);
});

test('a role cannot select another role command payload or silently use an invalid origin', async () => {
  await assert.rejects(runTelegramOperation({
    action: 'set-commands', role: 'moderator', runtimeConfig, apply: true, fetchFn: async () => { throw new Error('must not call'); },
  }), /assistant role only/);
  await assert.rejects(runTelegramOperation({
    action: 'set-webhook', role: 'assistant', runtimeConfig, publicOrigin: 'http://unsafe.example.test', apply: true,
    fetchFn: async () => { throw new Error('must not call'); },
  }), /exact HTTPS origin/);
});
