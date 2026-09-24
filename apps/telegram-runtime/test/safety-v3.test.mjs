import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ABUSE_BASES,
  ABUSE_SEVERITIES,
  ABUSE_TYPES,
  SAFETY_ABUSE_RESPONSE_FORMAT,
  SAFETY_CONTRACT_REJECTION_REASONS,
  SAFETY_MODEL,
  SAFETY_REASONING_EFFORT,
  SAFETY_ROUTER_RESPONSE_FORMAT,
  buildSafetyRouterSelectorResponseFormat,
  SAFETY_TARGETS,
  SAFETY_VENDOR,
  SafetyV3ContractError,
  THREAT_TYPES,
  buildAbuseClassifierSystem,
  buildSafetyRouterSystem,
  classifySafetyV3,
  parseAbuseSeverityVerdict,
  parseSafetyRouterVerdict,
} from '../src/safety-v3.mjs';
import { selectorFixture } from './evidence-selector-fixture.mjs';

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
  assert.match(router, /Если оба `match=false`, обязательно `target="none"`/);
  assert.match(router, /`context_used=false`, даже когда вопрос обращён к ассистенту/);
});

test('wire schemas are strict closed objects with the same keys and enums as semantic validation', () => {
  const router = SAFETY_ROUTER_RESPONSE_FORMAT.json_schema.schema;
  const severity = SAFETY_ABUSE_RESPONSE_FORMAT.json_schema.schema;
  function assertClosed(schema) {
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, Object.keys(schema.properties));
    assert.ok(Object.isFrozen(schema));
  }
  for (const format of [SAFETY_ROUTER_RESPONSE_FORMAT, SAFETY_ABUSE_RESPONSE_FORMAT]) {
    assert.equal(format.type, 'json_schema');
    assert.equal(format.json_schema.strict, true);
    assertClosed(format.json_schema.schema);
  }
  assert.deepEqual(router.required, ['threat', 'abuse', 'target', 'context_used']);
  assert.deepEqual(severity.required, ['severity', 'confidence', 'basis']);
  assert.deepEqual(router.properties.target.enum, SAFETY_TARGETS);
  for (const [domain, types] of [['threat', THREAT_TYPES], ['abuse', ABUSE_TYPES]]) {
    const match = router.properties[domain];
    assertClosed(match);
    assert.deepEqual(match.required, ['match', 'types', 'confidence', 'evidence']);
    assert.deepEqual(match.properties.types.items.enum, types);
    assert.deepEqual(match.properties.confidence, { type: 'number', minimum: 0, maximum: 1 });
    assert.deepEqual(match.properties.evidence, {
      type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 240 },
    });
  }
  assert.deepEqual(severity.properties.severity.enum, ABUSE_SEVERITIES);
  assert.deepEqual(severity.properties.basis.enum, ABUSE_BASES);
  assert.throws(() => { router.properties.target.enum.push('unknown'); }, TypeError);
});

test('selector schema exposes only current IDs and leaves canonical evidence schema unchanged', () => {
  const ids = ['E0000', 'E0001'];
  const selected = buildSafetyRouterSelectorResponseFormat(ids);
  assert.equal(selected.json_schema.name, 'telegram_safety_router_selector_v1');
  assert.equal(selected.json_schema.strict, true);
  for (const domain of ['threat', 'abuse']) {
    assert.deepEqual(selected.json_schema.schema.properties[domain].properties.evidence.items,
      { type: 'string', enum: ids });
    assert.deepEqual(SAFETY_ROUTER_RESPONSE_FORMAT.json_schema.schema.properties[domain].properties.evidence.items,
      { type: 'string', minLength: 1, maxLength: 240 });
  }
  assert.equal(JSON.stringify(selected).includes('private message'), false);
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
      return { text: selectorFixture(input, routerJson()), receipt: receipt(input.stage, 100, 10) };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxOutputTokens, 1024);
  assert.deepEqual(calls[0].responseFormat, buildSafetyRouterSelectorResponseFormat(
    JSON.parse(calls[0].user).evidence_catalogue.entries.map((entry) => entry.id)));
  const { evidence_catalogue: catalogue, ...routerInput } = JSON.parse(calls[0].user);
  assert.ok(catalogue.entries.every((entry) => routerInput.message.includes(entry.text)));
  assert.deepEqual(routerInput, {
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
  const billed = await classifySafetyV3({ message: 'Ты идиот', async invoke(input) {
    const reply = replies.shift();
    return { ...reply, text: selectorFixture(input, reply.text) };
  } });
  assert.deepEqual({
    calls: billed.safetyTrace.usage.calls,
    inputTokens: billed.safetyTrace.usage.inputTokens,
    outputTokens: billed.safetyTrace.usage.outputTokens,
    totalTokens: billed.safetyTrace.usage.totalTokens,
  }, { calls: 2, inputTokens: 200, outputTokens: 32, totalTokens: 232 });

  // Провайдер не назвал расход ни на одной ступени: вызовы были, цена
  // неизвестна. Ноль здесь сделал бы пробел учёта неотличимым от бесплатной
  // модерации.
  const silent = await classifySafetyV3({ message: 'Полезный вопрос', async invoke(input) { return { text: selectorFixture(input, routerJson()) }; } });
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
  const result = await classifySafetyV3({ message: 'Ты идиот', async invoke(input) {
    calls.push(input);
    const reply = replies.shift();
    return { ...reply, text: selectorFixture(input, reply.text) };
  } });
  assert.deepEqual(calls.map((input) => input.maxOutputTokens), [1024, 768]);
  assert.deepEqual(calls.map((input) => input.responseFormat), [buildSafetyRouterSelectorResponseFormat(
    JSON.parse(calls[0].user).evidence_catalogue.entries.map((entry) => entry.id)), SAFETY_ABUSE_RESPONSE_FORMAT]);
  assert.deepEqual({ route: result.safetyRoute, level: result.abuseLevel, confidence: result.confidence, quote: result.quote }, {
    route: 'abuse', level: 'weak', confidence: 0.94, quote: 'идиот',
  });
  const invalid = [
    { text: routerJson({ abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['идиот'] }), receipt: receipt('router') },
    { text: '{"severity":"strong","confidence":0.8,"basis":"sexual_harassment"}', receipt: receipt('abuse_classifier') },
  ];
  await assert.rejects(classifySafetyV3({ message: 'Ты идиот', async invoke(input) {
    const reply = invalid.shift();
    return { ...reply, text: selectorFixture(input, reply.text) };
  } }),
    (error) => error instanceof SafetyV3ContractError && error.stage === 'abuse_classifier');
});

test('threat wins priority and warning disputes require code-owned prior warning', async () => {
  let calls = 0;
  const threat = await classifySafetyV3({
    message: 'Я тебя уничтожу, тупая машина',
    async invoke(input) {
      calls++;
      return { text: selectorFixture(input, routerJson({
        threat: true, threatTypes: ['interpersonal_threat'], threatEvidence: ['Я тебя уничтожу'],
        abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['тупая машина'], target: 'assistant',
      })), receipt: receipt('router') };
    },
  });
  assert.equal(calls, 1);
  assert.equal(threat.safetyRoute, 'threat');
  const warning = routerJson({
    abuse: true, abuseTypes: ['warning_dispute'], abuseEvidence: ['предупреждение'], target: 'author', contextUsed: true,
  });
  await assert.rejects(classifySafetyV3({ message: 'Я обсуждаю предупреждение вообще', async invoke(input) { return { text: selectorFixture(input, warning), receipt: receipt('router') }; } }),
    (error) => error instanceof SafetyV3ContractError && error.stage === 'router');
});

test('unchanged semantic parser rejects every original malformed semantic fixture directly', () => {
  const mutate = (change) => {
    const parsed = JSON.parse(routerJson());
    change(parsed);
    return JSON.stringify(parsed);
  };
  const cases = [
    ['json_invalid', 'not json'],
    ['json_duplicate_keys', routerJson().replace('{', '{"target":"none",')],
    ['router_keys_invalid', mutate((v) => { v.private_key = 'private value'; })],
    ['target_invalid', mutate((v) => { v.target = 'private value'; })],
    ['target_match_mismatch', routerJson({ target: 'assistant' })],
    ['context_used_invalid', mutate((v) => { v.context_used = 'private value'; })],
    ['overlapping_evidence', routerJson({ threat: true, threatTypes: ['interpersonal_threat'], threatEvidence: ['идиот'], abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['идиот'] })],
  ];
  for (const [domain, type] of [['threat', 'interpersonal_threat'], ['abuse', 'targeted_insult']]) {
    cases.push(
      [`${domain}_keys_invalid`, mutate((v) => { v[domain].private_key = 'private value'; })],
      [`${domain}_match_invalid`, mutate((v) => { v[domain].match = 'false'; })],
      [`${domain}_confidence_invalid`, mutate((v) => { v[domain].confidence = 2; })],
      [`${domain}_types_invalid`, mutate((v) => { v[domain].types = ['private value']; })],
      [`${domain}_types_duplicate`, mutate((v) => { v[domain].types = [type, type]; })],
      [`${domain}_match_types_mismatch`, mutate((v) => { v[domain].types = [type]; })],
      [`${domain}_evidence_invalid`, mutate((v) => { v[domain].evidence = ['']; })],
      [`${domain}_evidence_not_verbatim`, mutate((v) => { v[domain].evidence = ['private value']; })],
      [`${domain}_match_evidence_mismatch`, mutate((v) => { v[domain].evidence = ['идиот']; })],
    );
  }
  for (const [reason, text] of cases) {
    assert.equal(parseSafetyRouterVerdict(text, 'Ты идиот'), null, reason);
    assert.ok(SAFETY_CONTRACT_REJECTION_REASONS.includes(reason));
  }
});

test('selector pipeline preserves warning-context rejection and one-call fence', async () => {
  for (const [reason, text] of [
    ['warning_context_mismatch', routerJson({ contextUsed: true })],
    ['warning_context_mismatch', routerJson({ abuse: true, abuseTypes: ['warning_dispute'], abuseEvidence: ['идиот'] })],
    ['warning_context_unavailable', routerJson({ abuse: true, abuseTypes: ['warning_dispute'], abuseEvidence: ['идиот'], contextUsed: true })],
  ]) {
    let calls = 0;
    await assert.rejects(classifySafetyV3({ message: 'Ты идиот', async invoke(input) {
      calls++;
      return { text: selectorFixture(input, text) };
    } }), (error) => error instanceof SafetyV3ContractError && error.reason === reason && error.stage === 'router');
    assert.equal(calls, 1);
  }
});

test('selector pipeline rejects raw text, absent IDs, duplicate IDs and malformed lists without retry', async () => {
  for (const domain of ['threat', 'abuse']) {
    for (const [reason, evidence] of [
      ['selector_evidence_id_unknown', ['private invented excerpt']],
      ['selector_evidence_id_unknown', ['идиот']], // Even a verbatim raw quote is no longer wire evidence.
      ['selector_evidence_id_unknown', ['E0127']], // Static ID, absent from this short request.
      ['selector_evidence_id_unknown', [null]],
      ['selector_evidence_id_duplicate', ['E0000', 'E0000']],
      ['selector_evidence_ids_invalid', null],
      ['selector_evidence_ids_invalid', 'E0000'],
      ['selector_evidence_ids_invalid', ['E0000', 'E0000', 'E0000', 'E0000']],
    ]) {
      let calls = 0;
      await assert.rejects(classifySafetyV3({ message: 'Ты идиот', async invoke(input) {
        calls++;
        const wire = JSON.parse(selectorFixture(input, routerJson()));
        wire[domain].evidence = evidence;
        return { text: JSON.stringify(wire) };
      } }), (error) => {
        assert.ok(error instanceof SafetyV3ContractError);
        assert.equal(error.stage, 'router');
        assert.equal(error.reason, reason);
        assert.ok(SAFETY_CONTRACT_REJECTION_REASONS.includes(reason));
        assert.equal(error.message.includes('private'), false);
        assert.equal(error.message.includes('идиот'), false);
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test('resolved selectors still pass through cross-field semantic rejection', async () => {
  for (const [reason, change] of [
    ['target_match_mismatch', (wire) => { wire.target = 'none'; }],
    ['threat_types_invalid', (wire) => { wire.threat.types = ['private unknown type']; }],
    ['threat_match_types_mismatch', (wire) => { wire.threat.types = []; }],
    ['threat_match_evidence_mismatch', (wire) => { wire.threat.evidence = []; }],
    ['overlapping_evidence', (wire) => { wire.abuse = { ...wire.threat, types: ['targeted_insult'] }; }],
  ]) {
    let calls = 0;
    await assert.rejects(classifySafetyV3({ message: 'Ты идиот', async invoke(input) {
      calls++;
      const wire = JSON.parse(selectorFixture(input, routerJson({
        threat: true, threatTypes: ['interpersonal_threat'], threatEvidence: ['идиот'],
      })));
      change(wire);
      return { text: JSON.stringify(wire) };
    } }), (error) => error instanceof SafetyV3ContractError && error.reason === reason && error.stage === 'router');
    assert.equal(calls, 1);
  }
});

test('severity schema still requires cross-field and router-type semantic validation', async () => {
  const verdict = { severity: 'weak', confidence: 0.9, basis: 'isolated_disrespect' };
  const cases = [
    ['severity_keys_invalid', { ...verdict, private_key: 'private value' }],
    ['severity_invalid', { ...verdict, severity: 'private value' }],
    ['severity_confidence_invalid', { ...verdict, confidence: -1 }],
    ['severity_basis_invalid', { ...verdict, basis: 'private value' }],
    ['severity_basis_mismatch', { ...verdict, basis: 'dehumanizing_attack' }],
    ['severity_router_type_mismatch', { ...verdict, basis: 'sexual_harassment' }],
  ];
  for (const [reason, severity] of cases) {
    const replies = [routerJson({ abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['идиот'] }), JSON.stringify(severity)];
    let calls = 0;
    await assert.rejects(classifySafetyV3({
      message: 'Ты идиот', async invoke(input) { calls++; return { text: selectorFixture(input, replies.shift()) }; },
    }), (error) => {
      assert.ok(error instanceof SafetyV3ContractError);
      assert.equal(error.stage, 'abuse_classifier');
      assert.equal(error.reason, reason);
      assert.ok(SAFETY_CONTRACT_REJECTION_REASONS.includes(error.reason));
      return true;
    });
    assert.equal(calls, 2, reason);
  }
});
