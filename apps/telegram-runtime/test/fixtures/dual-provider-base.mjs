// Shared fake model for the two wave3 adapters, at the actual provider
// transport boundary (same pattern as managed-provider.mjs). Answers are
// derived from the incoming question only: the sha256 prefix of the question
// proves response-dependence (§11.1) without echoing private text.
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createProviderAdapter } from '../../src/provider-adapter.mjs';
import { workingStateProviderFromAnalyzer } from '../../src/working-state-updater.mjs';

export const ANSWER_MODEL = 'fixture-answer';
export const questionDigest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);

/** Test-only side channel: one line per model call, outside every pinned directory. */
function logCall(participant, stage) {
  const file = process.env.DUAL_FIXTURE_CALL_LOG;
  if (file) appendFileSync(file, `${JSON.stringify({ pid: process.pid, participant, stage })}\n`);
}

export function createFixtureProviders({ record, config, answer, wrapFetch = (fn) => fn }) {
  const participant = config?.instance?.participant_id ?? 'unknown';
  const tuple = (model) => ({ model, reasoningEffort: 'low', maxOutputTokens: 2048 });
  const fetchFn = async (_url, request) => {
    const body = JSON.parse(request.body); const input = JSON.parse(body.messages[1].content);
    const stage = input.completed_pair ? 'state' : input.current_turn ? 'analyzer' : body.model === ANSWER_MODEL ? 'answer' : 'router';
    record({ stage, input, system: body.messages[0].content });
    logCall(participant, stage);
    let content;
    if (stage === 'state') content = JSON.stringify({ base_revision: input.state.revision, operations: [] });
    else if (stage === 'analyzer') content = JSON.stringify({ topics: ['content'], topics_evidence: input.current_turn,
      context_dependent: true, level: { hypothesis: 'none', confidence: 'low', evidence: '' },
      intent: { kind: 'explicit', confidence: 'high', evidence: '', hidden_premise: null } });
    else if (stage === 'router') content = JSON.stringify({ action: 'teach', sourceId: 'course-content-v1' });
    else content = answer(input);
    return { ok: true, status: 200, async json() { return { model: body.model,
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }, choices: [{ finish_reason: 'stop', message: { content } }] }; } };
  };
  const wire = createProviderAdapter({ enabled: true, vendor: 'openai', endpoint: 'https://offline.invalid/v1', apiKey: 'fixture',
    modelTuples: { moderatorSafety: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', maxOutputTokens: 1024 },
      assistantRouter: tuple('fixture-router'), assistantAnswer: tuple(ANSWER_MODEL) } }, { fetchFn: wrapFetch(fetchFn) });
  return { provider: wire, stateProvider: workingStateProviderFromAnalyzer(wire) };
}
