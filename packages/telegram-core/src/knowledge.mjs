import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export const KNOWLEDGE_MANIFEST_FORMAT = 'aichattg-knowledge-manifest-v1';
export const KNOWLEDGE_SOURCE_IDS = Object.freeze([
  'course-content-v1',
  'course-operations-v1',
]);

const KNOWLEDGE_SOURCE_ID_SET = new Set(KNOWLEDGE_SOURCE_IDS);

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
  return Object.freeze({ available: false, reason, snapshot: null, identity: null });
}

function validExpectedIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    return { valid: false, reason: 'knowledge_identity_missing' };
  }
  if (typeof identity.sourceId !== 'string' || !identity.sourceId) {
    return { valid: false, reason: 'knowledge_identity_missing' };
  }
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
