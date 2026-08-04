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

function enabledProviderConfig(overrides = {}) {
  return {
    enabled: true,
    vendor: 'openai-compatible',
    endpoint: 'https://provider.example.test/v1',
    apiKey: 'fixture-key',
    modelTuples: {
      moderatorSafety: { model: 'moderator-model', reasoningEffort: 'minimal', maxOutputTokens: 200 },
      assistantRouter: { model: 'router-model', reasoningEffort: 'none', maxOutputTokens: 100 },
      assistantAnswer: { model: 'answer-model', reasoningEffort: 'low', maxOutputTokens: 500 },
    },
    ...overrides,
  };
}

test('default configuration does not plan Telegram side effects or polling', () => {
  const loaded = loadRuntimeConfig({}, { cwd: '/tmp/aichattg-test' });
  assert.deepEqual(loaded.startupPlan, { setCommands: false, registerWebhook: false, deleteWebhook: false, poll: false });
  assert.equal(loaded.ingressEnabled, false);
  assert.equal(loaded.assistantModerationWaitMs, 30_000);
  assert.equal(loaded.provider.enabled, false);
  assert.throws(() => loadRuntimeConfig({ TELEGRAM_RUNTIME_POLLING_ENABLED: 'true' }), /polling/);
  assert.throws(() => loadRuntimeConfig({ TELEGRAM_RUNTIME_PROVIDER_ENABLED: 'true' }), /OpenAI-compatible/);
  assert.throws(() => loadRuntimeConfig({
    TELEGRAM_RUNTIME_KNOWLEDGE_CONTENT_MANIFEST_PATH: '/tmp/unreviewed-course-content.manifest.json',
  }, { cwd: '/tmp/aichattg-test' }), /must name a file below TELEGRAM_RUNTIME_KNOWLEDGE_ROOT/);
});

test('disabled or invalid provider adapters cannot call fetch', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; };
  const disabled = createProviderAdapter({ enabled: false }, { fetchFn });
  const invalid = createProviderAdapter(enabledProviderConfig({ endpoint: 'http://provider.example.test/v1' }), { fetchFn });
  await assert.rejects(disabled.answer({}), (error) => error instanceof ProviderUnavailableError && error.code === 'provider_disabled');
  await assert.rejects(invalid.routeAssistant({}), (error) => error instanceof ProviderUnavailableError && error.code === 'provider_endpoint_invalid');
  assert.equal(calls, 0);
});

test('provider adapter accepts only explicit runtime configuration and fake fetch', async () => {
  const calls = [];
  const adapter = createProviderAdapter(enabledProviderConfig(), {
    async fetchFn(url, init) {
      calls.push({ url, init });
      return {
        ok: true, status: 200,
        headers: { get(name) { return name === 'x-request-id' ? 'fixture-request' : null; } },
        async json() {
          return {
            model: 'moderator-model',
            choices: [{ message: { content: JSON.stringify({ safetyRoute: 'clean', abuseLevel: null, confidence: 1, reason: 'fixture', quote: '' }) } }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          };
        },
      };
    },
  });
  const result = await adapter.moderate({ text: 'fixture' });
  assert.equal(result.safetyRoute, 'clean');
  assert.equal(result.modelId, 'moderator-model');
  assert.equal(result.receipt.requestId, 'fixture-request');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://provider.example.test/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-key');
  assert.equal(JSON.parse(calls[0].init.body).model, 'moderator-model');
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

test('a terminal webhook receipt is persisted once and replayed deterministically', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-inbox-replay-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  let moderationCalls = 0;
  const provider = fakeLlm();
  provider.moderate = async () => {
    moderationCalls++;
    return { safetyRoute: 'clean', abuseLevel: null, confidence: 1, reason: 'fixture', modelId: 'fake' };
  };
  const loaded = config({ ingressEnabled: true, moderationMode: 'shadow' });
  const runtime = createTelegramRuntime({
    config: loaded, store: createRuntimeStore(db), provider, knowledge: availableKnowledge(), ...adapters(actions),
  });
  const server = createTelegramRuntimeHttpServer({ config: loaded, runtime, logger: { error() {} } });
  const delivery = update(401, 90, '/ask replay');
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const first = await request(server, '/webhooks/telegram/moderator', {
      'x-telegram-bot-api-secret-token': 'moderator-secret',
    }, delivery);
    const replay = await request(server, '/webhooks/telegram/moderator', {
      'x-telegram-bot-api-secret-token': 'moderator-secret',
    }, delivery);

    assert.equal(first.status, 200);
    assert.deepEqual(replay, first);
    assert.equal(moderationCalls, 1);
    const conflict = await request(server, '/webhooks/telegram/moderator', {
      'x-telegram-bot-api-secret-token': 'moderator-secret',
    }, update(401, 90, '/ask altered'));
    assert.deepEqual(conflict.body.result, {
      kind: 'delivery_conflict', eventId: 'moderator:401', receiptId: 'moderator:401', reason: 'receipt_identity_conflict',
    });
    assert.equal(moderationCalls, 1);
    assert.deepEqual(db.prepare(`SELECT receipt_id, revision_identity FROM runtime_inbound_update_conflicts`).get(), {
      receipt_id: 'moderator:401', revision_identity: '-100:90',
    });
    assert.deepEqual(db.prepare(`SELECT receipt_id, bot_role, update_id, revision_identity,
      status, claim_generation, result_json FROM runtime_inbound_update_receipts`).get(), {
      receipt_id: 'moderator:401', bot_role: 'moderator', update_id: 401,
      revision_identity: '-100:90', status: 'completed', claim_generation: 1,
      result_json: JSON.stringify(first.body.result),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(folder, { recursive: true, force: true });
  }
});

test('concurrent redelivery observes the active fenced claim and never runs it twice', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-inbox-concurrency-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  let moderationCalls = 0;
  let releaseModeration;
  const provider = fakeLlm();
  provider.moderate = async () => {
    moderationCalls++;
    return new Promise((resolve) => { releaseModeration = resolve; });
  };
  const runtime = createTelegramRuntime({
    config: config(), store: createRuntimeStore(db), provider, knowledge: availableKnowledge(), ...adapters(actions),
  });
  const delivery = update(402, 91, 'concurrent');
  try {
    const first = runtime.handleUpdate('moderator', delivery);
    await new Promise((resolve) => setImmediate(resolve));
    const duplicate = await runtime.handleUpdate('moderator', delivery);
    assert.deepEqual(duplicate, {
      kind: 'processing', eventId: 'moderator:402', receiptId: 'moderator:402', reason: 'claim_in_progress',
    });
    assert.equal(moderationCalls, 1);

    releaseModeration({ safetyRoute: 'clean', abuseLevel: null, confidence: 1, reason: 'fixture', modelId: 'fake' });
    const completed = await first;
    const replay = await runtime.handleUpdate('moderator', delivery);
    assert.deepEqual(replay, completed);
    assert.equal(moderationCalls, 1);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('original and edited revisions remain separate inbound receipts', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-inbox-revision-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const actions = [];
  let moderationCalls = 0;
  const provider = fakeLlm();
  provider.moderate = async () => {
    moderationCalls++;
    return { safetyRoute: 'clean', abuseLevel: null, confidence: 1, reason: 'fixture', modelId: 'fake' };
  };
  const runtime = createTelegramRuntime({
    config: config(), store: createRuntimeStore(db), provider, knowledge: availableKnowledge(), ...adapters(actions),
  });
  try {
    const original = await runtime.handleUpdate('moderator', update(403, 92, 'original'));
    const edited = await runtime.handleUpdate('moderator', editedUpdate(404, 92, 'edited'));
    assert.equal(original.kind, 'moderated');
    assert.equal(edited.kind, 'moderated');
    assert.equal(moderationCalls, 2);
    assert.deepEqual(db.prepare(`SELECT receipt_id, revision_identity, status
      FROM runtime_inbound_update_receipts ORDER BY update_id`).all(), [
      { receipt_id: 'moderator:403', revision_identity: '-100:92', status: 'completed' },
      { receipt_id: 'moderator:404', revision_identity: '-100:edit:404:92', status: 'completed' },
    ]);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('restart recovery quarantines an abandoned claim without replaying a provider or Telegram call', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-inbox-restart-'));
  const databasePath = join(folder, 'runtime.db');
  const firstDb = openRuntimeDatabase(databasePath);
  const firstActions = [];
  const hangingProvider = fakeLlm();
  hangingProvider.moderate = async () => new Promise(() => {});
  const firstRuntime = createTelegramRuntime({
    config: config(), store: createRuntimeStore(firstDb), provider: hangingProvider,
    knowledge: availableKnowledge(), ...adapters(firstActions),
  });
  const delivery = update(405, 93, 'recover me');
  try {
    void firstRuntime.handleUpdate('moderator', delivery);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(firstDb.prepare("SELECT status FROM runtime_inbound_update_receipts WHERE receipt_id = 'moderator:405'").get().status, 'processing');
    firstDb.close();

    const restartedDb = openRuntimeDatabase(databasePath);
    let providerCalls = 0;
    const provider = fakeLlm();
    provider.moderate = async () => { providerCalls++; throw new Error('must not run during recovery'); };
    const restartedStore = createRuntimeStore(restartedDb);
    const restartedRuntime = createTelegramRuntime({
      config: config(), store: restartedStore, provider, knowledge: availableKnowledge(), ...adapters([]),
    });
    try {
      assert.deepEqual(await restartedRuntime.handleUpdate('moderator', delivery), {
        kind: 'processing', eventId: 'moderator:405', receiptId: 'moderator:405', reason: 'claim_in_progress',
      });
      assert.equal(providerCalls, 0);
      assert.deepEqual(restartedRuntime.recoverInboundDeliveries({ recoveryId: 'operator-recovery-405' }), {
        recoveryId: 'operator-recovery-405', quarantined: 1,
      });
      assert.deepEqual(await restartedRuntime.handleUpdate('moderator', delivery), {
        kind: 'uncertain_delivery', eventId: 'moderator:405', receiptId: 'moderator:405',
        reason: 'recovery_required', recoveryId: 'operator-recovery-405',
      });
      assert.equal(providerCalls, 0);
      const stale = restartedDb.prepare(`SELECT receipt_id, claim_id, claim_generation
        FROM runtime_inbound_update_receipts WHERE receipt_id = 'moderator:405'`).get();
      assert.equal(restartedStore.completeInboundDelivery({
        claim: { receiptId: stale.receipt_id, claimId: stale.claim_id, claimGeneration: stale.claim_generation - 1 },
        status: 'completed', result: { kind: 'must_not_finalize' },
      }).completed, false);
    } finally { restartedDb.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('an ambiguous Telegram delivery is quarantined and exact redelivery cannot resend it', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-inbox-uncertain-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const store = createRuntimeStore(db);
  const delivery = update(406, 94, '/help');
  let sends = 0;
  store.upsertAssistantDisposition({
    chatId: '-100', messageId: '94', status: 'allowed', verdict: 'clean', reason: 'fixture',
    moderationMessageId: '-100:94', moderationEventId: 'moderator:94',
  });
  const runtime = createTelegramRuntime({
    config: config(), store, provider: fakeLlm(), knowledge: availableKnowledge(),
    moderatorTelegram: adapters([]).moderatorTelegram,
    assistantTelegram: {
      async sendMessage() { sends++; throw new Error('delivery outcome unknown'); },
    },
    notifier: adapters([]).notifier,
  });
  try {
    const first = await runtime.handleUpdate('assistant', delivery);
    const replay = await runtime.handleUpdate('assistant', delivery);
    assert.equal(first.kind, 'uncertain_delivery');
    assert.equal(first.reason, 'runtime_error');
    assert.equal(replay.kind, 'uncertain_delivery');
    assert.equal(replay.reason, 'runtime_error');
    assert.equal(sends, 1);
    assert.deepEqual(db.prepare(`SELECT status, error_code FROM runtime_inbound_update_receipts
      WHERE receipt_id = 'assistant:406'`).get(), { status: 'uncertain', error_code: 'runtime_error' });
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});
