import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_DOMAIN_CATALOG, loadDomainCatalog } from '../src/assistant-domains.mjs';
import { compileDomainRouterPrompt } from '../src/assistant-domain-routing.mjs';
import { normalizeDomainSelection, resolveDomainSelection } from '../src/assistant-domain-routing.mjs';
import { answerSystemPrompt, createProviderAdapter, ProviderRequestError } from '../src/provider-adapter.mjs';
import { createAnalyzerAdapter } from '../src/analyzer-adapter.mjs';
import { runtimeAnalyzerSpec } from '../src/analyzer-spec.mjs';

function catalogFixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-provider-domains-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const blocks = ['orchard', 'navigation', 'archive'].map((id) => {
    writeFileSync(join(folder, `${id}.md`), `# ${id} evidence\n\n${id.toUpperCase()}_EVIDENCE_ONLY\n`);
    return [
      `## ${id}`, '### Title', `${id} fixture`, '### Description', `DESCRIPTION_${id}`,
      '### Includes', `INCLUDES_${id}`, '### Excludes', `EXCLUDES_${id}`,
      '### Examples', `- POSITIVE_${id}`, '### Negative examples', `- NEGATIVE_${id}`,
      '### Capability', `Explain ${id}.`, '### Action', 'explain',
      '### Source', `${id}-v1`, '### Source kind', 'markdown', '### Knowledge', `${id}.md`,
      '### Answer policy', `TRUSTED_POLICY_${id}: use only this domain's admitted facts.`, '',
    ].join('\n');
  });
  const indexPath = join(folder, 'INDEX.md');
  writeFileSync(indexPath, `# Assistant domain registry\n\n${blocks.join('\n')}\n`);
  return loadDomainCatalog({ indexPath });
}

function adapterFixture(catalog) {
  const requests = [];
  const adapter = createProviderAdapter({
    enabled: true, vendor: 'openai', endpoint: 'https://offline.example.test/v1', apiKey: 'fake-test-only',
    modelTuples: {
      moderatorSafety: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', maxOutputTokens: 1024 },
      assistantRouter: { model: 'router-fixture', reasoningEffort: 'none', maxOutputTokens: 120 },
      assistantAnswer: { model: 'answer-fixture', reasoningEffort: 'low', maxOutputTokens: 300 },
    },
  }, {
    domainCatalog: catalog,
    async fetchFn(_url, options) {
      const request = JSON.parse(options.body);
      requests.push(request);
      return {
        ok: true, status: 200, headers: { get() { return null; } },
        async json() {
          return { model: request.model, usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
            choices: [{ message: { content: request.response_format
              ? '{"domains":["orchard"],"riskFlags":[]}' : 'Offline grounded answer.' } }] };
        },
      };
    },
  });
  return { adapter, requests };
}

function singlePayload(catalog, id = 'orchard') {
  return {
    text: 'Explain this reviewed topic.', dialogue: [], route: catalog.routeFor(id),
    domainRoutes: [catalog.routeFor(id)],
    domainCoverage: [{ domainId: id, sourceId: `${id}-v1`, status: 'available', reason: null }],
    missingDomains: [], riskFlags: [], registryDigest: catalog.digest,
    knowledge: catalog.markdownKnowledge(id),
  };
}

test('the real analyzer adapter recognizes the custom catalog vocabulary and independent risks', async (t) => {
  const catalog = catalogFixture(t);
  const seen = [];
  const response = { topics: ['orchard', 'navigation'], risk_flags: ['privacy'],
    topics_evidence: 'seeds', context_dependent: false,
    level: { hypothesis: 'none', confidence: 'high', evidence: '' },
    intent: { kind: 'explicit', confidence: 'high', evidence: 'seeds' } };
  const adapter = createAnalyzerAdapter({ domainCatalog: catalog, spec: runtimeAnalyzerSpec().spec,
    config: { mode: 'dispatch', chatIds: ['-100'] },
    provider: { async analyze(input) { seen.push(input); return { text: JSON.stringify(response), modelId: 'offline' }; } } });
  const result = await adapter.analyze({ text: 'Explain seeds and locate the guide.' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.verdict.topics, ['orchard', 'navigation']);
  assert.deepEqual(result.verdict.riskFlags, ['privacy']);
  assert.equal(adapter.domainCatalogDigest, catalog.digest);
  assert.match(seen[0].system, /DESCRIPTION_orchard/);
  assert.match(seen[0].system, /EXCLUDES_orchard/);
  assert.match(seen[0].system, /NEGATIVE_orchard/);
  assert.deepEqual(adapter.domainPrimacyRules, [], 'legacy policy cannot inject a missing value domain');
  response.topics = ['content'];
  assert.equal((await adapter.analyze({ text: 'Explain seeds.' })).status, 'invalid');
  response.topics = ['orchard'];
  response.risk_flags = ['invented'];
  assert.equal((await adapter.analyze({ text: 'Explain seeds.' })).status, 'invalid');
});

function mixedPayload(catalog, missing = ['archive']) {
  const ids = ['orchard', 'navigation', 'archive'];
  return {
    text: 'Explain all three parts.', dialogue: [], route: catalog.routeFor(ids[0]),
    domainRoutes: ids.map((id) => catalog.routeFor(id)),
    domainCoverage: ids.map((id) => ({ domainId: id, sourceId: `${id}-v1`,
      status: missing.includes(id) ? 'missing' : 'available', reason: missing.includes(id) ? 'knowledge_unavailable' : null })),
    missingDomains: missing, riskFlags: ['privacy'], registryDigest: catalog.digest,
    knowledge: { sourceId: `${ids.find((id) => !missing.includes(id))}-v1`, entries: ids.filter((id) => !missing.includes(id))
      .flatMap((id) => catalog.markdownKnowledge(id).entries.map((entry) => ({ ...entry, domainId: id, sourceId: `${id}-v1` }))) },
  };
}

test('a real provider adapter compiles the custom catalog and selects its trusted answer policy', async (t) => {
  const catalog = catalogFixture(t);
  const { adapter, requests } = adapterFixture(catalog);
  assert.equal(adapter.domainCatalogDigest, catalog.digest);
  const routed = await adapter.routeAssistant({ text: 'Explain seeds.', registryDigest: catalog.digest,
    domainHints: { domains: ['orchard'] } });
  assert.deepEqual(routed.domains, ['orchard']);
  assert.equal(requests[0].messages[0].content, compileDomainRouterPrompt(catalog));
  assert.deepEqual(JSON.parse(requests[0].messages[1].content).domainHints, { domains: ['orchard'] });
  assert.match(requests[0].messages[0].content, /EXCLUDES_orchard/);
  assert.match(requests[0].messages[0].content, /NEGATIVE_orchard/);
  assert.doesNotMatch(requests[0].messages[0].content, /course-operations/);
  const answer = await adapter.answer({ ...singlePayload(catalog), answerPolicy: 'UNTRUSTED_POLICY_DO_NOT_USE' });
  assert.equal(answer.receipt.totalTokens, 16);
  assert.equal(requests[1].model, 'answer-fixture');
  assert.equal(requests[1].max_completion_tokens, 300);
  assert.match(requests[1].messages[0].content, /TRUSTED_POLICY_orchard/);
  assert.doesNotMatch(JSON.stringify(requests[1]), /UNTRUSTED_POLICY_DO_NOT_USE|TRUSTED_POLICY_navigation/);
  const input = JSON.parse(requests[1].messages[1].content);
  assert.deepEqual(input.domainRoutes, [catalog.routeFor('orchard')]);
  assert.equal(input.registryDigest, catalog.digest);
  assert.equal(input.knowledge.entries[0].content, 'ORCHARD_EVIDENCE_ONLY');
});

test('invalid domain, action, source, coverage and registry claims fail before transport', async (t) => {
  const catalog = catalogFixture(t);
  const { adapter, requests } = adapterFixture(catalog);
  const base = singlePayload(catalog);
  const invalid = [
    { ...base, route: { domainId: 'unknown' } },
    { ...base, route: { ...base.route, action: 'unregistered' } },
    { ...base, route: { ...base.route, sourceId: 'navigation-v1' } },
    { ...base, registryDigest: '0'.repeat(64) },
    { ...base, knowledge: { ...base.knowledge, sourceId: 'navigation-v1' } },
    { ...base, domainRoutes: [catalog.routeFor('navigation')] },
    { ...base, domainRoutes: [base.route, base.route] },
    { ...base, domainCoverage: [{ domainId: 'orchard', sourceId: 'navigation-v1', status: 'available' }] },
    { ...base, missingDomains: ['orchard'] },
    { ...base, riskFlags: ['invented-risk'] },
    { ...base, knowledge: { ...base.knowledge, entries: [{ id: 'empty', content: ' ' }] } },
  ];
  for (const payload of invalid) await assert.rejects(adapter.answer(payload),
    (error) => error instanceof ProviderRequestError && error.code === 'provider_request_invalid');
  await assert.rejects(adapter.routeAssistant({ text: 'Question', registryDigest: 'wrong' }),
    (error) => error.code === 'provider_request_invalid');
  assert.equal(requests.length, 0);
});

test('mixed knowledge preserves attribution and missing metadata without granting missing-domain policy', async (t) => {
  const catalog = catalogFixture(t);
  const { adapter, requests } = adapterFixture(catalog);
  const payload = mixedPayload(catalog);
  await adapter.answer(payload);
  const input = JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(input.domainCoverage, payload.domainCoverage);
  assert.deepEqual(input.missingDomains, ['archive']);
  assert.deepEqual(input.riskFlags, ['privacy']);
  assert.deepEqual(input.knowledge.entries, payload.knowledge.entries);
  const prompt = requests[0].messages[0].content;
  assert.match(prompt, /TRUSTED_POLICY_orchard/);
  assert.match(prompt, /TRUSTED_POLICY_navigation/);
  assert.doesNotMatch(prompt, /TRUSTED_POLICY_archive/);
  assert.match(prompt, /explicitly state which requested portions lack knowledge/);
  assert.match(prompt, /Do not substitute/);
  // Missing primary is also valid: it must not replace another source's facts
  // or force the primary policy onto the available domains.
  await adapter.answer(mixedPayload(catalog, ['orchard']));
  assert.doesNotMatch(requests[1].messages[0].content, /TRUSTED_POLICY_orchard/);
  assert.match(requests[1].messages[0].content, /TRUSTED_POLICY_archive/);
});

test('mixed-source identity corruption cannot be relabelled into an available domain', async (t) => {
  const catalog = catalogFixture(t);
  const { adapter, requests } = adapterFixture(catalog);
  const base = mixedPayload(catalog);
  const invalid = [
    { ...base, knowledge: { ...base.knowledge, entries: base.knowledge.entries.map(({ domainId, sourceId, ...entry }) => entry) } },
    { ...base, knowledge: { ...base.knowledge, entries: [{ ...base.knowledge.entries[0], sourceId: 'navigation-v1' }, base.knowledge.entries[1]] } },
    { ...base, knowledge: { ...base.knowledge, entries: [...base.knowledge.entries, { id: 'missing', domainId: 'archive', sourceId: 'archive-v1', content: 'Unadmitted' }] } },
    { ...base, knowledge: { ...base.knowledge, entries: [base.knowledge.entries[0]] } },
    { ...base, domainCoverage: undefined },
  ];
  for (const payload of invalid) await assert.rejects(adapter.answer(payload), (error) => error.code === 'provider_request_invalid');
  assert.equal(requests.length, 0);
});

test('default content admits its declared served-source alias, while arbitrary aliases are refused', async () => {
  const catalog = DEFAULT_DOMAIN_CATALOG;
  const { adapter, requests } = adapterFixture(catalog);
  const payload = {
    text: 'Explain the lesson.', dialogue: [], route: { action: 'teach', sourceId: 'course-content-v1' },
    knowledge: { sourceId: 'course-knowledge-v2', entries: [{ id: 'lesson', content: 'Reviewed lesson.' }] },
  };
  await adapter.answer(payload);
  assert.equal(JSON.parse(requests[0].messages[1].content).knowledge.sourceId, 'course-knowledge-v2');
  await assert.rejects(adapter.answer({ ...payload, knowledge: { ...payload.knowledge, sourceId: 'course-knowledge-v99' } }),
    (error) => error.code === 'provider_request_invalid');
  assert.equal(requests.length, 1);
  assert.match(answerSystemPrompt({ knowledge: { sourceId: 'course-operations-v1' } }), /never state, quote, estimate, recalculate or infer any price/);
  assert.match(answerSystemPrompt({ knowledge: { sourceId: 'course-value-v1' } }), /Never validate the premise that learning is unnecessary/);
});

test('resolved shared-source knowledge survives actual provider validation with all domain attributions', async () => {
  const catalog = DEFAULT_DOMAIN_CATALOG;
  const { adapter, requests } = adapterFixture(catalog);
  let reads = 0;
  const resolved = await resolveDomainSelection(normalizeDomainSelection({ domains: ['content', 'navigation'] }, catalog), {
    catalog, question: { text: 'Explain this concept and locate the lesson.' },
    knowledge: { forSource() { throw new Error('must not use snapshot'); } },
    retrievals: new Map([['course-content-v1', { available: true, async forQuestion() {
      reads++;
      return { grounded: true, knowledge: { sourceId: 'course-knowledge-v2',
        entries: [{ id: 'lesson', title: 'Reviewed lesson', content: 'Reviewed explanation and location.' }] } };
    } }]]),
  });
  assert.equal(reads, 1);
  const payload = { ...resolved, text: 'Explain and locate the lesson.', dialogue: [] };
  await adapter.answer(payload);
  const input = JSON.parse(requests[0].messages[1].content);
  assert.equal(input.knowledge.entries.length, 1);
  assert.deepEqual(input.knowledge.entries[0].domainIds, ['content', 'navigation']);
  const invalid = { ...payload, knowledge: { ...payload.knowledge,
    entries: [{ ...payload.knowledge.entries[0], domainIds: ['content', 'operations'] }] } };
  await assert.rejects(adapter.answer(invalid), (e) => e.code === 'provider_request_invalid');
  assert.equal(requests.length, 1, 'cross-source attribution is rejected before transport');
});
