import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOMAIN_OUT_OF_SCOPE,
  DOMAIN_ROUTE_REASONS,
  createDomainRegistry,
  isDefinitiveDomainRouteReason,
  measureDomainSignal,
  routeQuestionDomain,
} from '../src/index.mjs';
import { normalizeForm, stemNgram } from '../src/retrieval.mjs';

// Dictionaries are built exactly the way the runtime adapter builds them from a
// package, so a test that passes here is a claim about the real matcher.
function dictionary(canonicals) {
  const concepts = new Map();
  const conceptsStem = new Map();
  let maxConceptLen = 1;
  for (const canonical of canonicals) {
    const norm = normalizeForm(canonical);
    concepts.set(norm, { canonical, nUnits: 1 });
    conceptsStem.set(stemNgram(norm), norm);
    maxConceptLen = Math.max(maxConceptLen, norm.split(' ').length);
  }
  return { concepts, conceptsStem, maxConceptLen };
}

function registryOfTwoDomains() {
  return createDomainRegistry([
    { domainId: 'ai', sourceId: 'course-knowledge-v2', ...dictionary(['агент', 'промпт', 'модель', 'контекстное окно']) },
    { domainId: 'cooking', sourceId: 'cooking-knowledge-v2', ...dictionary(['тесто', 'духовка']) },
  ]);
}

test('a claimed domain the question actually names is accepted with its evidence', () => {
  const decision = routeQuestionDomain(
    { question: 'как работает контекстное окно у модели?', claimedDomainId: 'ai' },
    { registry: registryOfTwoDomains() },
  );
  assert.equal(decision.accepted, true);
  assert.equal(decision.domainId, 'ai');
  assert.equal(decision.reason, DOMAIN_ROUTE_REASONS.ACCEPTED);
  assert.ok(decision.evidence.conceptHits >= 1);
  assert.ok(decision.evidence.concepts.includes('контекстное окно'));
});

test('a domain claim the question gives no signal for is vetoed into abstention', () => {
  const decision = routeQuestionDomain(
    { question: 'какая завтра погода в Лиссабоне?', claimedDomainId: 'ai' },
    { registry: registryOfTwoDomains() },
  );
  assert.equal(decision.accepted, false);
  assert.equal(decision.domainId, DOMAIN_OUT_OF_SCOPE);
  assert.equal(decision.reason, DOMAIN_ROUTE_REASONS.NO_SIGNAL);
  assert.equal(decision.evidence.conceptHits, 0);
});

test('the veto is per domain: a cooking question may not be claimed as ai', () => {
  const registry = registryOfTwoDomains();
  const wrong = routeQuestionDomain({ question: 'как замесить тесто?', claimedDomainId: 'ai' }, { registry });
  assert.equal(wrong.accepted, false);
  assert.equal(wrong.reason, DOMAIN_ROUTE_REASONS.NO_SIGNAL);

  // The same question routed to its own domain passes, which proves the veto
  // measures the domain rather than rejecting unfamiliar phrasing outright.
  const right = routeQuestionDomain({ question: 'как замесить тесто?', claimedDomainId: 'cooking' }, { registry });
  assert.equal(right.accepted, true);
  assert.equal(right.domainId, 'cooking');
});

test('a second domain is registry data, not a new branch', () => {
  const registry = registryOfTwoDomains();
  assert.deepEqual([...registry.list()], ['ai', 'cooking']);
  assert.equal(registry.size, 2);
  assert.equal(registry.get('cooking').sourceId, 'cooking-knowledge-v2');
  assert.equal(registry.get('nope'), null);
});

test('an unknown, absent or self-declined domain claim never reaches a package', () => {
  const registry = registryOfTwoDomains();
  const cases = [
    [{ question: 'что такое агент?', claimedDomainId: 'medicine' }, DOMAIN_ROUTE_REASONS.CLAIM_UNKNOWN],
    [{ question: 'что такое агент?', claimedDomainId: '' }, DOMAIN_ROUTE_REASONS.CLAIM_MISSING],
    [{ question: 'что такое агент?' }, DOMAIN_ROUTE_REASONS.CLAIM_MISSING],
    [{ question: 'что такое агент?', claimedDomainId: DOMAIN_OUT_OF_SCOPE }, DOMAIN_ROUTE_REASONS.CLAIM_MISSING],
    [{ question: '   ', claimedDomainId: 'ai' }, DOMAIN_ROUTE_REASONS.QUESTION_INVALID],
  ];
  for (const [input, reason] of cases) {
    const decision = routeQuestionDomain(input, { registry });
    assert.equal(decision.accepted, false, reason);
    assert.equal(decision.domainId, DOMAIN_OUT_OF_SCOPE);
    assert.equal(decision.reason, reason);
  }
});

test('an empty registry or an unloaded dictionary refuses instead of accepting blindly', () => {
  const empty = routeQuestionDomain({ question: 'что такое агент?', claimedDomainId: 'ai' },
    { registry: createDomainRegistry([]) });
  assert.equal(empty.reason, DOMAIN_ROUTE_REASONS.REGISTRY_EMPTY);

  const unloaded = createDomainRegistry([{ domainId: 'ai', concepts: new Map(), conceptsStem: new Map() }]);
  const decision = routeQuestionDomain({ question: 'что такое агент?', claimedDomainId: 'ai' }, { registry: unloaded });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, DOMAIN_ROUTE_REASONS.EVIDENCE_UNAVAILABLE);
});

test('domain evidence is measurable on its own, without a model or a database', () => {
  const entry = createDomainRegistry([
    { domainId: 'ai', ...dictionary(['агент', 'промпт']) },
  ]).get('ai');
  const signal = measureDomainSignal('чем агент отличается от промпта', entry);
  assert.ok(signal.concepts.includes('агент'));
  // Inflected "промпта" reaches the concept through the same stemmer the
  // retriever uses, so the veto cannot be stricter than the search it guards.
  assert.ok(signal.concepts.includes('промпт'));
  assert.ok(signal.significantTokens >= 2);
});

test('every domain veto reason returns the quota because it precedes any paid call', () => {
  for (const reason of Object.values(DOMAIN_ROUTE_REASONS)) {
    if (reason === DOMAIN_ROUTE_REASONS.ACCEPTED) continue;
    assert.equal(isDefinitiveDomainRouteReason(reason), true, reason);
  }
  assert.equal(isDefinitiveDomainRouteReason('rewrite_provider_failed'), false);
  assert.equal(isDefinitiveDomainRouteReason(''), false);
});

test('a decision is frozen so no caller can upgrade a veto into access', () => {
  const decision = routeQuestionDomain(
    { question: 'погода', claimedDomainId: 'ai' },
    { registry: registryOfTwoDomains() },
  );
  assert.throws(() => { decision.accepted = true; }, TypeError);
  assert.throws(() => { decision.evidence.conceptHits = 99; }, TypeError);
});
