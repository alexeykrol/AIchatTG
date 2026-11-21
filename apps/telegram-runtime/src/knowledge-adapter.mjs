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
/**
 * Admit one registry slot (knowledge-packages.mjs). The slot's identity is the
 * registry sourceId plus the pinned package digest; the manifest's own
 * `sourceId` names the v2 package FORMAT family (`course-knowledge-v2` is the
 * only one core accepts) and is checked as such. Package files are immutable
 * and never rewritten to carry a slot name: the digest pin is what binds this
 * exact package to this slot. The admitted package is then re-labelled with the
 * slot sourceId, so grounding, receipts and the domain resolver all see which
 * base served the answer.
 */
function admitPackageSlot(slot, { exists, readFile }) {
  const manifest = parseManifest(slot.manifestPath, { exists, readFile });
  if (!manifest) return unavailable('knowledge_manifest_missing');
  const admission = admitKnowledgePackage({
    manifest,
    root: slot.packageRoot,
    expectedIdentity: {
      sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE,
      packageDigest: slot.packageDigest,
    },
  });
  if (!admission.available || !admission.package) return admission;
  return Object.freeze({
    ...admission,
    identity: Object.freeze({ sourceId: slot.sourceId, packageDigest: admission.identity.packageDigest }),
    package: Object.freeze({
      ...admission.package,
      sourceId: slot.sourceId,
      manifestSourceId: admission.package.sourceId,
    }),
  });
}

export function createKnowledgeAdapter(
  { root, admissions = {}, packages = null } = {},
  { exists = existsSync, readFile = readFileSync } = {},
) {
  const admitted = new Map();
  const slotStatuses = [];
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
  for (const slot of packages?.slots || []) {
    // Registry ids are disjoint from built-in sources by validation; the guard
    // here keeps an injected adapter config from shadowing one anyway.
    if (admitted.has(slot.sourceId)) {
      slotStatuses.push(Object.freeze({ sourceId: slot.sourceId, configured: true, admitted: false,
        reason: 'knowledge_source_duplicate', domainId: null, digest: slot.packageDigest, manifestPath: slot.manifestPath }));
      continue;
    }
    const admission = admitPackageSlot(slot, { exists, readFile });
    admitted.set(slot.sourceId, admission);
    slotStatuses.push(Object.freeze({
      sourceId: slot.sourceId,
      configured: true,
      admitted: admission.available === true,
      reason: admission.available === true ? null : admission.reason,
      domainId: admission.package?.domainId || null,
      digest: slot.packageDigest,
      manifestPath: slot.manifestPath,
    }));
  }
  return Object.freeze({
    /** Admission status of every registry slot, for the startup log. */
    packageSlots() { return [...slotStatuses]; },
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
