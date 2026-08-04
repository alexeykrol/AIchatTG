import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
export const WEBHOOK_PATH = '/webhooks/tribute';
const RECEIPT_FILE_NAME = 'receipt.json';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function captureIsEnabled(env) {
  return env.TRIBUTE_CAPTURE_ENABLED === 'true'
    && isNonEmptyString(env.TRIBUTE_CAPTURE_HMAC_KEY);
}

export function parseSignature(headerValue) {
  if (typeof headerValue !== 'string') {
    return null;
  }

  return /^[a-f0-9]{64}$/i.test(headerValue) ? Buffer.from(headerValue, 'hex') : null;
}

export function verifySignature(rawBody, headerValue, hmacKey) {
  const received = parseSignature(headerValue);
  if (!received || !isNonEmptyString(hmacKey)) {
    return false;
  }

  const expected = createHmac('sha256', hmacKey).update(rawBody).digest();
  return timingSafeEqual(expected, received);
}

function singleSignatureHeader(request) {
  const signatureValues = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === 'trbt-signature') {
      signatureValues.push(request.rawHeaders[index + 1]);
    }
  }
  return signatureValues.length === 1 ? signatureValues[0] : null;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the capture limit.');
    this.name = 'PayloadTooLargeError';
  }
}

export function readRawBody(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    request.on('data', (chunk) => {
      if (settled) {
        return;
      }

      byteLength += chunk.length;
      if (byteLength > maxBodyBytes) {
        request.resume();
        fail(new PayloadTooLargeError());
        return;
      }

      chunks.push(chunk);
    });
    request.once('error', fail);
    request.once('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function declaredByteLength(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function jsonShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function eventNameFrom(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }

  const eventKeys = ['event', 'event_name', 'event_type', 'type'];
  let candidate;
  for (const key of eventKeys) {
    if (Object.hasOwn(payload, key) && payload[key] !== null && payload[key] !== undefined) {
      candidate = payload[key];
      break;
    }
  }
  if (typeof candidate !== 'string') {
    return undefined;
  }

  const eventName = candidate.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(eventName) ? eventName : undefined;
}

function createReceipt(rawBody, now, receiptId, payload) {
  const eventName = eventNameFrom(payload);
  return {
    schemaVersion: 1,
    receiptId,
    receivedAt: now.toISOString(),
    hmacVerified: true,
    rawByteLength: rawBody.length,
    json_valid: true,
    json_shape: jsonShape(payload),
    ...(eventName ? { event_name: eventName } : {}),
  };
}

async function writePrivateReceipt(receiptDirectory, receipt) {
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  const receiptPath = path.join(receiptDirectory, RECEIPT_FILE_NAME);
  await writeFile(receiptPath, JSON.stringify(receipt) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

export function createCaptureHandler({
  env = process.env,
  receiptDirectory = '/data/receipts',
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  now = () => new Date(),
  receiptId = randomUUID,
} = {}) {
  return async function captureHandler(request, response) {
    if (request.method !== 'POST' || request.url !== WEBHOOK_PATH) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    // This check intentionally precedes body capture. A disabled service does
    // not collect payload bytes, verify signatures, parse JSON, or write files.
    if (!captureIsEnabled(env)) {
      sendJson(response, 503, { error: 'capture_disabled' });
      return;
    }

    const declaredLength = declaredByteLength(request.headers['content-length']);
    if (declaredLength !== null && declaredLength > maxBodyBytes) {
      request.resume();
      sendJson(response, 413, { error: 'payload_too_large' });
      return;
    }

    let rawBody;
    try {
      rawBody = await readRawBody(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendJson(response, 413, { error: 'payload_too_large' });
        return;
      }
      sendJson(response, 400, { error: 'invalid_request_body' });
      return;
    }

    const signature = singleSignatureHeader(request);
    if (!verifySignature(rawBody, signature, env.TRIBUTE_CAPTURE_HMAC_KEY)) {
      sendJson(response, 401, { error: 'invalid_signature' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
    } catch {
      sendJson(response, 400, { error: 'invalid_json' });
      return;
    }

    const receipt = createReceipt(rawBody, now(), receiptId(), payload);
    try {
      // Exclusive creation is the only receipt write. After the first valid
      // request, every later request fails closed without another receipt.
      await writePrivateReceipt(receiptDirectory, receipt);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        sendJson(response, 409, { error: 'capture_complete' });
        return;
      }
      sendJson(response, 500, { error: 'receipt_write_failed' });
      return;
    }

    sendJson(response, 202, {
      accepted: true,
      receiptId: receipt.receiptId,
    });
  };
}

export function createCaptureServer(options) {
  return http.createServer(createCaptureHandler(options));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = toPositiveInteger(process.env.PORT, 3100);
  const server = createCaptureServer();
  server.listen(port, '0.0.0.0', () => {
    console.log('tribute capture service listening on port ' + port);
  });
}
