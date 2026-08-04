import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MAX_BODY_BYTES,
  createCaptureServer,
  eventNameFrom,
  jsonShape,
  parseSignature,
} from '../src/server.js';

const TEST_KEY = 'local-test-key-never-used-outside-tests';

function signatureFor(rawBody, key = TEST_KEY) {
  return createHmac('sha256', key).update(rawBody).digest('hex');
}

async function startServer(options) {
  const server = createCaptureServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    origin: 'http://127.0.0.1:' + port,
  };
}

async function request(origin, {
  body = '',
  headers = {},
  method = 'POST',
  omitContentLength = false,
  requestPath = '/webhooks/tribute',
} = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = Buffer.from(body);
    const req = http.request(origin + requestPath, {
      method,
      headers: {
        ...(omitContentLength ? { 'transfer-encoding': 'chunked' } : {
          'content-length': bodyBuffer.length,
        }),
        ...headers,
      },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.once('end', () => resolve({
        body: JSON.parse(responseBody),
        statusCode: res.statusCode,
      }));
    });
    req.once('error', reject);
    req.end(bodyBuffer);
  });
}

async function receiptFiles(directory) {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function rawHttpRequest(origin, body, headerLines) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    let response = '';
    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port),
    });
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      const request = [
        'POST /webhooks/tribute HTTP/1.1',
        'Host: ' + url.host,
        'Connection: close',
        'Content-Length: ' + Buffer.byteLength(body),
        ...headerLines,
        '',
        body,
      ].join('\r\n');
      socket.end(request);
    });
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => {
      const status = /^HTTP\/1\.1 ([0-9]{3})/.exec(response);
      resolve(Number(status?.[1]));
    });
  });
}

function enabledEnvironment() {
  return {
    TRIBUTE_CAPTURE_ENABLED: 'true',
    TRIBUTE_CAPTURE_HMAC_KEY: TEST_KEY,
  };
}

test('disabled by default: no raw capture or receipt without both explicit flag and key', async (t) => {
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'tribute-capture-disabled-'));
  const server = await startServer({
    env: {},
    receiptDirectory,
  });
  t.after(() => server.close());

  const rawBody = JSON.stringify({ email: 'person@example.test' });
  const response = await request(server.origin, {
    body: rawBody,
    headers: { 'trbt-signature': signatureFor(rawBody) },
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: 'capture_disabled' });
  assert.deepEqual(await receiptFiles(receiptDirectory), []);
});

test('writes exactly one redacted receipt only after raw HMAC verification and JSON parsing', async (t) => {
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'tribute-capture-valid-'));
  const server = await startServer({
    env: enabledEnvironment(),
    receiptDirectory,
    now: () => new Date('2026-08-02T00:00:00.000Z'),
    receiptId: () => 'receipt-test-1',
  });
  t.after(() => server.close());

  const rawBody = JSON.stringify({
    event: 'contribution.created',
    email: 'person@example.test',
    name: 'Sensitive Person',
    contribution: 25,
  });
  const signature = signatureFor(rawBody);
  const response = await request(server.origin, {
    body: rawBody,
    headers: { 'trbt-signature': signature },
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.body, { accepted: true, receiptId: 'receipt-test-1' });
  assert.deepEqual(await receiptFiles(receiptDirectory), ['receipt.json']);

  const receiptText = await readFile(path.join(receiptDirectory, 'receipt.json'), 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.deepEqual(Object.keys(receipt).sort(), [
    'event_name',
    'hmacVerified',
    'json_shape',
    'json_valid',
    'rawByteLength',
    'receiptId',
    'receivedAt',
    'schemaVersion',
  ]);
  assert.equal(receipt.hmacVerified, true);
  assert.equal(receipt.event_name, 'contribution.created');
  assert.equal(receipt.json_valid, true);
  assert.equal(receipt.json_shape, 'object');
  assert.equal(receipt.rawByteLength, Buffer.byteLength(rawBody));
  assert.equal(receipt.receivedAt, '2026-08-02T00:00:00.000Z');
  assert.equal(receipt.receiptId, 'receipt-test-1');
  assert.equal(receiptText.includes(rawBody), false);
  assert.equal(receiptText.includes('person@example.test'), false);
  assert.equal(receiptText.includes('Sensitive Person'), false);
  assert.equal(receiptText.includes(signature), false);
  assert.equal((await stat(receiptDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(receiptDirectory, 'receipt.json'))).mode & 0o777, 0o600);
});

test('single-use receipt resists parallel valid posts and remains closed after restart', async (t) => {
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'tribute-capture-single-use-'));
  const options = {
    env: enabledEnvironment(),
    receiptDirectory,
  };
  const firstServer = await startServer(options);
  let firstServerClosed = false;
  t.after(() => firstServerClosed ? undefined : firstServer.close());

  const rawBody = JSON.stringify({ event: 'one-time-capture' });
  const requests = await Promise.all([
    request(firstServer.origin, {
      body: rawBody,
      headers: { 'trbt-signature': signatureFor(rawBody) },
    }),
    request(firstServer.origin, {
      body: rawBody,
      headers: { 'trbt-signature': signatureFor(rawBody) },
    }),
  ]);
  assert.deepEqual(requests.map((result) => result.statusCode).sort(), [202, 409]);
  assert.deepEqual(await receiptFiles(receiptDirectory), ['receipt.json']);

  await firstServer.close();
  firstServerClosed = true;
  const restartedServer = await startServer(options);
  t.after(() => restartedServer.close());
  const restartResponse = await request(restartedServer.origin, {
    body: rawBody,
    headers: { 'trbt-signature': signatureFor(rawBody) },
  });
  assert.equal(restartResponse.statusCode, 409);
  assert.deepEqual(await receiptFiles(receiptDirectory), ['receipt.json']);
});

test('requires exactly one bare trbt-signature header before JSON parsing', async (t) => {
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'tribute-capture-invalid-signature-'));
  const server = await startServer({
    env: enabledEnvironment(),
    receiptDirectory,
  });
  t.after(() => server.close());

  const wrongHeaderResponse = await request(server.origin, {
    body: '{not valid json',
    headers: { 'x-tribute-signature': signatureFor('{not valid json') },
  });
  assert.equal(wrongHeaderResponse.statusCode, 401);
  assert.deepEqual(wrongHeaderResponse.body, { error: 'invalid_signature' });

  const prefixedHeaderResponse = await request(server.origin, {
    body: '{not valid json',
    headers: { 'trbt-signature': 'sha256=' + signatureFor('{not valid json') },
  });
  assert.equal(prefixedHeaderResponse.statusCode, 401);
  assert.deepEqual(prefixedHeaderResponse.body, { error: 'invalid_signature' });
  assert.deepEqual(await receiptFiles(receiptDirectory), []);
});

test('rejects malformed JSON only after a valid raw-body HMAC and writes no receipt', async (t) => {
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'tribute-capture-invalid-json-'));
  const server = await startServer({
    env: enabledEnvironment(),
    receiptDirectory,
  });
  t.after(() => server.close());

  const rawBody = '{not valid json';
  const response = await request(server.origin, {
    body: rawBody,
    headers: { 'trbt-signature': signatureFor(rawBody) },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'invalid_json' });
  assert.deepEqual(await receiptFiles(receiptDirectory), []);
});

test('caps raw bytes before verification or parsing and writes no receipt', async (t) => {
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'tribute-capture-too-large-'));
  const maxBodyBytes = 16;
  const server = await startServer({
    env: enabledEnvironment(),
    receiptDirectory,
    maxBodyBytes,
  });
  t.after(() => server.close());

  const rawBody = JSON.stringify({ input: 'x'.repeat(maxBodyBytes) });
  const response = await request(server.origin, {
    body: rawBody,
    headers: { 'trbt-signature': signatureFor(rawBody) },
  });

  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.body, { error: 'payload_too_large' });
  assert.deepEqual(await receiptFiles(receiptDirectory), []);
});

test('caps a chunked body without trusting Content-Length', async (t) => {
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'tribute-capture-chunked-'));
  const maxBodyBytes = 16;
  const server = await startServer({
    env: enabledEnvironment(),
    receiptDirectory,
    maxBodyBytes,
  });
  t.after(() => server.close());

  const rawBody = JSON.stringify({ input: 'x'.repeat(maxBodyBytes) });
  const response = await request(server.origin, {
    body: rawBody,
    omitContentLength: true,
    headers: { 'trbt-signature': signatureFor(rawBody) },
  });

  assert.equal(response.statusCode, 413);
  assert.deepEqual(await receiptFiles(receiptDirectory), []);
});

test('rejects duplicate signature headers and invalid UTF-8 without a receipt', async (t) => {
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'tribute-capture-header-'));
  const server = await startServer({
    env: enabledEnvironment(),
    receiptDirectory,
  });
  t.after(() => server.close());

  const rawBody = JSON.stringify({ event: 'duplicate-header' });
  const signature = signatureFor(rawBody);
  const duplicateHeaderResponse = await request(server.origin, {
    body: rawBody,
    headers: { 'trbt-signature': [signature, signature] },
  });
  assert.equal(duplicateHeaderResponse.statusCode, 401);
  assert.deepEqual(await receiptFiles(receiptDirectory), []);

  const mixedCaseDuplicateStatus = await rawHttpRequest(server.origin, rawBody, [
    'trbt-signature: ' + signature,
    'TrBt-SiGnAtUrE: ' + signature,
  ]);
  assert.equal(mixedCaseDuplicateStatus, 401);
  assert.deepEqual(await receiptFiles(receiptDirectory), []);

  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  const utf8Response = await request(server.origin, {
    body: invalidUtf8,
    headers: { 'trbt-signature': signatureFor(invalidUtf8) },
  });
  assert.equal(utf8Response.statusCode, 400);
  assert.deepEqual(utf8Response.body, { error: 'invalid_json' });
  assert.deepEqual(await receiptFiles(receiptDirectory), []);
});

test('proves the prior trbt-signature contract signs the exact raw bytes', async (t) => {
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'tribute-capture-raw-hmac-'));
  const server = await startServer({
    env: enabledEnvironment(),
    receiptDirectory,
  });
  t.after(() => server.close());

  const signedRawBody = Buffer.from('{"event":"payment.created","amount":1}');
  const sameJsonDifferentBytes = Buffer.from('{\n  "amount": 1,\n  "event": "payment.created"\n}');
  const signedRawBodySignature = signatureFor(signedRawBody);

  const mismatchResponse = await request(server.origin, {
    body: sameJsonDifferentBytes,
    headers: { 'trbt-signature': signedRawBodySignature },
  });
  assert.equal(mismatchResponse.statusCode, 401);
  assert.deepEqual(await receiptFiles(receiptDirectory), []);

  const verifiedResponse = await request(server.origin, {
    body: signedRawBody,
    headers: { 'TrBt-SiGnAtUrE': signedRawBodySignature },
  });
  assert.equal(verifiedResponse.statusCode, 202);
  assert.deepEqual(await receiptFiles(receiptDirectory), ['receipt.json']);
});

test('extracts only identifier-safe event values from approved provider fields', () => {
  assert.equal(eventNameFrom({ event: 'payment.created' }), 'payment.created');
  assert.equal(eventNameFrom({ event_name: 'payment:created' }), 'payment:created');
  assert.equal(eventNameFrom({ event_type: 'payment-created' }), 'payment-created');
  assert.equal(eventNameFrom({ type: 'payment_created' }), 'payment_created');
  assert.equal(eventNameFrom({ event: 'https://example.test/private' }), undefined);
  assert.equal(eventNameFrom({ event: 'person@example.test' }), undefined);
  assert.equal(eventNameFrom({ email: 'person@example.test' }), undefined);
  assert.equal(eventNameFrom({ event: null, event_name: 'payment.created' }), 'payment.created');
  assert.equal(eventNameFrom({ event: 'unsafe value', event_name: 'payment.created' }), undefined);
  assert.equal(eventNameFrom({ event: 7, event_name: 'payment.created' }), undefined);
  assert.equal(eventNameFrom({ data: { event: 'payment.created' } }), undefined);
});

test('rejects every non-bare signature representation and reports only JSON structure', () => {
  const bare = signatureFor('raw bytes');
  for (const invalidSignature of [
    '',
    ' ' + bare,
    bare + ' ',
    'sha256=' + bare,
    '0x' + bare,
    bare.slice(0, -1),
    bare + '0',
    bare.slice(0, -1) + 'g',
    bare + ',' + bare,
  ]) {
    assert.equal(parseSignature(invalidSignature), null);
  }
  assert.equal(Buffer.isBuffer(parseSignature(bare)), true);
  assert.deepEqual([
    jsonShape({}),
    jsonShape([]),
    jsonShape('value'),
    jsonShape(1),
    jsonShape(false),
    jsonShape(null),
  ], ['object', 'array', 'string', 'number', 'boolean', 'null']);
});

test('omits unsafe event text and arbitrary payload values from the receipt', async (t) => {
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'tribute-capture-redacted-event-'));
  const server = await startServer({
    env: enabledEnvironment(),
    receiptDirectory,
  });
  t.after(() => server.close());

  const rawBody = JSON.stringify({
    event: 'https://example.test/private/person@example.test',
    email: 'person@example.test',
    customer: { name: 'Sensitive Person' },
  });
  const response = await request(server.origin, {
    body: rawBody,
    headers: { 'trbt-signature': signatureFor(rawBody) },
  });
  assert.equal(response.statusCode, 202);

  const receiptText = await readFile(path.join(receiptDirectory, 'receipt.json'), 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.equal('event_name' in receipt, false);
  assert.equal(receipt.json_valid, true);
  assert.equal(receipt.json_shape, 'object');
  assert.equal(receiptText.includes('example.test'), false);
  assert.equal(receiptText.includes('person@example.test'), false);
  assert.equal(receiptText.includes('Sensitive Person'), false);
});

test('exposes no other capture routes or methods', async (t) => {
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'tribute-capture-route-'));
  const server = await startServer({
    env: enabledEnvironment(),
    receiptDirectory,
  });
  t.after(() => server.close());

  const response = await request(server.origin, {
    method: 'GET',
    requestPath: '/webhooks/tribute',
  });
  assert.equal(response.statusCode, 404);
  const queryResponse = await request(server.origin, {
    requestPath: '/webhooks/tribute?unexpected=query',
  });
  assert.equal(queryResponse.statusCode, 404);
  assert.deepEqual(await receiptFiles(receiptDirectory), []);
  assert.equal(DEFAULT_MAX_BODY_BYTES, 16 * 1024);
});
