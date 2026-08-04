import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadOperatorConsoleConfig } from './config.mjs';
import { buildOperatorOverview } from './read-model.mjs';

const HTML = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const CSS = readFileSync(fileURLToPath(new URL('../public/operator.css', import.meta.url)), 'utf8');
const JAVASCRIPT = readFileSync(fileURLToPath(new URL('../public/operator.js', import.meta.url)), 'utf8');

function json(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function content(response, statusCode, type, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extraHeaders,
  });
  response.end(body);
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual), 'utf8');
  const right = Buffer.from(String(expected), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validOperatorAuthorization(header, token) {
  if (!token || typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  return safeEqual(decoded.slice(0, separator), 'operator') && safeEqual(decoded.slice(separator + 1), token);
}

export function createOperatorConsoleServer({ config, getOverview = () => buildOperatorOverview({ config }), logger = console } = {}) {
  if (!config) throw new Error('operator console config is required');
  const authorize = (request, response) => {
    if (!config.token) {
      json(response, 404, { error: 'not_found' });
      return false;
    }
    if (!validOperatorAuthorization(request.headers.authorization, config.token)) {
      content(response, 401, 'text/plain; charset=utf-8', 'Authentication required', {
        'www-authenticate': 'Basic realm="AIchatTG operator", charset="UTF-8"',
      });
      return false;
    }
    return true;
  };
  return createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { status: 'ok', service: 'aichattg-operator-console' });
        return;
      }
      const route = request.method === 'GET' ? url.pathname : '';
      if (!['/', '/operator.css', '/operator.js', '/api/v1/overview'].includes(route)) {
        json(response, 404, { error: 'not_found' });
        return;
      }
      if (!authorize(request, response)) return;
      if (route === '/') {
        content(response, 200, 'text/html; charset=utf-8', HTML);
        return;
      }
      if (route === '/operator.css') {
        content(response, 200, 'text/css; charset=utf-8', CSS);
        return;
      }
      if (route === '/operator.js') {
        content(response, 200, 'text/javascript; charset=utf-8', JAVASCRIPT);
        return;
      }
      json(response, 200, getOverview());
    } catch (error) {
      logger.error?.('[operator-console] read-only overview failed', error?.message || 'unknown_error');
      json(response, 503, { error: 'operator_console_unavailable' });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadOperatorConsoleConfig();
  const server = createOperatorConsoleServer({ config });
  server.listen(config.port, config.bindHost, () => {
    console.log(`[operator-console] listening on ${config.bindHost}:${config.port}; route-auth=${config.token ? 'configured' : 'disabled'}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}
