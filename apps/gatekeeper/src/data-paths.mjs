import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DATA_ROOT = path.join(MODULE_ROOT, 'data');
const PIPELINE_DATA_ROOT = path.resolve(MODULE_ROOT, '..', 'data');
const PIPELINE_DATABASE_PATH = path.join(PIPELINE_DATA_ROOT, 'news-digest.db');

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function lstatIfPresent(candidate) {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertContained(dataRoot, candidate, label) {
  if (candidate === dataRoot || !isWithin(dataRoot, candidate)) {
    throw new Error(`${label} must be contained below GATEKEEPER_DATA_ROOT`);
  }
}

function resolveConfiguredFile(dataRoot, value, fallback, label) {
  const candidate = value
    ? path.resolve(dataRoot, String(value))
    : path.join(dataRoot, fallback);
  assertContained(dataRoot, candidate, label);
  return candidate;
}

function assertNotSharedDatabase(dataRoot, databasePath) {
  if (isWithin(dataRoot, MODULE_ROOT) || (isWithin(MODULE_ROOT, dataRoot) && !isWithin(DEFAULT_DATA_ROOT, dataRoot))) {
    throw new Error('GATEKEEPER_DATA_ROOT must be a dedicated data directory, not a code or project directory');
  }
  if (isWithin(PIPELINE_DATA_ROOT, dataRoot)) {
    throw new Error('GATEKEEPER_DATA_ROOT must not be inside the shared news-digest data directory');
  }
  if (databasePath === PIPELINE_DATABASE_PATH || path.basename(databasePath).toLowerCase() === 'news-digest.db') {
    throw new Error('Gatekeeper refuses to open the shared news-digest database');
  }
}

export function resolveGatekeeperDataPaths(env = process.env) {
  const dataRoot = env.GATEKEEPER_DATA_ROOT
    ? path.resolve(MODULE_ROOT, String(env.GATEKEEPER_DATA_ROOT))
    : DEFAULT_DATA_ROOT;
  const databasePath = resolveConfiguredFile(
    dataRoot,
    env.GATEKEEPER_DATABASE_PATH,
    'gatekeeper.sqlite',
    'GATEKEEPER_DATABASE_PATH',
  );
  assertNotSharedDatabase(dataRoot, databasePath);
  return { dataRoot, databasePath };
}

export function resolveGatekeeperBackupPath(env = process.env, dataRoot = resolveGatekeeperDataPaths(env).dataRoot) {
  const raw = String(env.GATEKEEPER_BACKUP_PATH || '').trim();
  if (!raw) throw new Error('GATEKEEPER_BACKUP_PATH is required');
  const destination = resolveConfiguredFile(dataRoot, raw, '', 'GATEKEEPER_BACKUP_PATH');
  const { databasePath } = resolveGatekeeperDataPaths(env);
  if (destination === databasePath) throw new Error('backup destination must differ from the Gatekeeper database');
  return destination;
}

function existingRoot(dataRoot) {
  if (!fs.existsSync(dataRoot)) throw new Error(`Gatekeeper data root does not exist: ${dataRoot}`);
  const rootStat = fs.lstatSync(dataRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('GATEKEEPER_DATA_ROOT must be a real directory, not a symlink');
  }
  if ((rootStat.mode & 0o077) !== 0) {
    throw new Error('GATEKEEPER_DATA_ROOT permissions must not allow group or other access');
  }
  return fs.realpathSync(dataRoot);
}

function assertSafeComponents(dataRoot, candidate, { requireTarget = false } = {}) {
  assertContained(dataRoot, candidate, 'Gatekeeper data path');
  const realRoot = existingRoot(dataRoot);
  const relative = path.relative(dataRoot, candidate);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = dataRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      if (requireTarget || index < segments.length - 1) {
        throw new Error(`Gatekeeper data path does not exist: ${current}`);
      }
      break;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Gatekeeper data path must not traverse a symlink: ${current}`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`Gatekeeper data parent is not a directory: ${current}`);
    }
    if (stat.isDirectory() && (stat.mode & 0o077) !== 0) {
      throw new Error(`Gatekeeper data directory permissions must not allow group or other access: ${current}`);
    }
    const realCurrent = fs.realpathSync(current);
    if (!isWithin(realRoot, realCurrent)) throw new Error('Gatekeeper data path escapes GATEKEEPER_DATA_ROOT');
  }
  return realRoot;
}

export function preparePrivateDataParent(dataRoot, targetPath) {
  assertContained(dataRoot, targetPath, 'Gatekeeper data path');
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(dataRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('GATEKEEPER_DATA_ROOT must be a real directory, not a symlink');
  }
  fs.chmodSync(dataRoot, 0o700);
  const realRoot = fs.realpathSync(dataRoot);
  const parent = path.dirname(targetPath);
  const relativeParent = path.relative(dataRoot, parent);
  let current = dataRoot;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Gatekeeper data parent must be a real directory: ${current}`);
      }
    } else {
      fs.mkdirSync(current, { mode: 0o700 });
    }
    fs.chmodSync(current, 0o700);
    if (!isWithin(realRoot, fs.realpathSync(current))) {
      throw new Error('Gatekeeper data parent escapes GATEKEEPER_DATA_ROOT');
    }
  }
  const targetStat = lstatIfPresent(targetPath);
  if (targetStat?.isSymbolicLink()) {
    throw new Error(`Gatekeeper data file must not be a symlink: ${targetPath}`);
  }
}

export function assertExistingPrivateDataFile(dataRoot, targetPath) {
  assertSafeComponents(dataRoot, targetPath, { requireTarget: true });
  const stat = fs.statSync(targetPath);
  if (!stat.isFile()) throw new Error(`Gatekeeper data path is not a file: ${targetPath}`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Gatekeeper data file permissions must not allow group or other access: ${targetPath}`);
  }
}

export function enforcePrivateFileMode(targetPath) {
  if (fs.lstatSync(targetPath).isSymbolicLink()) {
    throw new Error(`Gatekeeper data file must not be a symlink: ${targetPath}`);
  }
  fs.chmodSync(targetPath, 0o600);
  if ((fs.statSync(targetPath).mode & 0o777) !== 0o600) {
    throw new Error(`failed to enforce private file permissions: ${targetPath}`);
  }
}
