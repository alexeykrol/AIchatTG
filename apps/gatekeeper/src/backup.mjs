import fs from 'node:fs';
import {
  enforcePrivateFileMode,
  preparePrivateDataParent,
  resolveGatekeeperBackupPath,
  resolveGatekeeperDataPaths,
} from './data-paths.mjs';
import { openExistingStore } from './ops-store.mjs';

process.umask(0o077);
const { dataRoot } = resolveGatekeeperDataPaths(process.env);
const destination = resolveGatekeeperBackupPath(process.env, dataRoot);
if (fs.existsSync(destination)) throw new Error('backup destination already exists');
preparePrivateDataParent(dataRoot, destination);

const { store } = openExistingStore(process.env);
try {
  await store.backup(destination);
  console.log(JSON.stringify({ ok: true, backup_path: destination, method: 'better-sqlite3.backup' }));
} finally {
  if (fs.existsSync(destination)) enforcePrivateFileMode(destination);
  store.close();
}
