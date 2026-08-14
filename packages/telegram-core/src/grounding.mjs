/**
 * Input-layer step 6→7 boundary: turning one retrieval pack into the knowledge
 * the answer model receives. Everything here is pure — no database, no provider,
 * no clock — so the projection that decides what a user's answer may be built
 * from is testable offline and identical in the runtime and in a test.
 *
 * Two rules carry the weight:
 *  - a citation survives to the model (`title`, `canonicalUrl`), because an
 *    answer without a link to the lesson breaks the funnel it exists to serve;
 *  - the front's hard caps (128 entries, 60 000 characters of request JSON) are
 *    honoured by deterministic truncation in relevance order, and the fact that
 *    truncation happened is recorded rather than hidden.
 */

/** The provider's own limits, restated here so the projection cannot exceed them. */
export const GROUNDING_MAX_ENTRIES = 128;
export const GROUNDING_MAX_CHARS = 60_000;

// The request JSON also carries the question, route and dialogue. This reserve
// keeps the entries below the ceiling once those are serialized around them.
export const GROUNDING_CHAR_RESERVE = 6_000;

export const GROUNDING_REASONS = Object.freeze({
  PACK_MISSING: 'grounding_pack_missing',
  NOT_FOUND: 'grounding_not_found',
  EMPTY: 'grounding_empty',
});

/** Pack statuses that carry no usable grounding: the honest answer is abstention. */
const UNGROUNDED_STATUSES = new Set(['not_found', 'error']);

function boundedTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  return title ? title.slice(0, 200) : null;
}

function boundedUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2_048) return null;
  try { return new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
}

/**
 * Project a pack into `{sourceId, entries}` for the answer model.
 *
 * Truncation is deterministic and in pack order, which is descending relevance:
 * when the caps bite, the entries that survive are the best ones, and the same
 * pack always produces the same input. A budget too small for even one entry is
 * reported as `grounding_empty` rather than silently sending nothing.
 */
export function groundingFromPack(pack, {
  sourceId,
  maxEntries = GROUNDING_MAX_ENTRIES,
  maxChars = GROUNDING_MAX_CHARS,
  charReserve = GROUNDING_CHAR_RESERVE,
} = {}) {
  if (!pack || typeof pack !== 'object' || !Array.isArray(pack.entries)) {
    return { grounded: false, reason: GROUNDING_REASONS.PACK_MISSING, knowledge: null, trace: null };
  }
  if (UNGROUNDED_STATUSES.has(String(pack.status || ''))) {
    return {
      grounded: false,
      reason: GROUNDING_REASONS.NOT_FOUND,
      knowledge: null,
      trace: Object.freeze({
        status: pack.status, offered: pack.entries.length, used: 0,
        droppedByEntryCap: 0, droppedByCharCap: 0, chars: 0,
      }),
    };
  }

  const citations = pack.citations && typeof pack.citations === 'object' ? pack.citations : {};
  const entryCap = Math.max(0, Math.min(GROUNDING_MAX_ENTRIES, Number(maxEntries) || 0));
  const charCap = Math.max(0, (Number(maxChars) || 0) - Math.max(0, Number(charReserve) || 0));

  const entries = [];
  let chars = 0;
  let droppedByEntryCap = 0;
  let droppedByCharCap = 0;

  for (const source of pack.entries) {
    const id = String(source?.id || '');
    const content = String(source?.content ?? '');
    if (!id) continue;
    if (entries.length >= entryCap) { droppedByEntryCap += 1; continue; }
    const citation = citations[id] || {};
    const entry = {
      id,
      content,
      ...(boundedTitle(citation.title) == null ? {} : { title: boundedTitle(citation.title) }),
      ...(boundedUrl(citation.canonicalUrl) == null ? {} : { canonicalUrl: boundedUrl(citation.canonicalUrl) }),
    };
    // Measured on the serialized entry, because the cap the front enforces is on
    // the JSON it sends, not on the raw text.
    const cost = JSON.stringify(entry).length;
    if (chars + cost > charCap) {
      // Deliberately `continue`, not `break`: a single oversized chunk must not
      // discard the shorter, still relevant entries ranked behind it.
      droppedByCharCap += 1;
      continue;
    }
    entries.push(entry);
    chars += cost;
  }

  const trace = Object.freeze({
    status: pack.status,
    offered: pack.entries.length,
    used: entries.length,
    droppedByEntryCap,
    droppedByCharCap,
    chars,
  });
  if (!entries.length) {
    return { grounded: false, reason: GROUNDING_REASONS.EMPTY, knowledge: null, trace };
  }
  return {
    grounded: true,
    reason: null,
    knowledge: { sourceId: String(sourceId || ''), entries },
    trace,
  };
}
