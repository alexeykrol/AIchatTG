import { readFileSync, lstatSync } from 'node:fs';
import { dirname, relative, resolve, sep, isAbsolute } from 'node:path';
import { ASSISTANT_SOURCE_PACKAGES } from '@aichattg/telegram-core';

/**
 * Generic retrieval-package registry (owner, 2026-11-21: "the number of
 * knowledge bases must not matter; the router switches to one base or another").
 *
 * The built-in course slot (`course-knowledge-v2`) keeps its single-slot env
 * exactly as before. Every ADDITIONAL base is one entry of a JSON file named by
 * TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES (a file below the knowledge root):
 *
 *   [{ "sourceId": "book-tcr-v1",
 *      "manifestPath": "tcr/pkg-hybrid-36b8db92318b/knowledge.manifest.json",
 *      "digestSha256": "<package digest>",
 *      "retrieval": { "mode": "hybrid", "maxEntries": 24, ... } }]
 *
 * Adding a base = adding an entry + a domain block whose Source (or Served
 * source) names the entry's sourceId. No code or compose change.
 *
 * This module is pure parsing/validation; it never opens a package. Admission
 * (digest proof) happens in the knowledge adapter, and an entry that is listed
 * but not admitted fails startup (assertPackageSlotsAdmitted).
 */

export const KNOWLEDGE_PACKAGES_ENV = 'TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES';
const REGISTRY_LIMIT_BYTES = 256 * 1024;
const MAX_SLOTS = 1024;
const SOURCE_ID = /^[a-z][a-z0-9-]{0,79}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ENTRY_KEYS = new Set(['sourceId', 'manifestPath', 'digestSha256', 'retrieval']);
const RETRIEVAL_KEYS = new Set([
  'mode', 'maxEntries', 'maxContextTokens', 'hybridMaxContextTokens',
  'noConceptGate', 'coverageText', 'linkTypes', 'linkMax',
]);
const MODES = new Set(['lexical', 'hybrid']);
const GATES = new Set(['refuse', 'pass']);
const COVERAGE = new Set(['content', 'content+alias']);
const LINK_TYPES = new Set(['contradicts', 'qualifies', 'continues', 'applies']);
// Built-in sources keep their own admission paths; a registry entry may not
// shadow one of them.
const RESERVED = new Set(Object.values(ASSISTANT_SOURCE_PACKAGES));

/**
 * The live recipe measured for the book (2.4.47): applied to any retrieval key
 * an entry leaves out. A package without vectors/model still works: hybrid
 * falls back to lexical per question and logs the reason once.
 */
export const PACKAGE_RETRIEVAL_DEFAULTS = Object.freeze({
  mode: 'hybrid',
  maxEntries: 24,
  maxContextTokens: 6_000,
  hybridMaxContextTokens: 12_000,
  noConceptGate: 'pass',
  coverageText: 'content+alias',
  linkTypes: Object.freeze(['contradicts', 'qualifies']),
  linkMax: 4,
});

function fail(message) {
  throw new Error(`${KNOWLEDGE_PACKAGES_ENV}: ${message}`);
}

function within(root, candidate) {
  const rel = relative(root, candidate);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function int(value, where, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${where} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function choice(value, where, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) fail(`${where} must be one of ${[...allowed].join(', ')}`);
  return value;
}

function retrievalSettings(raw, where) {
  if (raw === undefined) raw = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${where}.retrieval must be an object`);
  for (const key of Object.keys(raw)) if (!RETRIEVAL_KEYS.has(key)) fail(`${where}.retrieval.${key} is not a known key`);
  const value = { ...PACKAGE_RETRIEVAL_DEFAULTS, ...raw };
  if (!Array.isArray(value.linkTypes) || value.linkTypes.some((t) => typeof t !== 'string' || !LINK_TYPES.has(t))
    || new Set(value.linkTypes).size !== value.linkTypes.length) {
    fail(`${where}.retrieval.linkTypes must list distinct values of ${[...LINK_TYPES].join(', ')}`);
  }
  const linkMax = int(value.linkMax, `${where}.retrieval.linkMax`, { min: 0, max: 16 });
  if (linkMax > 0 && !value.linkTypes.length) fail(`${where}.retrieval.linkMax > 0 requires at least one link type`);
  // Same names and ranges as config.assistantRetrieval, so one retrieval factory
  // serves the built-in slot and every registry slot alike.
  return Object.freeze({
    retrievalMode: choice(value.mode, `${where}.retrieval.mode`, MODES),
    maxEntries: int(value.maxEntries, `${where}.retrieval.maxEntries`, { min: 1, max: 128 }),
    maxContextTokens: int(value.maxContextTokens, `${where}.retrieval.maxContextTokens`, { min: 500, max: 60_000 }),
    hybridMaxContextTokens: int(value.hybridMaxContextTokens, `${where}.retrieval.hybridMaxContextTokens`, { min: 500, max: 60_000 }),
    noConceptGate: choice(value.noConceptGate, `${where}.retrieval.noConceptGate`, GATES),
    coverageText: choice(value.coverageText, `${where}.retrieval.coverageText`, COVERAGE),
    linkExpansion: Object.freeze({ types: Object.freeze([...value.linkTypes]), max: linkMax }),
  });
}

/**
 * Parse the registry named by the env. Unset/empty = no extra slots (today's
 * behaviour). Anything malformed throws: a half-read registry would silently
 * drop a base, and the router would then send its questions nowhere.
 */
export function loadKnowledgePackageRegistry(env, cwd, knowledgeRoot, { readFile = readFileSync, lstat = lstatSync } = {}) {
  const raw = String(env[KNOWLEDGE_PACKAGES_ENV] || '').trim();
  if (!raw) return Object.freeze({ path: null, slots: Object.freeze([]) });
  const path = resolve(cwd, raw);
  if (!within(knowledgeRoot, path)) fail('must name a file below TELEGRAM_RUNTIME_KNOWLEDGE_ROOT');
  let text;
  try {
    const stat = lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) fail('must be a regular file');
    if (stat.size > REGISTRY_LIMIT_BYTES) fail(`file exceeds ${REGISTRY_LIMIT_BYTES} bytes`);
    text = String(readFile(path, 'utf8'));
  } catch (error) {
    if (String(error?.message || '').startsWith(KNOWLEDGE_PACKAGES_ENV)) throw error;
    fail('file is unreadable');
  }
  let entries;
  try { entries = JSON.parse(text); } catch { fail('file is not valid JSON'); }
  if (!Array.isArray(entries)) fail('file must contain a JSON array');
  if (entries.length > MAX_SLOTS) fail(`at most ${MAX_SLOTS} entries`);
  const seen = new Set();
  const slots = entries.map((entry, index) => {
    const where = `entry[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${where} must be an object`);
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) fail(`${where}.${key} is not a known key`);
    const { sourceId, manifestPath, digestSha256 } = entry;
    if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) fail(`${where}.sourceId must match ${SOURCE_ID}`);
    if (RESERVED.has(sourceId)) fail(`${where}.sourceId ${sourceId} is a built-in source`);
    if (seen.has(sourceId)) fail(`${where}.sourceId ${sourceId} is duplicated`);
    seen.add(sourceId);
    if (typeof manifestPath !== 'string' || !manifestPath.trim()) fail(`${where}.manifestPath is required`);
    // Relative paths resolve against the knowledge root, never the cwd.
    const manifest = resolve(knowledgeRoot, manifestPath.trim());
    if (!within(knowledgeRoot, manifest)) fail(`${where}.manifestPath must be below the knowledge root`);
    const packageRoot = dirname(manifest);
    if (!within(knowledgeRoot, packageRoot)) fail(`${where}.manifestPath must sit in a package directory below the knowledge root`);
    const digest = typeof digestSha256 === 'string' ? digestSha256.trim().toLowerCase() : '';
    if (!SHA256.test(digest)) fail(`${where}.digestSha256 must be a sha256 hex digest`);
    return Object.freeze({
      sourceId,
      manifestPath: manifest,
      packageRoot,
      packageDigest: digest,
      retrieval: retrievalSettings(entry.retrieval, where),
    });
  });
  return Object.freeze({ path, slots: Object.freeze(slots) });
}

/** A listed slot that failed admission is a configuration defect: fail startup. */
export function assertPackageSlotsAdmitted(statuses) {
  const broken = statuses.filter((slot) => slot.configured && !slot.admitted);
  if (broken.length) {
    throw new Error(`knowledge package slot not admitted: ${broken.map((s) => `${s.sourceId}(${s.reason})`).join(', ')}`);
  }
}

/**
 * Bind slot retrievals to domains: a retrieval domain is served by the slot
 * whose sourceId equals the domain's Served source (or Source). The result is
 * keyed by the domain Source, the key the domain resolver dispatches on. The
 * catalog already guarantees one binding per Source, so no key can conflict.
 */
export function bindRetrievalsToDomains(catalog, slotRetrievals) {
  const slots = slotRetrievals instanceof Map ? slotRetrievals : new Map(Object.entries(slotRetrievals || {}));
  const bound = new Map();
  for (const domain of catalog.domains) {
    if (domain.sourceKind !== 'retrieval' || bound.has(domain.sourceId)) continue;
    const retrieval = slots.get(domain.servedSourceId) || slots.get(domain.sourceId);
    if (retrieval) bound.set(domain.sourceId, retrieval);
  }
  return bound;
}
