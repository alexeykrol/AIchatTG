import { loadRuntimeConfig } from './config.mjs';
import { openRuntimeDatabase, createRuntimeStore } from './database.mjs';
import { createProviderAdapter } from './provider-adapter.mjs';
import { createKnowledgeAdapter } from './knowledge-adapter.mjs';
import { assertSlicesAdmitted, composeKnowledgeSlices } from './knowledge-slices.mjs';
import { createKnowledgeRetrieval } from './knowledge-retrieval.mjs';
import { createAnalyzerAdapter } from './analyzer-adapter.mjs';
import { loadAnalyzerSpec } from './analyzer-spec.mjs';
import { createRewriterAdapter } from './rewriter-adapter.mjs';
import { createNotificationAdapter } from './notification-adapter.mjs';
import { createTelegramAdapter } from './telegram-adapter.mjs';
import { createGuardAdapter } from './guard-adapter.mjs';
import { botIdFromToken } from '@aichattg/telegram-core';
import { createTelegramRuntime } from './runtime.mjs';
import { createTelegramRuntimeHttpServer } from './http-server.mjs';
import { createModeratorRecoveryWorker } from './moderator-recovery.mjs';
import { createAssistantAskExpiryWorker } from './assistant-ask-expiry.mjs';
import { loadDomainCatalog } from './assistant-domains.mjs';
import { loadModerationReviewBinding } from '../../../packages/telegram-core/src/moderation-review-config.mjs';
import { createRuntimeReviewService } from './moderation-review-service.mjs';

const config = loadRuntimeConfig();
const domainCatalog = loadDomainCatalog({ indexPath: config.assistantDomainIndexPath });
console.log(`[telegram-runtime] domain registry count=${domainCatalog.domains.length}; digest=${domainCatalog.digest}`);
const database = openRuntimeDatabase(config.databasePath);
const moderatorTelegram = createTelegramAdapter(config.moderator);
const guard = createGuardAdapter({
  telegram: moderatorTelegram,
  guardBotId: botIdFromToken(config.moderator.botToken),
  guardChatIds: config.moderator.chatIds,
  // The assistant's own token-derived id is always exempt from code-side bot
  // escalation; configured friendly bots are additive.
  exemptBotIds: [
    ...config.moderator.exemptBotIds,
    botIdFromToken(config.assistant.botToken),
    botIdFromToken(config.moderator.botToken),
  ].filter(Boolean),
});
// Срезы подключаются поверх пакета уроков тем же порядком, что и на стенде:
// в ответы уходит склеенное знание, а ретривер строится от БАЗОВОГО адаптера —
// иначе поиск по урокам увидел бы записи срезов. Заданный, но не принятый срез
// роняет старт (см. assertSlicesAdmitted): дефект конфигурации должен всплыть
// здесь, а не молчаливой дырой в домене на живом вопросе.
const composed = composeKnowledgeSlices(createKnowledgeAdapter(config.knowledge), {
  orgSlicePath: config.knowledge.slices.orgPath,
  valueSlicePath: config.knowledge.slices.valuePath,
});
for (const slice of composed.slices) {
  // Только путь, флаг и код причины: содержимое среза в лог не попадает.
  console.log(`[telegram-runtime] knowledge slice ${slice.name}: configured=${slice.configured}; admitted=${slice.admitted}; reason=${slice.reason || 'none'}; entries=${slice.entries}; path=${slice.path || 'none'}`);
}
assertSlicesAdmitted(composed.slices);
const knowledge = composed.knowledge;
// The content retriever is built only when explicitly enabled. When it is off
// the assistant keeps its previous path exactly, so this cutover is a switch,
// not a rewrite of a running deployment.
const contentRetrieval = config.assistantRetrieval.enabled === true
  ? createKnowledgeRetrieval(config.assistantRetrieval, {
    knowledge: composed.baseKnowledge,
    rewriteQuestion: config.assistantRetrieval.rewriteEnabled === true
      ? createRewriterAdapter({
        enabled: true,
        endpoint: config.provider.endpoint,
        apiKey: config.provider.apiKey,
        model: config.assistantRetrieval.rewrite.model,
        reasoningEffort: config.assistantRetrieval.rewrite.reasoningEffort,
      })
      : null,
  })
  : null;
if (contentRetrieval && !contentRetrieval.available) {
  console.error(`[telegram-runtime] content retrieval unavailable: ${contentRetrieval.reason}`);
}
// Анализатор запроса. Спецификация — данные выката: её дайджест печатается в
// лог, потому что тот же файл живёт в лаборатории, и расхождение стенда с боем
// обязано быть видимым, а не обнаруживаться по странным цифрам замера.
const provider = createProviderAdapter(config.provider, { domainCatalog });
const analyzerSpec = config.analyzer.mode === 'off'
  ? { valid: false, code: 'analyzer_disabled', spec: null, digest: null }
  : loadAnalyzerSpec(config.analyzer.specPath);
if (config.analyzer.mode !== 'off' && !analyzerSpec.valid) {
  // Включённый, но нерабочий анализатор — дефект конфигурации, а не режим
  // работы: он должен всплыть при старте, а не тишиной в журнале наблюдений.
  throw new Error(`analyzer spec unavailable: ${analyzerSpec.code} (${config.analyzer.specPath})`);
}
const analyzer = createAnalyzerAdapter({
  config: config.analyzer, provider, spec: analyzerSpec.spec, digest: analyzerSpec.digest, domainCatalog,
});
console.log(`[telegram-runtime] analyzer mode=${analyzer.mode}; enabled=${analyzer.enabled}; `
  + `reason=${analyzer.reason || 'none'}; chats=${config.analyzer.chatIds.length}; `
  + `spec=${analyzerSpec.digest ? analyzerSpec.digest.slice(0, 12) : 'none'}`);
const runtime = createTelegramRuntime({
  config,
  store: createRuntimeStore(database),
  provider,
  domainCatalog,
  knowledge,
  contentRetrieval,
  analyzer,
  moderatorTelegram,
  guard,
  assistantTelegram: createTelegramAdapter(config.assistant),
  notifier: createNotificationAdapter(config.notification),
});
const loadedReview = loadModerationReviewBinding(process.env.AICHATTG_REVIEW_BINDING_PATH);
let review = null;
if (loadedReview.binding) {
  try { review = await createRuntimeReviewService({ binding: loadedReview.binding, config }); }
  catch { console.error('[telegram-runtime] review unavailable; primary moderation unchanged'); }
}
const server = createTelegramRuntimeHttpServer({ config, runtime, reviewCapture: review?.capture });
const recoveryWorker = createModeratorRecoveryWorker({
  runtime,
  intervalSec: config.moderatorRecoveryIntervalSec,
  batchSize: config.moderatorRecoveryBatchSize,
});
const askExpiryWorker = createAssistantAskExpiryWorker({ runtime });

server.listen(config.port, () => {
  console.log(`[telegram-runtime] listening on ${config.port}; ingress=${config.ingressEnabled}; poll=false; webhook-registration=false; commands=false`);
  recoveryWorker.start();
  askExpiryWorker.start();
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    recoveryWorker.stop();
    askExpiryWorker.stop();
    const reviewClosed = Promise.resolve(review?.close()).catch(() => {});
    server.close(async () => { await reviewClosed; database.close(); process.exit(0); });
  });
}
