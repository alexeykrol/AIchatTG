import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { TelegramApi } from './telegram-api.mjs';

export const ALLOWED_UPDATES = Object.freeze(['chat_join_request', 'message', 'callback_query']);

// Production action: registering the webhook requires Product Owner approval
// and a release lease (contract §12). Not executed by tests or CI.
export async function registerWebhook({
  env = process.env,
  telegramFactory = ({ botToken }) => new TelegramApi({ botToken }),
  writeReceipt = (receipt) => console.log(JSON.stringify(receipt)),
} = {}) {
  const config = loadConfig(env);
  if (config.scenario.status !== 'ready') {
    throw new Error('webhook registration requires a ready join scenario');
  }
  if (!config.publicBaseUrl.startsWith('https://')) {
    throw new Error('JOIN_GATEKEEPER_PUBLIC_BASE_URL must be a configured https URL');
  }
  const telegram = telegramFactory({ botToken: config.botToken });
  const url = `${config.publicBaseUrl}/webhooks/telegram`;
  await telegram.setWebhook({
    url,
    secret_token: config.webhookSecret,
    allowed_updates: [...ALLOWED_UPDATES],
    drop_pending_updates: false,
  });
  const receipt = { ok: true, webhook_url: url, allowed_updates: [...ALLOWED_UPDATES] };
  writeReceipt(receipt);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await registerWebhook();
}
