import { classifySafetyV3 } from '../../src/safety-v3.mjs';

/** Explicit synthetic lab substitution, never production recognition.
 * Only the real strict parser executes; there is no network/model invocation. */
export async function labSafetyVerdict({ text, currentWeakStrikes = 0, warningStage = null }) {
  const parsed = await classifySafetyV3({ message: text, context: { currentWeakStrikes, warningStage },
    async invoke() {
      return { text: JSON.stringify({
        threat: { match: false, types: [], confidence: 1, evidence: [] },
        abuse: { match: false, types: [], confidence: 1, evidence: [] },
        target: 'none', context_used: false,
      }) };
    },
  });
  return { ...parsed, reason: 'lab_local_judge', modelId: 'lab',
    safetyTrace: { ...parsed.safetyTrace, receipts: [], usage: {
      calls: 0, failed: 0, inputTokens: null, outputTokens: null, totalTokens: null,
      costUsd: 0, modelId: 'lab', vendor: 'local', reasoningEffort: null,
    } },
  };
}
