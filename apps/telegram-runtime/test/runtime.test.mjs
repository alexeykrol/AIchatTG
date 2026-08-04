import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ASSISTANT_SOURCE_PACKAGES, knowledgeManifestDigest } from '@aichattg/telegram-core';
import { loadRuntimeConfig } from '../src/config.mjs';
import { openRuntimeDatabase, createRuntimeStore } from '../src/database.mjs';
import { createKnowledgeAdapter } from '../src/knowledge-adapter.mjs';
import { createProviderAdapter, ProviderUnavailableError } from '../src/provider-adapter.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import { createTelegramRuntimeHttpServer } from '../src/http-server.mjs';

function config(overrides = {}) {
  return {
    ingressEnabled: false,
    moderationMode: 'live',
    assistantModerationWaitMs: 0,
    assistantModerationPollMs: 1,
    moderator: { chatIds: ['-100'], botToken: '', botUsername: '', webhookSecret: 'moderator-secret', exemptBotIds: [] },
    assistant: { chatIds: ['-100'], botToken: '', botUsername: 'assistant_bot', webhookSecret: 'assistant-secret', exemptBotIds: [] },
    ...overrides,
  };
}

function update(updateId, messageId, text, from = { id: 7, first_name: 'Student', is_bot: false }) {
  return { update_id: updateId, message: { message_id: messageId, chat: { id: -100 }, from, text } };
}

function editedUpdate(updateId, messageId, text) {
  return {
    update_id: updateId,
    edited_message: {
      message_id: messageId,
      chat: { id: -100 },
      from: { id: 7, first_name: 'Student', is_bot: false },
      edit_date: 10,
      text,
    },
  };
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

function availableKnowledge() {
  return {
    forSource(sourceId) {
      return sourceId === 'course-content-v1' || sourceId === 'course-operations-v1'
        ? { available: true, snapshot: { sourceId, entries: [{ id: 'test', content: 'offline fixture' }] } }
        : { available: false, reason: 'knowledge_source_unavailable' };
    },
  };
}

function adapters(actions) {
  return {
    moderatorTelegram: {
      async banMember(input) { actions.push(['ban', input]); return { ok: true }; },
      async deleteMessage(input) { actions.push(['delete', input]); return { ok: true }; },
      async sendMessage(input) { actions.push(['warn', input]); return { ok: true }; },
    },
    assistantTelegram: {
      async sendMessage(input) { actions.push(['send', input]); return { ok: true, data: { message_id: 90 } }; },
    },
    notifier: { async notify(input) { actions.push(['notify', input]); return { delivered: true }; } },
  };
}

function fakeLlm({ safetyRoute = 'clean', abuseLevel = null } = {}) {
  return {
    async moderate() {
      return { safetyRoute, abuseLevel, confidence: 0.98, reason: 'offline-fixture', modelId: 'fake' };
    },
    async routeAssistant({ courseOperationsHint }) {
      return courseOperationsHint
        ? { action: 'support', sourceId: 'course-operations-v1' }
        : { action: 'teach', sourceId: 'course-content-v1' };
    },
    async answer(input) { return { text: `answer:${input.text}:${input.route.action}`, modelId: 'fake' }; },
  };
}

test('default configuration does not plan Telegram side effects or polling', () => {
  const loaded = loadRuntimeConfig({}, { cwd: '/tmp/aichattg-test' });
  assert.deepEqual(loaded.startupPlan, { setCommands: false, registerWebhook: false, deleteWebhook: false, poll: false });
  assert.equal(loaded.ingressEnabled, false);
  assert.equal(loaded.assistantModerationWaitMs, 30_000);
  assert.equal(loaded.provider.enabled, false);
  assert.throws(() => loadRuntimeConfig({ TELEGRAM_RUNTIME_POLLING_ENABLED: 'true' }), /polling/);
  assert.throws(() => loadRuntimeConfig({ TELEGRAM_RUNTIME_PROVIDER_ENABLED: 'true' }), /provider requires/);
});

test('disabled or invalid provider adapters cannot call fetch', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; };
  const disabled = createProviderAdapter({ enabled: false }, { fetchFn });
  const invalid = createProviderAdapter({
    enabled: true, endpoint: 'http://provider.example.test', apiKey: 'fixture-key', model: 'fixture-model',
  }, { fetchFn });
  await assert.rejects(disabled.answer({}), (error) => error instanceof ProviderUnavailableError && error.code === 'provider_disabled');
  await assert.rejects(invalid.routeAssistant({}), (error) => error instanceof ProviderUnavailableError && error.code === 'provider_configuration_invalid');
  assert.equal(calls, 0);
});

test('provider adapter accepts only explicit runtime configuration and fake fetch', async () => {
  const calls = [];
  const adapter = createProviderAdapter({
    enabled: true,
    endpoint: 'https://provider.example.test/v1/generate',
    apiKey: 'fixture-key',
    model: 'fixture-model',
  }, {
    async fetchFn(url, init) {
      calls.push({ url, init });
      return { ok: true, status: 200, async json() { return { safetyRoute: 'clean', confidence: 1 }; } };
    },
  });
  assert.deepEqual(await adapter.moderate({ text: 'fixture' }), { safetyRoute: 'clean', confidence: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://provider.example.test/v1/generate');
  assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-key');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    kind: 'moderate', model: 'fixture-model', input: { text: 'fixture' },
  });
});

test('knowledge admissions require one matching identity per source package', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-knowledge-admission-'));
  try {
    const createManifest = (sourceId, file, content) => ({
      format: 'aichattg-knowledge-manifest-v1', sourceId, entries: [{
        id: sourceId, path: file,
        sha256: createHash('sha256').update(content).digest('hex'),
        canonicalUrl: `https://knowledge.example.test/${file}`,
      }],
    });
    const contentSource = ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT;
    const operationsSource = ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS;
    const contentManifest = createManifest(contentSource, 'content.md', 'content fixture');
    const operationsManifest = createManifest(operationsSource, 'operations.md', 'operations fixture');
    writeFileSync(join(folder, 'content.md'), 'content fixture');
    writeFileSync(join(folder, 'operations.md'), 'operations fixture');
    writeFileSync(join(folder, 'content-manifest.json'), JSON.stringify(contentManifest));
    writeFileSync(join(folder, 'operations-manifest.json'), JSON.stringify(operationsManifest));
    const adapter = createKnowledgeAdapter({
      root: folder,
      admissions: {
        [contentSource]: {
          manifestPath: join(folder, 'content-manifest.json'),
          expectedIdentity: { sourceId: contentSource, manifestDigest: knowledgeManifestDigest(contentManifest) },
        },
        [operationsSource]: {
          manifestPath: join(folder, 'operations-manifest.json'),
          expectedIdentity: { sourceId: operationsSource, manifestDigest: knowledgeManifestDigest(operationsManifest) },
        },
      },
    });
    assert.equal(adapter.forSource(contentSource).available, true);
    assert.equal(adapter.forSource(operationsSource).available, true);
    assert.equal(adapter.forSource('unreviewed-source').reason, 'knowledge_source_invalid');

    const rejected = createKnowledgeAdapter({
      root: folder,
      admissions: {
        [contentSource]: {
          manifestPath: join(folder, 'content-manifest.json'),
          expectedIdentity: { sourceId: contentSource, manifestDigest: '0'.repeat(64) },
        },
      },
    });
    assert.equal(rejected.forSource(contentSource).reason, 'knowledge_identity_mismatch');
    assert.equal(rejected.forSource(operationsSource).reason, 'knowledge_identity_missing');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('moderator safety result writes a matching allow disposition before an Assistant answer', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-runtime-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store: createRuntimeStore(db), provider: fakeLlm(), knowledge: availableKnowledge(),
    ...adapters(actions),
  });
  try {
    const moderated = await runtime.handleUpdate('moderator', update(1, 50, '/ask hello'));
    assert.deepEqual({ kind: moderated.kind, verdict: moderated.verdict, action: moderated.action }, {
      kind: 'moderated', verdict: 'clean', action: 'none',
    });
    const answered = await runtime.handleUpdate('assistant', update(2, 50, '/ask hello'));
    assert.equal(answered.kind, 'answered');
    assert.equal(actions.at(-1)[0], 'send');
    assert.equal(db.prepare('SELECT status, verdict FROM runtime_assistant_moderation_dispositions').get().status, 'allowed');
    assert.equal((await runtime.handleUpdate('assistant', update(3, 50, '/ask hello'))).kind, 'duplicate_question');
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('Assistant fails closed before the claim, model and delivery boundary without a matching moderator result', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-runtime-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  let routeCalls = 0;
  const provider = fakeLlm();
  provider.routeAssistant = async () => { routeCalls++; return { action: 'teach', sourceId: 'course-content-v1' }; };
  const runtime = createTelegramRuntime({ config: config(), store: createRuntimeStore(db), provider, knowledge: availableKnowledge(), ...adapters(actions) });
  try {
    const result = await runtime.handleUpdate('assistant', update(4, 51, '/ask hello'));
    assert.equal(result.kind, 'skipped');
    assert.equal(result.reason, 'moderator_unavailable');
    assert.equal(routeCalls, 0);
    assert.equal(actions.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runtime_assistant_question_claims').get().count, 0);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('blocked and edited-revision dispositions never unlock an Assistant answer', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-runtime-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store: createRuntimeStore(db), provider: fakeLlm({ safetyRoute: 'threat' }), knowledge: availableKnowledge(),
    ...adapters(actions),
  });
  try {
    await runtime.handleUpdate('moderator', update(5, 52, '/ask unsafe'));
    const blocked = await runtime.handleUpdate('assistant', update(6, 52, '/ask unsafe'));
    assert.equal(blocked.reason, 'moderator_blocked');
    assert.deepEqual(actions.slice(0, 2).map(([kind]) => kind), ['ban', 'delete']);

    const cleanRuntime = createTelegramRuntime({
      config: config(), store: createRuntimeStore(db), provider: fakeLlm(), knowledge: availableKnowledge(), ...adapters(actions),
    });
    await cleanRuntime.handleUpdate('moderator', update(7, 53, '/ask original'));
    const edited = await cleanRuntime.handleUpdate('assistant', editedUpdate(8, 53, '/ask changed'));
    assert.equal(edited.reason, 'moderator_unavailable');
    assert.equal(actions.filter(([kind]) => kind === 'send').length, 0);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('weak-abuse safety plans advance independently to warning, final warning and ban', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-runtime-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config(), store: createRuntimeStore(db), provider: fakeLlm({ safetyRoute: 'abuse', abuseLevel: 'weak' }),
    knowledge: availableKnowledge(), ...adapters(actions),
  });
  try {
    const first = await runtime.handleUpdate('moderator', update(9, 61, 'abuse'));
    const second = await runtime.handleUpdate('moderator', update(10, 62, 'abuse'));
    const third = await runtime.handleUpdate('moderator', update(11, 63, 'abuse'));
    assert.deepEqual([first.action, second.action, third.action], ['delete_warn_1', 'delete_warn_2', 'ban_purge']);
    assert.equal(db.prepare('SELECT weak_strikes FROM runtime_moderation_weak_strikes').get().weak_strikes, 3);
    assert.deepEqual(actions.map(([kind]) => kind), ['delete', 'warn', 'notify', 'delete', 'warn', 'notify', 'ban', 'delete']);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('course-operations hints reject content routing and need the isolated operations snapshot', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-runtime-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  const provider = fakeLlm();
  provider.routeAssistant = async () => ({ action: 'teach', sourceId: 'course-content-v1' });
  const runtime = createTelegramRuntime({ config: config(), store: createRuntimeStore(db), provider, knowledge: availableKnowledge(), ...adapters(actions) });
  try {
    await runtime.handleUpdate('moderator', update(12, 70, '/ask В курсе как перейти к следующему уроку?'));
    const result = await runtime.handleUpdate('assistant', update(13, 70, '/ask В курсе как перейти к следующему уроку?'));
    assert.equal(result.reason, 'course_operations_route_required');
    assert.equal(actions.length, 0);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('course-operations answers receive only the isolated operations snapshot', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-runtime-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  const provider = fakeLlm();
  let answerInput;
  provider.answer = async (input) => { answerInput = input; return { text: 'offline support answer', modelId: 'fake' }; };
  const runtime = createTelegramRuntime({ config: config(), store: createRuntimeStore(db), provider, knowledge: availableKnowledge(), ...adapters(actions) });
  try {
    await runtime.handleUpdate('moderator', update(14, 71, '/ask В курсе какая цена?'));
    const result = await runtime.handleUpdate('assistant', update(15, 71, '/ask В курсе какая цена?'));
    assert.deepEqual(result.route, { action: 'support', sourceId: 'course-operations-v1' });
    assert.equal(answerInput.knowledge.sourceId, 'course-operations-v1');
    assert.equal(actions.at(-1)[0], 'send');
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('a duplicate pending write cannot regress a terminal Moderator disposition', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-runtime-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const store = createRuntimeStore(db, { now: () => 100 });
  try {
    const identity = { chatId: '-100', messageId: '72', moderationMessageId: '-100:72' };
    store.upsertAssistantDisposition({ ...identity, status: 'allowed', verdict: 'clean', reason: 'clean' });
    store.upsertAssistantDisposition({ ...identity, status: 'pending', reason: 'duplicate' });
    assert.equal(store.getAssistantDisposition(identity).status, 'allowed');
    store.upsertAssistantDisposition({ ...identity, moderationMessageId: '-100:edit:16:72', status: 'pending', reason: 'edit' });
    assert.equal(store.getAssistantDisposition(identity).status, 'pending');
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('HTTP ingress is opt-in and validates role-specific webhook secrets', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-http-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  const runtime = createTelegramRuntime({
    config: config({ ingressEnabled: true, moderationMode: 'shadow' }), store: createRuntimeStore(db),
    provider: fakeLlm(), knowledge: availableKnowledge(), ...adapters(actions),
  });
  const server = createTelegramRuntimeHttpServer({ config: config({ ingressEnabled: true, moderationMode: 'shadow' }), runtime, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    assert.equal((await request(server, '/webhooks/telegram/assistant', {}, update(16, 80, '/ask Hi'))).status, 401);
    const headers = { 'x-telegram-bot-api-secret-token': 'moderator-secret' };
    assert.equal((await request(server, '/webhooks/telegram/moderator', headers, update(17, 80, '/ask Hi'))).status, 200);
    const accepted = await request(server, '/webhooks/telegram/assistant', { 'x-telegram-bot-api-secret-token': 'assistant-secret' }, update(18, 80, '/ask Hi'));
    assert.equal(accepted.status, 200);
    assert.equal(actions.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(folder, { recursive: true, force: true });
  }
});
