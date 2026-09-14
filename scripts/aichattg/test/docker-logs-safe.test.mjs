import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('../docker-logs-safe.sh', import.meta.url).pathname;

async function withFakeTimeout(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'aichattg-docker-logs-test-'));
  const capture = join(directory, 'timeout-arguments');
  const timeout = join(directory, 'timeout');
  const docker = join(directory, 'docker');

  await writeFile(timeout, '#!/bin/bash\nprintf "%s\\n" "$@" > "$CAPTURE"\nexit "${FAKE_TIMEOUT_STATUS:-0}"\n');
  await writeFile(docker, '#!/bin/bash\nexit 99\n');
  await chmod(timeout, 0o755);
  await chmod(docker, 0o755);

  try {
    await callback({
      capture,
      env: {
        ...process.env,
        CAPTURE: capture,
        PATH: directory,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('finite log reads are bounded by time, volume, and period', async () => {
  await withFakeTimeout(async ({ capture, env }) => {
    const result = spawnSync('/bin/bash', [script, 'aichattg-runtime'], { encoding: 'utf8', env });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(capture, 'utf8')).trim().split('\n'), [
      '--signal=TERM', '--kill-after=5s', '20s', 'docker', 'logs', '--tail', '200', '--since', '10m', 'aichattg-runtime',
    ]);
  });
});

test('follow reads retain a hard five-minute deadline', async () => {
  await withFakeTimeout(async ({ capture, env }) => {
    const result = spawnSync('/bin/bash', [script, 'aichattg-runtime', '--follow'], { encoding: 'utf8', env });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(capture, 'utf8')).trim().split('\n'), [
      '--signal=TERM', '--kill-after=5s', '5m', 'docker', 'logs', '--follow', '--tail', '100', '--since', '10m', 'aichattg-runtime',
    ]);
  });
});

test('a timeout remains visible and asks the operator not to retry', async () => {
  await withFakeTimeout(async ({ env }) => {
    const result = spawnSync('/bin/bash', [script, 'aichattg-runtime'], {
      encoding: 'utf8',
      env: { ...env, FAKE_TIMEOUT_STATUS: '124' },
    });

    assert.equal(result.status, 124);
    assert.match(result.stderr, /timed out after 20s/);
    assert.match(result.stderr, /do not retry in a loop/);
  });
});

test('malformed or cross-project input is rejected before Docker is called', async () => {
  await withFakeTimeout(async ({ capture, env }) => {
    const malformed = spawnSync('/bin/bash', [script, '--bad-container'], { encoding: 'utf8', env });
    const foreign = spawnSync('/bin/bash', [script, 'news-substack-publisher'], { encoding: 'utf8', env });

    assert.equal(malformed.status, 64);
    assert.equal(foreign.status, 64);
    await assert.rejects(readFile(capture, 'utf8'));
  });
});
