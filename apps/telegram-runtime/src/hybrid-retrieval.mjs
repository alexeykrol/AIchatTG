/**
 * Pure pieces of the hybrid (words + vectors) retrieval, ported 1:1 from the
 * offline recipe that won the held-out measurement:
 *   scripts/eval/hybrid_candidates.py  — passage pieces, vector ranking, RRF fusion;
 *   scripts/eval/expand_links.py       — passage-link expansion.
 * No I/O here: the retriever adapter reads the package, this module only ranks.
 */

export const RRF_K = 60;
export const DEFAULT_LINK_TYPES = Object.freeze(['contradicts', 'qualifies']);
export const LINK_TYPES = Object.freeze(['contradicts', 'qualifies', 'continues', 'applies']);

// Python: re.compile(r'(?<=[.!?…])\s+')
const SENT = /(?<=[.!?…])\s+/u;

/**
 * Three-sentence windows with stride 2 over the whitespace-collapsed text
 * (`windows()` of hybrid_candidates.py).
 */
export function sentenceWindows(text, size = 3) {
  const collapsed = String(text ?? '').split(/\s+/u).filter(Boolean).join(' ');
  const sents = collapsed.split(SENT).filter((s) => s.trim());
  if (sents.length <= size) return sents.length ? [sents.join(' ')] : [];
  const out = [];
  for (let i = 0; i <= sents.length - size; i += 2) out.push(sents.slice(i, i + size).join(' '));
  return out;
}

/** Every text that represents one passage in vector space: windows + each alias line. */
export function passagePieces(content, alias = '', { includeAlias = true } = {}) {
  const pieces = sentenceWindows(content);
  if (includeAlias) {
    for (const line of String(alias ?? '').split('\n')) if (line.trim()) pieces.push(line);
  }
  return pieces;
}

/**
 * Rank passages by their best piece cosine against an L2-normalized query.
 * `index` = { ids: string[], owner: Int32Array (piece -> passage idx),
 *             matrix: Float32Array (pieces × dim), dim }.
 * `allowed` (optional Set of ids) restricts the ranking. Ties keep package order,
 * as numpy's stable argsort does.
 */
export function vectorRanking(index, query, { allowed = null } = {}) {
  const { ids, owner, matrix, dim } = index;
  const scores = new Float64Array(ids.length).fill(-2);
  const pieces = owner.length;
  for (let p = 0; p < pieces; p += 1) {
    let dot = 0;
    const base = p * dim;
    for (let d = 0; d < dim; d += 1) dot += matrix[base + d] * query[d];
    const i = owner[p];
    if (dot > scores[i]) scores[i] = dot;
  }
  const order = [];
  for (let i = 0; i < ids.length; i += 1) {
    if (allowed && !allowed.has(ids[i])) continue;
    order.push(i);
  }
  order.sort((a, b) => (scores[b] - scores[a]) || (a - b));
  return order.map((i) => ({ id: ids[i], score: scores[i] }));
}

/**
 * Reciprocal-rank fusion with equal weights, 1/(k + rank + 1), of the lexical
 * order and the top `vectorDepth` vector ranks; keeps `top`. Ties keep first
 * insertion (lexical before vector-only), as Python's stable sort over a dict.
 */
export function rrfFuse(lexicalIds, vectorIds, { k = RRF_K, vectorDepth, top }) {
  const fused = new Map();
  const add = (id, rank, key) => {
    const cur = fused.get(id) || { id, score: 0, lexRank: null, vecRank: null };
    cur.score += 1 / (k + rank + 1);
    cur[key] = rank;
    fused.set(id, cur);
  };
  lexicalIds.forEach((id, rank) => add(id, rank, 'lexRank'));
  vectorIds.slice(0, vectorDepth).forEach((id, rank) => add(id, rank, 'vecRank'));
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, top);
}

/**
 * Undirected neighbour lists from passage_links rows (in table order), only for
 * the listed types — `nb` of expand_links.py.
 */
export function linkNeighbours(rows, types) {
  const allowed = new Set(types);
  const nb = new Map();
  const push = (a, b, type) => {
    if (!nb.has(a)) nb.set(a, []);
    nb.get(a).push({ id: b, type });
  };
  for (const row of rows) {
    if (!allowed.has(row.type)) continue;
    push(row.a, row.b, row.type);
    push(row.b, row.a, row.type);
  }
  return nb;
}

/** After the context, append up to `max` passages linked to any of its passages. */
export function expandLinks(ids, neighbours, max) {
  const present = new Set(ids);
  const added = [];
  for (const id of ids) {
    for (const other of neighbours.get(id) || []) {
      if (added.length >= max) break;
      if (present.has(other.id)) continue;
      present.add(other.id);
      added.push({ id: other.id, via: id, type: other.type });
    }
  }
  return added;
}
