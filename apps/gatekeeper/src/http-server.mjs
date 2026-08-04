import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildAdminSettingsSnapshot } from './admin-settings.mjs';
import { createScenarioProvider } from './scenario.mjs';
import { safeEqual } from './security.mjs';
import {
  mapSiteRegistration,
  singleSiteSignatureFromRawHeaders,
  verifySiteWebhook,
} from './site.mjs';
import { assertNoDuplicateJsonKeys, DuplicateJsonKeyError } from './strict-json.mjs';
import { mapTributeNewSubscription, verifyTributeWebhook } from './tribute.mjs';

const MAX_BODY_BYTES = 32 * 1024;
const ADMIN_PAGE = fs.readFileSync(fileURLToPath(new URL('../public/gatekeeper.html', import.meta.url)), 'utf8');
const ADMIN_CSS = fs.readFileSync(fileURLToPath(new URL('../public/gatekeeper.css', import.meta.url)), 'utf8');

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
  });
  response.end(payload);
}

function textResponse(response, statusCode, contentType, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(body);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function copyHtml(value) {
  return escapeHtml(value).replaceAll('\n', '<br>');
}

function publicRoute(config, routePath, relativeFallback) {
  const normalizedRoute = String(routePath).replace(/^\/+/, '');
  const publicBaseUrl = String(config.publicBaseUrl || '').replace(/\/+$/, '');
  if (!publicBaseUrl) return relativeFallback;
  return new URL(normalizedRoute, `${publicBaseUrl}/`).toString();
}

function renderAdminPage(config) {
  return ADMIN_PAGE
    .replaceAll('__GATEKEEPER_CSS_URL__', escapeHtml(publicRoute(
      config,
      'admin/gatekeeper.css',
      'gatekeeper.css',
    )))
    .replaceAll('__GATEKEEPER_SNAPSHOT_URL__', escapeHtml(publicRoute(
      config,
      'admin/settings/snapshot',
      'settings/snapshot',
    )));
}

function sitePage({ title, text, links = [], buttonText = '', token = '', completionUrl = '' }) {
  const linkHtml = links.map((link) => (
    `<li><a href="${escapeHtml(link.url)}" rel="noreferrer noopener">${escapeHtml(link.label)}</a></li>`
  )).join('');
  const form = buttonText && token && completionUrl
    ? `<form method="post" action="${escapeHtml(completionUrl)}">`
      + `<input type="hidden" name="token" value="${escapeHtml(token)}">`
      + `<button type="submit">${escapeHtml(buttonText)}</button></form>`
    : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}</title><style>`
    + `body{font-family:system-ui,sans-serif;max-width:48rem;margin:0 auto;padding:2rem;line-height:1.55}`
    + `main{border:1px solid #ddd;border-radius:1rem;padding:1.5rem}button{font:inherit;padding:.8rem 1.2rem}`
    + `li{margin:.7rem 0}</style></head><body><main><h1>${escapeHtml(title)}</h1>`
    + `<p>${copyHtml(text)}</p>${linkHtml ? `<ul>${linkHtml}</ul>` : ''}${form}</main></body></html>`;
}

function html(response, statusCode, body) {
  textResponse(response, statusCode, 'text/html; charset=utf-8', body, {
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  });
}

function parseJson(rawBody, { rejectDuplicateKeys = false } = {}) {
  try {
    if (rejectDuplicateKeys) assertNoDuplicateJsonKeys(rawBody);
    return JSON.parse(rawBody);
  } catch (error) {
    if (error instanceof DuplicateJsonKeyError) {
      throw Object.assign(new Error(error.message), { statusCode: 400 });
    }
    if (error.message.startsWith('raw JSON duplicate-key scan failed closed:')) {
      throw Object.assign(new Error('request body failed strict JSON validation'), { statusCode: 400 });
    }
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 });
  }
}

function validAdminAuthorization(authorization, token) {
  if (!token || typeof authorization !== 'string' || !authorization.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return safeEqual(username, 'gatekeeper') && safeEqual(password, token);
}

export function createGatekeeperHttpServer({
  config,
  service,
  store,
  clock = Date.now,
  logger = console,
  ingressScenarioProvider = createScenarioProvider({
    scenarioPath: config.scenarioPath,
    allowDraftScenario: false,
  }),
  adminScenarioProvider = createScenarioProvider({
    scenarioPath: config.scenarioPath,
    allowDraftScenario: true,
  }),
}) {
  function loadReadyIngressScenario() {
    const scenario = ingressScenarioProvider.load();
    if (scenario.status !== 'ready') throw new Error('HTTP ingress requires a ready Gatekeeper scenario');
    return scenario;
  }

  function authorizeAdmin(request, response) {
    if (!config.adminSettingsToken) {
      json(response, 404, { error: 'not_found' });
      return false;
    }
    if (!validAdminAuthorization(request.headers.authorization, config.adminSettingsToken)) {
      textResponse(response, 401, 'text/plain; charset=utf-8', 'Authentication required', {
        'www-authenticate': 'Basic realm="Gatekeeper settings", charset="UTF-8"',
      });
      return false;
    }
    return true;
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, {
          status: 'ok',
          service: 'telegram-gatekeeper',
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/admin/gatekeeper') {
        if (!authorizeAdmin(request, response)) return;
        textResponse(response, 200, 'text/html; charset=utf-8', renderAdminPage(config), {
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          'referrer-policy': 'no-referrer',
          'x-frame-options': 'DENY',
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/admin/gatekeeper.css') {
        if (!authorizeAdmin(request, response)) return;
        textResponse(response, 200, 'text/css; charset=utf-8', ADMIN_CSS);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/admin/settings/snapshot') {
        if (!authorizeAdmin(request, response)) return;
        json(response, 200, buildAdminSettingsSnapshot({
          config,
          scenario: adminScenarioProvider.load(),
          storeSummary: store.operationalStatus(),
        }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/onboarding/site') {
        if (!config.siteEnabled) {
          json(response, 404, { error: 'not_found' });
          return;
        }
        const scenario = loadReadyIngressScenario();
        const lookup = service.getSiteOnboarding(url.searchParams.get('token'));
        if (!lookup.siteCase) {
          html(response, 404, sitePage({
            title: 'Ссылка недействительна',
            text: scenario.messages.site_invalid_link.text,
          }));
          return;
        }
        if (lookup.state === 'completed') {
          html(response, 200, sitePage({
            title: 'Онбординг завершён',
            text: scenario.messages.site_completion_already_completed.text,
          }));
          return;
        }
        const copy = scenario.messages.site_instruction;
        html(response, 200, sitePage({
          title: 'Онбординг',
          text: copy.text,
          links: copy.links,
          buttonText: copy.completion_button_text,
          token: url.searchParams.get('token'),
          completionUrl: publicRoute(config, 'onboarding/site/complete', 'site/complete'),
        }));
        return;
      }
      if (request.method !== 'POST') {
        json(response, 404, { error: 'not_found' });
        return;
      }

      const rawBody = await readBody(request);
      const rawText = rawBody.toString('utf8');
      if (url.pathname === '/webhooks/telegram') {
        const receivedSecret = request.headers['x-telegram-bot-api-secret-token'];
        if (!safeEqual(config.telegramWebhookSecret, receivedSecret || '')) {
          json(response, 401, { error: 'invalid_telegram_secret' });
          return;
        }
        const scenario = loadReadyIngressScenario();
        const result = await service.handleTelegramUpdate(parseJson(rawText), rawText, { scenario });
        json(response, 200, { ok: true, result });
        return;
      }

      if (url.pathname === '/webhooks/tribute') {
        const valid = verifyTributeWebhook({
          apiKey: config.tributeApiKey,
          rawBody,
          signature: request.headers['trbt-signature'],
        });
        if (!valid) {
          json(response, 401, { error: 'invalid_tribute_signature' });
          return;
        }
        const scenario = loadReadyIngressScenario();
        const mapped = mapTributeNewSubscription(parseJson(rawText), config);
        if (mapped.ignored) {
          json(response, 200, { status: 'ignored' });
          return;
        }
        await service.handleExternalEvent(mapped.event, mapped.canonicalBody, { scenario });
        json(response, 200, { status: 'ok' });
        return;
      }

      if (url.pathname === '/webhooks/site-registration') {
        if (!config.siteEnabled) {
          json(response, 404, { error: 'not_found' });
          return;
        }
        const signature = singleSiteSignatureFromRawHeaders(request.rawHeaders);
        if (!verifySiteWebhook({ secret: config.siteWebhookSecret, rawBody, signature })) {
          json(response, 401, { error: 'invalid_site_signature' });
          return;
        }
        if (!config.zapierEnabled) {
          json(response, 503, { error: 'site_delivery_not_configured' });
          return;
        }
        const parsed = parseJson(rawText, { rejectDuplicateKeys: true });
        const scenario = loadReadyIngressScenario();
        const mapped = mapSiteRegistration(parsed);
        const result = await service.handleSiteRegistration(mapped.event, mapped.canonicalBody, { scenario });
        json(response, 200, { status: 'ok', result });
        return;
      }

      if (url.pathname === '/onboarding/site/complete') {
        if (!config.siteEnabled) {
          json(response, 404, { error: 'not_found' });
          return;
        }
        if (!config.zapierEnabled) {
          json(response, 503, { error: 'completion_delivery_not_configured' });
          return;
        }
        const scenario = loadReadyIngressScenario();
        const params = new URLSearchParams(rawText);
        if ([...params.keys()].some((key) => key !== 'token') || params.getAll('token').length !== 1) {
          json(response, 400, { error: 'invalid_form' });
          return;
        }
        const result = await service.completeSiteOnboarding(params.get('token'));
        const success = result.state === 'completed';
        html(response, success ? 200 : 404, sitePage({
          title: success ? 'Онбординг завершён' : 'Ссылка недействительна',
          text: success
            ? (result.duplicate
              ? scenario.messages.site_completion_already_completed.text
              : scenario.messages.site_completion_success.text)
            : scenario.messages.site_invalid_link.text,
        }));
        return;
      }

      json(response, 404, { error: 'not_found' });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) logger.error?.('[gatekeeper] request failed', { message: error.message });
      json(response, statusCode, { error: statusCode >= 500 ? 'internal_error' : error.message });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
