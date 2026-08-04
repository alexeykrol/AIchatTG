import { openExistingStore } from './ops-store.mjs';

const [updateId] = process.argv.slice(2);
if (!updateId) throw new Error('usage: npm run ops:resolve-update -- <update-id>');
if (process.env.GATEKEEPER_RESOLUTION_CONFIRMED !== 'true') {
  throw new Error('set GATEKEEPER_RESOLUTION_CONFIRMED=true after manually confirming the prior side effect was delivered');
}

const { store } = openExistingStore();
try {
  if (!store.resolveUpdateProcessed(updateId, new Date().toISOString())) {
    throw new Error('update is missing or is not in an uncertain state');
  }
  console.log(JSON.stringify({ ok: true, update_id: updateId, resolution: 'processed' }));
} finally {
  store.close();
}
