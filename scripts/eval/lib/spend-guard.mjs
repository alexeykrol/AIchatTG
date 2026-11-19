/**
 * Hard spend guard for a paid eval run. It wraps the transport (`fetchFn`), so no model call can bypass it.
 *
 * Before each call it reserves a cost CEILING computed from the outgoing request:
 *   input ceiling  = UTF-8 bytes of system + messages + a fixed overhead. Claude's tokenizer is byte-level,
 *                    so a text cannot produce more tokens than it has bytes: this is an upper bound, not an
 *                    estimate (Russian text costs ~2 bytes per char, so the ceiling is generous);
 *   output ceiling = `max_tokens` of the request (thinking tokens are billed as output and are inside it).
 * If money already settled + all open reservations + this ceiling would exceed the tranche cap, the call is
 * refused BEFORE the network and the run stops (`SpendCapReached`). After the response the reservation is
 * replaced by the actual cost from `usage`; a call whose usage is unknown keeps its full ceiling as spent.
 * Every call (allowed, refused, failed) is appended to the run journal with tokens and cost.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OVERHEAD_TOKENS = 64; // message framing; generous against the documented per-request overhead

/** USD per million tokens. Source: claude-api skill `shared/models.md` (Claude Code 2.1.326 bundle),
 * read 2026-11-19, not a live fetch; same figures as agi2claude `pricing.yaml`. Override on the CLI. */
export const PUBLISHED_PRICES = Object.freeze({
  'claude-sonnet-5-5': Object.freeze({ input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 2.5 }),
  'claude-opus-5-5': Object.freeze({ input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 }),
  'claude-haiku-5-5': Object.freeze({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }),
});

export class SpendCapReached extends Error {
  constructor(detail) {
    super(`spend cap reached: ${JSON.stringify(detail)}`);
    this.name = 'SpendCapReached';
    this.detail = detail;
  }
}

export function inputTokenCeiling(messagesRequest) {
  const parts = [messagesRequest.system || '', ...(messagesRequest.messages || [])
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))];
  return parts.reduce((n, s) => n + Buffer.byteLength(String(s), 'utf8'), 0) + OVERHEAD_TOKENS;
}

export function costUsd(usage, price) {
  const u = usage || {};
  return ((u.input_tokens || 0) * price.input + (u.output_tokens || 0) * price.output
    + (u.cache_read_input_tokens || 0) * (price.cacheRead ?? price.input)
    + (u.cache_creation_input_tokens || 0) * (price.cacheWrite ?? price.input)) / 1e6;
}

/**
 * @param {object} o
 * @param {number} o.capUsd        tranche cap for this run (required, > 0)
 * @param {{input:number, output:number}} o.price  USD per million tokens
 * @param {string|null} o.journalPath  JSONL file; null keeps the journal in memory only (tests)
 * @param {number} [o.alreadySpentUsd] money spent by earlier parts of the same tranche
 */
export function createSpendGuard({ capUsd, price, journalPath = null, alreadySpentUsd = 0, now = () => new Date() }) {
  if (!(Number(capUsd) > 0)) throw new Error('spend_cap_required');
  if (!(price?.input > 0) || !(price?.output > 0)) throw new Error('spend_price_required');
  let settled = Number(alreadySpentUsd) || 0;
  let reserved = 0;
  let stopped = null;
  const journal = [];
  if (journalPath) mkdirSync(dirname(journalPath), { recursive: true });
  function write(row) {
    const line = { at: now().toISOString(), ...row };
    journal.push(line);
    if (journalPath) appendFileSync(journalPath, `${JSON.stringify(line)}\n`);
  }

  /** Reserve the ceiling of one Messages request; throws SpendCapReached instead of allowing the call. */
  function reserve(messagesRequest, tag = null) {
    if (stopped) throw new SpendCapReached(stopped);
    const inTok = inputTokenCeiling(messagesRequest);
    const outTok = Number(messagesRequest.max_tokens) || 0;
    const ceiling = (inTok * price.input + outTok * price.output) / 1e6;
    if (settled + reserved + ceiling > capUsd) {
      stopped = { capUsd, settledUsd: settled, openReservationsUsd: reserved, nextCeilingUsd: ceiling, tag };
      write({ event: 'refused', tag, ceilingUsd: ceiling, settledUsd: settled, capUsd });
      throw new SpendCapReached(stopped);
    }
    reserved += ceiling;
    return { tag, ceiling, inTok, outTok };
  }

  /** Replace a reservation by the actual cost; usage null = unknown, the full ceiling counts as spent. */
  function settle(r, { usage = null, status = null, stopReason = null, model = null } = {}) {
    reserved -= r.ceiling;
    const actual = usage ? costUsd(usage, price) : r.ceiling;
    settled += actual;
    write({ event: 'call', tag: r.tag, model, status, stopReason, ceilingUsd: r.ceiling,
      costUsd: actual, costKnown: Boolean(usage), usage, settledUsd: settled, capUsd });
    return actual;
  }

  /** Wrap a transport that speaks the Messages API. */
  function wrapFetch(fetchFn, { tagOf = () => null } = {}) {
    return async function guardedFetch(url, init = {}) {
      const body = JSON.parse(init.body);
      const r = reserve(body, tagOf(body));
      let res;
      try { res = await fetchFn(url, init); } catch (error) {
        settle(r, { status: 'transport_failed' });
        throw error;
      }
      // Read the body once here, hand a replayable copy back to the caller.
      let raw = null;
      try { raw = await res.json(); } catch { raw = null; }
      settle(r, { usage: res.ok ? raw?.usage ?? null : null, status: res.status,
        stopReason: raw?.stop_reason ?? null, model: raw?.model ?? null });
      return { ok: res.ok, status: res.status, headers: res.headers, json: async () => raw };
    };
  }

  return Object.freeze({
    reserve, settle, wrapFetch,
    spentUsd: () => settled, openReservationsUsd: () => reserved,
    stopped: () => stopped, journal: () => journal.slice(),
  });
}
