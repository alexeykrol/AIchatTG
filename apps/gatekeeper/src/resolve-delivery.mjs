import { openExistingStore } from './ops-store.mjs';

const [invitationId, resolution, messageId] = process.argv.slice(2);
if (!invitationId || !['sent', 'not_sent'].includes(resolution)) {
  throw new Error('usage: npm run ops:resolve-delivery -- <invitation-id> <sent|not_sent> [message-id]');
}
if (resolution === 'sent' && !messageId) throw new Error('message-id is required for a sent resolution');
if (process.env.GATEKEEPER_RESOLUTION_CONFIRMED !== 'true') {
  throw new Error('set GATEKEEPER_RESOLUTION_CONFIRMED=true after manually checking the Telegram outcome');
}

const { store } = openExistingStore();
try {
  const changed = store.resolveGroupDelivery(invitationId, {
    resolution,
    messageId,
    now: new Date().toISOString(),
  });
  if (!changed) throw new Error('invitation is missing or is not in an uncertain delivery state');
  console.log(JSON.stringify({ ok: true, invitation_id: invitationId, resolution }));
} finally {
  store.close();
}
