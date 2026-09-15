import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertArchivedCore, assertChildSuccess, assertExactBytes, assertHistoricalCounts, FROZEN_REF, GUARD,
  offlineEnvironment, parseArgs, readParentArtifacts } from '../scripts/verify-frozen-routing-v1.mjs';

const runner = fileURLToPath(new URL('../scripts/verify-frozen-routing-v1.mjs', import.meta.url));

test('historical routing mechanics run automatically against exact detached frozen source', { timeout: 65_000 }, () => {
  const result = spawnSync(process.execPath, [runner], {
    encoding: 'utf8', env: offlineEnvironment(), timeout: 63_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes(FROZEN_REF));
  assert.match(result.stdout, /# tests 29\b/u);
  assert.match(result.stdout, /# pass 23\b/u);
  assert.match(result.stdout, /# fail 0\b/u);
  assert.match(result.stdout, /# skipped 6\b/u);
  assert.equal((result.stdout.match(/# SKIP immutable local parent artifacts unavailable/gu) || []).length, 6);
});

test('live modes, relative parent paths and additional arguments are rejected', () => {
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(parseArgs(['--parent-dir', '/tmp/explicit-parent']), { parentDir: '/tmp/explicit-parent' });
  for (const args of [['--lease', '/tmp/lease.json'], ['--parent-dir', 'relative'],
    ['--parent-dir'], ['--parent-dir', '/tmp/parent', '--live'], ['--fetch'], ['--parent-dir', '/tmp/\0parent']]) {
    assert.throws(() => parseArgs(args), /frozen_routing:usage/u);
  }
  const result = spawnSync(process.execPath, [runner, '--lease', '/tmp/not-a-lease'], {
    env: offlineEnvironment(), encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /frozen_routing:usage/u);
});

test('source byte drift and failed or timed-out child tests cannot become passes', () => {
  assert.doesNotThrow(() => assertExactBytes(Buffer.from('frozen'), Buffer.from('frozen'), 'fixture'));
  assert.throws(() => assertExactBytes(Buffer.from('current'), Buffer.from('frozen'), 'fixture'), /source_changed/u);
  assert.doesNotThrow(() => assertChildSuccess({ status: 0, signal: null }, 'child'));
  for (const result of [{ status: 1 }, { status: 0, error: new Error('timeout') }, { status: null, signal: 'SIGTERM' }]) {
    assert.throws(() => assertChildSuccess(result, 'child'), /child_failed/u);
  }
  const counts = '# tests 29\n# pass 23\n# fail 0\n# cancelled 0\n# skipped 6\n';
  assert.doesNotThrow(() => assertHistoricalCounts(counts, false));
  assert.throws(() => assertHistoricalCounts(counts, true), /historical_count/u);
  assert.throws(() => assertHistoricalCounts(counts.replace('# pass 23', '# pass 22'), false), /historical_count/u);
  assert.throws(() => assertHistoricalCounts('', false), /historical_count/u);
});

test('inherited provider, Node and Git configuration is absent from test environment', () => {
  const environment = offlineEnvironment('/tmp/frozen-source');
  assert.deepEqual(Object.keys(environment).sort(), ['PATH', 'LANG', 'LC_ALL', 'TZ',
    'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'FROZEN_ROUTING_TEST_ROOT'].sort());
  assert.equal(environment.GIT_CONFIG_GLOBAL, '/dev/null');
});

test('offline guard blocks fetch, sockets, DNS and live credentials before access', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync, openSync, createReadStream } from 'node:fs';
    import { readFile, open } from 'node:fs/promises';
    import { connect } from 'node:net';
    import { request } from 'node:https';
    import { lookup } from 'node:dns';
    for (const action of [() => fetch('https://invalid.test'), () => connect(443, 'invalid.test'),
      () => request('https://invalid.test'), () => lookup('invalid.test', () => {})]) {
      assert.throws(action, /FROZEN_ROUTING_NETWORK_FORBIDDEN/);
    }
    const credential = '/Users/alexeykrolmini/Code/AIchatTG/apps/telegram-runtime/.env.provider.local';
    for (const action of [() => readFileSync(credential), () => openSync(credential, 'r'), () => createReadStream(credential)]) {
      assert.throws(action, /FROZEN_ROUTING_CREDENTIAL_READ_FORBIDDEN/);
    }
    await assert.rejects(readFile(credential), /FROZEN_ROUTING_CREDENTIAL_READ_FORBIDDEN/);
    await assert.rejects(open(credential), /FROZEN_ROUTING_CREDENTIAL_READ_FORBIDDEN/);
  `;
  const result = spawnSync(process.execPath, ['--require', GUARD, '--input-type=module', '-e', source], {
    env: offlineEnvironment(), encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('optional artifacts reject missing or changed bytes and never accept symlink directories', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-routing-artifact-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, 'parent'); mkdirSync(parent);
  assert.throws(() => readParentArtifacts(parent));
  writeFileSync(join(parent, 'manifest.json'), '{}');
  assert.throws(() => readParentArtifacts(parent), /parent_file_changed/u);
  const link = join(root, 'alias'); symlinkSync(parent, link, 'dir');
  assert.throws(() => readParentArtifacts(link), /parent_directory/u);
});

test('core package resolution rejects a current or foreign dependency tree', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-routing-core-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archived = join(root, 'snapshot'), foreign = join(root, 'foreign-core');
  mkdirSync(join(archived, 'apps/telegram-runtime/node_modules/@aichattg'), { recursive: true });
  mkdirSync(join(archived, 'packages/telegram-core/src'), { recursive: true });
  writeFileSync(join(archived, 'apps/telegram-runtime/package.json'), '{}');
  writeFileSync(join(archived, 'packages/telegram-core/src/index.mjs'), '');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'package.json'), '{"exports":"./index.mjs"}');
  writeFileSync(join(foreign, 'index.mjs'), '');
  symlinkSync(foreign, join(archived, 'apps/telegram-runtime/node_modules/@aichattg/telegram-core'), 'dir');
  assert.throws(() => assertArchivedCore(archived), /core_outside_frozen_source/u);
});
