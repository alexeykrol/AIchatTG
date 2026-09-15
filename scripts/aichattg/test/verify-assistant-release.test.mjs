import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('../verify-assistant-release.mjs', import.meta.url));
const wrapper = fileURLToPath(new URL('../verify-release-source.sh', import.meta.url));
const metadataPath = 'apps/telegram-runtime/src/assistant-release.json';
const runtimePath = 'apps/telegram-runtime/src/server.mjs';
const initialRelease = { version: '2.4.36', releasedOn: '2026-09-14' };
const nextRelease = { version: '2.4.37', releasedOn: '2026-09-15' };

function git(cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Release Guard Test',
      GIT_AUTHOR_EMAIL: 'release-guard@example.invalid',
      GIT_COMMITTER_NAME: 'Release Guard Test',
      GIT_COMMITTER_EMAIL: 'release-guard@example.invalid',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

async function put(cwd, path, contents) {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), contents);
}

async function release(cwd, value) {
  await put(cwd, metadataPath, `${JSON.stringify(value)}\n`);
}

function commit(cwd) {
  git(cwd, 'add', '--all');
  git(cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'fixture');
  return git(cwd, 'rev-parse', 'HEAD');
}

async function fixture(t, value = initialRelease) {
  const cwd = await mkdtemp(join(tmpdir(), 'aichattg-assistant-release-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '--quiet');
  await put(cwd, runtimePath, 'throw new Error("Candidate code must never execute");\n');
  if (value !== null) await release(cwd, value);
  await put(cwd, 'README.md', 'Fixture documentation.\n');
  return { cwd, source: commit(cwd) };
}

function run(cwd, source, previous, command = checker) {
  const args = ['--source', source];
  if (previous !== undefined) args.push('--previous', previous);
  return spawnSync(process.execPath, [command, ...args], { cwd, encoding: 'utf8' });
}

function passed(result) {
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'passed');
  return output;
}

function rejected(result, pattern) {
  assert.equal(result.status, 1, result.stdout || result.stderr);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, '');
}

async function wrapperFixture(t) {
  const current = await fixture(t);
  await put(current.cwd, 'scripts/aichattg/assert-isolation.sh', '#!/usr/bin/env bash\necho "fixture isolation: passed"\n');
  await chmod(join(current.cwd, 'scripts/aichattg/assert-isolation.sh'), 0o755);
  await copyFile(checker, join(current.cwd, 'scripts/aichattg/verify-assistant-release.mjs'));
  await copyFile(wrapper, join(current.cwd, 'scripts/aichattg/verify-release-source.sh'));
  return { cwd: current.cwd, source: commit(current.cwd) };
}

function runWrapper(cwd, ...args) {
  return spawnSync('bash', [join(cwd, 'scripts/aichattg/verify-release-source.sh'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
  });
}

test('no previous SHA validates committed metadata without executing candidate code', async (t) => {
  const { cwd, source } = await fixture(t, nextRelease);
  const result = passed(run(cwd, source));
  assert.equal(result.version, '2.4.37');
  assert.equal(result.releasedOn, '2026-09-15');
  assert.equal(result.comparison.status, 'not_run');
  assert.match(result.comparison.reason, /No previous production SHA.*structural metadata validation only/u);
});

test('code change with an increased component version and non-backwards date passes', async (t) => {
  const { cwd, source: previous } = await fixture(t);
  await put(cwd, runtimePath, 'throw new Error("Still never execute candidate code");\n');
  await release(cwd, nextRelease);
  const result = passed(run(cwd, commit(cwd), previous));
  assert.equal(result.comparison.status, 'passed');
  assert.equal(result.comparison.assistantChanged, true);
  assert.ok(result.comparison.changedPaths.includes(runtimePath));
});

for (const version of ['2.4.37', '2.5.0', '3.0.0', '9007199254740993.0.0']) {
  test(`compares numeric component version ${version} and accepts the same release date`, async (t) => {
    const { cwd, source: previous } = await fixture(t);
    await release(cwd, { version, releasedOn: initialRelease.releasedOn });
    passed(run(cwd, commit(cwd), previous));
  });
}

for (const version of ['v2.4.37', '02.4.37', '2.04.37', '2.4.037', '2.4', '2.4.37-beta', '2.4.37+build', '2.4.37\n', 37]) {
  test(`rejects malformed or non-stable version ${JSON.stringify(version)}`, async (t) => {
    const { cwd, source } = await fixture(t, { version, releasedOn: nextRelease.releasedOn });
    rejected(run(cwd, source), /strict stable SemVer/u);
  });
}

for (const releasedOn of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-09-00', '0000-01-01', '2026-9-15', '2026-09-15T00:00:00Z', 20260915]) {
  test(`rejects malformed or impossible release date ${JSON.stringify(releasedOn)}`, async (t) => {
    const { cwd, source } = await fixture(t, { version: '2.4.37', releasedOn });
    rejected(run(cwd, source), /real ISO calendar date/u);
  });
}

test('accepts a real leap day without comparing to the wall clock', async (t) => {
  const { cwd, source } = await fixture(t, { version: '0.0.0', releasedOn: '2000-02-29' });
  passed(run(cwd, source));
});

for (const value of [[], null, {}, { version: '2.4.37' }, { ...nextRelease, unexpected: true }]) {
  test(`rejects invalid metadata schema ${JSON.stringify(value)}`, async (t) => {
    const { cwd } = await fixture(t);
    await release(cwd, value);
    rejected(run(cwd, commit(cwd)), /exactly version and releasedOn/u);
  });
}

test('rejects malformed committed JSON even if the working copy is corrected', async (t) => {
  const { cwd } = await fixture(t);
  await put(cwd, metadataPath, '{"version":');
  const source = commit(cwd);
  await release(cwd, nextRelease);
  rejected(run(cwd, source), /valid JSON/u);
});

test('ignores uncommitted metadata when validating an exact Git source', async (t) => {
  const { cwd, source } = await fixture(t);
  await release(cwd, nextRelease);
  assert.equal(passed(run(cwd, source)).version, initialRelease.version);
});

test('rejects absent current metadata', async (t) => {
  const { cwd, source } = await fixture(t, null);
  rejected(run(cwd, source), /source is missing/u);
});

test('rejects a symbolic link instead of a metadata blob', async (t) => {
  const { cwd } = await fixture(t, null);
  await symlink('other-release.json', join(cwd, metadataPath));
  rejected(run(cwd, commit(cwd)), /must be a regular file/u);
});

for (const path of [
  runtimePath,
  'apps/telegram-runtime/package.json',
  'apps/telegram-runtime/package-lock.json',
  'apps/telegram-runtime/npm-shrinkwrap.json',
  'packages/telegram-core/src/core.mjs',
  'packages/telegram-core/package.json',
  'packages/telegram-core/package-lock.json',
  'packages/telegram-core/npm-shrinkwrap.json',
  'infra/aichattg/Dockerfile.telegram-runtime',
]) {
  test(`requires a version bump for Assistant-affecting path ${path}`, async (t) => {
    const { cwd, source: previous } = await fixture(t);
    await put(cwd, path, 'Changed fixture source.\n');
    rejected(run(cwd, commit(cwd), previous), /require a greater version/u);
  });
}

test('detects removed Assistant source files', async (t) => {
  const { cwd, source: previous } = await fixture(t);
  await rm(join(cwd, runtimePath));
  rejected(run(cwd, commit(cwd), previous), /require a greater version/u);
});

test('rejects a version rollback', async (t) => {
  const { cwd, source: previous } = await fixture(t);
  await release(cwd, { ...nextRelease, version: '2.4.35' });
  rejected(run(cwd, commit(cwd), previous), /require a greater version/u);
});

test('rejects a release date rollback even when the version increases', async (t) => {
  const { cwd, source: previous } = await fixture(t);
  await release(cwd, { ...nextRelease, releasedOn: '2026-09-13' });
  rejected(run(cwd, commit(cwd), previous), /must not move backwards/u);
});

test('allows documentation-only changes without a component version bump', async (t) => {
  const { cwd, source: previous } = await fixture(t);
  await put(cwd, 'docs/release.md', 'Documentation only.\n');
  const result = passed(run(cwd, commit(cwd), previous));
  assert.equal(result.comparison.assistantChanged, false);
  assert.deepEqual(result.comparison.changedPaths, []);
});

test('allows bootstrap restoration from a production commit with no metadata', async (t) => {
  const { cwd, source: previous } = await fixture(t, null);
  await release(cwd, nextRelease);
  const result = passed(run(cwd, commit(cwd), previous));
  assert.equal(result.comparison.status, 'not_run');
  assert.equal(result.comparison.previousSource, previous);
  assert.match(result.comparison.reason, /Bootstrap restoration/u);
});

test('does not treat malformed previous metadata as a bootstrap', async (t) => {
  const { cwd, source: previous } = await fixture(t, { version: 'bad', releasedOn: '2026-09-14' });
  await release(cwd, nextRelease);
  rejected(run(cwd, commit(cwd), previous), /previous version/u);
});

test('rejects an exact source SHA that is not current HEAD', async (t) => {
  const { cwd, source } = await fixture(t);
  await put(cwd, 'docs/release.md', 'A later commit.\n');
  commit(cwd);
  rejected(run(cwd, source), /source SHA mismatch/u);
});

test('requires exact current and previous SHAs rather than branch names or abbreviations', async (t) => {
  const { cwd, source } = await fixture(t);
  rejected(run(cwd, 'HEAD'), /source must be an exact/u);
  rejected(run(cwd, source.slice(0, 7)), /source must be an exact/u);
  rejected(run(cwd, source, 'HEAD'), /previous must be an exact/u);
  rejected(run(cwd, source, ''), /previous must be an exact/u);
});

test('rejects missing previous commits instead of silently skipping the comparison', async (t) => {
  const { cwd, source } = await fixture(t);
  rejected(run(cwd, source, '0'.repeat(40)), /Git cat-file check failed/u);
});

test('rejects object hashes that identify a blob rather than a commit', async (t) => {
  const { cwd, source } = await fixture(t);
  const blob = git(cwd, 'rev-parse', `${source}:${metadataPath}`);
  rejected(run(cwd, source, blob), /previous must identify a commit/u);
});

test('wrapper preserves its one-SHA interface and runs isolation before the metadata gate', async (t) => {
  const { cwd, source } = await wrapperFixture(t);
  const result = runWrapper(cwd, source);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture isolation: passed\n\{"status":"passed"/u);
  assert.match(result.stdout, /No previous production SHA/u);
  assert.match(result.stdout, /release source: passed/u);
});

test('wrapper forwards the optional production SHA and rejects a missing bump', async (t) => {
  const { cwd, source: previous } = await wrapperFixture(t);
  await put(cwd, runtimePath, 'Changed runtime source.\n');
  const result = runWrapper(cwd, commit(cwd), previous);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /require a greater version/u);
  assert.doesNotMatch(result.stdout, /release source: passed/u);
});

test('wrapper retains the exact HEAD check', async (t) => {
  const { cwd, source } = await wrapperFixture(t);
  await put(cwd, 'docs/release.md', 'A later commit.\n');
  commit(cwd);
  const result = runWrapper(cwd, source);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release source SHA mismatch/u);
  assert.equal(result.stdout, '');
});

for (const path of ['README.md', 'untracked.txt']) {
  test(`wrapper retains the clean-worktree gate for ${path}`, async (t) => {
    const { cwd, source } = await wrapperFixture(t);
    await put(cwd, path, 'Dirty worktree.\n');
    const result = runWrapper(cwd, source);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /worktree must be clean, including untracked files/u);
    assert.equal(result.stdout, '');
  });
}

test('wrapper retains isolation rejection without printing a passed release result', async (t) => {
  const { cwd } = await wrapperFixture(t);
  await put(cwd, 'scripts/aichattg/assert-isolation.sh', '#!/usr/bin/env bash\necho "fixture isolation: failed" >&2\nexit 1\n');
  const result = runWrapper(cwd, commit(cwd));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixture isolation: failed/u);
  assert.equal(result.stdout, '');
});

test('wrapper rejects invalid arguments without weakening the original usage gate', async (t) => {
  const { cwd, source } = await wrapperFixture(t);
  for (const args of [[], ['HEAD'], [source, 'HEAD'], [source, source, source]]) {
    const result = runWrapper(cwd, ...args);
    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /usage:/u);
  }
});
