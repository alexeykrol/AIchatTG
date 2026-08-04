import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import {
  preparePrivateDataParent,
  resolveGatekeeperBackupPath,
  resolveGatekeeperDataPaths,
} from '../src/data-paths.mjs';
import { openExistingStore } from '../src/ops-store.mjs';
import { GatekeeperStore } from '../src/store.mjs';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories = [];

function createTempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-gatekeeper-path-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createPrivateStore(dataRoot, relativePath = 'gatekeeper.sqlite') {
  const databasePath = path.join(dataRoot, relativePath);
  preparePrivateDataParent(dataRoot, databasePath);
  const store = new GatekeeperStore(databasePath);
  store.close();
  fs.chmodSync(databasePath, 0o600);
  return databasePath;
}

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('exclusive Gatekeeper data paths', () => {
  test('uses a module-owned default root instead of the caller working directory', () => {
    const { dataRoot, databasePath } = resolveGatekeeperDataPaths({});
    assert.equal(dataRoot, path.join(moduleRoot, 'data'));
    assert.equal(databasePath, path.join(moduleRoot, 'data', 'gatekeeper.sqlite'));
  });

  test('rejects database traversal, an outside absolute path, and the shared database name', () => {
    const dataRoot = path.join(createTempDirectory(), 'gatekeeper-data');
    for (const databasePath of ['../escape.sqlite', path.join(path.dirname(dataRoot), 'outside.sqlite')]) {
      assert.throws(() => resolveGatekeeperDataPaths({
        GATEKEEPER_DATA_ROOT: dataRoot,
        GATEKEEPER_DATABASE_PATH: databasePath,
      }), /contained below/);
    }
    assert.throws(() => resolveGatekeeperDataPaths({
      GATEKEEPER_DATA_ROOT: dataRoot,
      GATEKEEPER_DATABASE_PATH: 'news-digest.db',
    }), /shared news-digest database/);
    assert.throws(() => resolveGatekeeperDataPaths({
      GATEKEEPER_DATA_ROOT: moduleRoot,
      GATEKEEPER_DATABASE_PATH: 'gatekeeper.sqlite',
    }), /dedicated data directory/);
    assert.throws(() => resolveGatekeeperDataPaths({
      GATEKEEPER_DATA_ROOT: path.join(moduleRoot, '..', 'data', 'gatekeeper-child'),
      GATEKEEPER_DATABASE_PATH: 'gatekeeper.sqlite',
    }), /inside the shared news-digest data directory/);
  });

  test('rejects backup traversal and a destination outside the data root', () => {
    const dataRoot = path.join(createTempDirectory(), 'gatekeeper-data');
    const env = { GATEKEEPER_DATA_ROOT: dataRoot };
    assert.throws(() => resolveGatekeeperBackupPath({
      ...env, GATEKEEPER_BACKUP_PATH: '../backup.sqlite',
    }, dataRoot), /contained below/);
    assert.throws(() => resolveGatekeeperBackupPath({
      ...env, GATEKEEPER_BACKUP_PATH: path.join(path.dirname(dataRoot), 'backup.sqlite'),
    }, dataRoot), /contained below/);
  });

  test('rejects a symlink escape below the exclusive root', { skip: process.platform === 'win32' }, () => {
    const directory = createTempDirectory();
    const dataRoot = path.join(directory, 'gatekeeper-data');
    const outside = path.join(directory, 'outside');
    fs.mkdirSync(dataRoot, { mode: 0o700 });
    fs.mkdirSync(outside, { mode: 0o700 });
    createPrivateStore(outside, 'escaped.sqlite');
    fs.symlinkSync(outside, path.join(dataRoot, 'escape'));
    assert.throws(() => openExistingStore({
      GATEKEEPER_DATA_ROOT: dataRoot,
      GATEKEEPER_DATABASE_PATH: 'escape/escaped.sqlite',
    }), /must not traverse a symlink/);
  });

  test('rejects a dangling database symlink before SQLite can create its outside target', {
    skip: process.platform === 'win32',
  }, () => {
    const directory = createTempDirectory();
    const dataRoot = path.join(directory, 'gatekeeper-data');
    const outsideTarget = path.join(directory, 'outside', 'created.sqlite');
    fs.mkdirSync(dataRoot, { mode: 0o700 });
    fs.mkdirSync(path.dirname(outsideTarget), { mode: 0o700 });
    const databasePath = path.join(dataRoot, 'gatekeeper.sqlite');
    fs.symlinkSync(outsideTarget, databasePath);
    assert.throws(() => preparePrivateDataParent(dataRoot, databasePath), /must not be a symlink/);
    assert.equal(fs.existsSync(outsideTarget), false);
  });

  test('openExistingStore honors the supplied env instead of process.env', () => {
    const directory = createTempDirectory();
    const processRoot = path.join(directory, 'process-root');
    const suppliedRoot = path.join(directory, 'supplied-root');
    createPrivateStore(processRoot);
    fs.mkdirSync(suppliedRoot, { mode: 0o700 });
    const priorRoot = process.env.GATEKEEPER_DATA_ROOT;
    const priorDatabase = process.env.GATEKEEPER_DATABASE_PATH;
    process.env.GATEKEEPER_DATA_ROOT = processRoot;
    process.env.GATEKEEPER_DATABASE_PATH = 'gatekeeper.sqlite';
    try {
      assert.throws(() => openExistingStore({
        GATEKEEPER_DATA_ROOT: suppliedRoot,
        GATEKEEPER_DATABASE_PATH: 'missing.sqlite',
      }), new RegExp(path.join(suppliedRoot, 'missing.sqlite').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      if (priorRoot === undefined) delete process.env.GATEKEEPER_DATA_ROOT;
      else process.env.GATEKEEPER_DATA_ROOT = priorRoot;
      if (priorDatabase === undefined) delete process.env.GATEKEEPER_DATABASE_PATH;
      else process.env.GATEKEEPER_DATABASE_PATH = priorDatabase;
    }
  });

  test('rejects a foreign SQLite database before changing its journal or schema', () => {
    const directory = createTempDirectory();
    const dataRoot = path.join(directory, 'gatekeeper-data');
    const databasePath = path.join(dataRoot, 'foreign.sqlite');
    preparePrivateDataParent(dataRoot, databasePath);
    const foreign = new Database(databasePath);
    foreign.exec('CREATE TABLE digests (id INTEGER PRIMARY KEY)');
    const originalJournalMode = foreign.pragma('journal_mode', { simple: true });
    foreign.close();
    fs.chmodSync(databasePath, 0o600);

    assert.throws(() => openExistingStore({
      GATEKEEPER_DATA_ROOT: dataRoot,
      GATEKEEPER_DATABASE_PATH: 'foreign.sqlite',
    }), /refusing a non-empty or shared database/);

    const verify = new Database(databasePath, { readonly: true });
    try {
      assert.equal(verify.pragma('journal_mode', { simple: true }), originalJournalMode);
      assert.deepEqual(verify.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'gatekeeper_%'").all(), []);
      assert.deepEqual(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'digests'").all(), [{ name: 'digests' }]);
    } finally {
      verify.close();
    }
  });

  test('rejects a versioned lookalike before changing its journal or completing its schema', () => {
    const directory = createTempDirectory();
    const dataRoot = path.join(directory, 'gatekeeper-data');
    const databasePath = path.join(dataRoot, 'lookalike.sqlite');
    preparePrivateDataParent(dataRoot, databasePath);
    const lookalike = new Database(databasePath);
    lookalike.exec(`
      CREATE TABLE gatekeeper_events (event_key TEXT PRIMARY KEY, foreign_payload TEXT);
      PRAGMA user_version = 1;
    `);
    const originalJournalMode = lookalike.pragma('journal_mode', { simple: true });
    lookalike.close();
    fs.chmodSync(databasePath, 0o600);

    assert.throws(() => openExistingStore({
      GATEKEEPER_DATA_ROOT: dataRoot,
      GATEKEEPER_DATABASE_PATH: 'lookalike.sqlite',
    }), /schema ownership check failed|schema mismatch|application marker/);

    const verify = new Database(databasePath, { readonly: true });
    try {
      assert.equal(verify.pragma('journal_mode', { simple: true }), originalJournalMode);
      assert.deepEqual(
        verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
        [{ name: 'gatekeeper_events' }],
      );
      assert.deepEqual(
        verify.prepare('PRAGMA table_info(gatekeeper_events)').all().map((column) => column.name),
        ['event_key', 'foreign_payload'],
      );
    } finally {
      verify.close();
    }
  });

  test('rejects foreign views and triggers before changing journal mode', () => {
    const directory = createTempDirectory();
    const dataRoot = path.join(directory, 'gatekeeper-data');
    const databasePath = createPrivateStore(dataRoot);
    const contaminated = new Database(databasePath);
    contaminated.pragma('journal_mode = DELETE');
    contaminated.exec(`
      CREATE VIEW foreign_gatekeeper_view AS SELECT event_key FROM gatekeeper_events;
      CREATE TRIGGER foreign_gatekeeper_trigger
      AFTER INSERT ON gatekeeper_events
      BEGIN
        DELETE FROM gatekeeper_events WHERE event_key = NEW.event_key;
      END;
    `);
    const originalJournalMode = contaminated.pragma('journal_mode', { simple: true });
    contaminated.close();

    assert.throws(() => openExistingStore({
      GATEKEEPER_DATA_ROOT: dataRoot,
      GATEKEEPER_DATABASE_PATH: 'gatekeeper.sqlite',
    }), /unexpected schema objects/);

    const verify = new Database(databasePath, { readonly: true });
    try {
      assert.equal(verify.pragma('journal_mode', { simple: true }), originalJournalMode);
      assert.deepEqual(
        verify.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'foreign_%' ORDER BY type").all(),
        [
          { type: 'trigger', name: 'foreign_gatekeeper_trigger' },
          { type: 'view', name: 'foreign_gatekeeper_view' },
        ],
      );
    } finally {
      verify.close();
    }
  });
});

describe('private backup CLI', () => {
  test('forces existing destination directories to 0700 and the backup file to 0600', {
    skip: process.platform === 'win32',
  }, () => {
    const directory = createTempDirectory();
    const dataRoot = path.join(directory, 'gatekeeper-data');
    createPrivateStore(dataRoot);
    const backupParent = path.join(dataRoot, 'backups');
    fs.mkdirSync(backupParent, { mode: 0o755 });
    fs.chmodSync(backupParent, 0o755);

    const result = spawnSync(process.execPath, ['src/backup.mjs'], {
      cwd: moduleRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GATEKEEPER_DATA_ROOT: dataRoot,
        GATEKEEPER_DATABASE_PATH: 'gatekeeper.sqlite',
        GATEKEEPER_BACKUP_PATH: 'backups/snapshot.sqlite',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const backupPath = path.join(backupParent, 'snapshot.sqlite');
    assert.equal(fs.statSync(dataRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(backupParent).mode & 0o777, 0o700);
    assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);

    const backup = new GatekeeperStore(backupPath);
    backup.close();
  });
});
