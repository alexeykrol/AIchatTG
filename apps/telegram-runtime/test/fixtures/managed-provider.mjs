// A fake model at the actual provider transport boundary. This file is pinned.
import { createProviderAdapter } from '../../src/provider-adapter.mjs';
import { workingStateProviderFromAnalyzer } from '../../src/working-state-updater.mjs';
export function createManagedProviders({ record }) {
  const tuple = (model) => ({ model, reasoningEffort: 'low', maxOutputTokens: 2048 });
  const wire = createProviderAdapter({ enabled: true, vendor: 'openai', endpoint: 'https://offline.invalid/v1', apiKey: 'fixture',
    modelTuples: { moderatorSafety: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', maxOutputTokens: 1024 },
      assistantRouter: tuple('fixture-router'), assistantAnswer: tuple('fixture-answer') } }, {
    fetchFn: async (_url, request) => {
      const body = JSON.parse(request.body); const input = JSON.parse(body.messages[1].content);
      const stage = input.completed_pair ? 'state' : input.current_turn ? 'analyzer' : body.model === 'fixture-answer' ? 'answer' : 'router';
      record({ stage, input, system: body.messages[0].content });
      let content;
      if (stage === 'state') {
        // Scripted test answers, not the state implementation. Tests exercise the same strict model JSON boundary.
        const pair = input.completed_pair; const text = pair.user.text;
        const ops = [];
        if (text.includes('budget=100')) ops.push({ op: 'upsert', id: 'budget', kind: 'condition', value: '100', status: 'active', evidence: { turn_id: pair.user.turn_id, role: 'user', quote: 'budget=100' } });
        if (text.includes('budget=200')) ops.push({ op: 'upsert', id: 'budget', kind: 'condition', value: '200', status: 'active', evidence: { turn_id: pair.user.turn_id, role: 'user', quote: 'budget=200' } });
        content = JSON.stringify({ base_revision: input.state.revision, operations: ops });
      } else if (stage === 'analyzer') content = JSON.stringify({ topics: ['content'], topics_evidence: input.current_turn,
        context_dependent: true, level: { hypothesis: 'none', confidence: 'low', evidence: '' },
        intent: { kind: 'explicit', confidence: 'high', evidence: '', hidden_premise: null } });
      else if (stage === 'router') content = JSON.stringify({ action: 'teach', sourceId: 'course-content-v1' });
      else content = `Assistant reply about prompting: ${input.question}`;
      return { ok: true, status: 200, async json() { return { model: body.model,
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }, choices: [{ message: { content } }] }; } };
    },
  });
  return { provider: wire, stateProvider: workingStateProviderFromAnalyzer(wire) };
}
