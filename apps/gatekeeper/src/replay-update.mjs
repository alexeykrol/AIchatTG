import { loadConfig } from './config.mjs';
import { GatekeeperService } from './gatekeeper.mjs';
import { openExistingStore } from './ops-store.mjs';
import { TelegramApi } from './telegram-api.mjs';
import { decryptUpdateBody } from './security.mjs';

const [updateId] = process.argv.slice(2);
if (!updateId) throw new Error('usage: npm run ops:replay-update -- <update-id>');
if (process.env.GATEKEEPER_REPLAY_CONFIRMED_ABSENT !== 'true') {
  throw new Error('set GATEKEEPER_REPLAY_CONFIRMED_ABSENT=true only after confirming the prior side effect was absent');
}

const config = loadConfig();
const { store } = openExistingStore({ ...process.env, GATEKEEPER_DATABASE_PATH: config.databasePath });
try {
  const storedUpdate = store.findUpdate(updateId);
  if (!storedUpdate || !['processing', 'failed', 'inconclusive'].includes(storedUpdate.state)) {
    throw new Error('update is missing or is not replayable');
  }
  if (store.operationalStatus().uncertain_invitations.length) {
    throw new Error('resolve uncertain group deliveries before replaying an update');
  }
  if (!store.markUpdateRetryable(updateId, new Date().toISOString())) {
    throw new Error('update could not be marked retryable');
  }
  const telegram = new TelegramApi({ botToken: config.botToken });
  const service = new GatekeeperService({ config, store, telegram });
  const rawBody = decryptUpdateBody({
    ciphertext: storedUpdate.raw_body_ciphertext,
    iv: storedUpdate.raw_body_iv,
    tag: storedUpdate.raw_body_tag,
  }, config.linkSigningSecret);
  const result = await service.handleTelegramUpdate(JSON.parse(rawBody), rawBody, {
    rawBodySha256: storedUpdate.raw_body_sha256,
    confirmedAbsentCompletionDmReplay:
      process.env.GATEKEEPER_REPLAY_COMPLETION_DM_CONFIRMED_ABSENT === 'true',
  });
  console.log(JSON.stringify({ ok: true, update_id: updateId, result }));
} finally {
  store.close();
}
