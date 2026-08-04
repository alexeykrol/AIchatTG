import { TelegramApi } from './telegram-api.mjs';

const botToken = String(process.env.GATEKEEPER_BOT_TOKEN || '').trim();
if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error('GATEKEEPER_BOT_TOKEN is required');
const telegram = new TelegramApi({ botToken });
await telegram.deleteWebhook({ drop_pending_updates: false });
console.log(JSON.stringify({ ok: true, webhook_deleted: true, pending_updates_dropped: false }));
