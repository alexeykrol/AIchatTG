import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export const KNOWLEDGE_MANIFEST_FORMAT = 'aichattg-knowledge-manifest-v1';

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

/**
 * Validate a content-free, versioned knowledge manifest. The manifest names a
 * reviewed snapshot but never embeds course or student data in this repository.
 */
export function validateKnowledgeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  if (manifest.format !== KNOWLEDGE_MANIFEST_FORMAT || typeof manifest.sourceId !== 'string' || !manifest.sourceId) return null;
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
  const manifestDigest = createHash('sha256').update(JSON.stringify(valid)).digest('hex');
  return { ...valid, manifestDigest, entries };
}
