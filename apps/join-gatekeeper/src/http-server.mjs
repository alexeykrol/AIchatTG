import crypto from 'node:crypto';
import http from 'node:http';

const MAX_BODY_BYTES = 32 * 1024;
export const PUBLIC_PATH_PREFIX = '/join-gatekeeper';

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(Object.assign(new Error('request body is too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

function json(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

// Constant-time comparison independent of input length.
export function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b) && provided.length === expected.length;
}

export function routePath(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return '';
  }
  if (pathname === PUBLIC_PATH_PREFIX) return '/';
  if (pathname.startsWith(`${PUBLIC_PATH_PREFIX}/`)) return pathname.slice(PUBLIC_PATH_PREFIX.length);
  return pathname;
}

export function createJoinGatekeeperHttpServer({ config, service, logger = console }) {
  return http.createServer(async (request, response) => {
    const pathname = routePath(request.url);
    try {
      if (request.method === 'GET' && pathname === '/health') {
        json(response, 200, { ok: true, service: 'join-gatekeeper', mode: config.mode });
        return;
      }
      if (request.method === 'POST' && pathname === '/webhooks/telegram') {
        if (!secretMatches(request.headers['x-telegram-bot-api-secret-token'], config.webhookSecret)) {
          json(response, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        const raw = await readBody(request);
        let update;
        try {
          update = JSON.parse(raw.toString('utf8'));
        } catch {
          json(response, 400, { ok: false, error: 'invalid_json' });
          return;
        }
        if (!update || typeof update !== 'object' || Array.isArray(update) || !Number.isSafeInteger(update.update_id)) {
          json(response, 400, { ok: false, error: 'invalid_update' });
          return;
        }
        try {
          const result = await service.handleUpdate(update);
          json(response, 200, { ok: true, action: result?.action ?? null });
        } catch (error) {
          // The update id is already claimed; a Telegram redelivery would be
          // ignored, so acknowledge and log instead of inviting retries.
          logger.error?.('update_failed', { update_id: update.update_id, error: error.message });
          json(response, 200, { ok: false, error: 'processing_failed' });
        }
        return;
      }
      json(response, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) logger.error?.('http_error', { error: error.message });
      if (!response.headersSent) json(response, statusCode, { ok: false, error: statusCode === 413 ? 'too_large' : 'internal_error' });
    }
  });
}
