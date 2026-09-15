/** Explicitly invoked loopback-only synthetic QA harness; never production
 * bootstrap. It has no token lookup, runtime DB, provider or external client. */
import { createServer } from 'node:http';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createModerationReviewStore } from './moderation-review-store.mjs';
import { createModerationReviewHandler } from './moderation-review-http.mjs';
import { deliverNextModerationReviewAlert } from './moderation-review-alerts.mjs';
import { validOperatorAuthorization } from './server.mjs';

export const SYNTHETIC_REVIEW_TOKEN = 'synthetic-review-preview-only';
export const SYNTHETIC_REVIEW_LIMITS = Object.freeze({
  retentionMs: null, maxTextChars: 8192, maxContextChars: 2048,
  maxNoteChars: 2000, maxObservations: 100,
});

export async function createModerationReviewPreview({ root } = {}) {
  // The demonstration is seeded once into an explicitly fresh private root.
  // Never add fixture labels to a retained store or alter prior QA evidence.
  if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('synthetic_preview_requires_fresh_root');
  const existing = lstatSync(root, { throwIfNoEntry: false });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory() || readdirSync(root).length)) {
    throw new TypeError('synthetic_preview_requires_fresh_root');
  }
  const store = createModerationReviewStore({ root, mode: 'synthetic', limits: SYNTHETIC_REVIEW_LIMITS });
  let server;
  try {
    const observedAt = new Date().toISOString();
    const source = (messageId, text, extra = {}) => ({
      chatId: 'synthetic-chat', messageId, revision: 0, observedAt, text,
      userId: `synthetic-author-${messageId}`, ...extra,
    });
    const adText = 'Я прочитал книгу «Синтетический атлас» и наконец понял этот подход. Купите книгу по промокоду TEST-ONLY. Напишите мне в личку за условиями.';
    const ad = store.ingest(source('fixture-1', adText));
    store.ingest(source('fixture-2', adText, { context: { messageId: 'synthetic-post', text: 'Учебный пост о чтении. Только искусственный пример для проверки интерфейса.' } }));
    const hostile = store.ingest(source('fixture-3', 'Я попробовал сервис «Локальный макет». Купите продукт со скидкой. <img src=x onerror="window.reviewInjected=true"> Это синтетический текст, не настоящая реклама.'));
    const legitimate = store.ingest(source('fixture-4', 'Я прочитал книгу «Тестовый сад». Купите книгу, если она вам подходит. Это искусственный пример ошибочного подозрения для проверки отрицательной оценки.'));
    store.decide({ caseId: legitimate.caseId, expectedVersion: 1, decisionId: randomUUID(), label: 'legitimate', note: 'Синтетический отрицательный пример: допустимая рекомендация.' }, 'operator');
    const positive = store.ingest(source('fixture-5', 'Я прошла курс «Учебная заглушка». Запишитесь на курс по промокоду FAKE-ONLY. Это искусственный положительный пример, никаких настоящих продаж.'));
    store.decide({ caseId: positive.caseId, expectedVersion: 1, decisionId: randomUUID(), label: 'hidden_advertising', note: 'Только локальная проверка версии черновика.' }, 'operator');
    const uncertain = store.ingest(source('fixture-6', 'Я купил продукт «Синтетический пример». Купите продукт сейчас. Пример для проверки неполного контекста; реального товара не существует.'));
    store.decide({ caseId: uncertain.caseId, expectedVersion: 1, decisionId: randomUUID(), label: 'insufficient_evidence', note: 'Нет исходного контекста. Это не обучающий пример.' }, 'operator');
    store.ingest(source('fixture-clean', 'Я прочитал книгу о композиции. Вторая глава оказалась полезной, хотя с примерами автора я не согласен.'));

    let handler;
    const auth = (request) => validOperatorAuthorization(request.headers.authorization, SYNTHETIC_REVIEW_TOKEN) ? 'operator' : null;
    const page = readFileSync(new URL('../public/moderation-v3.html', import.meta.url), 'utf8')
      .replace('{{CONSOLE_RELEASE_STAMP}}', 'ЛОКАЛЬНАЯ ПРОВЕРКА · только синтетические данные');
    const css = readFileSync(new URL('../public/console-v3.css', import.meta.url), 'utf8');
    const legacy = {
      '/api/moderation/mode': { mode: 'shadow', telegramConfigured: false, telegramSafety: { model: 'synthetic-no-model', policyVersion: 'v1' } },
      '/api/moderation/stats': { totalEvents: 0, byVerdict: { clean: 0, suspect: 0, ban: 0 }, tokens: { input: 0, output: 0 }, cost: { total: 0 } },
      '/api/moderation/events': [],
      '/api/moderation/prompts': { active: 'synthetic-v1', versions: [{ version: 'synthetic-v1' }], activeText: 'Синтетический просмотр. Действующий production-промпт здесь не загружен.' },
    };
    server = createServer(async (request, response) => {
      if (!auth(request)) {
        response.writeHead(401, { 'www-authenticate': 'Basic realm="Synthetic Moderator preview"', 'cache-control': 'no-store' });
        response.end('Synthetic preview credentials only.'); return;
      }
      try {
        if (await handler(request, response)) return;
        const path = new URL(request.url, 'http://preview.invalid').pathname;
        const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" };
        if (request.method === 'GET' && (path === '/' || path === '/moderation-v3.html')) {
          response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }); response.end(page); return;
        }
        if (request.method === 'GET' && path === '/console-v3.css') {
          response.writeHead(200, { ...headers, 'content-type': 'text/css; charset=utf-8' }); response.end(css); return;
        }
        if (request.method === 'GET' && Object.hasOwn(legacy, path)) {
          response.writeHead(200, { ...headers, 'content-type': 'application/json' }); response.end(JSON.stringify(legacy[path])); return;
        }
        response.writeHead(404, headers); response.end('Synthetic harness route not found');
      } catch {
        response.writeHead(503, { 'cache-control': 'no-store' }); response.end('Synthetic harness unavailable');
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    handler = createModerationReviewHandler({ store, authenticate: auth, origin });
    const alerts = [];
    const alert = await deliverNextModerationReviewAlert({ store, consoleUrl: origin, send: async (payload) => {
      alerts.push(payload); return { ok: true, receipt: { id: randomUUID() } };
    } });
    return {
      origin, store, alerts, alert, cases: { ad: ad.caseId, hostile: hostile.caseId, legitimate: legitimate.caseId, positive: positive.caseId, uncertain: uncertain.caseId },
      async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); store.close(); },
    };
  } catch (error) { server?.close(); store.close(); throw error; }
}
