#!/usr/bin/env node
import { loadRuntimeConfig } from '../../apps/telegram-runtime/src/config.mjs';
import { createRuntimeStore, openReadOnlyRuntimeDatabase } from '../../apps/telegram-runtime/src/database.mjs';

const config = loadRuntimeConfig(process.env);
let database;
try {
  database = openReadOnlyRuntimeDatabase(config.databasePath);
  const status = createRuntimeStore(database).moderatorRecoveryStatus();
  process.stdout.write(`${JSON.stringify(status)}\n`);
} catch (error) {
  process.stderr.write(`moderator recovery status unavailable: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  database?.close();
}
