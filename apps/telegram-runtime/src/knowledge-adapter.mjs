import { existsSync, readFileSync } from 'node:fs';
import {
  ASSISTANT_SOURCE_PACKAGES,
  admitKnowledgeSnapshot,
} from '@aichattg/telegram-core';

const KNOWLEDGE_SOURCES = Object.freeze([
  ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT,
  ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS,
]);

function unavailable(reason) {
  return Object.freeze({ available: false, reason, snapshot: null, identity: null });
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
  return Object.freeze({
    forSource(sourceId) {
      return admitted.get(sourceId) || unavailable('knowledge_source_invalid');
    },
  });
}
