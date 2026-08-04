import { loadRuntimeConfig } from './config.mjs';
import { openRuntimeDatabase, createRuntimeStore } from './database.mjs';
import { createProviderAdapter } from './provider-adapter.mjs';
import { createKnowledgeAdapter } from './knowledge-adapter.mjs';
import { createNotificationAdapter } from './notification-adapter.mjs';
import { createTelegramAdapter } from './telegram-adapter.mjs';
import { createTelegramRuntime } from './runtime.mjs';
import { createTelegramRuntimeHttpServer } from './http-server.mjs';

const config = loadRuntimeConfig();
const database = openRuntimeDatabase(config.databasePath);
const runtime = createTelegramRuntime({
  config,
  store: createRuntimeStore(database),
  provider: createProviderAdapter(config.provider),
  knowledge: createKnowledgeAdapter(config.knowledge),
  moderatorTelegram: createTelegramAdapter(config.moderator),
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
