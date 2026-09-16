import test from 'node:test';
import assert from 'node:assert/strict';
import { labSafetyVerdict } from '../scripts/lib/lab-safety.mjs';
import { validateJudgementSemantic } from '../src/safety-v3.mjs';

test('lab safety uses the strict parser without network or invented paid inference', async () => {
  const before = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network forbidden'); };
  try {
    const verdict = await labSafetyVerdict({ text: '/ask local fixture' });
    assert.equal(validateJudgementSemantic(verdict, '/ask local fixture'), true);
    assert.equal(verdict.reason, 'lab_local_judge');
    assert.equal(verdict.modelId, 'lab');
    assert.deepEqual(verdict.safetyTrace.usage, { calls: 0, failed: 0,
      inputTokens: null, outputTokens: null, totalTokens: null, costUsd: 0,
      modelId: 'lab', vendor: 'local', reasoningEffort: null });
    assert.deepEqual(verdict.safetyTrace.receipts, []);
  } finally { globalThis.fetch = before; }
});
