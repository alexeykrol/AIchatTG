import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeReviewService } from '../src/moderation-review-service.mjs';
import { createReviewIpcServer, requestReviewIpc } from '../../../packages/telegram-core/src/moderation-review-ipc.mjs';
import { validateModerationReviewBinding, reviewSocketPaths } from '../../../packages/telegram-core/src/moderation-review-config.mjs';

const TIME = Date.parse('2026-09-17T12:00:00.000Z');
const CLAIM = { caseId: '10000000-0000-4000-8000-000000000001', attemptId: '20000000-0000-4000-8000-000000000001' };
const config = { moderator: { chatIds: ['-100100'], exemptBotIds: [], botToken: '111:fixture_secret_000000000000' },
  assistant: { botToken: '222:fixture_secret_000000000000' } };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
}

async function fixture(t) {
  const root = await mkdtemp(join(await realpath('/tmp'), 'review-service-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return validateModerationReviewBinding({ contract: 'moderation-review-binding/v1', enabled: true,
    bindingId: 'fixture_binding', epochId: 'fixture_epoch', chatIds: config.moderator.chatIds,
    startAt: '2026-09-17T11:00:00.000Z', allowUserId: false, exemptBotIds: ['111', '222'],
    limits: { retentionMs: null, maxTextChars: 2000, maxContextChars: 500, maxNoteChars: 1000, maxObservations: 100 },
    maxEvents: 100, maxErasureReceipts: 100, maxInflight: 4, captureTimeoutMs: 1000, ipcTimeoutMs: 1000,
    notificationTimeoutMs: 1000, notificationIntervalMs: 60_000, maxAlertsPerHour: 5,
    recipientChatId: '999001', reviewerPrincipal: 'fixture-owner', consoleUrl: 'https://console.example.invalid',
    ipcRoot: root, storeRoot: `${root}-store`, deliveryEnabled: true });
}

for (const mode of ['caller cancellation', 'runtime shutdown']) {
  test(`real private sockets: ${mode} during authorization prevents a late notification`, async (t) => {
    const binding = await fixture(t), sockets = reviewSocketPaths(binding);
    const authorizationEntered = deferred(), release = deferred(), authorizationAborted = deferred(), notificationFinished = deferred();
    let calls = 0;
    const consoleIpc = await createReviewIpcServer({ socketPath: sockets.console, handle: async ({ path, signal }) => {
      assert.equal(path, '/authorize');
      signal.addEventListener('abort', authorizationAborted.resolve, { once: true });
      authorizationEntered.resolve();
      await release.promise;
      return { statusCode: 200, body: { authorized: true } };
    } });
    t.after(() => consoleIpc.close());
    const runtime = await createRuntimeReviewService({ binding, config, now: () => TIME,
      serverFactory: (options) => createReviewIpcServer({ ...options, handle: async (input) => {
        const result = await options.handle(input); notificationFinished.resolve(result); return result;
      } }), fetchImpl: () => { calls++; assert.fail('cancelled notification must not invoke external transport'); } });
    t.after(() => runtime.close());
    const controller = new AbortController();
    const pending = requestReviewIpc({ socketPath: sockets.runtime, path: '/notify', body: CLAIM, signal: controller.signal });
    const rejected = assert.rejects(pending, (error) => /^review_ipc_/u.test(error.code));
    await authorizationEntered.promise;
    if (mode === 'runtime shutdown') await runtime.close(); else controller.abort();
    await rejected;
    await authorizationAborted.promise;
    const result = await notificationFinished.promise;
    assert.deepEqual(result.body, { ok: false, definite: true, code: 'review_sender_cancelled' });
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
  });
}

test('real private sockets: shutdown aborts an invoked send, frees the endpoint and permits restart without replay', async (t) => {
  const binding = await fixture(t), sockets = reviewSocketPaths(binding);
  const entered = deferred(), finished = deferred();
  let externalSignal, calls = 0;
  const consoleIpc = await createReviewIpcServer({ socketPath: sockets.console,
    handle: () => ({ statusCode: 200, body: { authorized: true } }) });
  t.after(() => consoleIpc.close());
  const runtime = await createRuntimeReviewService({ binding, config, now: () => TIME,
    serverFactory: (options) => createReviewIpcServer({ ...options, handle: async (input) => {
      const result = await options.handle(input); finished.resolve(result); return result;
    } }), fetchImpl: (_url, { signal }) => {
      externalSignal = signal; calls++; entered.resolve(); return new Promise(() => {});
    } });
  t.after(() => runtime.close());
  const pending = requestReviewIpc({ socketPath: sockets.runtime, path: '/notify', body: CLAIM });
  const rejected = assert.rejects(pending, (error) => /^review_ipc_/u.test(error.code));
  await entered.promise;
  await runtime.close();
  await rejected;
  assert.deepEqual((await finished.promise).body, { ok: false, definite: false, code: 'review_sender_cancelled' });
  assert.equal(externalSignal.aborted, true);
  assert.equal(calls, 1);
  const restarted = await createRuntimeReviewService({ binding, config, now: () => TIME,
    fetchImpl: () => assert.fail('restarted runtime must not replay a prior notification') });
  try {
    const coverage = await requestReviewIpc({ socketPath: sockets.runtime, path: '/coverage', body: {} });
    assert.equal(coverage.statusCode, 200);
    assert.equal(coverage.body.contract, 'moderation-review-coverage/v1');
    assert.equal(coverage.body.active, 0);
    assert.equal(calls, 1);
  } finally { await restarted.close(); }
});

test('unconfigured runtime creates no capture/socket; a username cannot replace the explicit numeric recipient', async (t) => {
  const runtime = await createRuntimeReviewService({ serverFactory: () => assert.fail('disabled must not bind'),
    fetchImpl: () => assert.fail('disabled must not send') });
  assert.equal(runtime.capture, null);
  await runtime.close();
  const binding = await fixture(t);
  assert.throws(() => validateModerationReviewBinding({ ...binding, recipientChatId: '@synthetic_username' }),
    { code: 'review_binding_invalid' });
});
