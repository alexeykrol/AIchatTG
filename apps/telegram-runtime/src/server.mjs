import { loadRuntimeConfig } from './config.mjs';
import { openRuntimeDatabase, createRuntimeStore } from './database.mjs';
import { createProviderAdapter } from './provider-adapter.mjs';
import { createKnowledgeAdapter } from './knowledge-adapter.mjs';
import { assertSlicesAdmitted, composeKnowledgeSlices } from './knowledge-slices.mjs';
import { createKnowledgeRetrieval } from './knowledge-retrieval.mjs';
import { createRewriterAdapter } from './rewriter-adapter.mjs';
import { createNotificationAdapter } from './notification-adapter.mjs';
import { createTelegramAdapter } from './telegram-adapter.mjs';
import { createGuardAdapter } from './guard-adapter.mjs';
import { botIdFromToken } from '@aichattg/telegram-core';
import { createTelegramRuntime } from './runtime.mjs';
import { createTelegramRuntimeHttpServer } from './http-server.mjs';
import { createModeratorRecoveryWorker } from './moderator-recovery.mjs';

const config = loadRuntimeConfig();
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
const runtime = createTelegramRuntime({
  config,
  store: createRuntimeStore(database),
  provider: createProviderAdapter(config.provider),
  knowledge,
  contentRetrieval,
  moderatorTelegram,
  guard,
  assistantTelegram: createTelegramAdapter(config.assistant),
  notifier: createNotificationAdapter(config.notification),
});
const server = createTelegramRuntimeHttpServer({ config, runtime });
const recoveryWorker = createModeratorRecoveryWorker({
  runtime,
  intervalSec: config.moderatorRecoveryIntervalSec,
  batchSize: config.moderatorRecoveryBatchSize,
});

server.listen(config.port, () => {
  console.log(`[telegram-runtime] listening on ${config.port}; ingress=${config.ingressEnabled}; poll=false; webhook-registration=false; commands=false`);
  recoveryWorker.start();
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    recoveryWorker.stop();
    server.close(() => { database.close(); process.exit(0); });
  });
}
