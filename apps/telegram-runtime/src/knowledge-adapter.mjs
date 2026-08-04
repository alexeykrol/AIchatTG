import { existsSync, readFileSync } from 'node:fs';
import { loadKnowledgeSnapshot } from '@aichattg/telegram-core';

function unavailable(reason) {
  return Object.freeze({ available: false, reason, snapshot: null });
}

/**
 * A local, one-way knowledge seam. It reads an explicitly supplied AIchatTG
 * manifest and root only; it has no News path, database, network or fallback.
 */
export function createKnowledgeAdapter({ root, manifestPath } = {}) {
  if (!root || !manifestPath || !existsSync(manifestPath)) {
    return { forSource() { return unavailable('knowledge_manifest_missing'); } };
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch {
    return { forSource() { return unavailable('knowledge_manifest_invalid'); } };
  }
  const snapshot = loadKnowledgeSnapshot(manifest, root);
  if (!snapshot || snapshot.entries.length === 0) {
    return { forSource() { return unavailable('knowledge_snapshot_unavailable'); } };
  }
  return {
    forSource(sourceId) {
      return snapshot.sourceId === sourceId
        ? { available: true, reason: null, snapshot }
        : unavailable('knowledge_source_unavailable');
    },
  };
}
