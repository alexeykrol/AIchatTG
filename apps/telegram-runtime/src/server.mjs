import { loadRuntimeConfig } from './config.mjs';
import { openRuntimeDatabase, createRuntimeStore } from './database.mjs';
import { createProviderAdapter } from './provider-adapter.mjs';
import { createKnowledgeAdapter } from './knowledge-adapter.mjs';
import { createNotificationAdapter } from './notification-adapter.mjs';
import { createTelegramAdapter } from './telegram-adapter.mjs';
import { createGuardAdapter } from './guard-adapter.mjs';
import { botIdFromToken } from '@aichattg/telegram-core';
import { createTelegramRuntime } from './runtime.mjs';
import { createTelegramRuntimeHttpServer } from './http-server.mjs';

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
const runtime = createTelegramRuntime({
  config,
  store: createRuntimeStore(database),
  provider: createProviderAdapter(config.provider),
  knowledge: createKnowledgeAdapter(config.knowledge),
  moderatorTelegram,
  guard,
  assistantTelegram: createTelegramAdapter(config.assistant),
  notifier: createNotificationAdapter(config.notification),
});
const server = createTelegramRuntimeHttpServer({ config, runtime });

server.listen(config.port, () => {
  console.log(`[telegram-runtime] listening on ${config.port}; ingress=${config.ingressEnabled}; poll=false; webhook-registration=false; commands=false`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => { database.close(); process.exit(0); }));
}
