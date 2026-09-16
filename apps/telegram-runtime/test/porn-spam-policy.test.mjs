import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planTelegramSafetyAction } from '@aichattg/telegram-core';
import {
  PORN_SPAM_POLICY_VERSION, SAFETY_MODEL, SAFETY_VENDOR,
  SAFETY_REASONING_EFFORT, SAFETY_ROUTER_MAX_OUTPUT_TOKENS,
  buildSafetyRouterSystem, classifySafetyV3,
} from '../src/safety-v3.mjs';

const policy = readFileSync(new URL('../src/safety-artifacts/porn-spam-policy-v1.md', import.meta.url), 'utf8').trim();
const fixture = JSON.parse(readFileSync(new URL('./fixtures/porn-spam-policy-v1.json', import.meta.url), 'utf8'));
const cases = Array.isArray(fixture) ? fixture : fixture.cases;

function labelledVerdict(text, expectedThreat, confidence = 0.35) {
  return JSON.stringify({
    threat: { match: expectedThreat, types: expectedThreat ? ['spam_or_scam'] : [],
      confidence, evidence: expectedThreat ? [text.slice(0, 200)] : [] },
    abuse: { match: false, types: [], confidence: 0.99, evidence: [] },
    target: expectedThreat ? 'group' : 'none', context_used: false,
  });
}

test('the semantic porn-spam supplement is loaded verbatim without changing provider settings', () => {
  const system = buildSafetyRouterSystem();
  assert.equal(PORN_SPAM_POLICY_VERSION, 'porn-spam-policy-v1');
  assert.ok(system.endsWith(policy));
  assert.equal(system.split('--- PORN-SPAM POLICY v1 ---').length, 2);
  assert.match(policy, /spam_or_scam/);
  assert.match(policy, /Suspicion is sufficient/);
  assert.match(policy, /One current message can suffice/);
  assert.match(policy, /not a rule to classify every ambiguous or unfamiliar message/);
  assert.match(policy, /Good-faith reporting/);
  assert.match(policy, /does not set `context_used=true`/);
  assert.deepEqual([SAFETY_MODEL, SAFETY_VENDOR, SAFETY_REASONING_EFFORT, SAFETY_ROUTER_MAX_OUTPUT_TOKENS],
    ['gpt-5.6-terra', 'openai', 'medium', 1024]);
});

test('the synthetic reference corpus has bounded unique labelled positive and negative cases', () => {
  assert.ok(Array.isArray(cases));
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.evaluationStatus, 'not_run');
  assert.ok(cases.length >= 24 && cases.length <= 40);
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  assert.ok(cases.filter(item => item.expectedThreat === true).length >= 10);
  assert.ok(cases.filter(item => item.expectedThreat === false).length >= 10);
  for (const item of cases) {
    assert.equal(typeof item.id, 'string');
    assert.ok(item.id.length > 0);
    assert.equal(typeof item.text, 'string');
    assert.ok(item.text.trim().length > 0 && item.text.length <= 1000);
    assert.equal(typeof item.expectedThreat, 'boolean');
    assert.equal(typeof item.rationale, 'string');
    assert.ok(item.rationale.trim().length > 0);
    assert.equal(typeof item.category, 'string');
  }
});

// Expected labels are supplied by the test, not inferred by a real model.
// This is deterministic protocol/action coverage, NEVER precision/recall or
// evidence that paraphrases/languages were recognised in production.
test('labelled corpus replays through the existing action contract (mocked, not semantic evaluation)', async t => {
  for (const item of cases) {
    await t.test(item.id, async () => {
      let calls = 0;
      const result = await classifySafetyV3({ message: item.text, async invoke(input) {
        calls++;
        assert.equal(input.stage, 'router');
        assert.ok(input.system.includes(policy));
        assert.equal(JSON.parse(input.user).message, item.text);
        return { text: labelledVerdict(item.text, item.expectedThreat) };
      } });
      assert.equal(calls, 1);
      assert.equal(result.safetyRoute, item.expectedThreat ? 'threat' : 'clean');
      assert.equal(planTelegramSafetyAction(result, 0).action, item.expectedThreat ? 'ban_purge' : 'none');
      assert.equal(result.safetyTrace.artifactSha256.pornSpamPolicy,
        createHash('sha256').update(policy).digest('hex'));
      assert.equal(result.safetyTrace.usage.inputTokens, null);
    });
  }
});

test('valid suspected-spam verdicts have no hidden confidence or warning threshold', async () => {
  const message = 'Synthetic unsolicited adult-gallery invitation.';
  for (const confidence of [0, 0.35, 1]) {
    const result = await classifySafetyV3({ message, async invoke() {
      return { text: labelledVerdict(message, true, confidence) };
    } });
    for (const strikes of [0, 1, 2]) {
      const plan = planTelegramSafetyAction(result, strikes);
      assert.equal(plan.action, 'ban_purge');
      assert.equal(plan.warning, null);
      assert.equal(plan.strikeAfter, strikes);
    }
  }
});
