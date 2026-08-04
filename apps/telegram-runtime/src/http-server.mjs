import http from 'node:http';
import { BOT_ROLES } from '@aichattg/telegram-core';

const MAX_BODY_BYTES = 64 * 1024;

function json(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
      else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function safeEqual(left, right) {
  return typeof left === 'string' && left.length > 0 && left === right;
}

export function createTelegramRuntimeHttpServer({ config, runtime, logger = console }) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { status: 'ok', service: 'aichattg-telegram-runtime', ingressEnabled: config.ingressEnabled });
        return;
      }
      const role = url.pathname === '/webhooks/telegram/moderator' ? BOT_ROLES.MODERATOR
        : url.pathname === '/webhooks/telegram/assistant' ? BOT_ROLES.ASSISTANT : null;
      if (!role || request.method !== 'POST' || !config.ingressEnabled) {
        json(response, 404, { error: 'not_found' });
        return;
      }
      const secret = role === BOT_ROLES.MODERATOR ? config.moderator.webhookSecret : config.assistant.webhookSecret;
      if (!safeEqual(secret, request.headers['x-telegram-bot-api-secret-token'])) {
        json(response, 401, { error: 'invalid_telegram_secret' });
        return;
      }
      const raw = await readBody(request);
      let update;
      try { update = JSON.parse(raw); } catch { json(response, 400, { error: 'invalid_json' }); return; }
      const result = await runtime.handleUpdate(role, update);
      json(response, 200, { ok: true, result });
    } catch (error) {
      logger.error?.('[telegram-runtime] webhook processing failed', error.message);
      json(response, error.statusCode || 500, { error: 'runtime_error' });
    }
  });
}
