import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, parse } from 'node:path';
import { TextDecoder } from 'node:util';

const REQUEST_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 16 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validTimeout(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}

function validPath(value) {
  return typeof value === 'string' && /^\/[a-z0-9/_-]{1,160}$/u.test(value)
    && !value.includes('//');
}

function encode(value, limit) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    // No toJSON coercion, functions, non-finite numbers, cycles or prototypes.
    const seen = new Set();
    let budget = limit;
    const check = (item, depth = 0) => {
      if (depth > 32 || --budget < 0) throw 0;
      if (item === null || typeof item === 'boolean') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      if (typeof item === 'string') {
        budget -= Buffer.byteLength(item);
        if (budget < 0) throw 0;
        return;
      }
      if (typeof item !== 'object' || seen.has(item)
        || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) throw 0;
      seen.add(item);
      if (Array.isArray(item) && Object.keys(item).length !== item.length) throw 0;
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw 0;
        budget -= Buffer.byteLength(key);
        check(descriptor.value, depth + 1);
      }
      seen.delete(item);
    };
    check(value);
    const encoded = Buffer.from(JSON.stringify(value));
    if (encoded.length > limit) throw 0;
    return encoded;
  } catch {
    throw failure('review_ipc_body_invalid');
  }
}

function decode(chunks) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value;
  } catch {
    throw failure('review_ipc_json_invalid');
  }
}

async function privateDirectory(socketPath) {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)
    || normalize(socketPath) !== socketPath || socketPath.includes('\0')
    || Buffer.byteLength(socketPath) > 100 || socketPath === parse(socketPath).root) {
    throw failure('review_ipc_socket_path_invalid');
  }
  const directory = dirname(socketPath);
  let current = parse(directory).root;
  let stat;
  try {
    for (const part of directory.slice(current.length).split('/').filter(Boolean)) {
      current = join(current, part);
      stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw 0;
    }
    stat ??= await lstat(directory);
    if (typeof process.getuid !== 'function' || stat.uid !== process.getuid()
      || (stat.mode & 0o7777) !== 0o700) throw 0;
  } catch {
    throw failure('review_ipc_directory_unsafe');
  }
  return stat;
}

async function privateSocket(socketPath) {
  await privateDirectory(socketPath);
  let stat;
  try { stat = await lstat(socketPath); } catch { throw failure('review_ipc_socket_unavailable'); }
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o7777) !== 0o600) throw failure('review_ipc_socket_unsafe');
  return stat;
}

/** One POST to one pre-provisioned private Unix socket. Never retries. */
export function requestReviewIpc({ socketPath, path, body, timeoutMs = 2000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let encoded;
    let chunks = [];
    let size = 0;
    let done = false;
    let timer;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal instanceof AbortSignal) signal.removeEventListener('abort', abort);
      chunks.length = 0;
      chunks = [];
      encoded = null;
      body = null;
      response?.destroy();
      request?.destroy();
      response = null;
      request = null;
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(failure('review_ipc_cancelled'));
    if (!validTimeout(timeoutMs) || !validPath(path)
      || (signal !== undefined && !(signal instanceof AbortSignal))) {
      finish(failure('review_ipc_config_invalid'));
      return;
    }
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(failure('review_ipc_timeout')), timeoutMs);
    (async () => {
      try {
        encoded = encode(body, REQUEST_LIMIT);
        body = null;
        await privateSocket(socketPath);
        if (done) return;
        request = http.request({ socketPath, path, method: 'POST', agent: false,
          headers: { 'content-type': 'application/json', 'content-length': encoded.length,
            connection: 'close' }, maxHeaderSize: 4096 }, (incoming) => {
          if (done) { incoming.destroy(); return; }
          response = incoming;
          const length = incoming.headers['content-length'];
          if (!JSON_TYPE.test(incoming.headers['content-type'] ?? '')
            || incoming.headers['content-encoding']
            || (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > RESPONSE_LIMIT))) {
            finish(failure('review_ipc_response_invalid'));
            return;
          }
          incoming.on('data', (chunk) => {
            if (done) return;
            size += chunk.length;
            if (size > RESPONSE_LIMIT) { finish(failure('review_ipc_response_too_large')); return; }
            chunks.push(chunk);
          });
          incoming.on('error', () => finish(failure('review_ipc_transport_error')));
          incoming.on('aborted', () => finish(failure('review_ipc_response_incomplete')));
          incoming.on('end', () => {
            if (done) return;
            if (!incoming.complete) { finish(failure('review_ipc_response_incomplete')); return; }
            try { finish(null, { statusCode: incoming.statusCode, body: decode(chunks) }); }
            catch { finish(failure('review_ipc_json_invalid')); }
          });
        });
        request.on('error', () => finish(failure('review_ipc_transport_error')));
        request.end(encoded);
        encoded = null;
      } catch (error) {
        finish(failure(typeof error?.code === 'string' && error.code.startsWith('review_ipc_')
          ? error.code : 'review_ipc_transport_error'));
      }
    })();
  });
}

/** No takeover, no queue and no unbounded network/body/handler wait. */
export async function createReviewIpcServer({ socketPath, handle, timeoutMs = 2000, maxConcurrent = 4 } = {}) {
  if (typeof handle !== 'function' || !validTimeout(timeoutMs)
    || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64) {
    throw failure('review_ipc_config_invalid');
  }
  const parent = await privateDirectory(socketPath);
  // Node/libuv unlinks its original bind path on close, even if that path was
  // replaced. Publish an exclusive hard link, then remove the random bind name;
  // the configured endpoint is cleaned up only after our own inode check.
  const bindPath = join(dirname(socketPath), `.${randomBytes(6).toString('hex')}`);
  if (Buffer.byteLength(bindPath) > 100) throw failure('review_ipc_socket_path_invalid');
  try {
    await lstat(socketPath);
    throw failure('review_ipc_socket_exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw failure('review_ipc_socket_exists');
  }
  let active = 0;
  let closing = false;
  const sockets = new Set();
  const controllers = new Set();
  const server = http.createServer({ maxHeaderSize: 4096, requestTimeout: timeoutMs,
    headersTimeout: timeoutMs, keepAliveTimeout: 1 }, (request, response) => {
    const controller = new AbortController();
    let chunks = [];
    let body;
    let size = 0;
    let done = false;
    let handling = false;
    let counted = false;
    const release = () => {
      if (counted) { active--; counted = false; }
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      controller.abort();
      controllers.delete(controller);
      chunks.length = 0;
      chunks = [];
      body = null;
      if (!handling) release();
    };
    const send = (statusCode, value) => {
      if (done || response.destroyed) return;
      let encoded;
      try { encoded = encode(value, RESPONSE_LIMIT); }
      catch { statusCode = 500; encoded = Buffer.from('{"code":"review_ipc_handler_response_invalid"}'); }
      response.writeHead(statusCode, { 'content-type': 'application/json',
        'content-length': encoded.length, connection: 'close' });
      response.end(encoded);
    };
    const timer = setTimeout(() => {
      finish();
      request.destroy();
      response.destroy();
    }, timeoutMs);
    controllers.add(controller);
    request.on('error', () => { finish(); response.destroy(); });
    request.on('aborted', finish);
    response.on('error', finish);
    response.on('finish', finish);
    response.on('close', finish);
    if (closing || active >= maxConcurrent) { send(503, { code: 'review_ipc_busy' }); return; }
    active++;
    counted = true;
    const length = request.headers['content-length'];
    if (request.method !== 'POST' || !validPath(request.url)
      || !JSON_TYPE.test(request.headers['content-type'] ?? '') || request.headers['content-encoding']) {
      send(400, { code: 'review_ipc_request_invalid' });
      return;
    }
    if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > REQUEST_LIMIT)) {
      send(413, { code: 'review_ipc_request_too_large' });
      return;
    }
    request.on('data', (chunk) => {
      if (done || response.writableEnded) return;
      size += chunk.length;
      if (size > REQUEST_LIMIT) { chunks.length = 0; send(413, { code: 'review_ipc_request_too_large' }); return; }
      chunks.push(chunk);
    });
    request.on('end', async () => {
      if (done || response.writableEnded) return;
      try { body = decode(chunks); }
      catch { chunks.length = 0; send(400, { code: 'review_ipc_json_invalid' }); return; }
      chunks.length = 0;
      handling = true;
      try {
        const pending = handle({ path: request.url, body, signal: controller.signal });
        body = null;
        const result = await pending;
        if (done) return;
        if (!result || !Number.isInteger(result.statusCode) || result.statusCode < 200 || result.statusCode > 599
          || [204, 205, 304].includes(result.statusCode)) {
          send(500, { code: 'review_ipc_handler_response_invalid' });
        } else send(result.statusCode, result.body);
      } catch {
        send(500, { code: 'review_ipc_handler_failed' });
      } finally {
        body = null;
        handling = false;
        release();
      }
    });
  });
  // A client that never sends complete HTTP headers has the same hard bound.
  server.on('connection', (socket) => {
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('error', () => {}); // Never expose raw transport errors after startup.
  server.maxConnections = maxConcurrent + 1; // One bounded slot can return busy.
  server.maxRequestsPerSocket = 1;
  let ownSocket;
  let closePromise;
  const close = () => {
    closePromise ??= (async () => {
      closing = true;
      for (const controller of controllers) controller.abort();
      const stopped = new Promise((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await stopped;
      try {
        const present = await lstat(socketPath);
        if (ownSocket && present.dev === ownSocket.dev && present.ino === ownSocket.ino && present.isSocket()) {
          await unlink(socketPath);
        }
      } catch { /* Missing socket is the normal Node close result. */ }
    })();
    return closePromise;
  };
  try {
    await new Promise((resolve, reject) => {
      const onError = () => reject(failure('review_ipc_listen_failed'));
      server.once('error', onError);
      server.listen({ path: bindPath, exclusive: true }, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    const after = await privateDirectory(socketPath);
    if (after.dev !== parent.dev || after.ino !== parent.ino) throw failure('review_ipc_directory_unsafe');
    await chmod(bindPath, 0o600);
    ownSocket = await privateSocket(bindPath);
    await link(bindPath, socketPath); // Atomic EEXIST; never replace an endpoint.
    await unlink(bindPath);
  } catch {
    await close();
    throw failure('review_ipc_start_failed');
  }
  return { close, server };
}
