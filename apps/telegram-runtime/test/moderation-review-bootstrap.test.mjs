import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

// Execute only the checked-in signal-registration block with fake process/HTTP
// dependencies. Never import a production bootstrap or send an actual signal.
function shutdownBlock(source) {
  const start = source.lastIndexOf("for (const signal of ['SIGINT', 'SIGTERM'])");
  assert.ok(start >= 0);
  const opening = source.indexOf('{', start);
  let depth = 0;
  for (let end = opening; end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}' && --depth === 0) return source.slice(start, end + 1);
  }
  assert.fail('shutdown registration block must be complete');
}

for (const [name, file] of [
  ['runtime', new URL('../src/server.mjs', import.meta.url)],
  ['Console', new URL('../../operator-console/src/server.mjs', import.meta.url)],
]) {
  test(`${name} bootstrap starts private Review close before a stalled public HTTP drain`, async () => {
    const registrations = new Map(), calls = [];
    let drain, releaseReview;
    const reviewClosed = new Promise((resolve) => { releaseReview = resolve; });
    const context = {
      process: { once: (signal, callback) => registrations.set(signal, callback), exit: (code) => calls.push(`exit:${code}`) },
      review: { close: () => { calls.push('review-close'); return reviewClosed; } },
      server: { close: (callback) => { calls.push('http-drain'); drain = callback; } },
      recoveryWorker: { stop: () => calls.push('recovery-stop') },
      askExpiryWorker: { stop: () => calls.push('expiry-stop') },
      database: { close: () => calls.push('database-close') },
    };
    vm.runInNewContext(shutdownBlock(await readFile(file, 'utf8')), context);
    registrations.get('SIGTERM')();
    assert.ok(calls.indexOf('review-close') >= 0);
    assert.ok(calls.indexOf('review-close') < calls.indexOf('http-drain'));
    releaseReview();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.includes('exit:0'), false, 'unrelated HTTP work may remain active while Review is closed');
    assert.equal(calls.includes('database-close'), false);
    await drain();
    assert.equal(calls.at(-1), 'exit:0');
    if (name === 'runtime') assert.equal(calls.at(-2), 'database-close');
  });
}
