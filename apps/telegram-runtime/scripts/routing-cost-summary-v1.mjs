#!/usr/bin/env node
/** Offline accounting for the bounded experiment; never a billing invoice. */
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const rates = Object.freeze({ input: 0.20, cached: 0.02, cacheWrite: 0.25, output: 1.20 });
export function tokenPriceEstimate(usage) {
  if (!usage) return null;
  const cached = usage.inputDetails?.cached_tokens ?? 0;
  const write = usage.inputDetails?.cache_write_tokens ?? 0;
  if (![usage.inputTokens, usage.outputTokens, cached, write].every((n) => Number.isSafeInteger(n) && n >= 0)
    || cached + write > usage.inputTokens) return null;
  return { usd: ((usage.inputTokens - cached - write) * rates.input + cached * rates.cached
      + write * rates.cacheWrite + usage.outputTokens * rates.output) / 1e6,
    cacheBreakdownComplete: Object.hasOwn(usage.inputDetails || {}, 'cached_tokens')
      && Object.hasOwn(usage.inputDetails || {}, 'cache_write_tokens'),
    assumption: 'Absent cache detail is treated as zero only for this price estimate; conservative bound is separate.' };
}

export function summarizeCosts(manifest, capture, journal) {
  if (manifest.planDigest !== capture.planDigest) throw new Error('cost_plan_mismatch');
  const reserved = new Map(journal.filter((r) => r.event === 'reserved').map((r) => [r.key, r]));
  const recorded = new Map(capture.records.map((r) => [r.key, r]));
  const requests = manifest.plan.requests.map((r) => {
    const reservation = reserved.get(r.key), rec = recorded.get(r.key), usage = rec?.receipt?.usage;
    const price = tokenPriceEstimate(usage);
    const bypass = !r.requiresModel;
    return { key: r.key, caseId: r.caseId, lane: r.lane, syntheticDialogueId: r.key,
      question: r.input.question ?? r.input.current_turn,
      contextTurns: r.input.dialogue?.length || 0,
      status: bypass ? 'legacy_deterministic_bypass' : !reservation ? 'not_run'
        : !usage ? 'attempted_cost_uncertain' : rec.validation,
      attempted: Boolean(reservation), usage: usage || null,
      routingPriceEstimateUsd: bypass ? 0 : price?.usd ?? null,
      routingCostUpperBoundUsd: bypass ? 0 : usage?.costUpperBoundUsd ?? reservation?.reservedCostUsd ?? null,
      reservedCostUpperBoundUsd: reservation?.reservedCostUsd ?? null,
      cacheBreakdownComplete: price?.cacheBreakdownComplete ?? null,
      answerGeneration: { status: 'not_run', usd: null }, historicalContextGenerationUsd: null };
  });
  const aggregate = (rows) => ({ attemptedCalls: rows.filter((r) => r.attempted).length,
    costUncertainCalls: rows.filter((r) => r.attempted && r.routingPriceEstimateUsd === null).length,
    notRunCalls: rows.filter((r) => r.status === 'not_run').length,
    knownRoutingPriceEstimateUsd: rows.reduce((n, r) => n + (r.routingPriceEstimateUsd ?? 0), 0),
    routingCostUpperBoundUsd: rows.reduce((n, r) => n + (r.routingCostUpperBoundUsd ?? 0), 0),
    answerGenerationUsd: null });
  return { schemaVersion: 'routing-dollar-accounting-v1', planDigest: manifest.planDigest,
    ratesUsdPerMillion: rates, ratesSource: 'https://developers.openai.com/api/docs/pricing',
    invoice: { status: 'unavailable', usd: null },
    notes: ['Price estimates use reported token counts, with absent cache details assumed zero; they are not invoices.',
      'Each case/lane is an independent synthetic dialogue with one measured current turn. Historical context was not generated in this run.',
      'Question totals sum old/new router/analyzer experiments, not the price of one production answer.',
      'Unattempted calls are not_run, not measured zero. Answer generation remains outside scope.'],
    total: aggregate(requests), requests,
    questions: [...new Set(requests.map((r) => r.caseId))].map((caseId) => ({ caseId,
      ...aggregate(requests.filter((r) => r.caseId === caseId)) })),
    dialogues: requests.map((r) => ({ syntheticDialogueId: r.syntheticDialogueId,
      caseId: r.caseId, lane: r.lane, contextTurns: r.contextTurns, measuredTurns: r.attempted ? 1 : 0,
      ...aggregate([r]), historicalContextGenerationUsd: null })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('usage: routing-cost-summary-v1.mjs RUN_DIRECTORY');
  const dir = resolve(args[0]);
  const json = (name) => JSON.parse(readFileSync(resolve(dir, name), 'utf8'));
  const journal = readFileSync(resolve(dir, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const summary = summarizeCosts(json('manifest.json'), json('capture.json'), journal);
  const fd = openSync(resolve(dir, 'cost-summary.json'), 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(summary, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  console.log(JSON.stringify(summary.total));
}
