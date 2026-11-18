import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { createJoinGatekeeperHttpServer } from './http-server.mjs';
import { JoinGatekeeperService } from './service.mjs';
import { JoinStore } from './store.mjs';
import { TelegramApi } from './telegram-api.mjs';

const SWEEP_INTERVAL_MS = 30_000;

process.umask(0o077);

function log(level, event, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, app: 'join-gatekeeper', event, ...data });
  if (level === 'error') console.error(line);
  else console.log(line);
}
const logger = {
  info: (event, data) => log('info', event, data),
  warn: (event, data) => log('warn', event, data),
  error: (event, data) => log('error', event, data),
};

function chmodPrivate(file) {
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
}

const config = loadConfig();
fs.mkdirSync(path.dirname(config.databasePath), { recursive: true, mode: 0o700 });
const store = new JoinStore(config.databasePath);
for (const suffix of ['', '-wal', '-shm']) chmodPrivate(`${config.databasePath}${suffix}`);

const telegram = new TelegramApi({ botToken: config.botToken });
const service = new JoinGatekeeperService({ config, store, telegram, logger });
const server = createJoinGatekeeperHttpServer({ config, service, logger });

let sweeping = false;
const sweepTimer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    const result = await service.sweep();
    if (result.timedOut > 0 || result.probationExpired > 0 || result.purged.answers > 0 || result.purged.applications > 0) {
      logger.info('sweep', result);
    }
  } catch (error) {
    logger.error('sweep_failed', { error: error.message });
  } finally {
    sweeping = false;
  }
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

server.listen(config.port, config.bindHost, () => {
  logger.info('listening', {
    host: config.bindHost,
    port: config.port,
    mode: config.mode,
    scenario_status: config.scenario.status,
    target_chats: config.targetChatIds.length,
  });
});

function shutdown(signal) {
  logger.info('shutdown', { signal });
  clearInterval(sweepTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
