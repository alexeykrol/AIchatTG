import fs from 'node:fs';
import { assertExistingPrivateDataFile, resolveGatekeeperDataPaths } from './data-paths.mjs';
import { GatekeeperStore } from './store.mjs';

export function openExistingStore(env = process.env) {
  const { dataRoot, databasePath } = resolveGatekeeperDataPaths(env);
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
    throw new Error(`Gatekeeper database does not exist: ${databasePath}`);
  }
  assertExistingPrivateDataFile(dataRoot, databasePath);
  return { dataRoot, databasePath, store: new GatekeeperStore(databasePath) };
}
