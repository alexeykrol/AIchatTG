import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantAskExpiryWorker } from '../src/assistant-ask-expiry.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function timerHarness() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled, cleared,
    setIntervalFn(callback, interval) { const timer = { callback, interval }; scheduled.push(timer); return timer; },
    clearIntervalFn(timer) { cleared.push(timer); },
  };
}

test('expiry worker requires a supported runtime', () => {
  assert.throws(() => createAssistantAskExpiryWorker(), /expiry support/);
  assert.throws(() => createAssistantAskExpiryWorker({ runtime: {} }), /expiry support/);
});

test('start drains recovery immediately, starts exactly one timer, and stop is idempotent', async () => {
  const timers = timerHarness();
  const calls = [];
  const worker = createAssistantAskExpiryWorker({ ...timers,
    runtime: { async expireAssistantAskPrompts(input) { calls.push(input); return { expired: 0 }; } },
  });
  assert.equal(worker.start(), true);
  assert.equal(worker.start(), false);
  assert.deepEqual(calls, [{ limit: 10, startup: true }]);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].interval, 1000);
  await flush();
  timers.scheduled[0].callback();
  await flush();
  assert.deepEqual(calls[1], { limit: 10, startup: false });
  assert.equal(worker.stop(), true);
  assert.equal(worker.stop(), false);
  assert.deepEqual(timers.cleared, [timers.scheduled[0]]);
  assert.equal(worker.active, false);
});

test('startup, timer and manual drains cannot overlap an in-flight cleanup batch', async () => {
  const timers = timerHarness();
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = createAssistantAskExpiryWorker({ ...timers,
    runtime: { async expireAssistantAskPrompts() { calls++; await gate; return { expired: 1 }; } },
  });
  worker.start();
  assert.equal(worker.active, true);
  timers.scheduled[0].callback();
  assert.deepEqual(await worker.drain(), { skipped: 'worker_already_active' });
  assert.equal(calls, 1);
  release();
  await flush();
  assert.equal(worker.active, false);
  assert.deepEqual(await worker.drain(), { expired: 1 });
  assert.equal(calls, 2);
  worker.stop();
});

for (const [intervalMs, batchSize, expectedInterval, expectedLimit] of [
  [1, -1, 250, 1], [100_000, 100_000, 5000, 50], [NaN, NaN, 1000, 10], [750, 12, 750, 12],
]) {
  test(`worker bounds interval ${intervalMs} and batch ${batchSize}`, async () => {
    const timers = timerHarness();
    const calls = [];
    const worker = createAssistantAskExpiryWorker({ ...timers, intervalMs, batchSize,
      runtime: { async expireAssistantAskPrompts(input) { calls.push(input); return { expired: 0 }; } },
    });
    worker.start();
    await flush();
    assert.equal(timers.scheduled[0].interval, expectedInterval);
    assert.equal(calls[0].limit, expectedLimit);
    worker.stop();
  });
}

test('failed batch releases the local overlap fence and next batch can run', async () => {
  const logs = [];
  let calls = 0;
  const worker = createAssistantAskExpiryWorker({
    logger: { error(...args) { logs.push(args); } },
    runtime: { async expireAssistantAskPrompts() {
      calls++;
      if (calls === 1) throw new Error('fixture failure');
      return { expired: 0 };
    } },
  });
  assert.deepEqual(await worker.drain(), { failed: 'ask_expiry_runtime_error' });
  assert.equal(worker.active, false);
  assert.equal(logs.length, 1);
  assert.deepEqual(await worker.drain(), { expired: 0 });
  assert.equal(calls, 2);
});
