#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256 = /^[0-9a-f]{64}$/u;
const SHA1 = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9._-]{8,128}$/u;

function fail(message) {
  throw new Error(`migration bundle rejected: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has an unsupported or missing field`);
  }
}

function string(value, label, matcher) {
  if (typeof value !== 'string' || !matcher.test(value)) fail(`${label} is invalid`);
  return value;
}

async function regularFile(file, label) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular non-symlink file`);
  return stat;
}

async function inspectJsonl(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  let newlines = 0;
  let lastByte = null;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
    for (const byte of chunk) if (byte === 10) newlines += 1;
    if (chunk.length > 0) lastByte = chunk[chunk.length - 1];
  }
  if (bytes === 0) fail('payload may not be empty');
  return {
    sha256: hash.digest('hex'),
    recordCount: newlines + (lastByte === 10 ? 0 : 1),
  };
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--manifest') {
    throw new Error('usage: verify-migration-bundle.mjs --manifest <bundle-manifest.json>');
  }
  return resolve(argv[1]);
}

export async function verifyMigrationBundle(manifestPath) {
  manifestPath = resolve(manifestPath);
  await regularFile(manifestPath, 'manifest');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    fail('manifest must contain valid JSON');
  }

  exactKeys(manifest, ['format', 'bundleId', 'source', 'target', 'payload', 'authorization'], 'manifest');
  if (manifest.format !== 'aichattg-migration-bundle-v1') fail('unsupported format');
  const bundleId = string(manifest.bundleId, 'bundleId', IDENTIFIER);

  exactKeys(manifest.source, ['application', 'commit', 'exportType', 'databaseIncluded'], 'source');
  if (manifest.source.application !== 'news-digest'
    || manifest.source.exportType !== 'approved-normalized-jsonl'
    || manifest.source.databaseIncluded !== false) {
    fail('source must be a normalized export and must not include a database');
  }
  string(manifest.source.commit, 'source.commit', SHA1);

  exactKeys(manifest.target, ['application', 'service', 'schema'], 'target');
  if (manifest.target.application !== 'aichattg'
    || manifest.target.service !== 'aichattg-telegram-runtime'
    || manifest.target.schema !== 'runtime-sqlite-v1') {
    fail('target is not the independent AIchatTG runtime');
  }

  exactKeys(manifest.authorization, ['candidateSha', 'controllerLeaseId', 'productOwnerApprovalId'], 'authorization');
  string(manifest.authorization.candidateSha, 'authorization.candidateSha', SHA1);
  string(manifest.authorization.controllerLeaseId, 'authorization.controllerLeaseId', IDENTIFIER);
  string(manifest.authorization.productOwnerApprovalId, 'authorization.productOwnerApprovalId', IDENTIFIER);

  exactKeys(manifest.payload, ['file', 'sha256', 'recordCount'], 'payload');
  if (manifest.payload.file !== 'records.jsonl' || basename(manifest.payload.file) !== manifest.payload.file) {
    fail('payload.file must be the exact normalized records.jsonl filename');
  }
  string(manifest.payload.sha256, 'payload.sha256', SHA256);
  if (!Number.isSafeInteger(manifest.payload.recordCount) || manifest.payload.recordCount < 0) {
    fail('payload.recordCount must be a non-negative safe integer');
  }

  const payloadPath = resolve(dirname(manifestPath), manifest.payload.file);
  if (dirname(payloadPath) !== dirname(manifestPath)) fail('payload must be beside the manifest');
  await regularFile(payloadPath, 'payload');
  const inspected = await inspectJsonl(payloadPath);
  if (inspected.sha256 !== manifest.payload.sha256 || inspected.recordCount !== manifest.payload.recordCount) {
    fail('payload digest or record count does not match the manifest');
  }

  return {
    status: 'verified',
    bundleId,
    sourceCommit: manifest.source.commit,
    candidateSha: manifest.authorization.candidateSha,
    recordCount: inspected.recordCount,
    payloadSha256: inspected.sha256,
    manifestPath,
    payloadPath,
    manifest,
  };
}

async function main() {
  const verified = await verifyMigrationBundle(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    status: verified.status,
    bundleId: verified.bundleId,
    sourceCommit: verified.sourceCommit,
    candidateSha: verified.candidateSha,
    recordCount: verified.recordCount,
    payloadSha256: verified.payloadSha256,
  })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
