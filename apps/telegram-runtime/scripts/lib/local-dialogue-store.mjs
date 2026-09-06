import Database from 'better-sqlite3';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// A separate held SQLite transaction is the one-writer lease. Process death
// releases it; durable checkpoints use another DB and do not share runtime transactions.
export function openDialogueStore(directory, resume) {
  for (const path of [directory, ...['writer.db', 'state.db', 'runtime.db'].map((name) => join(directory, name))]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('managed_storage_symlink');
  }
  if (!resume) mkdirSync(directory); // EEXIST is intentional; never overwrite a run.
  const lease = new Database(join(directory, 'writer.db'), { fileMustExist: resume });
  lease.pragma('busy_timeout = 0');
  try { lease.exec('BEGIN EXCLUSIVE'); }
  catch (error) { lease.close(); throw new Error('managed_run_writer_busy', { cause: error }); }
  let db;
  try {
    db = new Database(join(directory, 'state.db'), { fileMustExist: resume });
    db.pragma('synchronous = FULL');
    if (!resume) db.exec('CREATE TABLE checkpoint (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL)');
  } catch (error) { lease.close(); throw error; }
  return {
    read() { const row = db.prepare('SELECT payload FROM checkpoint WHERE id = 1').get(); return row ? JSON.parse(row.payload) : null; },
    write(value) { db.prepare('INSERT INTO checkpoint VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(value)); },
    close() { db.close(); lease.close(); },
  };
}
