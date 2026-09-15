import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCosts, tokenPriceEstimate } from '../scripts/routing-cost-summary-v1.mjs';

test('cost estimates preserve cache detail and do not double count reasoning output', () => {
  const usage = { inputTokens: 100, outputTokens: 20, inputDetails: { cached_tokens: 30, cache_write_tokens: 10 } };
  const price = tokenPriceEstimate(usage);
  assert.equal(price.usd, (60 * .20 + 30 * .02 + 10 * .25 + 20 * 1.2) / 1e6);
  assert.equal(price.cacheBreakdownComplete, true);
  assert.equal(tokenPriceEstimate({ ...usage, inputDetails: {} }).cacheBreakdownComplete, false);
  assert.equal(tokenPriceEstimate({ ...usage, inputDetails: { cached_tokens: 101 } }), null);
});

test('per-question and dialogue accounting separates unknown, not_run, bypass and unseen answer costs', () => {
  const requests = ['a', 'b', 'c', 'd'].map((key) => ({ key, caseId: 'one', lane: key,
    requiresModel: key !== 'd', input: { question: 'synthetic', dialogue: [{ question: 'prior', answer: 'unpriced context' }] } }));
  const usage = { inputTokens: 100, outputTokens: 20, inputDetails: {}, costUpperBoundUsd: .000049 };
  const report = summarizeCosts({ planDigest: 'same', plan: { requests } },
    { planDigest: 'same', records: [{ key: 'a', validation: 'passed', receipt: { usage } }] },
    [{ event: 'reserved', key: 'a', reservedCostUsd: .01 }, { event: 'reserved', key: 'b', reservedCostUsd: .02 }]);
  assert.equal(report.total.attemptedCalls, 2);
  assert.equal(report.total.costUncertainCalls, 1);
  assert.equal(report.total.notRunCalls, 1);
  assert.equal(report.total.routingCostUpperBoundUsd, .020049);
  assert.equal(report.requests[1].routingPriceEstimateUsd, null);
  assert.equal(report.requests[2].routingCostUpperBoundUsd, null);
  assert.equal(report.requests[3].routingPriceEstimateUsd, 0);
  assert.equal(report.questions.length, 1);
  assert.equal(report.dialogues.length, 4);
  assert.ok(report.dialogues.every((d) => d.historicalContextGenerationUsd === null && d.answerGenerationUsd === null));
  assert.equal(report.invoice.usd, null);
  assert.throws(() => summarizeCosts({ planDigest: 'wrong' }, { planDigest: 'same' }, []), /cost_plan_mismatch/);
});
