import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createScenarioProvider } from './scenario.mjs';
import { TelegramApi } from './telegram-api.mjs';

export async function registerWebhook({
  env = process.env,
  scenarioProviderFactory = createScenarioProvider,
  telegramFactory = ({ botToken }) => new TelegramApi({ botToken }),
  writeReceipt = (receipt) => console.log(JSON.stringify(receipt)),
} = {}) {
  const config = loadConfig(env);
  const scenarioProvider = scenarioProviderFactory({
    scenarioPath: config.scenarioPath,
    allowDraftScenario: false,
  });
  const scenario = scenarioProvider.load();
  if (scenario.status !== 'ready') throw new Error('webhook registration requires a ready Gatekeeper scenario');
  if (!config.publicBaseUrl.startsWith('https://')) {
    throw new Error('GATEKEEPER_PUBLIC_ORIGIN must be a configured HTTPS origin');
  }

  const telegram = telegramFactory({ botToken: config.botToken });
  const url = `${config.publicBaseUrl}/webhooks/telegram`;
  await telegram.setWebhook({
    url,
    secret_token: config.telegramWebhookSecret,
    allowed_updates: ['message', 'chat_member', 'callback_query'],
    drop_pending_updates: false,
  });
  const receipt = { ok: true, webhook_url: url };
  writeReceipt(receipt);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await registerWebhook();
}
