import fs from 'node:fs';
import { loadConfig } from './config.mjs';
import {
  assertExistingPrivateDataFile,
  enforcePrivateFileMode,
  preparePrivateDataParent,
} from './data-paths.mjs';
import { GatekeeperService } from './gatekeeper.mjs';
import { createGatekeeperHttpServer } from './http-server.mjs';
import { createScenarioProvider } from './scenario.mjs';
import { GatekeeperStore } from './store.mjs';
import { TelegramApi } from './telegram-api.mjs';

process.umask(0o077);
const config = loadConfig();
const scenarioProvider = createScenarioProvider({
  scenarioPath: config.scenarioPath,
  allowDraftScenario: false,
});
scenarioProvider.load();
preparePrivateDataParent(config.dataRoot, config.databasePath);
if (fs.existsSync(config.databasePath)) {
  assertExistingPrivateDataFile(config.dataRoot, config.databasePath);
}

const store = new GatekeeperStore(config.databasePath);
enforcePrivateFileMode(config.databasePath);
const telegram = new TelegramApi({ botToken: config.botToken });
const service = new GatekeeperService({ config, store, telegram, scenarioProvider });
const server = createGatekeeperHttpServer({ config, service, store });

server.listen(config.port, config.bindHost, () => {
  console.log(`[gatekeeper] listening on http://${config.bindHost}:${config.port}`);
});

function shutdown(signal) {
  console.log(`[gatekeeper] received ${signal}; shutting down`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
