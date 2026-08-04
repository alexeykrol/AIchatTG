#!/usr/bin/env node
/**
 * Candidate-only builder for an explicitly reviewed course export.
 *
 * This script neither discovers nor reads legacy application data. Its caller
 * must supply a reviewed JSON export and the local snapshot directory that the
 * export names. It then creates two independently admitted packages that the
 * existing knowledge loader can verify without any runtime changes.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOWLEDGE_MANIFEST_FORMAT,
  KNOWLEDGE_SOURCE_IDS,
  knowledgeManifestDigest,
} from '../../packages/telegram-core/src/knowledge.mjs';

export const REVIEWED_COURSE_EXPORT_FORMAT = 'aichattg-reviewed-course-export-v1';
export const COURSE_KNOWLEDGE_ADMISSIONS_FORMAT = 'aichattg-course-knowledge-admissions-v1';
export const COURSE_KNOWLEDGE_REPORT_FORMAT = 'aichattg-course-knowledge-admission-report-v1';

const SOURCE_ID_SET = new Set(KNOWLEDGE_SOURCE_IDS);
const SHA256 = /^[a-f0-9]{64}$/iu;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_TEXT = /^[^\0\r\n]{1,256}$/u;
const VISIBILITIES = new Set(['public', 'non_public', 'removed']);
const TEXT_EXTENSIONS = new Set(['.md', '.txt']);

function fail(message) {
  throw new Error(`course knowledge snapshot rejected: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has an unsupported or missing field`);
  }
}

function string(value, label, matcher = SAFE_TEXT) {
  if (typeof value !== 'string' || !matcher.test(value)) fail(`${label} is invalid`);
  return value;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return false;
  const normalized = value.replaceAll('\\', '/');
  return !normalized.startsWith('/')
    && !normalized.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function httpsUrl(value, label) {
  if (typeof value !== 'string' || !value || value.length > 2_048) fail(`${label} is invalid`);
  try {
    if (new URL(value).protocol !== 'https:') fail(`${label} must use HTTPS`);
  } catch (error) {
    if (error.message.startsWith('course knowledge snapshot rejected:')) throw error;
    fail(`${label} is invalid`);
  }
  return value;
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || Number.isNaN(Date.parse(value))) {
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function sourceRootPath(root) {
  const candidate = resolve(root);
  try {
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('source root must be a real directory');
    return realpathSync(candidate);
  } catch (error) {
    if (error.message.startsWith('course knowledge snapshot rejected:')) throw error;
    fail('source root must be an existing real directory');
  }
}

function regularFileBelow(root, relativePath, label) {
  if (!safeRelativePath(relativePath)) fail(`${label} must be a safe relative path`);
  const candidate = resolve(root, relativePath);
  const candidateRelative = relative(root, candidate);
  if (!candidateRelative || candidateRelative === '..' || candidateRelative.startsWith(`..${sep}`)) {
    fail(`${label} escapes the supplied source root`);
  }
  try {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
    const resolved = realpathSync(candidate);
    const resolvedRelative = relative(root, resolved);
    if (!resolvedRelative || resolvedRelative === '..' || resolvedRelative.startsWith(`..${sep}`)) {
      fail(`${label} escapes the supplied source root`);
    }
    return resolved;
  } catch (error) {
    if (error.message.startsWith('course knowledge snapshot rejected:')) throw error;
    fail(`${label} must be an existing regular file`);
  }
}

function readExport(sourceExportPath) {
  const resolved = resolve(sourceExportPath);
  try {
    const stat = lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('source export must be a regular non-symlink file');
    const raw = readFileSync(resolved, 'utf8');
    return { path: resolved, name: basename(resolved), sha256: sha256(raw), value: JSON.parse(raw) };
  } catch (error) {
    if (error.message.startsWith('course knowledge snapshot rejected:')) throw error;
    fail('source export must contain valid JSON');
  }
}

function validateProvenance(provenance) {
  exactKeys(provenance, ['reviewReference', 'reviewedAt', 'sourceExportId', 'sourceSystem'], 'provenance');
  return {
    sourceSystem: string(provenance.sourceSystem, 'provenance.sourceSystem'),
    sourceExportId: string(provenance.sourceExportId, 'provenance.sourceExportId', IDENTIFIER),
    reviewedAt: isoTimestamp(provenance.reviewedAt, 'provenance.reviewedAt'),
    reviewReference: string(provenance.reviewReference, 'provenance.reviewReference'),
  };
}

function validateEntry(entry, index) {
  const label = `entries[${index}]`;
  exactKeys(entry, [
    'canonicalUrl', 'contentPath', 'contentSha256', 'id', 'sourceId', 'sourceRecordId', 'title', 'visibility',
  ], label);
  const sourceId = string(entry.sourceId, `${label}.sourceId`, IDENTIFIER);
  if (!SOURCE_ID_SET.has(sourceId)) fail(`${label}.sourceId is not an admitted source package`);
  const visibility = string(entry.visibility, `${label}.visibility`, /^[a-z_]{1,32}$/u);
  if (!VISIBILITIES.has(visibility)) fail(`${label}.visibility is unsupported`);
  const valid = {
    id: string(entry.id, `${label}.id`, IDENTIFIER),
    sourceId,
    sourceRecordId: string(entry.sourceRecordId, `${label}.sourceRecordId`, IDENTIFIER),
    title: string(entry.title, `${label}.title`),
    canonicalUrl: httpsUrl(entry.canonicalUrl, `${label}.canonicalUrl`),
    visibility,
    contentPath: entry.contentPath,
    contentSha256: entry.contentSha256,
  };
  if (visibility === 'public') {
    if (!safeRelativePath(valid.contentPath) || !TEXT_EXTENSIONS.has(extname(valid.contentPath).toLowerCase())) {
      fail(`${label}.contentPath must name a .md or .txt file below the supplied source root`);
    }
    string(valid.contentSha256, `${label}.contentSha256`, SHA256);
    valid.contentSha256 = valid.contentSha256.toLowerCase();
  } else if (valid.contentPath !== null || valid.contentSha256 !== null) {
    fail(`${label} must not name content for a non-public or removed entry`);
  }
  return valid;
}

function titleComparable(value) {
  let text = value.normalize('NFKC').replace(/^\uFEFF/u, '').trim();
  text = text.replace(/^<h[1-6][^>]*>\s*/iu, '').replace(/\s*<\/h[1-6]>$/iu, '');
  text = text.replace(/^#{1,6}\s*/u, '').replace(/^\*\*|\*\*$/gu, '').replace(/^__|__$/gu, '');
  return text.replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

function outputPathFor(entry) {
  const extension = extname(entry.contentPath).toLowerCase();
  const stable = sha256(`${entry.sourceId}\0${entry.id}`).slice(0, 24);
  return `snapshots/${entry.sourceId}/${stable}${extension}`;
}

function reportDecision(entry, decision, reason, extra = {}) {
  return {
    sourceId: entry.sourceId,
    id: entry.id,
    sourceRecordId: entry.sourceRecordId,
    title: entry.title,
    canonicalUrl: entry.canonicalUrl,
    visibility: entry.visibility,
    decision,
    reason,
    ...extra,
  };
}

function orderedEntries(entries) {
  return [...entries].sort((left, right) => left.sourceId.localeCompare(right.sourceId)
    || left.id.localeCompare(right.id) || left.sourceRecordId.localeCompare(right.sourceRecordId));
}

/**
 * Inspect a reviewed export without creating any artifact. Non-public and
 * removed entries are recorded as filtered. Empty, title-only, changed or
 * duplicate public entries are blockers that prevent a build.
 */
export function evaluateCourseKnowledgeSnapshot({ sourceExportPath, sourceRoot } = {}) {
  if (typeof sourceExportPath !== 'string' || !sourceExportPath) fail('source export path is required');
  if (typeof sourceRoot !== 'string' || !sourceRoot) fail('source root path is required');
  const source = readExport(sourceExportPath);
  const root = sourceRootPath(sourceRoot);
  const exportValue = source.value;
  exactKeys(exportValue, ['entries', 'format', 'provenance'], 'source export');
  if (exportValue.format !== REVIEWED_COURSE_EXPORT_FORMAT) fail('unsupported source export format');
  if (!Array.isArray(exportValue.entries) || exportValue.entries.length === 0) fail('source export entries must be a non-empty array');
  const provenance = validateProvenance(exportValue.provenance);
  const entries = exportValue.entries.map(validateEntry);
  const knownIds = new Set();
  const knownSourceRecords = new Set();
  const decisions = [];
  const admitted = [];

  for (const entry of orderedEntries(entries)) {
    const entryIdentity = `${entry.sourceId}\0${entry.id}`;
    if (knownIds.has(entryIdentity)) {
      decisions.push(reportDecision(entry, 'blocked', 'duplicate_source_entry'));
      continue;
    }
    knownIds.add(entryIdentity);
    if (knownSourceRecords.has(entry.sourceRecordId)) {
      decisions.push(reportDecision(entry, 'blocked', 'duplicate_source_record'));
      continue;
    }
    knownSourceRecords.add(entry.sourceRecordId);
    if (entry.visibility === 'removed') {
      decisions.push(reportDecision(entry, 'filtered', 'removed'));
      continue;
    }
    if (entry.visibility === 'non_public') {
      decisions.push(reportDecision(entry, 'filtered', 'non_public'));
      continue;
    }

    const sourceFile = regularFileBelow(root, entry.contentPath, `${entry.sourceId}:${entry.id} content`);
    const content = readFileSync(sourceFile, 'utf8');
    const contentSha256 = sha256(content);
    if (contentSha256 !== entry.contentSha256) {
      decisions.push(reportDecision(entry, 'blocked', 'content_digest_mismatch', { contentSha256 }));
      continue;
    }
    if (!content.replace(/^\uFEFF/u, '').trim()) {
      decisions.push(reportDecision(entry, 'blocked', 'empty_content', { contentSha256 }));
      continue;
    }
    if (titleComparable(content) === titleComparable(entry.title)) {
      decisions.push(reportDecision(entry, 'blocked', 'title_only_content', { contentSha256 }));
      continue;
    }
    const path = outputPathFor(entry);
    admitted.push({ ...entry, content, contentSha256, path });
    decisions.push(reportDecision(entry, 'admitted', null, { contentSha256, path }));
  }

  const counts = {
    total: entries.length,
    admitted: Object.fromEntries(KNOWLEDGE_SOURCE_IDS.map((sourceId) => [
      sourceId, admitted.filter((entry) => entry.sourceId === sourceId).length,
    ])),
    filtered: decisions.filter((entry) => entry.decision === 'filtered').length,
    blocked: decisions.filter((entry) => entry.decision === 'blocked').length,
  };
  for (const sourceId of KNOWLEDGE_SOURCE_IDS) {
    if (counts.admitted[sourceId] === 0) {
      decisions.push({ sourceId, id: null, sourceRecordId: null, title: null, canonicalUrl: null,
        visibility: null, decision: 'blocked', reason: 'source_package_empty' });
      counts.blocked += 1;
    }
  }
  const report = {
    format: COURSE_KNOWLEDGE_REPORT_FORMAT,
    status: counts.blocked === 0 ? 'admissible' : 'blocked',
    sourceExport: {
      file: source.name,
      sha256: source.sha256,
      format: exportValue.format,
      provenance,
    },
    counts,
    decisions,
  };
  return { report, admitted: orderedEntries(admitted) };
}

function assertAdmissible(evaluation) {
  if (evaluation.report.status !== 'admissible') {
    const reasons = evaluation.report.decisions
      .filter((decision) => decision.decision === 'blocked')
      .map((decision) => decision.id ? `${decision.sourceId}:${decision.id}:${decision.reason}` : `${decision.sourceId}:${decision.reason}`);
    fail(`admission is blocked (${reasons.join(', ')})`);
  }
}

function manifestFor(sourceId, admitted) {
  const entries = admitted.filter((entry) => entry.sourceId === sourceId).map((entry) => ({
    id: entry.id,
    path: entry.path,
    sha256: entry.contentSha256,
    title: entry.title,
    canonicalUrl: entry.canonicalUrl,
  }));
  return { format: KNOWLEDGE_MANIFEST_FORMAT, sourceId, entries };
}

function assertNewOutputRoot(outputRoot) {
  const target = resolve(outputRoot);
  if (existsSync(target)) fail('output root already exists; choose a new empty target to avoid overwriting a reviewed snapshot');
  const parent = dirname(target);
  try {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('output root parent must be an existing real directory');
  } catch (error) {
    if (error.message.startsWith('course knowledge snapshot rejected:')) throw error;
    fail('output root parent must be an existing real directory');
  }
  return target;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Build both runtime-compatible source packages only when admission passes. */
export function buildCourseKnowledgeSnapshot({ sourceExportPath, sourceRoot, outputRoot } = {}) {
  if (typeof outputRoot !== 'string' || !outputRoot) fail('output root path is required');
  const target = assertNewOutputRoot(outputRoot);
  const evaluation = evaluateCourseKnowledgeSnapshot({ sourceExportPath, sourceRoot });
  assertAdmissible(evaluation);

  const manifests = Object.fromEntries(KNOWLEDGE_SOURCE_IDS.map((sourceId) => [sourceId, manifestFor(sourceId, evaluation.admitted)]));
  const admissions = {
    format: COURSE_KNOWLEDGE_ADMISSIONS_FORMAT,
    sourceExport: evaluation.report.sourceExport,
    admissions: Object.fromEntries(KNOWLEDGE_SOURCE_IDS.map((sourceId) => [sourceId, {
      manifestPath: `manifests/${sourceId}.manifest.json`,
      expectedIdentity: { sourceId, manifestDigest: knowledgeManifestDigest(manifests[sourceId]) },
    }])),
  };
  const stage = mkdtempSync(join(dirname(target), `.${basename(target)}.staging-`));
  try {
    for (const sourceId of KNOWLEDGE_SOURCE_IDS) {
      const snapshotDirectory = join(stage, 'snapshots', sourceId);
      requireDirectory(snapshotDirectory);
      for (const entry of evaluation.admitted.filter((item) => item.sourceId === sourceId)) {
        writeFileSync(join(stage, entry.path), entry.content, 'utf8');
      }
    }
    requireDirectory(join(stage, 'manifests'));
    for (const sourceId of KNOWLEDGE_SOURCE_IDS) {
      writeJson(join(stage, 'manifests', `${sourceId}.manifest.json`), manifests[sourceId]);
    }
    writeJson(join(stage, 'admissions.json'), admissions);
    writeJson(join(stage, 'admission-report.json'), evaluation.report);
    renameSync(stage, target);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return { outputRoot: target, report: evaluation.report, admissions, manifests };
}

function requireDirectory(path) {
  // This path is always below the private directory just created by mkdtempSync.
  mkdirSync(path, { recursive: true });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('staging directory is unsafe');
}

function parseArguments(argv) {
  const options = { validate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--validate') {
      if (options.validate) fail('--validate may be supplied only once');
      options.validate = true;
    } else if (['--source-export', '--source-root', '--output-root'].includes(argument)) {
      if (index + 1 >= argv.length) fail(`${argument} requires a value`);
      options[argument.slice(2).replaceAll('-', '_')] = argv[++index];
    } else {
      fail(`unsupported argument ${argument}`);
    }
  }
  if (!options.source_export || !options.source_root || (!options.validate && !options.output_root)) {
    throw new Error('usage: build-course-knowledge-snapshot.mjs --source-export <reviewed-export.json> --source-root <reviewed-snapshot-dir> [--validate | --output-root <new-output-dir>]');
  }
  if (options.validate && options.output_root) fail('--validate does not accept --output-root');
  return {
    validate: options.validate,
    sourceExportPath: options.source_export,
    sourceRoot: options.source_root,
    outputRoot: options.output_root,
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.validate) {
    const evaluation = evaluateCourseKnowledgeSnapshot(options);
    process.stdout.write(`${JSON.stringify(evaluation.report)}\n`);
    if (evaluation.report.status !== 'admissible') process.exitCode = 1;
    return;
  }
  const result = buildCourseKnowledgeSnapshot(options);
  process.stdout.write(`${JSON.stringify({
    status: 'built', outputRoot: result.outputRoot, admissions: result.admissions.admissions, counts: result.report.counts,
  })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
