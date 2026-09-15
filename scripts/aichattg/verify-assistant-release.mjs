#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXACT_SHA = /^[0-9a-f]{40}$/u;
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const RELEASE_PATH = 'apps/telegram-runtime/src/assistant-release.json';
const ASSISTANT_PATHS = [
  'apps/telegram-runtime/src',
  'apps/telegram-runtime/package.json',
  'apps/telegram-runtime/package-lock.json',
  'apps/telegram-runtime/npm-shrinkwrap.json',
  'packages/telegram-core/src',
  'packages/telegram-core/package.json',
  'packages/telegram-core/package-lock.json',
  'packages/telegram-core/npm-shrinkwrap.json',
  'infra/aichattg/Dockerfile.telegram-runtime',
];

function fail(message) {
  throw new Error(`assistant release rejected: ${message}`);
}

function git(cwd, args) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail(`Git ${args[0]} check failed`);
  return result.stdout;
}

function exactCommit(cwd, sha, label) {
  if (typeof sha !== 'string' || !EXACT_SHA.test(sha)) {
    fail(`${label} must be an exact 40-character lowercase Git SHA`);
  }
  if (git(cwd, ['cat-file', '-t', sha]).trim() !== 'commit') {
    fail(`${label} must identify a commit`);
  }
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function metadata(cwd, sha, label, optional = false) {
  const entry = git(cwd, ['ls-tree', '-z', sha, '--', RELEASE_PATH]);
  if (!entry) {
    if (optional) return null;
    fail(`${label} is missing ${RELEASE_PATH}`);
  }
  if (!/^100(?:644|755) blob [0-9a-f]{40}\t/u.test(entry)) {
    fail(`${label} release metadata must be a regular file`);
  }

  let value;
  try {
    // Read the exact committed blob as data; never import or execute candidate code.
    value = JSON.parse(git(cwd, ['show', `${sha}:${RELEASE_PATH}`]));
  } catch {
    fail(`${label} release metadata must contain valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'releasedOn,version') {
    fail(`${label} release metadata must contain exactly version and releasedOn`);
  }
  if (typeof value.version !== 'string' || !STABLE_VERSION.test(value.version)) {
    fail(`${label} version must be strict stable SemVer MAJOR.MINOR.PATCH`);
  }
  if (!isRealDate(value.releasedOn)) {
    fail(`${label} releasedOn must be a real ISO calendar date YYYY-MM-DD`);
  }
  return value;
}

function isGreaterVersion(candidate, previous) {
  const current = candidate.split('.').map(BigInt);
  const baseline = previous.split('.').map(BigInt);
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== baseline[index]) return current[index] > baseline[index];
  }
  return false;
}

export function verifyAssistantRelease({ source, previous, cwd = process.cwd() }) {
  const repoRoot = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  exactCommit(repoRoot, source, 'source');
  const head = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  if (head !== source) fail(`source SHA mismatch: expected ${source}, got ${head}`);
  const release = metadata(repoRoot, source, 'source');
  const result = { status: 'passed', source, metadataPath: RELEASE_PATH, ...release };

  if (previous === undefined) {
    return {
      ...result,
      comparison: {
        status: 'not_run',
        reason: 'No previous production SHA supplied; structural metadata validation only.',
      },
    };
  }

  exactCommit(repoRoot, previous, 'previous');
  const baseline = metadata(repoRoot, previous, 'previous', true);
  if (!baseline) {
    return {
      ...result,
      comparison: {
        status: 'not_run',
        previousSource: previous,
        reason: 'Bootstrap restoration: previous production source has no Assistant release metadata.',
      },
    };
  }

  const changedPaths = git(repoRoot, [
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z',
    previous, source, '--', ...ASSISTANT_PATHS,
  ]).split('\0').filter(Boolean);
  if (changedPaths.length > 0) {
    if (!isGreaterVersion(release.version, baseline.version)) {
      fail(`Assistant-affecting changes require a greater version than ${baseline.version}; got ${release.version}`);
    }
    if (release.releasedOn < baseline.releasedOn) {
      fail(`releasedOn must not move backwards from ${baseline.releasedOn}; got ${release.releasedOn}`);
    }
  }

  return {
    ...result,
    comparison: {
      status: 'passed',
      previousSource: previous,
      previousVersion: baseline.version,
      previousReleasedOn: baseline.releasedOn,
      assistantChanged: changedPaths.length > 0,
      changedPaths,
    },
  };
}

function parseArguments(argv) {
  if ((argv.length !== 2 && argv.length !== 4) || argv[0] !== '--source'
    || (argv.length === 4 && argv[2] !== '--previous')) {
    throw new Error('usage: verify-assistant-release.mjs --source <exact-SHA> [--previous <production-SHA>]');
  }
  return { source: argv[1], ...(argv.length === 4 ? { previous: argv[3] } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(verifyAssistantRelease(parseArguments(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
