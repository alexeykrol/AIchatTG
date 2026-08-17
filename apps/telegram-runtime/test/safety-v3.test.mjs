import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ABUSE_BASES,
  ABUSE_SEVERITIES,
  ABUSE_TYPES,
  SAFETY_MODEL,
  SAFETY_REASONING_EFFORT,
  SAFETY_VENDOR,
  SafetyV3ContractError,
  THREAT_TYPES,
  buildAbuseClassifierSystem,
  buildSafetyRouterSystem,
  classifySafetyV3,
  parseAbuseSeverityVerdict,
  parseSafetyRouterVerdict,
} from '../src/safety-v3.mjs';

function routerJson({
  threat = false, threatTypes = [], threatConfidence = 0.99, threatEvidence = [],
  abuse = false, abuseTypes = [], abuseConfidence = 0.99, abuseEvidence = [],
  target = threat || abuse ? 'participant' : 'none', contextUsed = false,
} = {}) {
  return JSON.stringify({
    threat: { match: threat, types: threatTypes, confidence: threatConfidence, evidence: threatEvidence },
    abuse: { match: abuse, types: abuseTypes, confidence: abuseConfidence, evidence: abuseEvidence },
    target, context_used: contextUsed,
  });
}

function receipt(stage, inputTokens = 10, outputTokens = 5) {
  return { operation: `moderatorSafety.${stage}`, modelId: SAFETY_MODEL, vendor: SAFETY_VENDOR,
    reasoningEffort: SAFETY_REASONING_EFFORT, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

test('artifacts preserve deployed v3 router and abuse classifier contract', () => {
  const router = buildSafetyRouterSystem();
  const abuse = buildAbuseClassifierSystem();
  assert.match(router, /THREAT LIBRARY v1/);
  assert.match(router, /ABUSE LIBRARY v1/);
  assert.match(router, /Не выбирай действие/);
  assert.match(abuse, /semantic severity/);
  assert.match(abuse, /Не добавляй `action`/);
  assert.equal(THREAT_TYPES.includes('root_access'), false);
  assert.equal(ABUSE_TYPES.includes('threat'), false);
  assert.deepEqual(ABUSE_SEVERITIES, ['weak', 'strong']);
  assert.equal(ABUSE_BASES.includes('because_i_say_so'), false);
});

test('router parser rejects wrappers, duplicate keys, unknown enums and invented evidence', () => {
  const clean = routerJson();
  assert.equal(parseSafetyRouterVerdict(`\`\`\`json\n${clean}\n\`\`\``, ''), null);
  assert.equal(parseSafetyRouterVerdict(clean.replace('{', '{"target":"none",'), ''), null);
  assert.equal(parseSafetyRouterVerdict(clean.replace('"match":false', '"match":true,"match":false'), ''), null);
  assert.equal(parseSafetyRouterVerdict(routerJson({ threat: true, threatTypes: ['root_access'], threatEvidence: ['root'] }), 'root'), null);
  assert.equal(parseSafetyRouterVerdict(routerJson({ abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['invented'] }), 'Ты идиот'), null);
});

test('severity parser rejects contradictory and unknown bases', () => {
  assert.equal(parseAbuseSeverityVerdict('{"severity":"weak","confidence":0.9,"basis":"dehumanizing_attack"}'), null);
  assert.equal(parseAbuseSeverityVerdict('{"severity":"strong","confidence":0.9,"basis":"isolated_disrespect"}'), null);
  assert.equal(parseAbuseSeverityVerdict('{"severity":"critical","confidence":0.9,"basis":"dehumanizing_attack"}'), null);
  assert.deepEqual(parseAbuseSeverityVerdict('{"severity":"weak","confidence":0.9,"basis":"sexual_harassment"}'), {
    severity: 'weak', confidence: 0.9, basis: 'sexual_harassment',
  });
});

test('classification uses exact Terra/OpenAI/medium and routes clean in one call', async () => {
  const calls = [];
  const result = await classifySafetyV3({
    message: 'Полезный вопрос по теме', context: { currentWeakStrikes: 1, rawHistory: 'do not admit' },
    async invoke(input) {
      calls.push(input);
      return { text: routerJson(), receipt: receipt(input.stage, 100, 10) };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxOutputTokens, 1024);
  assert.deepEqual(JSON.parse(calls[0].user), {
    message: 'Полезный вопрос по теме', context: { weak_strikes: 1, warning_stage: 'first' },
  });
  assert.equal(calls[0].user.includes('do not admit'), false);
  assert.deepEqual({ route: result.safetyRoute, level: result.abuseLevel, reason: result.reason }, {
    route: 'clean', level: null, reason: 'safety:clean',
  });
  assert.deepEqual(result.safetyTrace.usage, {
    calls: 1, failed: 0, inputTokens: 100, outputTokens: 10, totalTokens: 110, costUsd: null,
    modelId: 'gpt-5.6-terra', vendor: 'openai', reasoningEffort: 'medium',
  });
});

// Модерация — двухступенчатый контракт, и ход её оплачивает целиком. Учёт
// обязан сложить ОБЕ квитанции: цена по последнему вызову занизила бы счёт
// ровно на целый оплаченный вызов.
test('the abuse route bills both stages, and a stage without a receipt leaves null rather than zero', async () => {
  const replies = [
    { text: routerJson({ abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['идиот'], abuseConfidence: 0.96 }), receipt: receipt('router', 120, 20) },
    { text: '{"severity":"weak","confidence":0.94,"basis":"isolated_disrespect"}', receipt: receipt('abuse_classifier', 80, 12) },
  ];
  const billed = await classifySafetyV3({ message: 'Ты идиот', async invoke() { return replies.shift(); } });
  assert.deepEqual({
    calls: billed.safetyTrace.usage.calls,
    inputTokens: billed.safetyTrace.usage.inputTokens,
    outputTokens: billed.safetyTrace.usage.outputTokens,
    totalTokens: billed.safetyTrace.usage.totalTokens,
  }, { calls: 2, inputTokens: 200, outputTokens: 32, totalTokens: 232 });

  // Провайдер не назвал расход ни на одной ступени: вызовы были, цена
  // неизвестна. Ноль здесь сделал бы пробел учёта неотличимым от бесплатной
  // модерации.
  const silent = await classifySafetyV3({ message: 'Полезный вопрос', async invoke() { return { text: routerJson() }; } });
  assert.deepEqual({
    calls: silent.safetyTrace.usage.calls,
    inputTokens: silent.safetyTrace.usage.inputTokens,
    outputTokens: silent.safetyTrace.usage.outputTokens,
    totalTokens: silent.safetyTrace.usage.totalTokens,
  }, { calls: 1, inputTokens: null, outputTokens: null, totalTokens: null });
});

test('abuse calls the 768-token classifier exactly once and validates basis against router types', async () => {
  const calls = [];
  const replies = [
    { text: routerJson({ abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['идиот'], abuseConfidence: 0.96 }), receipt: receipt('router', 120, 20) },
    { text: '{"severity":"weak","confidence":0.94,"basis":"isolated_disrespect"}', receipt: receipt('abuse_classifier', 80, 12) },
  ];
  const result = await classifySafetyV3({ message: 'Ты идиот', async invoke(input) { calls.push(input); return replies.shift(); } });
  assert.deepEqual(calls.map((input) => input.maxOutputTokens), [1024, 768]);
  assert.deepEqual({ route: result.safetyRoute, level: result.abuseLevel, confidence: result.confidence, quote: result.quote }, {
    route: 'abuse', level: 'weak', confidence: 0.94, quote: 'идиот',
  });
  const invalid = [
    { text: routerJson({ abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['идиот'] }), receipt: receipt('router') },
    { text: '{"severity":"strong","confidence":0.8,"basis":"sexual_harassment"}', receipt: receipt('abuse_classifier') },
  ];
  await assert.rejects(classifySafetyV3({ message: 'Ты идиот', async invoke() { return invalid.shift(); } }),
    (error) => error instanceof SafetyV3ContractError && error.stage === 'abuse_classifier');
});

test('threat wins priority and warning disputes require code-owned prior warning', async () => {
  let calls = 0;
  const threat = await classifySafetyV3({
    message: 'Я тебя уничтожу, тупая машина',
    async invoke() {
      calls++;
      return { text: routerJson({
        threat: true, threatTypes: ['interpersonal_threat'], threatEvidence: ['Я тебя уничтожу'],
        abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['тупая машина'], target: 'assistant',
      }), receipt: receipt('router') };
    },
  });
  assert.equal(calls, 1);
  assert.equal(threat.safetyRoute, 'threat');
  const warning = routerJson({
    abuse: true, abuseTypes: ['warning_dispute'], abuseEvidence: ['предупреждение'], target: 'author', contextUsed: true,
  });
  await assert.rejects(classifySafetyV3({ message: 'Я обсуждаю предупреждение вообще', async invoke() { return { text: warning, receipt: receipt('router') }; } }),
    (error) => error instanceof SafetyV3ContractError && error.stage === 'router');
});
