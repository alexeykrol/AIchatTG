import { createHash } from 'node:crypto';

// No source text enters a schema, module cache or process-global catalogue.
// These caps bound request growth. A source that cannot be fully represented
// fails BEFORE a provider call; mandatory coverage is never silently truncated.
export const EVIDENCE_SELECTOR_VERSION = 'source-excerpt-selector-v1';
export const EVIDENCE_SELECTOR_IDS = Object.freeze(Array.from({ length: 128 },
  (_, index) => `E${String(index).padStart(4, '0')}`));
export const EVIDENCE_SELECTOR_LIMITS = Object.freeze({
  sourceUtf16: 60_000, excerptUtf16: 240, strideUtf16: 120,
  catalogueBytes: 65_536, entries: EVIDENCE_SELECTOR_IDS.length,
});
export class EvidenceSelectorError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
function reject(reason) { throw new EvidenceSelectorError(`selector_${reason}`); }
const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Immutable request-local map. Every excerpt is a slice, never normalized. */
export function createEvidenceSelector(message) {
  const limits = EVIDENCE_SELECTOR_LIMITS;
  if (typeof message !== 'string' || !message.trim() || message.length > limits.sourceUtf16) {
    reject('source_invalid');
  }
  if (message.length > limits.entries * limits.excerptUtf16) reject('source_coverage_limit');
  for (let index = 0; index < message.length; index++) {
    const code = message.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = message.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject('source_unicode_invalid');
    } else if (code >= 0xdc00 && code <= 0xdfff) reject('source_unicode_invalid');
  }
  const graphemes = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(message)];
  if (graphemes.some(item => item.segment.length > limits.excerptUtf16)) reject('source_grapheme_limit');
  const boundaries = [...graphemes.map(item => item.index), message.length];
  const boundarySet = new Set(boundaries);
  const entries = [];
  const intervals = new Set();
  let optionalOmissions = 0;
  let whitespaceCoverageWindows = 0;
  // Constant-length placeholder makes the serialized bound exact before hashing.
  const shape = id => ({ catalogue_id: id, entries: entries.map(({ id: key, text }) => ({ id: key, text })) });
  function offer(start, end, mandatory = false) {
    const interval = `${start}:${end}`;
    if (intervals.has(interval)) return;
    if (!boundarySet.has(start) || !boundarySet.has(end) || start >= end) reject('internal_interval_invalid');
    const text = message.slice(start, end);
    // Blank regions still advance original-source coverage, but cannot be
    // evidence. Padding must not turn an otherwise representable ad into an
    // automatic before-call failure. The full unmodified message is retained.
    if (!text.trim()) {
      if (mandatory) whitespaceCoverageWindows++;
      return;
    }
    if (text.length > limits.excerptUtf16 || entries.length >= limits.entries) {
      if (mandatory) reject('source_coverage_limit');
      optionalOmissions++;
      return;
    }
    entries.push(Object.freeze({ id: EVIDENCE_SELECTOR_IDS[entries.length], start, end, text }));
    if (Buffer.byteLength(JSON.stringify(shape('0'.repeat(64)))) > limits.catalogueBytes) {
      entries.pop();
      if (mandatory) reject('source_coverage_limit');
      optionalOmissions++;
      return;
    }
    intervals.add(interval);
  }
  function floorBoundary(offset) {
    let low = 0, high = boundaries.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (boundaries[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  }
  let startIndex = 0;
  let coveredThrough = 0;
  while (boundaries[startIndex] < message.length) {
    const start = boundaries[startIndex];
    const endIndex = floorBoundary(start + limits.excerptUtf16);
    if (endIndex <= startIndex || start > coveredThrough) reject('source_coverage_limit');
    offer(start, boundaries[endIndex], true);
    coveredThrough = boundaries[endIndex];
    if (coveredThrough === message.length) break;
    startIndex = Math.max(startIndex + 1, floorBoundary(start + limits.strideUtf16));
  }
  if (coveredThrough !== message.length) reject('source_coverage_limit');
  const coverageEntries = entries.length;
  // Fine spans allow separate threat and abuse evidence within one sentence.
  // Exact punctuation and spacing between adjacent words is preserved.
  const words = [...new Intl.Segmenter('und', { granularity: 'word' }).segment(message)]
    .filter(item => item.isWordLike);
  for (let index = 0; index < words.length; index++) {
    for (let width = 1; width <= 4 && index + width <= words.length; width++) {
      const last = words[index + width - 1];
      offer(words[index].index, last.index + last.segment.length);
    }
  }
  for (const item of graphemes) {
    if (/\p{Extended_Pictographic}/u.test(item.segment)) offer(item.index, item.index + item.segment.length);
  }
  const sourceSha256 = sha256(message);
  const catalogueId = sha256(JSON.stringify({ version: EVIDENCE_SELECTOR_VERSION, sourceSha256,
    spans: entries.map(({ id, start, end }) => ({ id, start, end })) }));
  const catalogue = shape(catalogueId);
  catalogue.entries.forEach(Object.freeze);
  Object.freeze(catalogue.entries);
  Object.freeze(catalogue);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const metadata = Object.freeze({ version: EVIDENCE_SELECTOR_VERSION, sourceSha256, catalogueId,
    sourceUtf16: message.length, coverageEntries, excerptCount: entries.length,
    coveredThrough, whitespaceCoverageWindows, optionalOmissions,
    catalogueBytes: Buffer.byteLength(JSON.stringify(catalogue)) });
  function resolve(ids) {
    if (!Array.isArray(ids) || ids.length > 3) reject('evidence_ids_invalid');
    const seen = new Set();
    return ids.map(id => {
      if (typeof id !== 'string' || !byId.has(id)) reject('evidence_id_unknown');
      if (seen.has(id)) reject('evidence_id_duplicate');
      seen.add(id);
      const entry = byId.get(id);
      return message.slice(entry.start, entry.end);
    });
  }
  return Object.freeze({ catalogue, metadata, entries: Object.freeze(entries), resolve });
}
