import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planTelegramSafetyAction } from '@aichattg/telegram-core';
import { openRuntimeDatabase, createRuntimeStore } from '../src/database.mjs';
import { createProviderAdapter } from '../src/provider-adapter.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import {
  ADVERTISING_SPAM_POLICY_VERSION, SAFETY_MODEL, SAFETY_VENDOR,
  SAFETY_REASONING_EFFORT, SAFETY_ROUTER_MAX_OUTPUT_TOKENS,
  SAFETY_ROUTER_RESPONSE_FORMAT, THREAT_TYPES, buildSafetyRouterSystem,
  classifySafetyV3,
} from '../src/safety-v3.mjs';

const artifact = (name) => readFileSync(new URL(`../src/safety-artifacts/${name}.md`, import.meta.url), 'utf8').trim();
const policy = artifact('advertising-spam-policy-v1');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const corpus = JSON.parse(readFileSync(new URL('./fixtures/advertising-spam-policy-v1.json', import.meta.url), 'utf8'));
const sample = corpus.cases.find((item) => item.id === 'ad-pos-002').text;

function labelledVerdict(message, match, confidence = 0.35) {
  return JSON.stringify({
    threat: { match, types: match ? ['spam_or_scam'] : [], confidence,
      evidence: match ? [message.slice(0, 240)] : [] },
    abuse: { match: false, types: [], confidence: 0.99, evidence: [] },
    target: match ? 'group' : 'none', context_used: false,
  });
}

test('advertising supplement is loaded verbatim under the existing primary safety contract', () => {
  const system = buildSafetyRouterSystem();
  assert.equal(ADVERTISING_SPAM_POLICY_VERSION, 'advertising-spam-policy-v1');
  assert.equal(system.split('--- ADVERTISING-SPAM POLICY v1 ---').length, 2);
  assert.ok(system.includes(policy));
  assert.ok(system.includes(artifact('threat-library-v1')));
  assert.ok(system.endsWith(artifact('porn-spam-policy-v1')));
  assert.match(policy, /unsolicited advertising/);
  assert.match(policy, /Do not require a URL, explicit price/);
  assert.match(policy, /A single current message can establish advertising spam/);
  assert.match(policy, /good-faith requested recommendations/);
  assert.match(policy, /Missing context\s+is not proof/);
  assert.match(policy, /a Review flag[\s\S]*not itself evidence/);
  assert.deepEqual([SAFETY_MODEL, SAFETY_VENDOR, SAFETY_REASONING_EFFORT, SAFETY_ROUTER_MAX_OUTPUT_TOKENS],
    ['gpt-5.6-terra', 'openai', 'medium', 1024]);
  assert.equal(THREAT_TYPES.includes('advertising'), false);
  assert.equal(THREAT_TYPES.includes('spam_or_scam'), true);
  assert.deepEqual(SAFETY_ROUTER_RESPONSE_FORMAT.json_schema.schema.required,
    ['threat', 'abuse', 'target', 'context_used']);
});

test('advertising reference corpus is synthetic, bounded, unique and explicitly unevaluated', () => {
  assert.equal(corpus.synthetic, true);
  assert.equal(corpus.evaluationStatus, 'not_run');
  assert.equal(corpus.cases.length, 24);
  assert.equal(new Set(corpus.cases.map((item) => item.id)).size, 24);
  assert.equal(corpus.cases.filter((item) => item.expectedThreat).length, 12);
  for (const item of corpus.cases) {
    assert.match(item.id, /^ad-(?:pos|neg)-\d{3}$/);
    assert.equal(typeof item.expectedThreat, 'boolean');
    assert.ok(item.text.trim().length > 0 && item.text.length <= 1000);
    assert.ok(item.category.length > 0 && item.rationale.length > 0);
  }
});

// Reference labels are injected, not predicted. Passing these tests proves
// prompt/evidence/action contracts, NEVER semantic accuracy or live moderation.
test('advertising labelled corpus uses immediate existing actions and fingerprints (mocked)', async (t) => {
  for (const item of corpus.cases) {
    await t.test(item.id, async () => {
      let calls = 0;
      const result = await classifySafetyV3({ message: item.text, async invoke(input) {
        calls++;
        assert.equal(input.stage, 'router');
        assert.ok(input.system.includes(policy));
        assert.equal(JSON.parse(input.user).message, item.text);
        assert.equal(input.maxOutputTokens, 1024);
        return { text: labelledVerdict(item.text, item.expectedThreat) };
      } });
      assert.equal(calls, 1);
      assert.equal(result.safetyRoute, item.expectedThreat ? 'threat' : 'clean');
      assert.equal(result.safetyTrace.router.context_used, false);
      assert.equal(result.safetyTrace.artifactSha256.advertisingSpamPolicy, hash(policy));
      assert.equal(result.safetyTrace.artifactSha256.routerSystem, hash(buildSafetyRouterSystem()));
      assert.equal(result.safetyTrace.artifactSha256.pornSpamPolicy, hash(artifact('porn-spam-policy-v1')));
      assert.equal(result.safetyTrace.usage.inputTokens, null);
      for (const strikes of [0, 1, 2]) {
        const plan = planTelegramSafetyAction(result, strikes);
        assert.equal(plan.action, item.expectedThreat ? 'ban_purge' : 'none');
        assert.equal(plan.warning, null);
        assert.equal(plan.strikeAfter, strikes);
      }
    });
  }
});

test('valid advertising threat does not acquire a confidence, repeat or Review wait threshold', async () => {
  for (const confidence of [0, 0.35, 1]) {
    const result = await classifySafetyV3({ message: sample, async invoke() {
      return { text: labelledVerdict(sample, true, confidence) };
    } });
    assert.equal(planTelegramSafetyAction(result, 0).action, 'ban_purge');
    assert.equal(Object.hasOwn(result, 'action'), false);
    assert.equal(result.confidence, confidence);
  }
});

test('Review hints and unseen parent context cannot replace the current-message safety verdict', async () => {
  const result = await classifySafetyV3({ message: sample,
    context: { review: { patternIds: ['covert-testimonial-bait'] }, parentText: 'A different topic.' },
    async invoke(input) {
      assert.deepEqual(JSON.parse(input.user).context, { weak_strikes: 0, warning_stage: 'none' });
      return { text: labelledVerdict(sample, false) };
    },
  });
  assert.equal(planTelegramSafetyAction(result, 0).action, 'none');
});

test('advertising evidence remains verbatim and additional model action fields are rejected', async () => {
  const message = 'Купите кни\u200bгу; доступ через пр\u200bофиль.';
  const changedEvidence = JSON.parse(labelledVerdict(message, true));
  changedEvidence.threat.evidence = ['Купите книгу'];
  await assert.rejects(classifySafetyV3({ message, async invoke() {
    return { text: JSON.stringify(changedEvidence) };
  } }), { stage: 'router', reason: 'threat_evidence_not_verbatim' });
  const extraAction = { ...JSON.parse(labelledVerdict(message, true)), action: 'ban' };
  await assert.rejects(classifySafetyV3({ message, async invoke() {
    return { text: JSON.stringify(extraAction) };
  } }), { stage: 'router', reason: 'router_keys_invalid' });
});

function runtimeHarness(t, fetchFn) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-advertising-policy-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.sqlite'));
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  const store = createRuntimeStore(db);
  const actions = [];
  const provider = createProviderAdapter({ enabled: true, vendor: 'openai',
    endpoint: 'https://provider.example.test/v1', apiKey: 'synthetic-offline-key',
    modelTuples: {
      moderatorSafety: { model: SAFETY_MODEL, reasoningEffort: 'medium', maxOutputTokens: 1024 },
      assistantRouter: { model: 'fixture-router', reasoningEffort: 'none', maxOutputTokens: 100 },
      assistantAnswer: { model: 'fixture-answer', reasoningEffort: 'none', maxOutputTokens: 100 },
    },
  }, { fetchFn });
  const runtime = createTelegramRuntime({
    config: { ingressEnabled: false, moderationMode: 'live',
      moderator: { chatIds: ['-100'], exemptBotIds: [] },
      assistant: { chatIds: ['-100'], exemptBotIds: [] },
    }, store, provider,
    guard: {
      async senderDisposition() { return { proven: true, exempt: false, reason: null }; },
      async verifyEnforcement() { return { proven: true, status: 'administrator' }; },
      async banAuthor() { actions.push('ban'); return { ok: true }; },
      async deleteMessage({ beforeDelete }) {
        if (beforeDelete) assert.equal(beforeDelete(), true);
        actions.push('delete'); return { ok: true };
      },
      async sendWarning() { actions.push('warning'); return { ok: true }; },
    },
    notifier: { async notify() { actions.push('notify'); return { delivered: true }; } },
  });
  return { runtime, store, actions };
}

const update = () => ({ update_id: 101, message: { message_id: 201, chat: { id: -100 },
  from: { id: 7, first_name: 'Synthetic participant', is_bot: false }, text: sample } });
const response = (content) => ({ ok: true, status: 200,
  async json() { return { model: SAFETY_MODEL,
    choices: [{ finish_reason: 'stop', message: { content, refusal: null } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }; },
});

test('injected advertising verdict bans and deletes once for a non-bot without Review (fake transport)', async (t) => {
  let calls = 0;
  const h = runtimeHarness(t, async (_url, options) => {
    calls++;
    assert.ok(JSON.parse(options.body).messages[0].content.includes(policy));
    return response(labelledVerdict(sample, true));
  });
  const result = await h.runtime.handleUpdate('moderator', update());
  assert.equal(result.action, 'ban_purge');
  assert.deepEqual(h.actions, ['ban', 'delete']);
  assert.equal(h.store.getWeakStrikeState({ chatId: '-100', userId: '7' }).weakStrikes, 0);
  assert.deepEqual(await h.runtime.handleUpdate('moderator', update()), result);
  assert.equal(calls, 1);
  assert.deepEqual(h.actions, ['ban', 'delete']);
});

for (const mode of ['transport', 'invalid-json', 'invalid-contract']) {
  test(`advertising input with ${mode} failure stays manual_review without sanction or retry`, async (t) => {
    let calls = 0;
    const h = runtimeHarness(t, async () => {
      calls++;
      if (mode === 'transport') throw new Error('synthetic transport failure');
      return response(mode === 'invalid-json' ? '{' : JSON.stringify({ action: 'ban' }));
    });
    const result = await h.runtime.handleUpdate('moderator', update());
    assert.equal(result.kind, 'moderation_manual_review');
    assert.equal(h.store.getModeratorJudgement('moderator:101').state, 'manual_review');
    assert.equal(h.store.getModerationEnforcement('moderator:101'), null);
    assert.equal((await h.runtime.recoverModeratorJudgements({ limit: 1 })).recovered, 0);
    await h.runtime.handleUpdate('moderator', update());
    assert.equal(calls, 1);
    assert.deepEqual(h.actions, []);
  });
}
