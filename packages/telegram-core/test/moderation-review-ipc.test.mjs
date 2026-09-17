import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createReviewIpcServer, requestReviewIpc } from '../src/moderation-review-ipc.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
}

async function fixture(t) {
  const directory = await mkdtemp(join(await realpath('/tmp'), 'review-ipc-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, socketPath: join(directory, 'ipc.sock') };
}

async function start(t, options) {
  const owner = await createReviewIpcServer(options);
  t.after(() => owner.close());
  return owner;
}

async function rawServer(t, socketPath, handle) {
  const server = http.createServer(handle);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closed;
  });
  return server;
}

function rawRequest(socketPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: '/capture', method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', ...headers } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('private IPC round trip has owned0700 directory and owned0600 socket, and close is idempotent', async (t) => {
  const { directory, socketPath } = await fixture(t);
  const owner = await start(t, { socketPath, handle: async ({ path, body, signal }) => {
    assert.equal(path, '/capture');
    assert.equal(signal.aborted, false);
    return { statusCode: 202, body: { accepted: body.value } };
  } });
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(socketPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['ipc.sock'], 'only the configured socket remains after publication');
  assert.deepEqual(await requestReviewIpc({ socketPath, path: '/capture', body: { value: 'synthetic' } }),
    { statusCode: 202, body: { accepted: 'synthetic' } });
  await Promise.all([owner.close(), owner.close()]);
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
});

test('existing socket is never taken over or removed by another server', async (t) => {
  const { socketPath } = await fixture(t);
  await start(t, { socketPath, handle: () => ({ statusCode: 200, body: { owner: true } }) });
  await assert.rejects(createReviewIpcServer({ socketPath, handle() {} }), { code: 'review_ipc_socket_exists' });
  assert.deepEqual((await requestReviewIpc({ socketPath, path: '/capture', body: {} })).body, { owner: true });
});

test('close preserves a replacement regular file instead of unlinking somebody else’s path', async (t) => {
  const { socketPath } = await fixture(t);
  const owner = await start(t, { socketPath, handle() {} });
  await unlink(socketPath);
  await writeFile(socketPath, 'replacement', { mode: 0o600 });
  await owner.close();
  assert.equal(await readFile(socketPath, 'utf8'), 'replacement');
});

test('close does not unlink a replacement socket owned by a new server', async (t) => {
  const { socketPath } = await fixture(t);
  const first = await start(t, { socketPath, handle() {} });
  await unlink(socketPath);
  await start(t, { socketPath, handle: () => ({ statusCode: 200, body: { generation: 2 } }) });
  await first.close();
  assert.equal((await requestReviewIpc({ socketPath, path: '/capture', body: {} })).body.generation, 2);
});

test('unsafe directory permissions reject both server and client', async (t) => {
  const { directory, socketPath } = await fixture(t);
  await chmod(directory, 0o750);
  await assert.rejects(createReviewIpcServer({ socketPath, handle() {} }), { code: 'review_ipc_directory_unsafe' });
  await assert.rejects(requestReviewIpc({ socketPath, path: '/capture', body: {} }), { code: 'review_ipc_directory_unsafe' });
});

test('symlink directory, symlink socket, regular file and public socket fail closed', async (t) => {
  const { directory, socketPath } = await fixture(t);
  await writeFile(socketPath, 'synthetic', { mode: 0o600 });
  await assert.rejects(requestReviewIpc({ socketPath, path: '/capture', body: {} }), { code: 'review_ipc_socket_unsafe' });
  await unlink(socketPath);
  const alternate = join(directory, 'alternate');
  await writeFile(alternate, 'synthetic');
  await symlink(alternate, socketPath);
  await assert.rejects(requestReviewIpc({ socketPath, path: '/capture', body: {} }), { code: 'review_ipc_socket_unsafe' });
  await unlink(socketPath);
  await start(t, { socketPath, handle() {} });
  await chmod(socketPath, 0o644);
  await assert.rejects(requestReviewIpc({ socketPath, path: '/capture', body: {} }), { code: 'review_ipc_socket_unsafe' });
  const link = join(directory, 'directory-link');
  await symlink(directory, link);
  await assert.rejects(createReviewIpcServer({ socketPath: join(link, 'other.sock'), handle() {} }),
    { code: 'review_ipc_directory_unsafe' });
});

test('client refuses network-style routes, bad configuration, non-JSON and oversized bodies before socket use', async () => {
  for (const extra of [{ path: 'https://example.invalid/' }, { timeoutMs: 0 }, { timeoutMs: 30_001 }, { signal: {} }]) {
    await assert.rejects(requestReviewIpc({ socketPath: '/missing/ipc.sock', path: '/capture', body: {}, ...extra }),
      { code: 'review_ipc_config_invalid' });
  }
  const cycle = {}; cycle.self = cycle;
  for (const body of [null, [], { x: undefined }, { x: NaN }, { x: () => {} }, cycle, { x: 'x'.repeat(65536) }]) {
    await assert.rejects(requestReviewIpc({ socketPath: '/missing/ipc.sock', path: '/capture', body }),
      { code: 'review_ipc_body_invalid' });
  }
});

test('server rejects oversized, malformed and invalid UTF-8 request bodies without calling handler', async (t) => {
  const { socketPath } = await fixture(t);
  let calls = 0;
  await start(t, { socketPath, handle: () => { calls++; return { statusCode: 200, body: {} }; } });
  for (const body of ['{"x":', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]) {
    assert.equal((await rawRequest(socketPath, body)).statusCode, 400);
  }
  assert.equal((await rawRequest(socketPath, '{}', { 'content-length': '70000' })).statusCode, 413);
  try {
    assert.equal((await rawRequest(socketPath, JSON.stringify({ x: 'x'.repeat(70_000) }),
      { 'transfer-encoding': 'chunked' })).statusCode, 413);
  } catch (error) {
    assert.ok(['EPIPE', 'ECONNRESET'].includes(error.code), 'oversized streaming request is closed');
  }
  assert.equal(calls, 0);
});

test('handler throws only a safe error and cannot emit an oversized response', async (t) => {
  const { socketPath } = await fixture(t);
  await start(t, { socketPath, handle: ({ body }) => {
    if (body.throw) throw new Error('private evidence or token must not escape');
    return { statusCode: 200, body: { text: 'x'.repeat(17_000) } };
  } });
  assert.deepEqual(await requestReviewIpc({ socketPath, path: '/capture', body: { throw: true } }),
    { statusCode: 500, body: { code: 'review_ipc_handler_failed' } });
  assert.deepEqual(await requestReviewIpc({ socketPath, path: '/capture', body: {} }),
    { statusCode: 500, body: { code: 'review_ipc_handler_response_invalid' } });
});

test('bodyless HTTP status cannot masquerade as a complete JSON response', async (t) => {
  const { socketPath } = await fixture(t);
  await start(t, { socketPath, handle: ({ body }) => ({ statusCode: body.status, body: {} }) });
  for (const status of [204, 205, 304, 100, 600]) {
    assert.deepEqual(await requestReviewIpc({ socketPath, path: '/capture', body: { status } }),
      { statusCode: 500, body: { code: 'review_ipc_handler_response_invalid' } });
  }
});

for (const [name, send] of [
  ['malformed JSON', (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{'); }],
  ['wrong media type', (_request, response) => { response.end('{}'); }],
  ['oversized body', (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ x: 'x'.repeat(17_000) })); }],
  ['partial body', (_request, response) => { response.writeHead(200, { 'content-type': 'application/json', 'content-length': 100 }); response.write('{}'); setImmediate(() => response.destroy()); }],
]) {
  test(`client rejects ${name} with a safe code`, async (t) => {
    const { socketPath } = await fixture(t);
    await rawServer(t, socketPath, send);
    await assert.rejects(requestReviewIpc({ socketPath, path: '/capture', body: {} }),
      (error) => /^review_ipc_/u.test(error.code) && error.message === error.code);
  });
}

test('real hard deadline ends continuously streaming response without retry', async (t) => {
  const { socketPath } = await fixture(t);
  let calls = 0;
  await rawServer(t, socketPath, (_request, response) => {
    calls++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
    const interval = setInterval(() => response.write(' '), 5);
    response.on('close', () => clearInterval(interval));
  });
  const before = Date.now();
  await assert.rejects(requestReviewIpc({ socketPath, path: '/capture', body: {}, timeoutMs: 80 }),
    { code: 'review_ipc_timeout' });
  assert.ok(Date.now() - before < 1000);
  assert.equal(calls, 1);
});

test('cancellation during response streaming destroys the local connection', async (t) => {
  const { socketPath } = await fixture(t);
  const entered = deferred();
  const closed = deferred();
  const controller = new AbortController();
  await rawServer(t, socketPath, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
    response.on('close', closed.resolve);
    entered.resolve();
  });
  const pending = requestReviewIpc({ socketPath, path: '/capture', body: {}, signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { code: 'review_ipc_cancelled' });
  await closed.promise;
});

test('cancellation before invocation and while handler runs is propagated', async (t) => {
  const { socketPath } = await fixture(t);
  const entered = deferred();
  const aborted = deferred();
  const controller = new AbortController();
  await start(t, { socketPath, handle: async ({ signal }) => {
    entered.resolve();
    signal.addEventListener('abort', aborted.resolve, { once: true });
    await aborted.promise;
    return { statusCode: 200, body: {} };
  } });
  const pending = requestReviewIpc({ socketPath, path: '/capture', body: {}, signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { code: 'review_ipc_cancelled' });
  await aborted.promise;
  await assert.rejects(requestReviewIpc({ socketPath, path: '/capture', body: {}, signal: controller.signal }),
    { code: 'review_ipc_cancelled' });
});

test('concurrency remains bounded even when an aborted handler ignores cancellation', async (t) => {
  const { socketPath } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const aborted = deferred();
  let calls = 0;
  await start(t, { socketPath, timeoutMs: 80, maxConcurrent: 1, handle: async ({ signal }) => {
    calls++;
    signal.addEventListener('abort', aborted.resolve, { once: true });
    entered.resolve();
    await release.promise;
    return { statusCode: 200, body: {} };
  } });
  const first = requestReviewIpc({ socketPath, path: '/capture', body: {}, timeoutMs: 500 });
  const firstRejected = assert.rejects(first, (error) => /^review_ipc_/u.test(error.code));
  await entered.promise;
  assert.equal((await requestReviewIpc({ socketPath, path: '/capture', body: {} })).statusCode, 503);
  await aborted.promise;
  await firstRejected;
  assert.equal((await requestReviewIpc({ socketPath, path: '/capture', body: {} })).statusCode, 503);
  assert.equal(calls, 1);
  release.resolve();
});

test('a raw client that never completes headers is closed on a hard deadline', async (t) => {
  const { socketPath } = await fixture(t);
  await start(t, { socketPath, timeoutMs: 60, handle() { assert.fail('handler must not run'); } });
  const socket = net.createConnection(socketPath);
  const before = Date.now();
  await new Promise((resolve, reject) => {
    socket.on('connect', () => socket.write('POST /capture HTTP/1.1\r\n'));
    socket.on('error', reject);
    socket.on('close', resolve);
  });
  assert.ok(Date.now() - before < 1000);
});

test('server shutdown aborts in-flight handler and rejects client without waiting for an uncooperative handler', async (t) => {
  const { socketPath } = await fixture(t);
  const entered = deferred();
  const aborted = deferred();
  const owner = await start(t, { socketPath, handle: ({ signal }) => {
    signal.addEventListener('abort', aborted.resolve, { once: true });
    entered.resolve();
    return new Promise(() => {});
  } });
  const pending = requestReviewIpc({ socketPath, path: '/capture', body: {}, timeoutMs: 2000 });
  const rejected = assert.rejects(pending, (error) => /^review_ipc_/u.test(error.code));
  await entered.promise;
  const before = Date.now();
  await owner.close();
  await aborted.promise;
  await rejected;
  assert.ok(Date.now() - before < 1000);
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
});
