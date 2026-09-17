import { createReviewIpcServer, requestReviewIpc } from '../../../packages/telegram-core/src/moderation-review-ipc.mjs';
import { reviewCapturePolicy, reviewSocketPaths } from '../../../packages/telegram-core/src/moderation-review-config.mjs';
import { createModerationReviewCapture } from './moderation-review-capture.mjs';
import { createModerationReviewTelegramSender } from './moderation-review-sender.mjs';

export async function createRuntimeReviewService({ binding, config, now = Date.now,
  request = requestReviewIpc, serverFactory = createReviewIpcServer, fetchImpl = globalThis.fetch } = {}) {
  if (!binding) return { capture: null, async close() {} };
  const knownChats = new Set(config.moderator.chatIds);
  const ownIds = [config.moderator.botToken, config.assistant.botToken].map((token) => String(token || '').split(':')[0]).filter(Boolean);
  const requiredExemptions = [...ownIds, ...config.moderator.exemptBotIds];
  if (binding.chatIds.some((id) => !knownChats.has(id))
    || requiredExemptions.some((id) => !binding.exemptBotIds.includes(id))) throw new Error('review_primary_scope_mismatch');
  const sockets = reviewSocketPaths(binding);
  const capture = createModerationReviewCapture({ policy: reviewCapturePolicy(binding), now,
    maxInflight: binding.maxInflight, timeoutMs: binding.captureTimeoutMs,
    send: (body, { signal, timeoutMs }) => request({ socketPath: sockets.console, path: '/capture', body, signal, timeoutMs }) });
  const send = createModerationReviewTelegramSender({ enabled: binding.deliveryEnabled,
    botToken: config.moderator.botToken, recipientChatId: binding.recipientChatId,
    consoleUrl: binding.consoleUrl, fetchImpl, timeoutMs: binding.notificationTimeoutMs,
    authorize: async (claim, { signal }) => {
      const response = await request({ socketPath: sockets.console, path: '/authorize', body: claim,
        timeoutMs: binding.ipcTimeoutMs, signal });
      return response.statusCode === 200 ? response.body : { authorized: false };
    } });
  let ipc;
  try {
    ipc = await serverFactory({ socketPath: sockets.runtime,
      timeoutMs: binding.notificationTimeoutMs + binding.ipcTimeoutMs + 500, maxConcurrent: binding.maxInflight,
      handle: async ({ path, body, signal }) => {
        if (signal.aborted) return { statusCode: 503, body: { error: 'review_unavailable' } };
        if (path === '/coverage' && body && Object.keys(body).length === 0) return { statusCode: 200, body: capture.snapshot() };
        if (path === '/notify') return { statusCode: 200, body: await send(body, { signal }) };
        return { statusCode: 404, body: { error: 'review_route_not_found' } };
      } });
  } catch (error) { capture.close(); throw error; }
  return { capture, async close() { capture.close(); await ipc.close(); } };
}
