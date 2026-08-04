import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadOperatorConsoleConfig } from './config.mjs';
import {
  legacyAssistantAnalytics,
  legacyAssistantConfig,
  legacyAssistantEvents,
  legacyEvalStatus,
  legacyMode,
  legacyModerationEvents,
  legacyModerationStats,
  legacyPrompts,
} from './legacy-read-model.mjs';

const PUBLIC = new Map([
  ['/moderation.html', readFileSync(fileURLToPath(new URL('../public/moderation.html', import.meta.url)), 'utf8')],
  ['/assistant.html', readFileSync(fileURLToPath(new URL('../public/assistant.html', import.meta.url)), 'utf8')],
  ['/eval.html', readFileSync(fileURLToPath(new URL('../public/eval.html', import.meta.url)), 'utf8')],
]);

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
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extraHeaders,
  });
  response.end(body);
}

function redirect(response, location) {
  response.writeHead(302, { location, 'cache-control': 'no-store', 'content-length': '0' });
  response.end();
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

function apiResponse(config, path, searchParams) {
  if (path === '/api/auth/status') return { required: true, authenticated: true, readOnly: true };
  if (path === '/api/moderation/mode') return legacyMode(config);
  if (path === '/api/moderation/stats') return legacyModerationStats(config);
  if (path === '/api/moderation/events') {
    return legacyModerationEvents(config, { limit: searchParams.get('limit') });
  }
  if (path === '/api/moderation/suspects') {
    return legacyModerationEvents(config, { limit: 100, suspectsOnly: true });
  }
  if (path === '/api/moderation/prompts' || /^\/api\/moderation\/prompts\/[^/]+$/u.test(path)) {
    if ((searchParams.get('platform') || 'telegram') !== 'telegram') return { error: 'platform_not_owned' };
    return legacyPrompts(config);
  }
  if (path === '/api/moderation/assistant/config') return legacyAssistantConfig(config);
  if (path === '/api/moderation/assistant/analytics') return legacyAssistantAnalytics(config);
  if (path === '/api/moderation/assistant/events') {
    return { events: legacyAssistantEvents(config, { limit: searchParams.get('limit') }) };
  }
  if (path === '/api/moderation/assistant/eval/status') return legacyEvalStatus();
  if (path === '/api/moderation/assistant/eval/last') return { result: null, readOnly: true };
  return null;
}

export function createOperatorConsoleServer({ config, logger = console } = {}) {
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
      if (!authorize(request, response)) return;

      if (request.method === 'GET' && ['/', '/index.html', '/operator', '/operator/'].includes(url.pathname)) {
        redirect(response, '/moderation.html');
        return;
      }
      if (request.method === 'GET' && PUBLIC.has(url.pathname)) {
        content(response, 200, 'text/html; charset=utf-8', PUBLIC.get(url.pathname));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/login') {
        redirect(response, url.searchParams.get('next') || '/moderation.html');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/logout') {
        redirect(response, url.searchParams.get('next') || '/moderation.html');
        return;
      }
      if (request.method === 'GET') {
        const result = apiResponse(config, url.pathname, url.searchParams);
        if (result) {
          if (result.error === 'platform_not_owned') json(response, 400, result);
          else json(response, 200, result);
          return;
        }
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/moderation/')) {
        json(response, 409, { error: 'read_only_after_project_split' });
        return;
      }
      json(response, 404, { error: 'not_found' });
    } catch (error) {
      logger.error?.('[operator-console] request failed', error?.message || 'unknown_error');
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
