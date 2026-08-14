import { existsSync, readFileSync } from 'node:fs';
import {
  ASSISTANT_SOURCE_PACKAGES,
  admitKnowledgePackage,
  admitKnowledgeSnapshot,
} from '@aichattg/telegram-core';

const KNOWLEDGE_SOURCES = Object.freeze([
  ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT,
  ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS,
]);

// Sources admitted through the v2 binary path. They are listed separately
// because their admission proves a database file, not a list of text entries.
const KNOWLEDGE_PACKAGE_SOURCES = Object.freeze([
  ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE,
]);

function unavailable(reason) {
  return Object.freeze({
    available: false, reason, snapshot: null, identity: null, package: null,
  });
}

function parseManifest(manifestPath, { exists, readFile }) {
  if (typeof manifestPath !== 'string' || !manifestPath || !exists(manifestPath)) return null;
  try { return JSON.parse(readFile(manifestPath, 'utf8')); } catch { return null; }
}

/**
 * A local, one-way knowledge seam. Every source package has its own manifest
 * path plus an expected source/digest identity. It has no News path, database,
 * network or fallback, and an absent admission remains unavailable.
 */
export function createKnowledgeAdapter(
  { root, admissions = {} } = {},
  { exists = existsSync, readFile = readFileSync } = {},
) {
  const admitted = new Map();
  for (const sourceId of KNOWLEDGE_SOURCES) {
    const admission = admissions?.[sourceId];
    if (!admission) {
      admitted.set(sourceId, unavailable('knowledge_identity_missing'));
      continue;
    }
    const manifest = parseManifest(admission.manifestPath, { exists, readFile });
    if (!manifest) {
      admitted.set(sourceId, unavailable('knowledge_manifest_missing'));
      continue;
    }
    admitted.set(sourceId, admitKnowledgeSnapshot({
      manifest,
      root,
      expectedIdentity: admission.expectedIdentity,
    }));
  }
  for (const sourceId of KNOWLEDGE_PACKAGE_SOURCES) {
    const admission = admissions?.[sourceId];
    if (!admission) {
      admitted.set(sourceId, unavailable('knowledge_identity_missing'));
      continue;
    }
    const manifest = parseManifest(admission.manifestPath, { exists, readFile });
    if (!manifest) {
      admitted.set(sourceId, unavailable('knowledge_manifest_missing'));
      continue;
    }
    admitted.set(sourceId, admitKnowledgePackage({
      manifest,
      // A package manifest names files relative to its own package directory,
      // which is itself proven to sit below the runtime knowledge root.
      root: admission.packageRoot || root,
      expectedIdentity: admission.expectedIdentity,
    }));
  }
  return Object.freeze({
    forSource(sourceId) {
      return admitted.get(sourceId) || unavailable('knowledge_source_invalid');
    },
    /**
     * A verified binary package: the caller receives a proven database path and
     * opens it read-only itself. An unadmitted or unverified package is never
     * downgraded into a usable path.
     */
    forPackage(sourceId) {
      const admission = admitted.get(sourceId);
      if (!admission) return unavailable('knowledge_source_invalid');
      if (!admission.available) return admission;
      if (!admission.package) return unavailable('knowledge_package_invalid');
      return admission;
    },
  });
}
