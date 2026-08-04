import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRuntimeConfig } from '../src/config.mjs';
import { openRuntimeDatabase, createRuntimeStore } from '../src/database.mjs';
import { createLlmAdapter, LlmDisabledError } from '../src/llm-adapter.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import { createTelegramRuntimeHttpServer } from '../src/http-server.mjs';

function config(overrides = {}) {
  return {
    ingressEnabled: false, moderationMode: 'live',
    moderator: { chatIds: ['-100'], botToken: '', botUsername: '', webhookSecret: 'moderator-secret', exemptBotIds: [] },
    assistant: { chatIds: ['-100'], botToken: '', botUsername: 'assistant_bot', webhookSecret: 'assistant-secret', exemptBotIds: [] },
    ...overrides,
  };
}
function update(updateId, text, from = { id: 7, first_name: 'Student', is_bot: false }) {
  return { update_id: updateId, message: { message_id: updateId, chat: { id: -100 }, from, text } };
}
function request(server, path, headers, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ port, path, method: 'POST', headers: { ...headers, 'content-type': 'application/json' } }, (response) => {
      const parts = []; response.on('data', (part) => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
}

test('default configuration does not plan Telegram side effects or polling', () => {
  const loaded = loadRuntimeConfig({}, { cwd: '/tmp/aichattg-test' });
  assert.deepEqual(loaded.startupPlan, { setCommands: false, registerWebhook: false, deleteWebhook: false, poll: false });
  assert.equal(loaded.ingressEnabled, false);
  assert.throws(() => loadRuntimeConfig({ TELEGRAM_RUNTIME_POLLING_ENABLED: 'true' }), /polling/);
});

test('disabled LLM adapter cannot call fetch', async () => {
  let calls = 0;
  const adapter = createLlmAdapter({ enabled: false }, { fetchFn: async () => { calls++; } });
  await assert.rejects(adapter.answer({}), LlmDisabledError);
  assert.equal(calls, 0);
});

test('runtime uses local SQLite claims, isolates roles, and only uses fake adapters', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-runtime-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store: createRuntimeStore(db),
    llm: { async moderate() { return { verdict: 'ban', confidence: 0.98, reason: 'test' }; }, async answer(input) { return { text: `answer:${input.text}`, modelId: 'fake' }; } },
    moderatorTelegram: { async banMember(input) { actions.push(['ban', input]); return { ok: true }; }, async deleteMessage(input) { actions.push(['delete', input]); return { ok: true }; } },
    assistantTelegram: { async sendMessage(input) { actions.push(['send', input]); return { ok: true, data: { message_id: 90 } }; } },
    notifier: { async notify() { actions.push(['notify']); return { delivered: true }; } },
  });
  try {
    const moderated = await runtime.handleUpdate('moderator', update(1, 'abuse'));
    assert.equal(moderated.verdict, 'ban');
    assert.deepEqual(actions.slice(0, 2).map(([kind]) => kind), ['ban', 'delete']);
    assert.equal((await runtime.handleUpdate('moderator', update(1, 'abuse'))).kind, 'duplicate');
    const answered = await runtime.handleUpdate('assistant', update(2, '/ask hello'));
    assert.equal(answered.kind, 'answered');
    assert.equal(actions.at(-1)[0], 'send');
    assert.equal((await runtime.handleUpdate('assistant', update(3, 'ordinary chat'))).kind, 'skipped');
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('HTTP ingress is opt-in and validates role-specific webhook secrets', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-http-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config({ ingressEnabled: true, moderationMode: 'shadow' }), store: createRuntimeStore(db),
    llm: { async moderate() { return { verdict: 'clean', confidence: 1, reason: 'fake' }; }, async answer() { return { text: 'fake' }; } },
    moderatorTelegram: {}, assistantTelegram: { async sendMessage(input) { actions.push(input); return { ok: true }; } }, notifier: { async notify() { return { delivered: false }; } },
  });
  const server = createTelegramRuntimeHttpServer({ config: config({ ingressEnabled: true, moderationMode: 'shadow' }), runtime, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    assert.equal((await request(server, '/webhooks/telegram/assistant', {}, update(11, '/ask Hi'))).status, 401);
    const accepted = await request(server, '/webhooks/telegram/assistant', { 'x-telegram-bot-api-secret-token': 'assistant-secret' }, update(11, '/ask Hi'));
    assert.equal(accepted.status, 200);
    assert.equal(actions.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(folder, { recursive: true, force: true });
  }
});
