import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadOperatorConsoleConfig } from './config.mjs';
import { createDomainCandidateStore, DomainCandidateError } from './domain-candidates.mjs';
import { createSettingsCandidateStore, SettingsCandidateError } from './settings-candidates.mjs';
import { assistantCostAnalytics } from './assistant-cost-analytics.mjs';
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

const publicPage = (name) => readFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), 'utf8');
const release = JSON.parse(readFileSync(fileURLToPath(new URL('./console-release.json', import.meta.url)), 'utf8'));
if (!/^\d+\.\d+\.\d+$/u.test(release.version)) throw new Error('invalid Console release version');
const RELEASE_STAMP = '{{CONSOLE_RELEASE_STAMP}}';
const V3_PAGES = new Set([
  '/moderation-v3.html', '/assistant-v3.html', '/settings-v3.html', '/domains-v3.html',
  '/analytics-v3.html', '/tests-v3.html', '/help-v3.html',
]);
const PUBLIC = new Map([
  ['/moderation-v3.html', publicPage('moderation-v3.html')],
  ['/assistant-v3.html', publicPage('assistant-v3.html')],
  ['/settings-v3.html', publicPage('settings-v3.html')],
  ['/domains-v3.html', publicPage('domains-v3.html')],
  ['/analytics-v3.html', publicPage('analytics-v3.html')],
  ['/tests-v3.html', publicPage('tests-v3.html')],
  ['/help-v3.html', publicPage('help-v3.html')],
  ['/legacy/v1/moderation.html', publicPage('moderation.html')],
  ['/legacy/v1/assistant.html', publicPage('assistant.html')],
  ['/legacy/v1/eval.html', publicPage('eval.html')],
  ['/legacy/v2/settings-v2.html', publicPage('settings-v2.html')],
  ['/legacy/v2/domains.html', publicPage('domains.html')],
  ['/legacy/v2/analytics.html', publicPage('analytics.html')],
]);
const PAGE_REDIRECTS = new Map([
  ['/moderation.html', '/moderation-v3.html'],
  ['/assistant.html', '/assistant-v3.html'],
  ['/eval.html', '/tests-v3.html'],
  ['/settings-v2.html', '/settings-v3.html'],
  ['/domains.html', '/domains-v3.html'],
  ['/analytics.html', '/analytics-v3.html'],
]);
const V2_CSS = readFileSync(fileURLToPath(new URL('../public/console-v2.css', import.meta.url)), 'utf8');
const V3_CSS = readFileSync(fileURLToPath(new URL('../public/console-v3.css', import.meta.url)), 'utf8');

const MAX_CANDIDATE_BODY = 70_000;

function releaseLabel(config) {
  if (!config.releasedAt) return `Версия ${release.version} · дата и время релиза ожидаются`;
  const date = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
  }).format(new Date(config.releasedAt));
  return `Версия ${release.version} · релиз ${date} UTC`;
}

function renderedPage(path, config) {
  const page = PUBLIC.get(path);
  if (!V3_PAGES.has(path)) return page;
  if (!page.includes(RELEASE_STAMP)) throw new Error(`release stamp missing in ${path}`);
  return page.replace(RELEASE_STAMP, releaseLabel(config));
}

async function candidateBody(request) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] || '')
    || request.headers['x-operator-intent'] !== 'candidate-draft'
    || request.headers['sec-fetch-site'] === 'cross-site') {
    throw new DomainCandidateError('candidate_request_invalid', 403);
  }
  if (request.headers.origin) {
    let origin;
    try { origin = new URL(request.headers.origin); } catch {
      throw new DomainCandidateError('candidate_origin_invalid', 403);
    }
    if (origin.host !== request.headers.host) throw new DomainCandidateError('candidate_origin_invalid', 403);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_CANDIDATE_BODY) throw new DomainCandidateError('candidate_body_too_large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DomainCandidateError('candidate_json_invalid', 400); }
}

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
  if (path === '/api/moderation/prompts') {
    if ((searchParams.get('platform') || 'telegram') !== 'telegram') return { error: 'platform_not_owned' };
    return legacyPrompts(config);
  }
  if (/^\/api\/moderation\/prompts\/[^/]+$/u.test(path)) {
    if ((searchParams.get('platform') || 'telegram') !== 'telegram') return { error: 'platform_not_owned' };
    const prompts = legacyPrompts(config);
    const version = decodeURIComponent(path.slice('/api/moderation/prompts/'.length));
    if (!prompts.versions.some((entry) => entry.version === version)) return { error: 'prompt_not_found' };
    return { version, text: prompts.activeText, active: version === prompts.active, readOnly: true };
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
  const domains = createDomainCandidateStore({
    domainIndexPath: config.domainIndexPath,
    candidateRoot: config.candidateRoot ? `${config.candidateRoot}/domain-bundles` : null,
  });
  const settings = createSettingsCandidateStore(config);
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

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { status: 'ok', service: 'aichattg-operator-console' });
        return;
      }
      if (!authorize(request, response)) return;

      if (request.method === 'GET' && ['/', '/index.html', '/operator', '/operator/'].includes(url.pathname)) {
        redirect(response, '/moderation-v3.html');
        return;
      }
      if (request.method === 'GET' && PAGE_REDIRECTS.has(url.pathname)) {
        redirect(response, PAGE_REDIRECTS.get(url.pathname));
        return;
      }
      if (request.method === 'GET' && PUBLIC.has(url.pathname)) {
        content(response, 200, 'text/html; charset=utf-8', renderedPage(url.pathname, config));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/console-v2.css') {
        content(response, 200, 'text/css; charset=utf-8', V2_CSS);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/console-v3.css') {
        content(response, 200, 'text/css; charset=utf-8', V3_CSS);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/login') {
        redirect(response, url.searchParams.get('next') || '/moderation-v3.html');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/logout') {
        redirect(response, url.searchParams.get('next') || '/moderation-v3.html');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/operator/settings') {
        json(response, 200, settings.read());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/operator/release') {
        json(response, 200, { version: release.version, releasedAt: config.releasedAt });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/operator/analytics') {
        json(response, 200, assistantCostAnalytics(config));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/operator/domains') {
        json(response, 200, domains.list());
        return;
      }
      const domainRead = /^\/api\/operator\/domains\/([a-z][a-z0-9-]*)$/u.exec(url.pathname);
      if (request.method === 'GET' && domainRead) {
        json(response, 200, domains.read(domainRead[1]));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/operator/settings/candidates') {
        json(response, 201, settings.save(await candidateBody(request)));
        return;
      }
      const domainWrite = /^\/api\/operator\/domains\/([a-z][a-z0-9-]*)\/candidates$/u.exec(url.pathname);
      if (request.method === 'POST' && domainWrite) {
        json(response, 201, domains.save(domainWrite[1], await candidateBody(request)));
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
      if (error instanceof DomainCandidateError || error instanceof SettingsCandidateError) {
        json(response, error.statusCode, { error: error.code });
        return;
      }
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
