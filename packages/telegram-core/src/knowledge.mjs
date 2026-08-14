import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const HASH_CHUNK_BYTES = 1_048_576;

/**
 * Hash a file in fixed-size reads. A knowledge package database is tens of
 * megabytes, and readFileSync would both cap at the buffer limit and hold the
 * whole artifact in memory just to prove a digest.
 */
function sha256OfFile(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const fd = openSync(path, 'r');
  try {
    let bytes = readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null);
    while (bytes > 0) {
      hash.update(buffer.subarray(0, bytes));
      bytes = readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null);
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export const KNOWLEDGE_MANIFEST_FORMAT = 'aichattg-knowledge-manifest-v1';

/**
 * The v2 format admits a single binary package (a SQLite knowledge base) rather
 * than a list of utf8 entries. It is a separate constant, never a mutation of
 * v1: course-operations-v1 keeps its text manifest and its exact validation.
 */
export const KNOWLEDGE_PACKAGE_MANIFEST_FORMAT = 'aichattg-knowledge-manifest-v2';

// The v1 text sources. This list keeps its exact meaning — every existing
// consumer (including the snapshot builder) reads it as "the sources that are
// built and admitted as utf8 entries", so the binary source is deliberately
// NOT added here.
export const KNOWLEDGE_SOURCE_IDS = Object.freeze([
  'course-content-v1',
  'course-operations-v1',
]);

// Only this source may be admitted through the v2 binary path. Keeping the two
// lists disjoint stops a text source from being satisfied by a database file
// and vice versa.
export const KNOWLEDGE_PACKAGE_SOURCE_IDS = Object.freeze(['course-knowledge-v2']);

/** Every admissible source, whichever format carries it. */
export const KNOWLEDGE_ALL_SOURCE_IDS = Object.freeze([
  ...KNOWLEDGE_SOURCE_IDS,
  ...KNOWLEDGE_PACKAGE_SOURCE_IDS,
]);

const KNOWLEDGE_SOURCE_ID_SET = new Set(KNOWLEDGE_SOURCE_IDS);
const KNOWLEDGE_PACKAGE_SOURCE_ID_SET = new Set(KNOWLEDGE_PACKAGE_SOURCE_IDS);

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return false;
  const normalized = value.replaceAll('\\', '/');
  return !normalized.startsWith('/')
    && !normalized.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function isSha256(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value); }

function isHttpsUrl(value) {
  if (value == null) return true;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function unavailable(reason) {
  return Object.freeze({
    available: false, reason, snapshot: null, identity: null, package: null,
  });
}

function validExpectedIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    return { valid: false, reason: 'knowledge_identity_missing' };
  }
  if (typeof identity.sourceId !== 'string' || !identity.sourceId) {
    return { valid: false, reason: 'knowledge_identity_missing' };
  }
  // A binary-package source is refused at the identity gate rather than later:
  // the text path must never be the layer that decides a v2 source's fate.
  if (!KNOWLEDGE_SOURCE_ID_SET.has(identity.sourceId) || !isSha256(identity.manifestDigest)) {
    return { valid: false, reason: 'knowledge_identity_invalid' };
  }
  return {
    valid: true,
    identity: Object.freeze({
      sourceId: identity.sourceId,
      manifestDigest: identity.manifestDigest.toLowerCase(),
    }),
  };
}

/**
 * Validate a content-free, versioned knowledge manifest. The manifest names a
 * reviewed snapshot but never embeds course or student data in this repository.
 */
export function validateKnowledgeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  // KNOWLEDGE_SOURCE_ID_SET holds only text sources, so a binary-package
  // source is never satisfiable by a v1 manifest.
  if (manifest.format !== KNOWLEDGE_MANIFEST_FORMAT
    || typeof manifest.sourceId !== 'string'
    || !KNOWLEDGE_SOURCE_ID_SET.has(manifest.sourceId)) return null;
  if (!Array.isArray(manifest.entries)) return null;
  const ids = new Set();
  const paths = new Set();
  const entries = [];
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.id !== 'string' || !entry.id || !safeRelativePath(entry.path)
      || !isSha256(entry.sha256) || !isHttpsUrl(entry.canonicalUrl)) return null;
    if (ids.has(entry.id) || paths.has(entry.path)) return null;
    ids.add(entry.id); paths.add(entry.path);
    entries.push({
      id: entry.id,
      path: entry.path,
      sha256: entry.sha256.toLowerCase(),
      title: entry.title == null ? null : String(entry.title),
      canonicalUrl: entry.canonicalUrl == null ? null : String(entry.canonicalUrl),
    });
  }
  return { format: KNOWLEDGE_MANIFEST_FORMAT, sourceId: manifest.sourceId, entries };
}

/**
 * The digest identifies exactly the normalized manifest admitted for a source.
 * It intentionally covers names, paths and entry digests, but not the content
 * itself: every entry is independently verified by loadKnowledgeSnapshot().
 */
export function knowledgeManifestDigest(manifest) {
  const valid = validateKnowledgeManifest(manifest);
  return valid
    ? createHash('sha256').update(JSON.stringify(valid)).digest('hex')
    : null;
}

function fileWithin(root, path) {
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return candidate;
}

/**
 * Load only a reviewed local snapshot. Symlinks, paths outside its explicit root
 * and digest mismatches are rejected so a manifest cannot become a News mount.
 */
export function loadKnowledgeSnapshot(manifest, root) {
  const valid = validateKnowledgeManifest(manifest);
  if (!valid || typeof root !== 'string' || !root) return null;
  let resolvedRoot;
  try { resolvedRoot = realpathSync(resolve(root)); } catch { return null; }
  const entries = [];
  try {
    for (const entry of valid.entries) {
      const file = fileWithin(resolvedRoot, entry.path);
      if (!file || lstatSync(file).isSymbolicLink()) return null;
      const resolvedFile = realpathSync(file);
      const rel = relative(resolvedRoot, resolvedFile);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return null;
      const content = readFileSync(file, 'utf8');
      if (createHash('sha256').update(content).digest('hex') !== entry.sha256) return null;
      entries.push({ ...entry, content });
    }
  } catch {
    return null;
  }
  const manifestDigest = knowledgeManifestDigest(valid);
  return { ...valid, manifestDigest, entries };
}

/**
 * Admit a local snapshot only when the runtime explicitly names both the
 * source package and the reviewed manifest digest. A missing, malformed or
 * mismatched identity cannot fall back to another package or to a filesystem
 * path outside the loader's explicit root.
 */
export function admitKnowledgeSnapshot({ manifest, root, expectedIdentity } = {}) {
  const expected = validExpectedIdentity(expectedIdentity);
  if (!expected.valid) return unavailable(expected.reason);

  const validManifest = validateKnowledgeManifest(manifest);
  if (!validManifest) return unavailable('knowledge_manifest_invalid');
  if (validManifest.sourceId !== expected.identity.sourceId) {
    return unavailable('knowledge_identity_mismatch');
  }

  const snapshot = loadKnowledgeSnapshot(validManifest, root);
  if (!snapshot) return unavailable('knowledge_snapshot_invalid');
  if (snapshot.manifestDigest !== expected.identity.manifestDigest) {
    return unavailable('knowledge_identity_mismatch');
  }
  if (snapshot.entries.length === 0) return unavailable('knowledge_snapshot_empty');
  return Object.freeze({
    available: true,
    reason: null,
    identity: expected.identity,
    snapshot,
  });
}

function validExpectedPackageIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    return { valid: false, reason: 'knowledge_identity_missing' };
  }
  if (typeof identity.sourceId !== 'string' || !identity.sourceId) {
    return { valid: false, reason: 'knowledge_identity_missing' };
  }
  if (!KNOWLEDGE_PACKAGE_SOURCE_ID_SET.has(identity.sourceId)
    || !isSha256(identity.packageDigest)) {
    return { valid: false, reason: 'knowledge_identity_invalid' };
  }
  return {
    valid: true,
    identity: Object.freeze({
      sourceId: identity.sourceId,
      packageDigest: identity.packageDigest.toLowerCase(),
    }),
  };
}

/**
 * Validate a v2 package manifest: one named database file inside the package,
 * plus the sha256 of every file the build recorded. The manifest still carries
 * no course content — it names a reviewed binary artifact and its digests.
 */
export function validateKnowledgePackageManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  if (manifest.format !== KNOWLEDGE_PACKAGE_MANIFEST_FORMAT
    || typeof manifest.sourceId !== 'string'
    || !KNOWLEDGE_PACKAGE_SOURCE_ID_SET.has(manifest.sourceId)) return null;
  if (typeof manifest.domainId !== 'string' || !manifest.domainId.trim()) return null;
  if (!isSha256(manifest.packageDigest)) return null;
  if (!safeRelativePath(manifest.databasePath)) return null;
  if (!manifest.files || typeof manifest.files !== 'object') return null;

  // Accept both the on-disk shape ({path: sha256}) and an already-normalized
  // manifest ([{path, sha256}]). Validation must be idempotent: it runs again
  // inside the loader, and a normalized manifest that failed re-validation
  // would reject a package that had just been accepted.
  const declared = Array.isArray(manifest.files)
    ? manifest.files.map((file) => [file?.path, file?.sha256])
    : Object.entries(manifest.files);

  const files = [];
  const paths = new Set();
  for (const [path, sha256] of declared) {
    if (!safeRelativePath(path) || !isSha256(sha256) || paths.has(path)) return null;
    paths.add(path);
    files.push({ path, sha256: sha256.toLowerCase() });
  }
  if (files.length === 0) return null;
  // The database the runtime is about to open must itself be covered by a
  // digest, otherwise the signature would prove everything except the one file
  // that carries the knowledge.
  if (!paths.has(manifest.databasePath)) return null;
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    format: KNOWLEDGE_PACKAGE_MANIFEST_FORMAT,
    sourceId: manifest.sourceId,
    domainId: manifest.domainId.trim(),
    packageName: typeof manifest.packageName === 'string' ? manifest.packageName : null,
    packageDigest: manifest.packageDigest.toLowerCase(),
    databasePath: manifest.databasePath,
    files,
  };
}

/**
 * Verify a package on disk without reading its content into memory: every file
 * named by the manifest is hashed by streaming, so a 65 MB database is proven
 * rather than trusted. Symlinks, absolute paths and any escape from the root are
 * refused exactly as in v1.
 */
export function loadKnowledgePackage(manifest, root, { verifyAllFiles = true } = {}) {
  const valid = validateKnowledgePackageManifest(manifest);
  if (!valid || typeof root !== 'string' || !root) return null;
  let resolvedRoot;
  try { resolvedRoot = realpathSync(resolve(root)); } catch { return null; }

  let databaseFile = null;
  try {
    for (const entry of valid.files) {
      const isDatabase = entry.path === valid.databasePath;
      if (!verifyAllFiles && !isDatabase) continue;
      const file = fileWithin(resolvedRoot, entry.path);
      if (!file || lstatSync(file).isSymbolicLink()) return null;
      const resolvedFile = realpathSync(file);
      const rel = relative(resolvedRoot, resolvedFile);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return null;
      if (!lstatSync(resolvedFile).isFile()) return null;
      if (sha256OfFile(file) !== entry.sha256) return null;
      if (isDatabase) databaseFile = file;
    }
  } catch {
    return null;
  }
  if (!databaseFile) return null;
  return { ...valid, root: resolvedRoot, databaseFile };
}

/**
 * Admit a binary knowledge package only when the runtime names both the source
 * and the exact package digest it reviewed. Unlike v1 this returns a verified
 * path rather than content: the retriever opens the database read-only itself.
 */
export function admitKnowledgePackage({ manifest, root, expectedIdentity, verifyAllFiles = true } = {}) {
  const expected = validExpectedPackageIdentity(expectedIdentity);
  if (!expected.valid) return unavailable(expected.reason);

  const validManifest = validateKnowledgePackageManifest(manifest);
  if (!validManifest) return unavailable('knowledge_package_manifest_invalid');
  if (validManifest.sourceId !== expected.identity.sourceId) {
    return unavailable('knowledge_identity_mismatch');
  }
  if (validManifest.packageDigest !== expected.identity.packageDigest) {
    return unavailable('knowledge_identity_mismatch');
  }

  const pkg = loadKnowledgePackage(validManifest, root, { verifyAllFiles });
  if (!pkg) return unavailable('knowledge_package_invalid');
  return Object.freeze({
    available: true,
    reason: null,
    identity: expected.identity,
    snapshot: null,
    package: Object.freeze({
      sourceId: pkg.sourceId,
      domainId: pkg.domainId,
      packageName: pkg.packageName,
      packageDigest: pkg.packageDigest,
      databasePath: pkg.databaseFile,
      root: pkg.root,
      files: Object.freeze(pkg.files.map((file) => Object.freeze({ ...file }))),
    }),
  });
}
