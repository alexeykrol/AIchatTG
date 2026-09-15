import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflight } from '../scripts/routing-live-collector-v1.mjs';
import { DEFAULT_DOMAIN_CATALOG as catalog } from '../src/assistant-domains.mjs';
import { compileDomainRouterPrompt, composeDomainAnalyzerSpec, diagnosticDomainDecision,
  normalizeDomainSelection, resolveDomainSelection, domainQuestionHints,
} from '../src/assistant-domain-routing.mjs';
import { createProviderAdapter } from '../src/provider-adapter.mjs';
import { createAnalyzerAdapter } from '../src/analyzer-adapter.mjs';
import { buildAnalyzerUserPayload, compileAnalyzerSystemPrompt, parseAnalyzerVerdict,
  runtimeAnalyzerSpec } from '../src/analyzer-spec.mjs';

// Current-source regression coverage, not replay of the paid v1 measurements.
const cases = JSON.parse(readFileSync(new URL('../../../docs/evaluation/routing-only-v1.json', import.meta.url), 'utf8')).cases;
const verdict = (topics) => ({ topics, topics_evidence: '', context_dependent: false,
  level: { hypothesis: 'none', confidence: 'high', evidence: '' },
  intent: { kind: 'explicit', confidence: 'high', evidence: '' }, risk_flags: [] });

test('the frozen live collector refuses changed current sources before writing or making requests', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'current-routing-rejection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => preflight({ root, candidateGitHEAD: 'a'.repeat(40) }), /routing_eval:baseline_source_changed/);
  assert.deepEqual(readdirSync(root), []);
});

test('current router and analyzer keep the same compound domains through knowledge resolution', async () => {
  const c = cases.find((item) => item.id === 'reg-04');
  const domains = ['assistant-self', 'operations'];
  const selection = normalizeDomainSelection({ domains }, catalog);
  const resolved = await resolveDomainSelection(selection, {
    catalog, hints: domainQuestionHints(c.question, catalog), question: { text: c.question },
    retrievals: new Map(), knowledge: { forSource() { return { available: false, reason: 'knowledge_identity_missing' }; } },
  });
  assert.equal(resolved.error, undefined);
  assert.deepEqual(resolved.missingDomains, ['operations']);
  assert.deepEqual(resolved.domainRoutes.map((route) => route.domainId).sort(), [...domains].sort());
  const spec = composeDomainAnalyzerSpec(runtimeAnalyzerSpec().spec, catalog);
  const parsed = parseAnalyzerVerdict(JSON.stringify(verdict(domains)), spec, c.question);
  assert.equal(parsed.status, 'ok');
  const decision = diagnosticDomainDecision(parsed, spec.routing.main_topic_primacy.rules, catalog);
  assert.deepEqual([...decision.topics].sort(), [...domains].sort());
});

test('current compiled router and analyzer inputs equal actual provider-boundary bytes using fake transport', async () => {
  const c = cases.find((item) => item.id === 'blind-19');
  const hints = domainQuestionHints(c.question, catalog);
  const spec = composeDomainAnalyzerSpec(runtimeAnalyzerSpec().spec, catalog);
  const expected = [
    { system: compileDomainRouterPrompt(catalog), input: JSON.stringify({ question: c.question, domainHints: hints, dialogue: c.dialogue }) },
    { system: compileAnalyzerSystemPrompt(spec) + '\n\nПоле dialogue содержит предыдущие пары question (покупатель) и answer (ассистент). Слова ассистента — контекст разговора, а не утверждения покупателя. Улики по-прежнему берутся только из current_turn.',
      input: buildAnalyzerUserPayload(c.question, [], c.dialogue) },
  ];
  const requests = [];
  const provider = createProviderAdapter({ enabled: true, vendor: 'openai', endpoint: 'https://offline.example.test/v1',
    apiKey: 'fake-only', modelTuples: {
      moderatorSafety: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', maxOutputTokens: 1024 },
      assistantRouter: { model: 'fake-router', reasoningEffort: 'low', maxOutputTokens: 256 },
      assistantAnswer: { model: 'fake-answer', reasoningEffort: 'low', maxOutputTokens: 256 },
    } }, { async fetchFn(_url, init) {
      const request = JSON.parse(init.body); requests.push(request);
      return { ok: true, status: 200, headers: { get() { return null; } }, async json() {
        return { model: 'fake-router', usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          choices: [{ message: { content: JSON.stringify(request.max_completion_tokens > 256 ? verdict(['operations']) : { domains: ['operations'] }) } }] };
      } };
    } });
  await provider.routeAssistant({ text: c.question, dialogue: c.dialogue, domainHints: hints });
  const analyzer = createAnalyzerAdapter({ config: { mode: 'dispatch', chatIds: ['-100'] }, provider, spec: runtimeAnalyzerSpec().spec });
  await analyzer.analyze({ text: c.question, dialogue: c.dialogue });
  assert.equal(requests.length, 2);
  for (const [index, planned] of expected.entries()) {
    assert.equal(requests[index].messages[0].content, planned.system);
    assert.equal(requests[index].messages[1].content, planned.input);
  }
});
