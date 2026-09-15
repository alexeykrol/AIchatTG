#!/usr/bin/env node
/** Offline historical mechanics tests, never a new measurement or live lease. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FROZEN_REF = '5600afd98d69da5e98edf3a7e9abacebff7406af';
const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
export const GUARD = fileURLToPath(new URL('./lib/frozen-routing-offline-guard.cjs', import.meta.url));
const RUNTIME = 'apps/telegram-runtime';
const NAMES = ['routing-only-eval', 'routing-live-collector-v1', 'routing-live-continuation-v1'];
const TESTS = NAMES.map((name) => `${RUNTIME}/test/${name}.test.mjs`);
const CONTROL_FILES = [
  ...NAMES.map((name) => [`${RUNTIME}/scripts/${name}.mjs`, `${RUNTIME}/scripts/${name}.mjs`]),
  ...NAMES.map((name) => [`${RUNTIME}/historical-checks/${name}.check.mjs`, `${RUNTIME}/test/${name}.test.mjs`]),
  ['docs/evaluation/routing-only-v1.json', 'docs/evaluation/routing-only-v1.json'],
];
export const PARENT_HASHES = Object.freeze({
  'manifest.json': 'ea84705079d09b88133ecfcd6da9a28293d0fb654202ed7e59a6161191d9aa45',
  'journal.jsonl': 'd21ce362f25bfe6b91edc4a86e6af596b5e227efc29a33588b282f2f5e1406b4',
  'capture.json': '8b9e3e31620e46e727155c025d6cab22a3426d9864273063e07b7525b317c918',
  'receipt.json': '118e228387cbcde52743ef7801cc0be8cc8353286243b3ecca76aa4c2e0354e5',
  'comparison.json': 'acdcd2e4010fcc07d4b3b16b6a40b5b63c08966130fd233fef76b948c6e5a89d',
  'cost-summary.json': '32e0b1bb2deabf7111650e442f3c5d4fdd8b82b89d08ce747e2de49fe4e98d57',
});
const fail = (code) => { throw new Error(`frozen_routing:${code}`); };
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function parseArgs(args) {
  if (!args.length) return {};
  if (args.length !== 2 || args[0] !== '--parent-dir' || !isAbsolute(args[1])
    || args[1].includes('\0')) fail('usage: [--parent-dir ABSOLUTE_DIRECTORY]');
  return { parentDir: args[1] };
}

/** Do not inherit provider credentials, NODE_OPTIONS, Git overrides or paid configuration. */
export function offlineEnvironment(frozenRoot) {
  return { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    ...(frozenRoot ? { FROZEN_ROUTING_TEST_ROOT: frozenRoot } : {}) };
}

export function assertExactBytes(actual, expected, label) {
  if (!Buffer.isBuffer(actual) || !Buffer.isBuffer(expected) || !actual.equals(expected)) {
    fail(`source_changed:${label}`);
  }
}

export function assertChildSuccess(result, label) {
  if (result.error || result.signal || result.status !== 0) fail(`${label}_failed`);
}

export function assertHistoricalCounts(output, hasParent) {
  const expected = { tests: 29, pass: hasParent ? 29 : 23, fail: 0, cancelled: 0, skipped: hasParent ? 0 : 6 };
  for (const [key, count] of Object.entries(expected)) {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    if (matches.length !== 1 || Number(matches[0][1]) !== count) fail(`historical_count:${key}`);
  }
}

export function readParentArtifacts(parentDir) {
  if (!isAbsolute(parentDir) || realpathSync(parentDir) !== resolve(parentDir)
    || !lstatSync(parentDir).isDirectory() || lstatSync(parentDir).isSymbolicLink()) fail('parent_directory');
  const files = new Map();
  for (const [name, expected] of Object.entries(PARENT_HASHES)) {
    const path = join(parentDir, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) fail('parent_file');
    const bytes = readFileSync(path);
    if (hash(bytes) !== expected) fail(`parent_file_changed:${name}`);
    files.set(name, bytes);
  }
  return files;
}

export function assertArchivedCore(frozenRoot) {
  const require = createRequire(join(frozenRoot, RUNTIME, 'package.json'));
  const actual = realpathSync(require.resolve('@aichattg/telegram-core'));
  const expected = realpathSync(join(frozenRoot, 'packages/telegram-core/src/index.mjs'));
  if (actual !== expected) fail('core_outside_frozen_source');
  return actual;
}

export function runFrozenRouting({ parentDir } = {}) {
  // Reserve five seconds of the total sixty-second deadline for owned cleanup.
  const started = Date.now(), deadline = started + 60_000, workDeadline = deadline - 5_000;
  const remaining = (end = workDeadline) => {
    const ms = end - Date.now();
    if (ms <= 0) fail('invocation_deadline');
    return ms;
  };
  const git = (cwd, args, end = workDeadline) => execFileSync('git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], {
      cwd, env: offlineEnvironment(), timeout: remaining(end), maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  // Missing local Git history is an error. There is deliberately no fetch path.
  git(ROOT, ['cat-file', '-e', `${FROZEN_REF}^{commit}`]);
  for (const [current, historical] of CONTROL_FILES) {
    const path = join(ROOT, current);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail(`source_not_regular:${current}`);
    assertExactBytes(readFileSync(path), git(ROOT, ['show', `${FROZEN_REF}:${historical}`]), current);
  }
  const parentFiles = parentDir ? readParentArtifacts(parentDir) : null;
  const ownerRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'aichattg-frozen-routing-v1-')));
  const frozenRoot = join(ownerRoot, 'source');
  const marker = join(ownerRoot, 'owner.json');
  const markerBytes = Buffer.from(JSON.stringify({ token: randomUUID(), frozenRoot, ref: FROZEN_REF }));
  writeFileSync(marker, markerBytes, { flag: 'wx', mode: 0o600 });
  let registered = false, result, failure;
  try {
    git(ROOT, ['worktree', 'add', '--detach', frozenRoot, FROZEN_REF]);
    registered = true;
    if (realpathSync(frozenRoot) !== frozenRoot
      || git(frozenRoot, ['rev-parse', 'HEAD']).toString().trim() !== FROZEN_REF) fail('frozen_git_identity');
  } catch (error) { failure = error; }
  try {
    if (failure) throw failure;
    if (!registered) fail('worktree_unavailable');
    const detached = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
      cwd: frozenRoot, env: offlineEnvironment(), timeout: remaining(), encoding: 'utf8',
    });
    if (detached.error || detached.signal || detached.status !== 1 || detached.stdout.trim()) fail('frozen_head_not_detached');
    // Compare every materialized tracked file, not only the advertised dependencies.
    git(frozenRoot, ['diff', '--exit-code', FROZEN_REF, '--']);
    const paths = git(frozenRoot, ['ls-files', '-z']).toString().split('\0').filter(Boolean);
    for (const path of paths) {
      if (path.split('/').some((part) => part === 'node_modules' || /^\.env(?:\.|$)/u.test(part))) fail('forbidden_snapshot_path');
      if (lstatSync(join(frozenRoot, path)).isSymbolicLink()) fail('snapshot_symlink');
    }
    const moduleRoot = join(frozenRoot, RUNTIME, 'node_modules/@aichattg');
    mkdirSync(moduleRoot, { recursive: true, mode: 0o700 });
    symlinkSync(join(frozenRoot, 'packages/telegram-core'), join(moduleRoot, 'telegram-core'), 'dir');
    assertArchivedCore(frozenRoot);
    if (parentFiles) {
      const target = join(frozenRoot, '.handoffs/local/routing-live-collector-v1');
      mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const [name, bytes] of parentFiles) writeFileSync(join(target, name), bytes, { flag: 'wx', mode: 0o600 });
    }
    result = spawnSync(process.execPath, ['--require', GUARD, '--test', '--test-reporter=tap', ...TESTS], {
      cwd: frozenRoot, env: offlineEnvironment(frozenRoot), encoding: 'utf8', timeout: remaining(),
      maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assertChildSuccess(result, 'historical_tests');
    assertHistoricalCounts(result.stdout, Boolean(parentFiles));
    git(frozenRoot, ['diff', '--exit-code', FROZEN_REF, '--']);
    if (parentFiles) {
      for (const [name, bytes] of parentFiles) {
        assertExactBytes(readFileSync(join(parentDir, name)), bytes, `original_parent:${name}`);
        assertExactBytes(readFileSync(join(frozenRoot, '.handoffs/local/routing-live-collector-v1', name)), bytes, `copied_parent:${name}`);
      }
    }
  } catch (error) { failure = error; }
  finally {
    // Never erase an unverified location, and never replace worktree removal with broad rm.
    if (realpathSync(ownerRoot) !== ownerRoot || !readFileSync(marker).equals(markerBytes)
      || dirname(frozenRoot) !== ownerRoot) fail('cleanup_ownership');
    if (registered) {
      if (!lstatSync(join(frozenRoot, '.git')).isFile()
        || git(frozenRoot, ['rev-parse', '--show-toplevel'], deadline).toString().trim() !== frozenRoot) fail('cleanup_worktree_identity');
      git(ROOT, ['worktree', 'remove', '--force', frozenRoot], deadline);
    } else if (existsSync(frozenRoot)) fail(`cleanup_requires_review:${frozenRoot}`);
    rmSync(ownerRoot, { recursive: true, force: false });
  }
  if (failure) {
    if (result?.stdout) failure.testOutput = result.stdout;
    throw failure;
  }
  return { source: FROZEN_REF, parentArtifacts: parentFiles ? 'validated' : 'not_run',
    stdout: result.stdout, stderr: result.stderr, elapsedMs: Date.now() - started };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = runFrozenRouting(parseArgs(process.argv.slice(2)));
    process.stdout.write(`# Frozen source ${result.source}; parent artifacts ${result.parentArtifacts}; no live measurement\n${result.stdout}`);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (error) {
    if (error.testOutput) process.stdout.write(error.testOutput);
    process.stderr.write(`frozen_routing:failed:${error.message}\n`);
    process.exitCode = 1;
  }
}
