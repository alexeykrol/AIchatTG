import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitKnowledgeSnapshot, knowledgeManifestDigest } from '@aichattg/telegram-core';
import { loadRuntimeConfig } from '../src/config.mjs';
import { ASSISTANT_PROVIDER_INPUT_MAX_CHARS } from '../src/assistant-dialogue.mjs';
import {
  answerSystemPrompt,
  createProviderAdapter,
  ProviderRequestError,
  ProviderUnavailableError,
  providerFailureDiagnostic,
  sanitizeProviderFailureDiagnostic,
  SAFETY_PROVIDER_TUPLE,
  validateProviderRuntimeConfig,
} from '../src/provider-adapter.mjs';
import { SAFETY_ABUSE_RESPONSE_FORMAT, SAFETY_ROUTER_RESPONSE_FORMAT } from '../src/safety-v3.mjs';

function providerConfig(overrides = {}) {
  return {
    enabled: true,
    vendor: 'openai',
    endpoint: 'https://provider.example.test/v1',
    apiKey: 'fixture-key',
    modelTuples: {
      moderatorSafety: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', maxOutputTokens: 1024 },
      assistantRouter: { model: 'router-model', reasoningEffort: 'none', maxOutputTokens: 100 },
      assistantAnswer: { model: 'answer-model', reasoningEffort: 'low', maxOutputTokens: 500 },
    },
    ...overrides,
  };
}

function completion(content, {
  model = 'returned-model', usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  finishReason = 'stop', refusal = null,
} = {}) {
  return { model, choices: [{ finish_reason: finishReason, message: { content, refusal } }], usage };
}

function response(body, { ok = true, status = 200, requestId = 'req_fixture' } = {}) {
  return {
    ok, status,
    headers: { get(name) { return name === 'x-request-id' ? requestId : null; } },
    async json() { return body; },
  };
}

function routerVerdict({
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

function answerPayload() {
  return {
    text: 'What does the approved snapshot say?', chatId: '-100-private', userId: '77',
    route: { action: 'teach', sourceId: 'course-content-v1' },
    dialogue: [{ question: 'Earlier question', answer: 'Earlier answer' }],
    knowledge: { sourceId: 'course-content-v1', entries: [{ id: 'lesson-1', content: 'Approved content.' }] },
  };
}

test('disabled and malformed providers fail before fake fetch', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; throw new Error('must not call'); };
  const disabled = createProviderAdapter({ enabled: false }, { fetchFn });
  const invalid = createProviderAdapter(providerConfig({ vendor: 'anthropic' }), { fetchFn });
  for (const operation of [disabled.moderate, disabled.routeAssistant, disabled.answer]) {
    await assert.rejects(operation({}), (error) => error instanceof ProviderUnavailableError && error.code === 'provider_disabled');
  }
  await assert.rejects(invalid.moderate({ text: 'fixture' }), (error) => error instanceof ProviderUnavailableError && error.code === 'provider_vendor_invalid');
  assert.equal(calls, 0);
});

test('configuration fixes the moderator contract to Terra/OpenAI/medium and router limit', () => {
  assert.equal(validateProviderRuntimeConfig(providerConfig()).valid, true);
  assert.deepEqual(SAFETY_PROVIDER_TUPLE, {
    vendor: 'openai', model: 'gpt-5.6-terra', reasoningEffort: 'medium',
    routerMaxOutputTokens: 1024, abuseMaxOutputTokens: 768,
  });
  for (const [field, value, code] of [
    ['vendor', 'openai-compatible', 'provider_vendor_invalid'],
    ['endpoint', 'http://provider.example.test/v1', 'provider_endpoint_invalid'],
    ['endpoint', 'https://provider.example.test/v1?key=bad', 'provider_endpoint_invalid'],
    ['apiKey', 'line\nbreak', 'provider_api_key_invalid'],
  ]) assert.equal(validateProviderRuntimeConfig(providerConfig({ [field]: value })).code, code);
  const wrongTuple = providerConfig();
  wrongTuple.modelTuples.moderatorSafety = { model: 'gpt-5.6-terra', reasoningEffort: 'low', maxOutputTokens: 1024 };
  assert.equal(validateProviderRuntimeConfig(wrongTuple).code, 'provider_safety_tuple_invalid');
  wrongTuple.modelTuples.moderatorSafety = { model: 'different', reasoningEffort: 'medium', maxOutputTokens: 1024 };
  assert.equal(validateProviderRuntimeConfig(wrongTuple).code, 'provider_safety_tuple_invalid');
  assert.equal(validateProviderRuntimeConfig(providerConfig({ requestTimeoutMs: 0 })).code, 'provider_timeout_invalid');
});

test('loadRuntimeConfig keeps disabled default and requires the exact safety tuple when enabled', () => {
  const disabled = loadRuntimeConfig({}, { cwd: '/tmp/aichattg-provider-test' });
  assert.equal(disabled.provider.enabled, false);
  const env = {
    TELEGRAM_RUNTIME_PROVIDER_ENABLED: 'true', TELEGRAM_RUNTIME_PROVIDER_VENDOR: 'openai',
    TELEGRAM_RUNTIME_PROVIDER_ENDPOINT: 'https://provider.example.test/v1/',
    TELEGRAM_RUNTIME_PROVIDER_API_KEY: 'fixture-key',
    TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_MODEL: 'gpt-5.6-terra',
    TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_REASONING_EFFORT: 'medium',
    TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_MAX_OUTPUT_TOKENS: '1024',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MODEL: 'router-model',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_REASONING_EFFORT: 'none',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MAX_OUTPUT_TOKENS: '100',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MODEL: 'answer-model',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_REASONING_EFFORT: 'low',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MAX_OUTPUT_TOKENS: '500',
  };
  const loaded = loadRuntimeConfig(env, { cwd: '/tmp/aichattg-provider-test' });
  assert.equal(loaded.provider.modelTuples.moderatorSafety.reasoningEffort, 'medium');
  assert.equal(loaded.provider.requestTimeoutMs, 45_000);
  assert.equal(loaded.moderator.requestTimeoutMs, 15_000);
  assert.equal(loaded.assistant.requestTimeoutMs, 15_000);
  assert.throws(() => loadRuntimeConfig({ ...env, TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_MAX_OUTPUT_TOKENS: '200' }, { cwd: '/tmp/aichattg-provider-test' }), /provider_safety_tuple_invalid/);
  assert.throws(() => loadRuntimeConfig({ ...env, TELEGRAM_RUNTIME_PROVIDER_REQUEST_TIMEOUT_MS: '999' }, { cwd: '/tmp/aichattg-provider-test' }), /between 1000 and 120000/);
});

test('synthetic bot ids stay inert unless synthetic testing is explicitly enabled', () => {
  const cwd = '/tmp/aichattg-provider-test';
  const env = { TELEGRAM_RUNTIME_ASSISTANT_SYNTHETIC_BOT_IDS: '77, 78' };
  assert.throws(() => loadRuntimeConfig(env, { cwd }), /TELEGRAM_RUNTIME_ASSISTANT_SYNTHETIC_BOT_IDS requires TELEGRAM_RUNTIME_SYNTHETIC_TESTING_ENABLED=true/);
  const enabled = loadRuntimeConfig({ ...env, TELEGRAM_RUNTIME_SYNTHETIC_TESTING_ENABLED: 'true' }, { cwd });
  assert.deepEqual(enabled.assistant.syntheticBotIds, ['77', '78']);
  assert.deepEqual(enabled.moderator.syntheticBotIds, []);
  assert.deepEqual(loadRuntimeConfig({}, { cwd }).assistant.syntheticBotIds, []);
});

test('clean Moderator makes exactly one fixed router request with no raw history', async () => {
  const calls = [];
  const adapter = createProviderAdapter(providerConfig(), {
    async fetchFn(url, init) {
      calls.push({ url, request: JSON.parse(init.body) });
      return response(completion(routerVerdict(), { model: 'gpt-5.6-terra' }));
    },
  });
  const result = await adapter.moderate({ text: 'Полезный вопрос', currentWeakStrikes: 1, rawHistory: 'must not be sent' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://provider.example.test/v1/chat/completions');
  assert.equal(calls[0].request.model, 'gpt-5.6-terra');
  assert.equal(calls[0].request.max_completion_tokens, 1024);
  assert.equal(calls[0].request.reasoning_effort, 'medium');
  assert.deepEqual(calls[0].request.response_format, SAFETY_ROUTER_RESPONSE_FORMAT);
  assert.match(calls[0].request.messages[0].content, /THREAT LIBRARY v1/);
  assert.match(calls[0].request.messages[0].content, /ABUSE LIBRARY v1/);
  assert.deepEqual(JSON.parse(calls[0].request.messages[1].content), {
    message: 'Полезный вопрос', context: { weak_strikes: 1, warning_stage: 'first' },
  });
  assert.equal(result.safetyRoute, 'clean');
  assert.equal(result.abuseLevel, null);
  assert.equal(result.safetyTrace.usage.calls, 1);
  assert.equal(result.receipt.operation, 'moderatorSafety.router');
  assert.equal(result.receipt.vendor, 'openai');
  assert.equal(JSON.stringify(result.safetyTrace.receipts).includes('Полезный вопрос'), false);
});

test('abuse makes exactly one router plus one severity request and maps weak policy meaning', async () => {
  const calls = [];
  const responses = [
    response(completion(routerVerdict({ abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['идиот'], abuseConfidence: 0.96 }))),
    response(completion(JSON.stringify({ severity: 'weak', confidence: 0.94, basis: 'isolated_disrespect' }))),
  ];
  const adapter = createProviderAdapter(providerConfig(), {
    async fetchFn(_url, init) { calls.push(JSON.parse(init.body)); return responses.shift(); },
  });
  const result = await adapter.moderate({ text: 'Ты идиот' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => [call.model, call.reasoning_effort, call.max_completion_tokens]), [
    ['gpt-5.6-terra', 'medium', 1024], ['gpt-5.6-terra', 'medium', 768],
  ]);
  assert.deepEqual(calls.map((call) => call.response_format), [SAFETY_ROUTER_RESPONSE_FORMAT, SAFETY_ABUSE_RESPONSE_FORMAT]);
  assert.match(calls[1].messages[0].content, /semantic severity/);
  assert.deepEqual(JSON.parse(calls[1].messages[1].content), {
    message: 'Ты идиот',
    router_abuse: { types: ['targeted_insult'], confidence: 0.96, target: 'participant', evidence: ['идиот'], context_used: false },
    context: { weak_strikes: 0, warning_stage: 'none' },
  });
  assert.deepEqual({ route: result.safetyRoute, level: result.abuseLevel, confidence: result.confidence, quote: result.quote }, {
    route: 'abuse', level: 'weak', confidence: 0.94, quote: 'идиот',
  });
  assert.equal(result.reason, 'safety:abuse:weak:targeted_insult');
});

test('threat has priority over abuse and never requests a second severity verdict', async () => {
  let calls = 0;
  const adapter = createProviderAdapter(providerConfig(), {
    async fetchFn() {
      calls++;
      return response(completion(routerVerdict({
        threat: true, threatTypes: ['interpersonal_threat'], threatEvidence: ['Я тебя уничтожу'],
        abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['тупая машина'], target: 'assistant',
      })));
    },
  });
  const result = await adapter.moderate({ text: 'Я тебя уничтожу, тупая машина' });
  assert.equal(calls, 1);
  assert.deepEqual({ route: result.safetyRoute, level: result.abuseLevel, reason: result.reason }, {
    route: 'threat', level: null, reason: 'safety:threat:interpersonal_threat',
  });
});

test('malformed or duplicate safety JSON is fenced after one attempt without an automatic retry', async () => {
  const samples = [
    'not json',
    routerVerdict().replace('{', '{"target":"none",'),
  ];
  for (const sample of samples) {
    let calls = 0;
    const adapter = createProviderAdapter(providerConfig(), {
      async fetchFn() { calls++; return response(completion(sample)); },
    });
    await assert.rejects(adapter.moderate({ text: 'Ты идиот' }), (error) => error instanceof ProviderRequestError
      && error.code === 'provider_safety_router_invalid' && error.retryable === false);
    assert.equal(calls, 1);
  }
});

test('malformed second-stage JSON is fenced after its single second-stage attempt', async () => {
  let calls = 0;
  const responses = [
    response(completion(routerVerdict({ abuse: true, abuseTypes: ['targeted_provocation'], abuseEvidence: ['клоун'] }))),
    response(completion('{"severity":"medium"}')),
  ];
  const adapter = createProviderAdapter(providerConfig(), { async fetchFn() { calls++; return responses.shift(); } });
  await assert.rejects(adapter.moderate({ text: 'Ну ты клоун' }), (error) => error instanceof ProviderRequestError
    && error.code === 'provider_safety_abuse_classifier_invalid' && error.safetyReceipts.length === 2);
  assert.equal(calls, 2);
});

test('the reported website question and other benign questions can pass clean safety without a relevance decision', async () => {
  // These are contract replays, not claims about live model accuracy. Safety
  // must neither answer these questions nor turn them into operations routing.
  for (const text of ['Ты можешь сделать сайт /ask', 'Как открыть урок курса?', 'Какая погода на Марсе?']) {
    const requests = [];
    const adapter = createProviderAdapter(providerConfig(), {
      async fetchFn(_url, init) {
        requests.push(JSON.parse(init.body));
        return response(completion(routerVerdict()));
      },
    });
    const result = await adapter.moderate({ text, currentWeakStrikes: 2, warningStage: 'final' });
    assert.equal(result.safetyRoute, 'clean');
    assert.equal(result.safetyTrace.router.target, 'none');
    assert.equal(result.safetyTrace.router.context_used, false);
    assert.equal(Object.hasOwn(result, 'action'), false);
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].messages[1].content).message, text);
    assert.deepEqual(requests[0].response_format, SAFETY_ROUTER_RESPONSE_FORMAT);
  }
});

test('every incomplete/refused/empty/unknown safety completion is fenced even with valid-looking JSON', async () => {
  const valid = routerVerdict();
  const missingFinish = completion(valid);
  delete missingFinish.choices[0].finish_reason;
  const toolCall = completion(valid);
  toolCall.choices[0].message.tool_calls = [{ secret: 'must-not-leak' }];
  const cases = [
    [completion(valid, { finishReason: 'length' }), 'completion_truncated', 'length', false, valid.length],
    [completion('{"threat":', { finishReason: 'length' }), 'completion_truncated', 'length', false, 10],
    [completion(valid, { finishReason: 'content_filter' }), 'completion_filtered', 'content_filter', false, valid.length],
    [completion(valid, { refusal: 'private refusal contents' }), 'completion_refusal', 'stop', true, valid.length],
    [completion(null, { refusal: 'private refusal contents' }), 'completion_refusal', 'stop', true, null],
    [completion(valid, { finishReason: 'tool_calls' }), 'completion_not_stopped', 'tool_calls', false, valid.length],
    [completion(valid, { finishReason: 'function_call' }), 'completion_not_stopped', 'function_call', false, valid.length],
    [completion(valid, { finishReason: 'private unknown finish reason' }), 'completion_not_stopped', 'unknown', false, valid.length],
    [missingFinish, 'completion_not_stopped', 'missing', false, valid.length],
    [completion(''), 'completion_empty', 'stop', false, 0],
    [completion('  '), 'completion_empty', 'stop', false, 2],
    [completion(null), 'completion_empty', 'stop', false, null],
    [completion([{ type: 'text', text: valid }]), 'completion_content_invalid', 'stop', false, null],
    [toolCall, 'completion_content_invalid', 'stop', false, valid.length],
    [{ choices: [], usage: null }, 'response_envelope_invalid', 'missing', false, null],
  ];
  for (const [body, reason, finishReason, refusal, outputTextChars] of cases) {
    let calls = 0;
    const adapter = createProviderAdapter(providerConfig(), {
      async fetchFn() { calls++; return response(body); },
    });
    await assert.rejects(adapter.moderate({ text: 'Ты можешь сделать сайт /ask' }), (error) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.code, 'provider_safety_router_invalid');
      assert.equal(error.retryable, false);
      const diagnostic = providerFailureDiagnostic(error);
      assert.deepEqual(diagnostic, {
        stage: 'router', reason, finishReason, refusal, outputTextChars,
        inputTokens: body.usage?.prompt_tokens ?? null,
        outputTokens: body.usage?.completion_tokens ?? null,
        totalTokens: body.usage?.total_tokens ?? null,
      });
      for (const secret of ['private', 'req_fixture', 'fixture-key', 'must-not-leak', 'threat', 'Ты можешь']) {
        assert.equal(JSON.stringify(diagnostic).includes(secret), false);
      }
      return true;
    });
    assert.equal(calls, 1, reason);
  }
});

test('semantic failures retain legacy error codes and exact allowlisted reason plus completion metadata', async () => {
  const cases = [
    ['not json', 'json_invalid'],
    [routerVerdict().replace('{', '{"target":"none",'), 'json_duplicate_keys'],
    [routerVerdict({ target: 'assistant' }), 'target_match_mismatch'],
    [routerVerdict({ contextUsed: true }), 'warning_context_mismatch'],
    [routerVerdict({ threat: true, threatTypes: ['credentials'], threatEvidence: ['invented'] }), 'threat_evidence_not_verbatim'],
  ];
  for (const [content, reason] of cases) {
    let calls = 0;
    const adapter = createProviderAdapter(providerConfig(), {
      async fetchFn() { calls++; return response(completion(content)); },
    });
    await assert.rejects(adapter.moderate({ text: 'Ты можешь сделать сайт /ask' }), (error) => {
      assert.equal(error.code, 'provider_safety_router_invalid');
      assert.equal(error.safetyReason, reason);
      assert.deepEqual(providerFailureDiagnostic(error), {
        stage: 'router', reason, finishReason: 'stop', refusal: false, outputTextChars: content.length,
        inputTokens: 11, outputTokens: 7, totalTokens: 18,
      });
      assert.equal(JSON.stringify(error).includes(content), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('second-stage completion failure keeps both call receipts and never retries or emits a moderation verdict', async () => {
  let calls = 0;
  const replies = [
    completion(routerVerdict({ abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: ['идиот'] })),
    completion('{"severity":"weak"', { finishReason: 'length' }),
  ];
  const adapter = createProviderAdapter(providerConfig(), { async fetchFn() { calls++; return response(replies.shift()); } });
  await assert.rejects(adapter.moderate({ text: 'Ты идиот' }), (error) => {
    assert.equal(error.code, 'provider_safety_abuse_classifier_invalid');
    assert.equal(error.safetyReceipts.length, 2);
    assert.equal(providerFailureDiagnostic(error).stage, 'abuse_classifier');
    assert.equal(providerFailureDiagnostic(error).reason, 'completion_truncated');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(calls, 2);
});

test('failure diagnostics are a closed idempotent content-free projection', () => {
  const safe = sanitizeProviderFailureDiagnostic({
    stage: 'router', reason: 'target_match_mismatch', finishReason: 'stop', refusal: false,
    outputTextChars: 243, inputTokens: 100, outputTokens: 20, totalTokens: 120,
    text: 'private output', prompt: 'private input', requestId: 'private request', apiKey: 'private key',
  });
  assert.deepEqual(sanitizeProviderFailureDiagnostic(safe), safe);
  assert.deepEqual(Object.keys(safe), [
    'stage', 'reason', 'finishReason', 'refusal', 'outputTextChars', 'inputTokens', 'outputTokens', 'totalTokens',
  ]);
  assert.ok(Object.isFrozen(safe));
  for (const value of [null, [], {}, { ...safe, stage: 'private value' }, { ...safe, reason: 'private value' }]) {
    assert.equal(sanitizeProviderFailureDiagnostic(value), null);
  }
  assert.deepEqual(sanitizeProviderFailureDiagnostic({
    ...safe, finishReason: 'private value', refusal: 'private value', outputTextChars: 'private value',
    inputTokens: -1, outputTokens: 1.2, totalTokens: Number.MAX_SAFE_INTEGER + 1,
  }), {
    stage: 'router', reason: 'target_match_mismatch', finishReason: 'unknown', refusal: false,
    outputTextChars: null, inputTokens: null, outputTokens: null, totalTokens: null,
  });
  assert.equal(providerFailureDiagnostic(new Error('private error')), null);
  assert.equal(providerFailureDiagnostic(new ProviderRequestError('provider_response_invalid')), null);
});

test('router and answer retain their own tuples without identity leakage', async () => {
  const requests = [];
  const responses = [
    response(completion(JSON.stringify({ action: 'support', sourceId: 'course-operations-v1' }), { model: 'router-returned' })),
    response(completion('Answer only from approved knowledge.', { model: 'answer-returned' })),
  ];
  const adapter = createProviderAdapter(providerConfig(), {
    async fetchFn(_url, init) { requests.push(JSON.parse(init.body)); return responses.shift(); },
  });
  const route = await adapter.routeAssistant({ text: 'How do I open the course?', courseOperationsHint: true, chatId: 'not-sent' });
  const answer = await adapter.answer(answerPayload());
  assert.deepEqual({ action: route.action, sourceId: route.sourceId, modelId: route.modelId }, {
    action: 'support', sourceId: 'course-operations-v1', modelId: 'router-returned',
  });
  assert.equal(answer.text, 'Answer only from approved knowledge.');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, 'router-model');
  assert.equal(Object.hasOwn(requests[0], 'reasoning_effort'), false);
  assert.equal(requests[1].model, 'answer-model');
  assert.equal(requests[1].reasoning_effort, 'low');
  assert.equal(requests[0].messages[1].content.includes('not-sent'), false);
  assert.equal(JSON.stringify(answer.receipt).includes('Approved content.'), false);
});

test('router and answer trim only oldest dialogue until each complete input envelope fits', async () => {
  const requests = [];
  const replies = [
    response(completion(JSON.stringify({ action: 'teach', sourceId: 'course-content-v1' }))),
    response(completion('Bounded answer.')),
  ];
  const adapter = createProviderAdapter(providerConfig(), {
    async fetchFn(_url, init) { requests.push(JSON.parse(init.body)); return replies.shift(); },
  });
  const dialogue = Array.from({ length: 4 }, (_, index) => ({
    question: `${index}:${'q'.repeat(8_190)}`,
    answer: `${index}:${'a'.repeat(8_190)}`,
  }));
  const question = 'x'.repeat(8_192);
  await adapter.routeAssistant({
    text: question,
    dialogue,
    working_state: { summary: 's'.repeat(5_000) },
  });
  await adapter.answer({
    ...answerPayload(),
    text: question,
    dialogue,
    knowledge: {
      sourceId: 'course-content-v1',
      entries: [{ id: 'lesson-1', content: 'k'.repeat(5_000) }],
    },
    working_state: { summary: 's'.repeat(5_000) },
  });
  for (const request of requests) {
    const input = request.messages[1].content;
    const parsed = JSON.parse(input);
    assert.ok(input.length <= ASSISTANT_PROVIDER_INPUT_MAX_CHARS);
    assert.ok(parsed.dialogue.length < 3, 'the full envelope must reduce the isolated three-pair projection');
    assert.equal(parsed.dialogue.at(-1).question.startsWith('3:'), true, 'newest complete turn must survive');
    assert.equal(parsed.question, question, 'current question must not be truncated');
  }
});

// История — вспомогательный контекст, а не условие ответа. Боевой дефект: один
// ход с пустым вопросом (служебный ответ на одинокую /ask) отвергал ВЕСЬ запрос,
// и человек молча переставал получать ответы.
test('unusable dialogue turns are filtered out instead of failing the whole answer', async () => {
  const { adapter, requests } = answerAdapter([
    response(completion('Answer despite a poisoned turn.')),
    response(completion('Answer without any history.')),
  ]);
  const answered = await adapter.answer({
    ...answerPayload(),
    dialogue: [
      { question: '', answer: 'После /ask напишите ваш вопрос одним сообщением.' },
      { question: 'Good question', answer: 'Good answer' },
      { question: 'Orphan question', answer: '   ' },
    ],
  });
  assert.equal(answered.text, 'Answer despite a poisoned turn.');
  assert.deepEqual(JSON.parse(requests[0].messages[1].content).dialogue, [
    { question: 'Good question', answer: 'Good answer' },
  ]);
  // Полностью пустая история — законное состояние (первый вопрос в диалоге).
  await adapter.answer({ ...answerPayload(), dialogue: [] });
  assert.deepEqual(JSON.parse(requests[1].messages[1].content).dialogue, []);
});

// Невалидна должна быть только САМА заявка: нет вопроса, маршрута или знания.
// Это настоящая невозможность ответить, и она обязана остаться отказом.
test('an invalid request itself still fails before any call is attempted', async () => {
  let calls = 0;
  const adapter = createProviderAdapter(providerConfig(), { async fetchFn() { calls++; throw new Error('must not call'); } });
  const rejected = [
    { ...answerPayload(), text: '   ' },
    { ...answerPayload(), route: null },
    { ...answerPayload(), knowledge: { sourceId: 'course-content-v1', entries: [] } },
    { ...answerPayload(), knowledge: { sourceId: '', entries: [{ id: 'a', content: 'b' }] } },
    {
      ...answerPayload(),
      knowledge: {
        sourceId: 'course-content-v1',
        entries: Array.from({ length: 129 }, (_item, index) => ({ id: `entry-${index}`, content: 'Approved content.' })),
      },
    },
  ];
  for (const payload of rejected) {
    await assert.rejects(adapter.answer(payload), (error) => error instanceof ProviderRequestError
      && error.code === 'provider_request_invalid');
  }
  // Проверка локальная: ни одного запроса к провайдеру, значит платы не было.
  assert.equal(calls, 0);
});

test('transport errors have no automatic retry', async () => {
  let calls = 0;
  const adapter = createProviderAdapter(providerConfig(), { async fetchFn() { calls++; throw new Error('network detail'); } });
  await assert.rejects(adapter.moderate({ text: 'fixture' }), (error) => error instanceof ProviderRequestError
    && error.code === 'provider_transport_failed' && error.retryable === false);
  assert.equal(calls, 1);
});

test('every provider request has one bounded deadline and timeout stays ambiguous without retry', async () => {
  let calls = 0;
  const adapter = createProviderAdapter(providerConfig(), {
    requestTimeoutMs: 1_000,
    fetchFn: async (_url, init) => {
      calls++;
      assert.equal(init.signal instanceof AbortSignal, true);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    },
  });
  // AbortSignal.timeout() is intentionally unref'ed by Node. Keep the test
  // event loop alive long enough to observe the real deadline firing.
  const keepAlive = setTimeout(() => {}, 1_250);
  try {
    await assert.rejects(adapter.moderate({ text: 'fixture' }), (error) => (
      error instanceof ProviderRequestError
        && error.code === 'provider_transport_failed'
        && error.retryable === false
    ));
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(calls, 1);
});

function answerAdapter(responses) {
  const requests = [];
  const adapter = createProviderAdapter(providerConfig(), {
    async fetchFn(_url, init) { requests.push(JSON.parse(init.body)); return responses.shift(); },
  });
  return { adapter, requests };
}

function answerEntries(request) {
  return JSON.parse(request.messages[1].content).knowledge.entries;
}

test('citation title and canonical url reach the answer model with the entry', async () => {
  const { adapter, requests } = answerAdapter([response(completion('Answer with a lesson link.'))]);
  const answer = await adapter.answer({
    ...answerPayload(),
    knowledge: {
      sourceId: 'course-content-v1',
      entries: [{
        id: 'lesson-1', content: 'Approved content.',
        title: 'Урок 2.3. Архитектура агентов',
        canonicalUrl: 'https://course.example.test/lesson-23',
      }],
    },
  });
  assert.equal(answer.text, 'Answer with a lesson link.');
  assert.deepEqual(answerEntries(requests[0]), [{
    id: 'lesson-1', content: 'Approved content.',
    title: 'Урок 2.3. Архитектура агентов',
    canonicalUrl: 'https://course.example.test/lesson-23',
  }]);
  // The answer prompt must license the admitted link, otherwise the standing
  // "do not invent links" instruction suppresses the funnel the fields exist for.
  const system = requests[0].messages[0].content;
  assert.equal(system.includes('canonicalUrl'), true);
  // The citation fields are data, not trace: the receipt stays content-free.
  const receipt = JSON.stringify(answer.receipt);
  assert.equal(receipt.includes('course.example.test'), false);
  assert.equal(receipt.includes('Архитектура'), false);
});

test('an entry without citation fields sends neither key and still answers', async () => {
  const { adapter, requests } = answerAdapter([response(completion('Answer without a link.'))]);
  await adapter.answer(answerPayload());
  const [entry] = answerEntries(requests[0]);
  assert.deepEqual(entry, { id: 'lesson-1', content: 'Approved content.' });
  assert.equal(Object.hasOwn(entry, 'title'), false);
  assert.equal(Object.hasOwn(entry, 'canonicalUrl'), false);
});

test('only an absolute https canonical url is forwarded as a citation', async () => {
  const rejected = [
    '/courses/lesson-23', 'http://course.example.test/lesson-23',
    'javascript:alert(1)', 'lesson-23', `https://course.example.test/${'x'.repeat(2_048)}`,
  ];
  const { adapter, requests } = answerAdapter(rejected.map(() => response(completion('Answer.'))));
  for (const canonicalUrl of rejected) {
    await adapter.answer({
      ...answerPayload(),
      knowledge: {
        sourceId: 'course-content-v1',
        entries: [{ id: 'lesson-1', content: 'Approved content.', title: 'Lesson', canonicalUrl }],
      },
    });
  }
  for (const request of requests) {
    const [entry] = answerEntries(request);
    assert.equal(Object.hasOwn(entry, 'canonicalUrl'), false, 'a non-https url must not become a citation');
    assert.equal(entry.title, 'Lesson');
  }
});

test('an admitted snapshot carries its citation fields to the model but no local paths', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-citation-'));
  try {
    const content = 'Lesson body about agents.';
    writeFileSync(join(folder, 'lesson.md'), content);
    const manifest = {
      format: 'aichattg-knowledge-manifest-v1',
      sourceId: 'course-content-v1',
      entries: [{
        id: 'lesson-1', path: 'lesson.md',
        sha256: createHash('sha256').update(content).digest('hex'),
        title: 'Урок 2.3', canonicalUrl: 'https://course.example.test/lesson-23',
      }],
    };
    const admitted = admitKnowledgeSnapshot({
      manifest, root: folder,
      expectedIdentity: { sourceId: 'course-content-v1', manifestDigest: knowledgeManifestDigest(manifest) },
    });
    assert.equal(admitted.available, true);
    const { adapter, requests } = answerAdapter([response(completion('Answer.'))]);
    await adapter.answer({ ...answerPayload(), knowledge: admitted.snapshot });
    assert.deepEqual(answerEntries(requests[0]), [{
      id: 'lesson-1', content,
      title: 'Урок 2.3', canonicalUrl: 'https://course.example.test/lesson-23',
    }]);
    // The snapshot's local filesystem identity is not the model's business.
    const sent = requests[0].messages[1].content;
    assert.equal(sent.includes('lesson.md'), false);
    assert.equal(sent.includes(manifest.entries[0].sha256), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

// Решение владельца: условия формулирует сайт, а не бот. Операционный промпт
// обязан требовать ссылку и запрещать цифру, иначе модель назовёт цену сама.
test('the operations answer prompt forbids restating terms and demands the link', () => {
  const operations = answerSystemPrompt({ knowledge: { sourceId: 'course-operations-v1', entries: [] } });
  const content = answerSystemPrompt({ knowledge: { sourceId: 'course-content-v1', entries: [] } });
  assert.notEqual(operations, content);
  assert.match(operations, /never state, quote, estimate, recalculate or infer any price/u);
  assert.match(operations, /tariff/u);
  assert.match(operations, /refund window/u);
  assert.match(operations, /canonicalUrl/u);
  // Содержательный промпт остаётся прежним для всего, что не операционный источник.
  assert.equal(answerSystemPrompt({ knowledge: { sourceId: 'course-knowledge-v2' } }), content);
  assert.equal(answerSystemPrompt(null), content);
});

// Решение владельца: «понимать без учёбы» — вера в волшебную пилюлю. Value-промпт
// обязан запрещать подтверждение этой посылки и требовать честную цену в усилиях.
test('the value answer prompt refuses the magic-pill premise and demands the honest track', () => {
  const value = answerSystemPrompt({ knowledge: { sourceId: 'course-value-v1', entries: [] } });
  const content = answerSystemPrompt({ knowledge: { sourceId: 'course-content-v1', entries: [] } });
  const operations = answerSystemPrompt({ knowledge: { sourceId: 'course-operations-v1', entries: [] } });
  assert.notEqual(value, content);
  assert.notEqual(value, operations);
  assert.match(value, /Never validate the premise that learning is unnecessary/u);
  assert.match(value, /"you do not need a course"/u);
  assert.match(value, /does not exist without a minimal immersion/u);
  assert.match(value, /minimal track with its real cost in effort/u);
  assert.match(value, /name lessons by their title/u);
  assert.match(value, /Do not invent prices, dates, discounts or promises of results/u);
});
